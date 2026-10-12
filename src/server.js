// ============================================================
//  server.js  -  ponto de entrada do chatbot
//
//  Fluxo padrao:
//  Google Sheets --(conta de servico/sincronizacao)--> Supabase
//  WhatsApp -> Webhook validado -> agente SQL -> Supabase -> WhatsApp.
//
//  O atendimento usa exclusivamente PostgreSQL; Sheets é lido na ingestão.
// ============================================================

import "dotenv/config";
import crypto from "crypto";
import express from "express";

import { sincronizar } from "./ingestao.js";
import { responderPergunta } from "./agente.js";
import { enviarTexto } from "./whatsapp.js";
import { queryReadOnly } from "./db.js";

const app = express();
// Guarda os bytes originais para validar a assinatura HMAC enviada pela Meta.
app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || VERIFY_TOKEN;
const PERMITIR_TOKEN_QUERY = process.env.PERMITIR_TOKEN_QUERY === "true";
const PERMITIR_SYNC_GET_LEGADO = process.env.PERMITIR_SYNC_GET_LEGADO === "true";

if (!VERIFY_TOKEN) {
  throw new Error("VERIFY_TOKEN e obrigatorio; o servidor nao inicia sem ele.");
}
if (!META_APP_SECRET) {
  throw new Error("META_APP_SECRET e obrigatorio para validar o webhook da Meta.");
}
if (!ADMIN_TOKEN) {
  throw new Error("ADMIN_TOKEN e obrigatorio para as rotas administrativas.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL read-only e obrigatoria para o agente SQL.");
}

