// ============================================================
//  server.js  -  ponto de entrada do chatbot
//
//  Fluxo (igual ao item 2 do documento):
//  WhatsApp -> Webhook (aqui) -> Google Sheets (busca) ->
//  Groq (interpreta e responde) -> WhatsApp Cloud API (envia)
// ============================================================

import "dotenv/config";
import express from "express";

import { getObras } from "./sheets.js";
import { buscarObras } from "./search.js";
import { responderComIA } from "./groq.js";
import { enviarTexto } from "./whatsapp.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
    return res.status(200).send(challenge); // devolve o desafio -> confirma
  }
  return res.sendStatus(403); // token errado
});

// ------------------------------------------------------------
//  2) RECEBIMENTO DE MENSAGENS (a Meta manda cada msg via POST)
// ------------------------------------------------------------
app.post("/webhook", (req, res) => {
  // Responde 200 IMEDIATAMENTE. Se demorar, a Meta reenvia a mensagem.
  res.sendStatus(200);

  // Processa em segundo plano (sem travar a resposta).
  processarWebhook(req.body).catch((e) =>
    console.error("Erro ao processar webhook:", e)
  );
});

// ------------------------------------------------------------
//  Orquestracao: extrai a mensagem, busca, chama a IA, responde
// ------------------------------------------------------------
async function processarWebhook(payload) {
  // Extrai a primeira mensagem de texto do formato do WhatsApp.
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const mensagem = value?.messages?.[0];

  // Ignora "status" (recibos de entrega/leitura) e mensagens sem texto.
  if (!mensagem || mensagem.type !== "text") return;

  const de = mensagem.from; // numero do cidadao
  const pergunta = mensagem.text.body;
  console.log(`Pergunta de ${de}: ${pergunta}`);

  try {
    // Passo A: le a planilha (com cache) e busca as obras que combinam.
    const obras = await getObras();
    const encontradas = buscarObras(pergunta, obras);

    // Passo B: se nada bateu, responde de forma simpatica sem gastar IA.
    if (encontradas.length === 0) {
      await enviarTexto(
        de,
        "Nao encontrei nenhuma obra correspondente. Tente citar o bairro, " +
          "a rua ou o tipo da obra (ex.: pavimentacao, praca, escola)."
      );
      return;
    }

    // Passo C: a IA formula a resposta usando SO os dados encontrados.
    const resposta = await responderComIA(pergunta, encontradas);

    // Passo D: envia de volta pelo WhatsApp.
    await enviarTexto(de, resposta || "Nao consegui gerar a resposta agora.");
  } catch (e) {
    console.error("Falha no processamento:", e);
    await enviarTexto(
      de,
      "Tivemos um problema momentaneo ao consultar as obras. Tente novamente em instantes."
    );
  }
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
