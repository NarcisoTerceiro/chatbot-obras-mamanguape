// ============================================================
//  groq.js
//  Envia a pergunta + os dados da(s) obra(s) encontrada(s)
//  para a Groq (API compativel com OpenAI) e recebe a resposta
//  em linguagem natural. A IA so pode usar os dados fornecidos.
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `Voce e o assistente de obras publicas da Prefeitura de Mamanguape (PB).
Responda em portugues do Brasil, de forma curta, clara e educada.
Use EXCLUSIVAMENTE os dados fornecidos sobre a(s) obra(s). NUNCA invente
prazos, valores, percentuais ou status. Se os dados nao trouxerem a
informacao pedida, diga que essa informacao nao consta na base.
Quando houver mais de uma obra, resuma cada uma em poucas linhas.`;

export async function responderComIA(pergunta, obras) {
  // Monta o bloco de dados que a IA vai poder usar (so as obras encontradas).
  const dados = JSON.stringify(obras, null, 2);

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: 500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Dados da(s) obra(s) encontrada(s):\n${dados}\n\n` +
          `Pergunta do cidadao: "${pergunta}"`,
      },
    ],
  };

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Groq respondeu ${resp.status}: ${erro}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}