function compararSegredo(a, b) {
  const ba = Buffer.from((a || "").toString());
  const bb = Buffer.from((b || "").toString());
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function adminAutorizado(req) {
  const cabecalho = req.get("authorization") || "";
  const bearer = cabecalho.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (compararSegredo(bearer, ADMIN_TOKEN)) return true;
  // Compatibilidade temporaria, desligada por padrao. Tokens na URL podem
  // aparecer em historico, proxy e logs; migre o chamador para Authorization.
  return PERMITIR_TOKEN_QUERY && compararSegredo(req.query.token, ADMIN_TOKEN);
}

function exigirAdmin(req, res) {
  if (adminAutorizado(req)) return true;
  res.sendStatus(403);
  return false;
}

function assinaturaMetaValida(req) {
  const recebida = req.get("x-hub-signature-256") || "";
  if (!recebida.startsWith("sha256=") || !req.rawBody) return false;
  const esperada = "sha256=" + crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  return compararSegredo(recebida, esperada);
}

// --- Memoria de conversa por cidadao (numero de WhatsApp) ---
// Histórico curto por usuário, separado das conversas de teste.
const memoriaPorUsuario = new Map();
const MEMORIA_VALIDADE_MS = 30 * 60 * 1000; // 30 minutos; o agente envia so contexto curto
const MAX_HISTORICO = 10; // somente RAM: guarda os 10 turnos/mensagens mais recentes por ate 30 minutos

// Evita responder duas vezes ao mesmo evento da Meta. E uma protecao local;
// para varias instancias, substitua por Redis/PostgreSQL com chave unica.
const mensagensEmProcessamento = new Set();
const mensagensProcessadas = new Map();
const DEDUP_VALIDADE_MS = 24 * 60 * 60 * 1000;

function limparDeduplicacao(agora = Date.now()) {
  for (const [id, quando] of mensagensProcessadas) {
    if (agora - quando > DEDUP_VALIDADE_MS) mensagensProcessadas.delete(id);
  }
}

function mascararTelefone(numero) {
  const s = (numero || "").toString();
  return s.length <= 4 ? "****" : `***${s.slice(-4)}`;
}


function memoriaVazia() {
  return { historico: [] };
}

function lerMemoria(de) {
  const m = memoriaPorUsuario.get(de);
  if (!m) return memoriaVazia();
  if (Date.now() - m.time > MEMORIA_VALIDADE_MS) {
    memoriaPorUsuario.delete(de);
    return memoriaVazia();
  }
  return {
    historico: m.historico || [],
  };
}

function salvarMemoria(de, dados) {
  memoriaPorUsuario.set(de, {
    historico: (dados.historico || []).slice(-MAX_HISTORICO),
    // O relogio reinicia a cada nova mensagem. A sessao expira apos
    // 30 minutos sem atividade e nada e gravado no PostgreSQL.
    time: Date.now(),
  });
}

// Rota de saude (util pra manter o servico "acordado" e testar no navegador).
app.get("/", (_req, res) => res.send("Chatbot de Obras de Mamanguape no ar."));

// ------------------------------------------------------------
//  Rota administrativa de diagnostico. Use:
//    Authorization: Bearer SEU_ADMIN_TOKEN
//  O diagnóstico consulta o banco usado pelo atendimento.
// ------------------------------------------------------------
app.get("/diagnostico", async (req, res) => {
  if (!exigirAdmin(req, res)) return;
  try {
    const [total, status, exemplo, sync, abas] = await Promise.all([
      queryReadOnly('SELECT COUNT(*)::int AS total FROM public.obras'),
      queryReadOnly("SELECT COALESCE(status, 'Não informado') AS status, COUNT(*)::int AS total FROM public.obras GROUP BY status ORDER BY total DESC LIMIT 20"),
      queryReadOnly('SELECT id, objeto, bairro, status, categoria, aba_origem FROM public.obras ORDER BY id LIMIT 1'),
      queryReadOnly('SELECT atualizada_em, registros FROM public.obras_sync WHERE id=1'),
      queryReadOnly('SELECT planilha_id,aba,view_nome,registros,linhas_lidas,avisos,atualizada_em FROM public.planilha_abas WHERE ativa=true ORDER BY aba'),
    ]);
    res.json({
      fonte_do_atendimento: 'PostgreSQL/Supabase',
      total_de_obras: total.rows[0]?.total || 0,
      contagem_por_status: status.rows,
      exemplo_de_obra: exemplo.rows[0] || null,
      lido_em: sync.rows[0]?.atualizada_em || null,
      ultima_sincronizacao: sync.rows[0]?.atualizada_em || null,
      abas: abas.rows,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ------------------------------------------------------------
//  SINCRONIZAR: a conta de servico LE o Google Sheets e esta rota popula o
//  Supabase. O WhatsApp continua consultando somente o banco.
//  Chame com POST + Authorization: Bearer SEU_ADMIN_TOKEN.
// ------------------------------------------------------------
async function executarRotaSincronizacao(req, res) {
  if (!exigirAdmin(req, res)) return;
  try {
    const resultado = await sincronizar();
    res.json({
      ok: true,
      obras_inseridas: resultado.inseridas,
      abas: resultado.abas,
      planilha_id: resultado.planilha_id,
      quando: new Date().toISOString(),
    });
  } catch (e) {
    // Mostra o erro completo para diagnostico (mensagem + tipo + detalhe).
    const detalhe = e && (e.message || e.toString());
    const codigo = e && (e.code || "");
    console.error("ERRO na sincronizacao:", detalhe, codigo, e && e.stack);
    res.status(500).json({
      ok: false,
      erro: detalhe || "erro desconhecido",
      codigo: codigo || undefined,
      dica: "Verifique DATABASE_ADMIN_URL no Render e as credenciais do Google.",
    });
  }
}

app.post("/sincronizar", executarRotaSincronizacao);

app.get("/sincronizar", (req, res) => {
  if (!PERMITIR_SYNC_GET_LEGADO) {
    res.set("Allow", "POST");
    return res.status(405).json({
      erro: "Use POST /sincronizar com Authorization: Bearer <ADMIN_TOKEN>.",
    });
  }
  console.warn("AVISO: sincronizacao por GET legado habilitada; migre o chamador para POST.");
  return executarRotaSincronizacao(req, res);
});

// ------------------------------------------------------------
//  TESTAR-AGENTE: testa o agente SQL sem WhatsApp.
//  Chame GET /testar-agente?q=quantas obras concluidas com o cabecalho:
//    Authorization: Bearer SEU_ADMIN_TOKEN
//  Mostra o SQL gerado, quantas linhas voltaram, e a resposta.
//  So para TESTE - nao mexe no bot do WhatsApp.
// ------------------------------------------------------------
app.get("/testar-agente", async (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const pergunta = req.query.q;
  if (!pergunta) return res.json({ erro: "passe a pergunta em ?q=..." });

  // Memoria somente em RAM. Use ?sessao=nome para separar conversas de teste.
  // A sessao expira apos 30 minutos sem atividade e nao grava nada no banco.
  const sessao = String(req.query.sessao || req.get("x-test-session") || "padrao")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
  const chaveTeste = `__teste_sql_agent__:${sessao}`;
  const memoriaTeste = lerMemoria(chaveTeste);
  const historicoTeste = memoriaTeste.historico || [];

  try {
    const r = await responderPergunta(pergunta, historicoTeste, { conversationId: chaveTeste });
    const novasMensagens = [
      { role: "user", content: pergunta },
      {
        role: "assistant",
        content: r.resposta,
        sql: r.sql || null,
        linhas: r.linhas ?? null,
        estado: r.estado || null,
      },
    ];
    salvarMemoria(chaveTeste, {
      ...memoriaTeste,
      historico: [...historicoTeste, ...novasMensagens],
    });

    res.json({
      pergunta,
      sessao,
      sql_gerada: r.sql || r.sqlBloqueada || null,
      linhas_retornadas: r.linhas ?? null,
      resposta: r.resposta,
      reparos: r.reparos ?? null,
      early_accept: r.earlyAccept ?? null,
      tentativas: r.tentativas || null,
      modo_agente: r.modoAgente || null,
      diagnostico: r.diagnostico || null,
      erro: r.erro || null,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ------------------------------------------------------------
//  1) VERIFICACAO DO WEBHOOK (a Meta chama isso 1 vez, via GET)
// ------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && compararSegredo(token, VERIFY_TOKEN)) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ------------------------------------------------------------
//  2) RECEBIMENTO DE MENSAGENS (a Meta manda cada msg via POST)
// ------------------------------------------------------------
app.post("/webhook", (req, res) => {
  if (!assinaturaMetaValida(req)) {
    console.warn("Webhook rejeitado: assinatura da Meta invalida ou ausente.");
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  processarWebhook(req.body).catch((e) =>
    console.error("Erro ao processar webhook:", e)
  );
});

async function processarWebhook(payload) {
  const mensagens = (payload?.entry || []).flatMap((entry) =>
    (entry?.changes || []).flatMap((change) => change?.value?.messages || [])
  );

  limparDeduplicacao();
  for (const mensagem of mensagens) {
    if (!mensagem || mensagem.type !== "text") continue;
    const id = (mensagem.id || "").toString();
    if (id && (mensagensProcessadas.has(id) || mensagensEmProcessamento.has(id))) {
      console.log("Webhook duplicado ignorado:", id);
      continue;
    }

    if (id) mensagensEmProcessamento.add(id);
    try {
      await processarMensagem(mensagem);
      if (id) mensagensProcessadas.set(id, Date.now());
    } catch (e) {
      console.error("Erro ao processar mensagem do webhook:", e.message);
    } finally {
      if (id) mensagensEmProcessamento.delete(id);
    }
  }
}

async function processarMensagem(mensagem) {
  if (!mensagem || mensagem.type !== 'text' || !mensagem.from || !mensagem.text?.body) return;
  const de = mensagem.from;
  const pergunta = mensagem.text.body;
  console.log('Mensagem recebida:', { id: mensagem.id || null, de: mascararTelefone(de), caracteres: pergunta.length });
    const memoriaAg = lerMemoria(de);
    const historicoAg = memoriaAg.historico || [];

    let respostaAg;
    let resultadoAg = null;
    try {
      resultadoAg = await responderPergunta(pergunta, historicoAg, { conversationId: de });
      respostaAg = resultadoAg.resposta;
    } catch (e) {
      console.error("AGENTE SQL falhou:", e.message);
      respostaAg = "Desculpe, tive um problema para responder agora. Pode tentar de novo?";
    }

    const novasMensagens = [
      { role: "user", content: pergunta },
      {
        role: "assistant",
        content: respostaAg,
        sql: resultadoAg?.sql || null,
        linhas: resultadoAg?.linhas ?? null,
        estado: resultadoAg?.estado || null,
      },
    ];

    salvarMemoria(de, {
      ...memoriaAg,
      historico: [...historicoAg, ...novasMensagens].slice(-MAX_HISTORICO),
    });

    // Nao persiste conversa no PostgreSQL. O contexto existe apenas em RAM
    // por ate 30 minutos sem atividade.
    await enviarTexto(de, respostaAg);
 }

export { app, processarWebhook };
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
