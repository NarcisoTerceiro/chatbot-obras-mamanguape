// ============================================================
//  groq.js
//  A IA (Groq) tem DUAS funcoes neste projeto:
//
//  1) interpretarPergunta(): ENTENDER o pedido do cidadao (mesmo
//     informal, com girias ou erros de digitacao) e transformar
//     isso em termos de busca reais + o tipo/nivel de detalhe.
//     Com isso o SISTEMA (search.js) procura na planilha.
//
//  2) redigirResposta(): depois que o SISTEMA encontrou as obras
//     na planilha, a IA recebe SOMENTE esses dados ja filtrados e
//     REDIGE a resposta final do jeito que o cidadao pediu
//     (resumida, completa, ou so um dado especifico como valor,
//     data, prazo, empresa...).
//
//  Importante: a IA NUNCA acessa a planilha diretamente e NUNCA
//  inventa dado que nao esteja no que o sistema entregou a ela.
//  Quem busca e sempre o sistema; a IA so interpreta e redige.
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Da pra usar um modelo diferente pra redacao, se quiser. Por padrao usa o mesmo.
const GROQ_MODEL_RESPOSTA = process.env.GROQ_MODEL_RESPOSTA || GROQ_MODEL;

// ------------------------------------------------------------
//  Funcao auxiliar generica pra chamar a API do Groq.
// ------------------------------------------------------------
async function chamarGroq(body) {
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
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ============================================================
//  PARTE 1 - INTERPRETACAO
// ============================================================

const SYSTEM_PROMPT_INTERPRETAR = `Voce interpreta perguntas de cidadaos sobre obras publicas
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
  const texto = await chamarGroq({
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 150,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
      { role: "user", content: pergunta },
    ],
  });

  // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
  console.log("DEBUG resposta crua da IA (interpretar):", JSON.stringify(texto));

  try {
    // Remove eventuais cercas de markdown (```json ... ```) se a IA colocar.
    const limpo = (texto || "{}").replace(/^```json\s*|```$/g, "").trim();
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

// ============================================================
//  PARTE 2 - REDACAO DA RESPOSTA FINAL
// ============================================================

const SYSTEM_PROMPT_RESPOSTA = `Voce e o assistente de obras publicas da Prefeitura de
Mamanguape, respondendo cidadaos pelo WhatsApp.

Voce recebe um JSON com tres campos:
- "pergunta": a pergunta original do cidadao (pode ser informal, com girias ou erros).
- "detalhe": "resumido" ou "completo", indicando o nivel de detalhe desejado.
- "obras": a lista de obras que o SISTEMA ja encontrou na planilha da prefeitura.
  Cada obra e um objeto com os campos que existem na planilha.

Sua tarefa e redigir a resposta final para o cidadao usando SOMENTE os dados
presentes em "obras". Regras obrigatorias:

1) NUNCA invente, estime ou complete informacao que nao esteja em "obras". Se o
   cidadao perguntou algo (valor, prazo, empresa, engenheiro, data, etc.) e esse
   campo NAO existe nos dados, diga com clareza que essa informacao nao consta na
   base. Nao chute e nao arredonde numeros.

2) Responda exatamente o que a pessoa pediu:
   - Se ela pediu so um dado especifico (preco, data, horario, prazo, empresa,
     status, percentual executado), responda so esse dado, citando o nome da obra.
   - Se "detalhe" for "resumido", liste as obras de forma curta (nome + status).
   - Se "detalhe" for "completo", apresente os campos relevantes de forma
     organizada e legivel.

3) Formatacao WhatsApp: use *asteriscos* para negrito e quebras de linha simples.
   No maximo um emoji sutil. Nao use tabelas nem titulos com #.

4) Seja claro, direto e cordial. Nao repita a pergunta, nao invente saudacoes
   longas, nao diga que voce e uma IA nem cite "os dados fornecidos". Fale como a
   propria prefeitura falaria.

5) Escreva em portugues do Brasil.

Responda apenas com o texto final da mensagem, sem JSON e sem aspas ao redor.`;

// Limpa as obras antes de mandar pra IA: tira o campo interno "_aba", remove
// campos vazios e corta textos muito longos (economiza tokens e evita estourar
// o limite do modelo).
function prepararObrasParaIA(obras) {
  return obras.map((obra) => {
    const limpa = {};
    for (const [chave, valor] of Object.entries(obra)) {
      if (chave === "_aba" || valor == null || valor === "") continue;
      const texto = valor.toString();
      limpa[chave] = texto.length > 300 ? texto.slice(0, 300) + "…" : texto;
    }
    return limpa;
  });
}

export async function redigirResposta(pergunta, obras, detalhe) {
  const obrasLimpo = prepararObrasParaIA(obras);

  const texto = await chamarGroq({
    model: GROQ_MODEL_RESPOSTA,
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_RESPOSTA },
      {
        role: "user",
        content: JSON.stringify({
          pergunta,
          detalhe: detalhe === "resumido" ? "resumido" : "completo",
          obras: obrasLimpo,
        }),
      },
    ],
  });

  // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
  console.log("DEBUG resposta crua da IA (redigir):", JSON.stringify(texto));

  const final = (texto || "").trim();
  if (!final) {
    // Sem texto valido -> deixa o server.js cair no formatador do sistema.
    throw new Error("IA de redacao retornou vazio");
  }
  return final;
}