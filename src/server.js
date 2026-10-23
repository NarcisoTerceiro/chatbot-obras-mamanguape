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

import { getObras, limparCache, getDiagnostico } from "./sheets.js";
import { responderPergunta } from "./agente.js";
import { enviarTexto } from "./whatsapp.js";
import { executarComMetricas, medirEtapa } from "./telemetria.js";

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
if (!process.env.GOOGLE_SHEETS_ID) {
  throw new Error("GOOGLE_SHEETS_ID e obrigatorio: o agente le a planilha diretamente.");
}
// Aquece o cache da planilha na subida para a 1a resposta ser rapida.
getObras().catch((e) => console.error("Falha ao pre-carregar planilha:", e.message));

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
const MEMORIA_VALIDADE_MS = 10 * 60 * 1000; // 10 minutos; o agente envia so contexto curto
const limpezaMemoria = setInterval(() => {
  for (const [chave, valor] of memoriaPorUsuario) if (Date.now() - valor.time >= MEMORIA_VALIDADE_MS) memoriaPorUsuario.delete(chave);
}, 60000);
limpezaMemoria.unref();
const MAX_HISTORICO = 10; // somente RAM: guarda os 10 turnos/mensagens mais recentes por ate 10 minutos

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
    // 10 minutos sem atividade e nada e gravado no PostgreSQL.
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
    const obras = await getObras();
    const d = getDiagnostico();
    res.json({
      fonte_do_atendimento: "Google Sheets (direto, sem banco)",
      total_de_registros: obras.length,
      lido_em: d.quando,
      abas: d.abas.map(({ celulas, ...resto }) => resto),
      exemplo: obras[0] || null,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// SINCRONIZAR: limpa o cache e rele a planilha na hora.
async function executarRotaSincronizacao(req, res) {
  if (!exigirAdmin(req, res)) return;
  try {
    limparCache();
    const obras = await getObras({ force: true });
    res.json({ ok: true, registros: obras.length, abas: getDiagnostico().abas.length, quando: new Date().toISOString() });
  } catch (e) {
    console.error("ERRO ao reler planilha:", e.message);
    res.status(500).json({ ok: false, erro: e.message, dica: "Verifique GOOGLE_SHEETS_ID e GOOGLE_SERVICE_ACCOUNT_JSON." });
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
  if (!pergunta) return res.json({ resposta: "Digite sua pergunta sobre as obras." });

  // Memoria somente em RAM. Use ?sessao=nome para separar conversas de teste.
  // A sessao expira apos 10 minutos sem atividade e nao grava nada no banco.
  const sessao = String(req.query.sessao || req.get("x-test-session") || "padrao")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
  const chaveTeste = `__teste_sql_agent__:${sessao}`;
  const memoriaTeste = lerMemoria(chaveTeste);
  const historicoTeste = memoriaTeste.historico || [];

  try {
    const r = await responderPergunta(pergunta, historicoTeste, { conversationId: chaveTeste, canal: "teste" });
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
      metricas: r.metricas || null,
      erro: r.erro || null,
    });
  } catch (e) {
    console.error('Erro no teste do agente:', e.message);
    res.status(500).json({ resposta: 'Não consegui responder agora. Pode tentar novamente?' });
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
  return executarComMetricas("whatsapp", () => processarMensagemInterno(mensagem));
}

async function processarMensagemInterno(mensagem) {
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
    // por ate 10 minutos sem atividade.
    await medirEtapa("envio_whatsapp", () => enviarTexto(de, respostaAg));
    return resultadoAg || { erro: "falha_agente" };
 }

export { app, processarWebhook };
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
