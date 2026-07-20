// ============================================================
//  groq.js
//  A IA (Groq) CONDUZ a conversa e agora tem MEMORIA: em cada
//  chamada ela recebe o historico recente do cidadao, entao
//  entende referencias e perguntas de acompanhamento
//  (ex.: "e o prazo?", "quanto custou?") sem repetir o nome da obra.
//
//  Ela tem duas funcoes:
//
//  1) interpretarPergunta(pergunta, historico): ENTENDE o pedido
//     (mesmo informal, com girias/erros), usando o historico para
//     resolver referencias, e devolve tipo + termos de busca +
//     nivel de detalhe. Com isso o SISTEMA (search.js) busca.
//
//  2) redigirResposta(pergunta, obras, detalhe, historico): depois
//     que o SISTEMA achou as obras, a IA recebe SOMENTE esses dados
//     ja filtrados (mais o historico) e REDIGE a resposta final,
//     conectada com o que ja foi dito. Se "obras" vier vazio, ela
//     apenas conversa/sauda de forma cordial, sem inventar obra.
//
//  A IA NUNCA acessa a planilha diretamente e NUNCA inventa dado
//  que nao esteja no que o sistema entregou. Quem busca e sempre
//  o sistema; a IA interpreta, lembra e redige.
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Da pra usar um modelo diferente pra redacao, se quiser. Por padrao usa o mesmo.
const GROQ_MODEL_RESPOSTA = process.env.GROQ_MODEL_RESPOSTA || GROQ_MODEL;

// Quantas mensagens do historico enviar (ida + volta = 2). 6 = ~3 trocas.
const MAX_HISTORICO_ENVIO = 6;
// Corta cada mensagem antiga pra nao estourar tokens (o limite do Groq aperta
// primeiro no token por minuto).
const MAX_CHARS_HISTORICO = 500;

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

// Normaliza o historico recebido do server em mensagens que a API entende,
// cortando tamanho e mantendo so as ultimas trocas.
function prepararHistorico(historico) {
  if (!Array.isArray(historico)) return [];
  return historico
    .slice(-MAX_HISTORICO_ENVIO)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString().slice(0, MAX_CHARS_HISTORICO),
    }))
    .filter((m) => m.content);
}

// ============================================================
//  PARTE 1 - INTERPRETACAO (com memoria da conversa)
// ============================================================

const SYSTEM_PROMPT_INTERPRETAR = `Voce interpreta perguntas de cidadaos sobre obras publicas
de uma prefeitura, enviadas por WhatsApp de forma informal, formal, com girias,
abreviacoes ou erros de digitacao.

Voce recebe o HISTORICO recente da conversa (mensagens anteriores da pessoa e
respostas do bot) seguido da mensagem atual. USE o historico para resolver
referencias: se a pessoa disser "e o prazo?", "quanto custou?", "e a empresa?"
ou "essa mesma", entenda que ela fala da MESMA obra tratada antes e gere termos
coerentes com esse contexto (por exemplo, repetindo o nome/bairro da obra que
ja estava em pauta).

Sua tarefa tem duas partes:

1) Extrair os termos de busca reais para procurar na planilha de obras (bairro,
rua, tipo de obra, nome de obra, empresa, etc.), normalizando girias e sinonimos
para termos comuns em obras publicas.
Exemplos: "asfalto"/"asfaltamento" -> "pavimentacao"; "colegio" -> "escola";
"postinho"/"posto" -> "UBS" ou "posto de saude"; "pracinha" -> "praca".

2) Decidir o NIVEL DE DETALHE que a pessoa quer:
- "resumido": quando pede so os nomes, uma lista rapida, "quais obras tem",
  "me fala os nomes", ou qualquer pedido sem detalhes especificos.
- "completo": quando pede detalhes especificos de uma obra (valor, empresa,
  status, prazo, engenheiro, percentual executado, etc.).

Tambem identifique se a mensagem e uma SAUDACAO/conversa solta sem pedido de
informacao (ex: "oi", "bom dia", "obrigado") ou um pedido de LISTAGEM GERAL
(ex: "quais obras existem", "me mostra as obras").

Responda SOMENTE com um JSON valido, sem texto antes ou depois, no formato:
{"tipo": "busca" | "saudacao" | "listagem", "termos": ["termo1", "termo2"], "detalhe": "resumido" | "completo"}

Se tipo for "saudacao", "termos" pode ser lista vazia e "detalhe" irrelevante.
Se tipo for "listagem", "termos" normalmente e lista vazia.`;

