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

  const MAX_TENTATIVAS = 3;
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const controle = new AbortController();
    const timeout = setTimeout(() => controle.abort(), 15000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: controle.signal,
      });

      if (resp.ok) return await resp.json().catch(() => ({ ok: true }));

      const erro = await resp.text();
      const e = new Error(`WhatsApp respondeu ${resp.status}: ${erro.slice(0, 300)}`);
      e.status = resp.status;
      ultimoErro = e;

      // So repete erros temporarios. Erros 4xx de autenticacao/destinatario
      // precisam de correcao, nao de novas tentativas.
      const temporario = resp.status === 429 || resp.status >= 500;
      if (!temporario || tentativa === MAX_TENTATIVAS) throw e;
    } catch (e) {
      ultimoErro = e;
      const temporario = e.name === "AbortError" || e.status === 429 || e.status >= 500;
      if (!temporario || tentativa === MAX_TENTATIVAS) throw e;
    } finally {
      clearTimeout(timeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 500 * tentativa));
  }

  throw ultimoErro || new Error("Falha desconhecida ao enviar mensagem pelo WhatsApp");
}
