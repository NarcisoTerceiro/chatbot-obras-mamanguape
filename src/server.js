// ============================================================
//  server.js  -  ponto de entrada do chatbot
//
//  Fluxo:
//  WhatsApp -> Webhook (aqui)
//           -> A IA (Groq) CONDUZ a conversa: com o HISTORICO recente
//              do cidadao, ela entende o pedido (mesmo informal e com
//              referencias tipo "e o prazo?") e devolve tipo + termos.
//           -> O SISTEMA (search.js) BUSCA na planilha (Google Sheets).
//           -> O SISTEMA entrega as obras encontradas de volta a IA.
//           -> A IA (Groq) REDIGE a resposta final, conectada com o que
//              ja foi dito na conversa.
//           -> WhatsApp Cloud API envia ao cidadao.
//
//  A IA lembra da conversa (memoria por usuario) e redige, mas NUNCA
//  acessa a planilha nem inventa dado: quem busca e sempre o sistema.
//  Se a IA falhar, o proprio sistema monta a resposta com um formatador
//  simples, sem travar o atendimento.
// ============================================================

import "dotenv/config";
import express from "express";

import { getObras } from "./sheets.js";
import { buscarObrasPorTermos, buscarObras } from "./search.js";
import { interpretarPergunta, redigirResposta } from "./groq.js";
import { enviarTexto } from "./whatsapp.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Quantas obras mostrar no maximo numa resposta DETALHADA (cada uma ocupa
// bastante espaco). Numa resposta RESUMIDA (so nomes), cabe bem mais.
const LIMITE_RESULTADOS = 3;
const LIMITE_RESUMIDO = 15;

// --- Memoria de conversa por cidadao (numero de WhatsApp) ---
// Guarda o HISTORICO recente (mensagens da pessoa + respostas do bot) e a(s)
// ultima(s) obra(s) que essa pessoa perguntou. O historico vai para a IA em
// cada chamada, para ela lembrar do contexto e conduzir a conversa. As obras
// guardadas ajudam perguntas de acompanhamento ("quanto gastou?") a reusarem
// a obra ja em pauta.
const memoriaPorUsuario = new Map();
const MEMORIA_VALIDADE_MS = 10 * 60 * 1000; // 10 minutos
const MAX_HISTORICO = 8; // guarda ate 8 mensagens (~4 trocas)

function lerMemoria(de) {
  const m = memoriaPorUsuario.get(de);
  if (!m) return { historico: [], obras: [] };
  if (Date.now() - m.time > MEMORIA_VALIDADE_MS) {
    memoriaPorUsuario.delete(de);
    return { historico: [], obras: [] };
  }
  return { historico: m.historico || [], obras: m.obras || [] };
}

function salvarMemoria(de, { historico, obras }) {
  memoriaPorUsuario.set(de, {
    historico: (historico || []).slice(-MAX_HISTORICO),
    obras: obras || [],
    time: Date.now(),
  });
}

// Rota de saude (util pra manter o servico "acordado" e testar no navegador).
app.get("/", (_req, res) => res.send("Chatbot de Obras de Mamanguape no ar."));

// ------------------------------------------------------------
//  1) VERIFICACAO DO WEBHOOK (a Meta chama isso 1 vez, via GET)
// ------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ------------------------------------------------------------
//  2) RECEBIMENTO DE MENSAGENS (a Meta manda cada msg via POST)
// ------------------------------------------------------------
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  processarWebhook(req.body).catch((e) =>
    console.error("Erro ao processar webhook:", e)
  );
});

// ------------------------------------------------------------
//  Formatacao de RESPALDO (fallback): usada so quando a IA de
//  redacao falha. O SISTEMA monta o texto usando exatamente as
//  colunas que existirem na planilha, sem depender da IA.
// ------------------------------------------------------------

