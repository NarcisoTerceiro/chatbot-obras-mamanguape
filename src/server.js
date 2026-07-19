// ============================================================
//  server.js  -  ponto de entrada do chatbot
//
//  Fluxo:
//  WhatsApp -> Webhook (aqui)
//           -> IA (Groq) SO INTERPRETA a pergunta e extrai termos
//           -> Sistema (search.js) busca na planilha (Google Sheets)
//           -> Sistema MONTA a resposta com os dados encontrados
//           -> WhatsApp Cloud API envia ao cidadao
//
//  A IA nunca acessa a planilha nem redige a resposta final -
//  ela so ajuda a entender o que o cidadao quis dizer, mesmo de
//  forma informal, com girias ou erros de digitacao. Quem busca
//  e quem informa o cidadao e sempre o sistema.
// ============================================================

import "dotenv/config";
import express from "express";

import { getObras } from "./sheets.js";
import { buscarObrasPorTermos, buscarObras } from "./search.js";
import { interpretarPergunta } from "./groq.js";
import { enviarTexto } from "./whatsapp.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Quantas obras mostrar no maximo numa unica resposta (WhatsApp fica ilegivel
// se vier informacao demais de uma vez).
const LIMITE_RESULTADOS = 5;

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
//  Formatacao: o SISTEMA monta o texto da resposta (sem IA),
//  usando exatamente as colunas que existirem na planilha.
// ------------------------------------------------------------
function formatarObra(obra) {
  const linhas = [];
  for (const [chave, valor] of Object.entries(obra)) {
    if (chave === "_aba" || !valor) continue;
    linhas.push(`• *${chave}*: ${valor}`);
  }
  return linhas.join("\n");
}

function formatarLista(obras) {
  return obras.map((o, i) => `${i + 1}) ${formatarObra(o)}`).join("\n\n");
}

// ------------------------------------------------------------
//  Orquestracao principal
// ------------------------------------------------------------
async function processarWebhook(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const mensagem = value?.messages?.[0];

  if (!mensagem || mensagem.type !== "text") return;

  const de = mensagem.from;
  const pergunta = mensagem.text.body;
  console.log(`Pergunta de ${de}: ${pergunta}`);

  try {
    // Passo A: le a planilha (com cache).
    const obras = await getObras();

    if (obras.length === 0) {
      await enviarTexto(
        de,
        "No momento nao encontrei nenhuma obra cadastrada na base. Tente novamente mais tarde."
      );
      return;
    }

    // Passo B: a IA so INTERPRETA a pergunta (entende girias, informalidade,
    // erros de digitacao) e devolve o tipo da mensagem + termos de busca.
    // Se a IA falhar (ex.: limite atingido), o sistema cai para uma busca
    // direta pelo texto cru, sem travar o atendimento.
    let interpretacao;
    try {
      interpretacao = await interpretarPergunta(pergunta);
    } catch (e) {
      console.error("IA de interpretacao falhou, usando busca direta:", e.message);
      interpretacao = { tipo: "busca", termos: [] };
    }

    // Passo C: saudacao / conversa solta - resposta fixa do sistema, sem buscar.
    if (interpretacao.tipo === "saudacao") {
      await enviarTexto(
        de,
        "Olá! Eu sou o assistente de obras públicas da Prefeitura de Mamanguape. " +
          "Pode perguntar sobre qualquer obra (ex.: bairro, rua, tipo de obra ou nome da obra)."
      );
      return;
    }

    // Passo D: listagem geral - o sistema lista as obras direto, sem IA.
    if (interpretacao.tipo === "listagem") {
      const lista = obras.slice(0, LIMITE_RESULTADOS);
      const texto =
        `Temos ${obras.length} obra(s) cadastrada(s). Aqui estão as primeiras:\n\n` +
        formatarLista(lista) +
        (obras.length > LIMITE_RESULTADOS
          ? `\n\n...e mais ${obras.length - LIMITE_RESULTADOS}. Pergunte por bairro, rua ou tipo para ver mais detalhes.`
          : "");
      await enviarTexto(de, texto);
      return;
    }

    // Passo E: busca especifica - usa os termos da IA; se vier vazio, cai
    // para a busca direta pelo texto cru da pergunta (respaldo).
    let encontradas = buscarObrasPorTermos(interpretacao.termos, obras, LIMITE_RESULTADOS);
    if (encontradas.length === 0) {
      encontradas = buscarObras(pergunta, obras, LIMITE_RESULTADOS);
    }

    if (encontradas.length === 0) {
      await enviarTexto(
        de,
        "Não encontrei nenhuma obra correspondente. Tente citar o bairro, " +
          "a rua ou o tipo da obra (ex.: pavimentação, praça, escola)."
      );
      return;
    }

    // Passo F: o SISTEMA monta e envia a resposta com os dados encontrados.
    const texto =
      encontradas.length === 1
        ? formatarObra(encontradas[0])
        : `Encontrei ${encontradas.length} obra(s):\n\n` + formatarLista(encontradas);

    await enviarTexto(de, texto);
  } catch (e) {
    console.error("Falha no processamento:", e);
    await enviarTexto(
      de,
      "Tivemos um problema momentâneo ao consultar as obras. Tente novamente em instantes."
    );
  }
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