export async function interpretarPergunta(pergunta, historico = []) {
  const texto = await chamarGroq({
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 150,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
      ...prepararHistorico(historico),
      { role: "user", content: pergunta },
    ],
  });

  // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
  console.log("DEBUG resposta crua da IA (interpretar):", JSON.stringify(texto));

  try {
    const limpo = (texto || "{}").replace(/^```json\s*|```$/g, "").trim();
    const interpretado = JSON.parse(limpo);
    return {
      tipo: interpretado.tipo || "busca",
      termos: Array.isArray(interpretado.termos) ? interpretado.termos : [],
      detalhe: interpretado.detalhe === "resumido" ? "resumido" : "completo",
    };
  } catch {
    // Sem JSON valido -> busca com a frase crua (o sistema ainda tenta buscar).
    return { tipo: "busca", termos: [], detalhe: "completo" };
  }
}

// ============================================================
//  PARTE 2 - REDACAO DA RESPOSTA FINAL (com memoria da conversa)
// ============================================================

const SYSTEM_PROMPT_RESPOSTA = `Voce e o assistente de obras publicas da Prefeitura de
Mamanguape, conversando com cidadaos pelo WhatsApp. Voce CONDUZ a conversa de
forma natural e lembra do que ja foi dito (recebe o historico recente).

Voce recebe o historico da conversa e, na mensagem atual, um JSON com:
- "pergunta": a pergunta original do cidadao (pode ser informal).
- "detalhe": "resumido" ou "completo".
- "obras": a lista de obras que o SISTEMA ja encontrou na planilha. Cada obra e
  um objeto com os campos que existem na planilha. Pode vir VAZIA.

Regras obrigatorias:

1) NUNCA invente, estime ou complete informacao que nao esteja em "obras". Se a
   pessoa perguntou algo (valor, prazo, empresa, data, etc.) e esse campo NAO
   existe nos dados, diga com clareza que essa informacao nao consta na base.
   Nao chute e nao arredonde numeros.

2) Se "obras" estiver VAZIA, e uma saudacao ou conversa solta: responda de forma
   curta e cordial, se apresente se fizer sentido e convide a pessoa a perguntar
   sobre uma obra (por bairro, rua, tipo ou nome). Nao invente nenhuma obra.

3) Responda exatamente o que a pessoa pediu, aproveitando o contexto da conversa:
   - Se ela pediu so um dado especifico (preco, data, prazo, empresa, status,
     percentual), responda so esse dado, citando o nome da obra.
   - Se for pergunta de acompanhamento ("e o prazo?"), responda sobre a mesma
     obra que ja estava em pauta.
   - "resumido" -> lista curta (nome + status). "completo" -> campos relevantes
     organizados e legiveis.

4) Formatacao WhatsApp: use *asteriscos* para negrito e quebras de linha simples.
   No maximo um emoji sutil. Nao use tabelas nem titulos com #.

5) Seja claro, direto e cordial. Nao repita a pergunta, nao diga que voce e uma
   IA nem cite "os dados fornecidos". Fale como a propria prefeitura falaria.
   Escreva em portugues do Brasil.

Responda apenas com o texto final da mensagem, sem JSON e sem aspas ao redor.`;

// Limpa as obras antes de mandar pra IA: tira o campo interno "_aba", remove
// campos vazios e corta textos muito longos.
function prepararObrasParaIA(obras) {
  return (obras || []).map((obra) => {
    const limpa = {};
    for (const [chave, valor] of Object.entries(obra)) {
      if (chave === "_aba" || valor == null || valor === "") continue;
      const texto = valor.toString();
      limpa[chave] = texto.length > 300 ? texto.slice(0, 300) + "\u2026" : texto;
    }
    return limpa;
  });
}

export async function redigirResposta(pergunta, obras, detalhe, historico = []) {
  const obrasLimpo = prepararObrasParaIA(obras);

  const texto = await chamarGroq({
    model: GROQ_MODEL_RESPOSTA,
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_RESPOSTA },
      ...prepararHistorico(historico),
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