function campoNome(obra) {
  const candidatos = ["OBJETO DA OBRA", "OBJETO", "NOME DA OBRA", "NOME", "OBRA"];
  for (const c of candidatos) {
    if (obra[c]) return obra[c];
  }
  const primeiro = Object.entries(obra).find(([k, v]) => k !== "_aba" && v);
  return primeiro ? primeiro[1] : "Obra sem nome cadastrado";
}

function campoStatus(obra) {
  return obra["STATUS"] || obra["Status"] || obra["SITUA\u00c7\u00c3O"] || "";
}

function formatarResumido(obra) {
  const status = campoStatus(obra);
  return status ? `\u2022 ${campoNome(obra)} (${status})` : `\u2022 ${campoNome(obra)}`;
}

function formatarListaResumida(obras) {
  return obras.map((o) => formatarResumido(o)).join("\n");
}

function formatarObra(obra) {
  const linhas = [];
  for (const [chave, valor] of Object.entries(obra)) {
    if (chave === "_aba" || !valor) continue;
    const texto = valor.toString();
    const valorCurto = texto.length > 200 ? texto.slice(0, 200) + "\u2026" : texto;
    linhas.push(`\u2022 *${chave}*: ${valorCurto}`);
  }
  return linhas.join("\n");
}

function formatarLista(obras) {
  return obras.map((o, i) => `${i + 1}) ${formatarObra(o)}`).join("\n\n");
}

// Monta a resposta localmente (sem IA) a partir das obras encontradas.
// Usada como respaldo quando a IA de redacao nao responde.
function montarRespostaLocal(encontradas, detalhe) {
  if (detalhe === "resumido" && encontradas.length > 1) {
    return `Encontrei ${encontradas.length} obra(s):\n\n` + formatarListaResumida(encontradas);
  }
  if (encontradas.length === 1) {
    return formatarObra(encontradas[0]);
  }
  return `Encontrei ${encontradas.length} obra(s):\n\n` + formatarLista(encontradas);
}

