// ============================================================
//  groq.js
//  A IA (Groq) tem UMA SO funcao aqui: ENTENDER a pergunta do
//  cidadao (mesmo informal, com girias ou erros de digitacao) e
//  transformar isso em termos de busca reais, que o SISTEMA
//  (search.js) vai usar para procurar na planilha.
//
//  A IA NAO redige a resposta final e NAO recebe os dados da
//  planilha - ela so interpreta a pergunta. Quem busca e quem
//  informa o cidadao e sempre o sistema (server.js + search.js).
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `Voce interpreta perguntas de cidadaos sobre obras publicas
de uma prefeitura, enviadas por WhatsApp de forma informal, formal, com girias,
abreviacoes ou erros de digitacao.

Sua tarefa tem duas partes:

1) Extrair os termos de busca reais que devem ser usados para procurar na
planilha de obras (bairro, rua, tipo de obra, nome de obra, empresa, etc.),
normalizando girias e sinonimos para termos comuns em obras publicas.
Exemplos: "asfalto"/"asfaltamento" -> "pavimentacao"; "colegio" -> "escola";
"postinho"/"posto" -> "UBS" ou "posto de saude"; "pracinha" -> "praca".

2) Decidir o NIVEL DE DETALHE que a pessoa quer na resposta:
- "resumido": quando ela pede so os nomes, uma lista rapida, "quais obras
  tem", "me fala os nomes", ou qualquer pedido que nao peça detalhes
  especificos.
- "completo": quando ela pede detalhes especificos de uma obra (valor,
  empresa, status, prazo, engenheiro responsavel, percentual executado,
  etc.) ou faz uma pergunta especifica sobre uma obra.

Tambem identifique se a mensagem e uma SAUDACAO/conversa solta sem pedido de
informacao (ex: "oi", "bom dia", "obrigado") ou um pedido de LISTAGEM GERAL
(ex: "quais obras existem", "quais obras estao cadastradas", "me mostra as
obras", "me fala os nomes das obras").

Responda SOMENTE com um JSON valido, sem texto antes ou depois, no formato:
{"tipo": "busca" | "saudacao" | "listagem", "termos": ["termo1", "termo2"], "detalhe": "resumido" | "completo"}

Se tipo for "saudacao", "termos" pode ser lista vazia e "detalhe" irrelevante.
Se tipo for "listagem", "termos" normalmente e lista vazia.`;

export async function interpretarPergunta(pergunta) {
  const body = {
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 150,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: pergunta },
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
    const err = new Error(`Groq respondeu ${resp.status}: ${erro}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const texto = data.choices?.[0]?.message?.content?.trim() || "{}";

  // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
  console.log("DEBUG resposta crua da IA:", JSON.stringify(texto));

  try {
    // Remove eventuais cercas de markdown (```json ... ```) se a IA colocar.
    const limpo = texto.replace(/^```json\s*|```$/g, "").trim();
    const interpretado = JSON.parse(limpo);
    return {
      tipo: interpretado.tipo || "busca",
      termos: Array.isArray(interpretado.termos) ? interpretado.termos : [],
      detalhe: interpretado.detalhe === "resumido" ? "resumido" : "completo",
    };
  } catch {
    // Se a IA nao devolver um JSON valido, cai para busca com a frase crua -
    // o sistema ainda tenta buscar direto pelo texto original.
    return { tipo: "busca", termos: [], detalhe: "completo" };
  }
}