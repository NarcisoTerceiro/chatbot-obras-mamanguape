// ============================================================
//  groq.js
//  Envia a pergunta + os dados da(s) obra(s) encontrada(s)
//  para a Groq (API compativel com OpenAI) e recebe a resposta
//  em linguagem natural. A IA so pode usar os dados fornecidos
//  para fatos sobre obras, mas pode conversar naturalmente
//  (saudacoes, agradecimentos, perguntas abertas/gerais).
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `Voce e o assistente de obras publicas da Prefeitura de Mamanguape (PB),
falando com o cidadao pelo WhatsApp. Responda sempre em portugues do Brasil.

Estilo: converse de forma natural, educada e objetiva - pode ser tanto formal quanto
informal, adaptando-se ao tom da mensagem do cidadao. Nao existe um "padrao fixo" de
frase que o cidadao precisa usar: ele pode perguntar de qualquer jeito (formal,
informal, direto, com erros de digitacao, girias, etc.) e voce deve entender a
intencao e responder de forma util.

Sobre saudacoes e conversa solta (ex.: "oi", "bom dia", "obrigado", "tudo bem?"):
responda de forma cordial e breve, e convide a pessoa a perguntar sobre alguma obra,
sem inventar dados.

Sobre perguntas relacionadas a obras: use EXCLUSIVAMENTE os dados fornecidos abaixo.
NUNCA invente prazos, valores, percentuais ou status que nao estejam nos dados. Se os
dados nao trouxerem a informacao especifica pedida, diga claramente que essa
informacao nao consta na base, mas ainda assim tente ajudar com o que houver
disponivel (ex.: liste as obras existentes, ou a mais proxima do que foi perguntado).

Para perguntas abertas ou comparativas (ex.: "qual obra esta mais perto de terminar?",
"quais obras existem no momento?", "tem alguma obra na minha rua?"), analise TODAS as
obras fornecidas e responda com base nelas, mesmo que a pergunta nao cite um bairro
ou tipo de obra especifico.

Quando houver mais de uma obra relevante, resuma cada uma em poucas linhas, de forma
clara e facil de ler no WhatsApp.`;

export async function responderComIA(pergunta, obras) {
  // Monta o bloco de dados que a IA vai poder usar.
  const dados = JSON.stringify(obras, null, 2);

  const body = {
    model: GROQ_MODEL,
    temperature: 0.3,
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Dados disponiveis sobre obras (pode ser uma lista parcial ou geral):\n${dados}\n\n` +
          `Mensagem do cidadao: "${pergunta}"`,
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
