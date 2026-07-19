// ============================================================
//  whatsapp.js
//  Envia mensagens de texto de volta ao cidadao usando a
//  WhatsApp Cloud API (Meta).
// ============================================================

const VERSION = process.env.GRAPH_API_VERSION || "v22.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

// Envia um texto simples para um numero (formato internacional, ex: 5583999998888).
export async function enviarTexto(para, texto) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: para,
    type: "text",
    text: { body: texto },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    console.error(`Erro ao enviar WhatsApp (${resp.status}):`, erro);
  }
}
