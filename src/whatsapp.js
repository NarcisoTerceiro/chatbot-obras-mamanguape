// ============================================================
//  whatsapp.js
//  Envia mensagens de texto de volta ao cidadao usando a
//  WhatsApp Cloud API (Meta).
// ============================================================

const VERSION = process.env.GRAPH_API_VERSION || "v22.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

// O WhatsApp recusa mensagens com mais de 4096 caracteres. Cortamos com
// folga de seguranca para nunca estourar, mesmo se o texto vier grande.
const LIMITE_CARACTERES = 4000;

function cortarSeNecessario(texto) {
  if (texto.length <= LIMITE_CARACTERES) return texto;
  return texto.slice(0, LIMITE_CARACTERES) + "\n\n(mensagem resumida — peça mais detalhes se precisar)";
}

// Envia um texto simples para um numero (formato internacional, ex: 5583999998888).
export async function enviarTexto(para, texto) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: para,
    type: "text",
    text: { body: cortarSeNecessario(texto) },
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