// ------------------------------------------------------------
//  Orquestracao principal
//  Cada ramo apenas DEFINE o "texto" (resposta) e "obrasContexto"
//  (o que guardar). O envio e o salvamento da memoria acontecem
//  uma unica vez, no fim.
// ------------------------------------------------------------
async function processarWebhook(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const mensagem = value?.messages?.[0];

  if (!mensagem || mensagem.type !== "text") return;

  const de = mensagem.from;
  const pergunta = mensagem.text.body;
  console.log(`Pergunta de ${de}: ${pergunta}`);

  // Le a memoria da conversa deste cidadao (historico + ultimas obras).
  const { historico, obras: obrasContexto } = lerMemoria(de);

  let texto = "";                    // resposta final que sera enviada
  let obrasParaGuardar = obrasContexto; // obras a manter no contexto

  try {
    // Passo A: le a planilha (com cache).
    const obras = await getObras();

    if (obras.length === 0) {
      texto =
        "No momento nao encontrei nenhuma obra cadastrada na base. Tente novamente mais tarde.";
    } else {
      // Passo B: a IA CONDUZ - com o historico, interpreta a pergunta e
      // devolve tipo + termos + detalhe. Se falhar, cai para busca direta.
      let interpretacao;
      try {
        interpretacao = await interpretarPergunta(pergunta, historico);
      } catch (e) {
        console.error("IA de interpretacao falhou, usando busca direta:", e.message);
        interpretacao = { tipo: "busca", termos: [], detalhe: "completo" };
      }

      // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
      console.log("DEBUG interpretacao:", JSON.stringify(interpretacao));

      // Passo C: SAUDACAO / conversa solta - resposta FIXA do sistema, sem
      // chamar o Groq (economiza requisicao e tokens em "oi", "bom dia", etc.).
      if (interpretacao.tipo === "saudacao") {
        texto =
          "Ola! Eu sou o assistente de obras publicas da Prefeitura de Mamanguape. " +
          "Pode perguntar sobre qualquer obra (ex.: bairro, rua, tipo de obra ou nome da obra).";
      }

      // Passo D: LISTAGEM geral - o sistema separa as obras e a IA redige a
      // lista (resumida ou completa). Fallback: formatador local.
      else if (interpretacao.tipo === "listagem") {
        const resumido = interpretacao.detalhe === "resumido";
        const limite = resumido ? LIMITE_RESUMIDO : LIMITE_RESULTADOS;
        const lista = obras.slice(0, limite);
        const restante = obras.length - lista.length;
        obrasParaGuardar = lista;

        let corpo;
        try {
          corpo = await redigirResposta(pergunta, lista, interpretacao.detalhe, historico);
        } catch (e) {
          console.error("IA de redacao (listagem) falhou, usando local:", e.message);
          corpo = resumido
            ? `Temos ${obras.length} obra(s) cadastrada(s):\n\n` + formatarListaResumida(lista)
            : `Temos ${obras.length} obra(s) cadastrada(s). Aqui estao as primeiras, com detalhes:\n\n` +
              formatarLista(lista);
        }

        const rodape =
          restante > 0
            ? `\n\n...e mais ${restante}. Pergunte por uma obra especifica (bairro, rua, tipo ou nome) para ver detalhes.`
            : "";
        texto = corpo + rodape;
      }

      // Passo E: BUSCA especifica - usa os termos da IA; se vier vazio, cai
      // para busca direta pelo texto cru; se ainda nada, reusa a obra que ja
      // estava em pauta (pergunta de acompanhamento).
      else {
        let encontradas = buscarObrasPorTermos(interpretacao.termos, obras, LIMITE_RESULTADOS);
        console.log(`DEBUG busca por termos da IA: ${encontradas.length} resultado(s)`);
        if (encontradas.length === 0) {
          encontradas = buscarObras(pergunta, obras, LIMITE_RESULTADOS);
          console.log(`DEBUG busca direta pelo texto: ${encontradas.length} resultado(s)`);
        }
        if (encontradas.length === 0 && obrasContexto.length > 0) {
          console.log("DEBUG reusando obra(s) do contexto da conversa");
          encontradas = obrasContexto;
        }

        if (encontradas.length === 0) {
          // Nada e sem contexto: mostra um resumo geral para o cidadao sempre
          // receber algo util (e guarda essas obras como novo contexto).
          const lista = obras.slice(0, LIMITE_RESULTADOS);
          obrasParaGuardar = lista;
          try {
            texto = await redigirResposta(pergunta, lista, "resumido", historico);
          } catch (e) {
            console.error("IA de fallback falhou, usando local:", e.message);
            texto =
              `Nao encontrei uma obra especifica para essa pergunta. Temos ${obras.length} obra(s) cadastrada(s). Aqui estao algumas:\n\n` +
              formatarLista(lista) +
              `\n\nVoce pode perguntar por bairro, rua, tipo de obra ou nome especifico.`;
          }
        } else {
          // Achou (ou reusou) obras: a IA redige com o contexto da conversa.
          obrasParaGuardar = encontradas;
          try {
            texto = await redigirResposta(pergunta, encontradas, interpretacao.detalhe, historico);
          } catch (e) {
            console.error("IA de redacao falhou, usando formatador local:", e.message);
            texto = montarRespostaLocal(encontradas, interpretacao.detalhe);
          }
        }
      }
    }
  } catch (e) {
    console.error("Falha no processamento:", e);
    texto =
      "Tivemos um problema momentaneo ao consultar as obras. Tente novamente em instantes.";
  }

  if (!texto) return; // seguranca: nada a enviar

  // Atualiza a memoria: acrescenta esta troca ao historico e guarda as obras
  // em pauta, para a IA lembrar na proxima mensagem desta pessoa.
  const novoHistorico = [
    ...historico,
    { role: "user", content: pergunta },
    { role: "assistant", content: texto },
  ];
  salvarMemoria(de, { historico: novoHistorico, obras: obrasParaGuardar });

  await enviarTexto(de, texto);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});