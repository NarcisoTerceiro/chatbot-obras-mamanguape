// ============================================================
//  groq.js
//  A IA (Groq) CONDUZ a conversa e tem MEMORIA: em cada chamada
//  recebe o historico recente do cidadao, entao entende referencias
//  e perguntas de acompanhamento ("e o prazo?", "quanto custou?").
//
//  Duas funcoes:
//
//  1) interpretarPergunta(pergunta, historico): ENTENDE o pedido
//     (informal, girias, erros) e devolve tipo + termos de busca +
//     nivel de detalhe + (se for o caso) a operacao de AGREGACAO.
//     Com isso o SISTEMA busca / calcula.
//
//  2) redigirResposta(pergunta, obras, detalhe, historico, fatos):
//     depois que o SISTEMA achou as obras (e, em agregacoes, ja fez
//     a conta), a IA recebe SOMENTE esses dados e REDIGE a resposta
//     final, conectada com o que ja foi dito.
//
//  A IA NUNCA acessa a planilha, NUNCA faz conta e NUNCA inventa
//  dado. Quem busca e calcula e sempre o sistema.
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Da pra usar um modelo diferente pra redacao, se quiser. Por padrao usa o mesmo.
const GROQ_MODEL_RESPOSTA = process.env.GROQ_MODEL_RESPOSTA || GROQ_MODEL;

// Contato para escalar quando o bot nao resolve (opcional, via .env).
const CONTATO_SECRETARIA = process.env.CONTATO_SECRETARIA || "";

// Quantas mensagens do historico enviar (ida + volta = 2). 6 = ~3 trocas.
const MAX_HISTORICO_ENVIO = 6;
// Corta cada mensagem antiga pra nao estourar tokens.
const MAX_CHARS_HISTORICO = 500;

// Operacoes de agregacao que o SISTEMA sabe executar (agregacao.js).
const OPERACOES_VALIDAS = new Set([
  "maior_valor",
  "menor_valor",
  "soma_valor",
  "contar_por_status",
  "contar_total",
]);

// ------------------------------------------------------------
//  Funcao auxiliar generica pra chamar a API do Groq.
// ------------------------------------------------------------
// IMPORTANTE: o modelo openai/gpt-oss-120b e um modelo de RACIOCINIO. Os
// tokens que ele gasta "pensando" contam dentro do limite de geracao. Se o
// limite for baixo demais, o raciocinio consome tudo e a resposta volta VAZIA
// (erro 400 json_validate_failed). Por isso usamos max_completion_tokens
// folgado e reasoning_effort "low" na etapa de interpretacao.
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

// Normaliza o historico em mensagens que a API entende.
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

Voce recebe o HISTORICO recente da conversa seguido da mensagem atual. USE o
historico para resolver referencias: se a pessoa disser "e o prazo?", "quanto
custou?", "e a empresa?" ou "essa mesma", ela fala da MESMA obra ja tratada -
gere termos coerentes com esse contexto (repetindo o nome/bairro da obra que
estava em pauta).

Classifique a mensagem em um destes TIPOS:

- "saudacao": cumprimento, agradecimento ou despedida sem pedido de informacao
  (ex: "oi", "bom dia", "obrigado", "valeu", "tchau").
- "listagem": pedido generico da lista de obras (ex: "quais obras existem",
  "me mostra as obras", "o que ta sendo feito na cidade").
- "agregacao": pergunta que exige CONTA ou COMPARACAO sobre o conjunto de obras
  (ex: "qual a obra mais cara?", "quantas obras estao paralisadas?", "quanto
  foi gasto no total?", "quantas obras tem?").
- "busca": qualquer pergunta sobre uma obra ou grupo de obras especifico
  (por bairro, rua, tipo, nome, empresa).

Quando o tipo for "agregacao", escolha a "operacao":
- "maior_valor"  -> obra mais cara / de maior valor
- "menor_valor"  -> obra mais barata / de menor valor
- "soma_valor"   -> total investido / quanto foi gasto somando
- "contar_por_status" -> quantas obras estao em determinada situacao. Nesse caso
  preencha "filtro_status" com o status citado (ex: "paralisada", "concluida",
  "em andamento"). Se a pessoa pedir a contagem geral por situacao, deixe
  "filtro_status" vazio.
- "contar_total" -> quantas obras existem no total
Se a agregacao for limitada a um recorte (ex: "obra mais cara do Centro"),
coloque esse recorte em "termos" (ex: ["centro"]).

Para "busca" e "agregacao" com recorte, extraia em "termos" as palavras que
realmente identificam a obra (bairro, rua, tipo, nome, empresa), normalizando
girias e sinonimos para o vocabulario de obras publicas:
"asfalto"/"asfaltamento" -> "pavimentacao"; "colegio" -> "escola";
"postinho"/"posto" -> "UBS" ou "posto de saude"; "pracinha" -> "praca";
"quadra" -> "quadra poliesportiva"; "creche" -> "creche".
NAO coloque em "termos" palavras genericas como "obra", "valor", "prazo",
"situacao" - elas nao ajudam a localizar a obra.
NAO coloque o nome da cidade ("Mamanguape") sozinho como termo: quase toda obra
fica em Mamanguape, entao isso nao distingue nada. Use o NOME/tipo da obra e o
BAIRRO especifico. Ex.: em "praca de lazer em Nova Mamanguape", os termos uteis
sao "praca de lazer" e "nova" (o bairro Nova Mamanguape) - nao "mamanguape".
Se a mensagem for vaga demais e nao houver contexto ("e aquela obra ali?"),
devolva "termos" como lista vazia - o sistema vai pedir mais detalhes.

Decida o NIVEL DE DETALHE:
- "resumido": pede so nomes ou uma lista rapida, sem detalhes especificos.
- "completo": pede detalhes especificos (valor, empresa, status, prazo,
  engenheiro, percentual executado) ou pergunta sobre uma obra so.

Responda SOMENTE com um JSON valido, sem texto antes ou depois:
{"tipo":"busca"|"saudacao"|"listagem"|"agregacao","termos":["termo1"],"detalhe":"resumido"|"completo","operacao":"","filtro_status":""}

Deixe "operacao" e "filtro_status" como string vazia quando o tipo nao for
"agregacao".

Exemplos:
"bom dia" -> {"tipo":"saudacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":""}
"quais obras tem?" -> {"tipo":"listagem","termos":[],"detalhe":"resumido","operacao":"","filtro_status":""}
"quanto custou o asfalto do centro?" -> {"tipo":"busca","termos":["pavimentacao","centro"],"detalhe":"completo","operacao":"","filtro_status":""}
"qual a obra mais cara?" -> {"tipo":"agregacao","termos":[],"detalhe":"completo","operacao":"maior_valor","filtro_status":""}
"quantas estao paradas?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"contar_por_status","filtro_status":"paralisada"}`;

export async function interpretarPergunta(pergunta, historico = []) {
  const mensagens = [
    { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
    ...prepararHistorico(historico),
    { role: "user", content: pergunta },
  ];

  const base = {
    model: GROQ_MODEL,
    temperature: 0,
    // Orcamento generoso: cobre o raciocinio do modelo + o JSON final.
    max_completion_tokens: 1024,
    // Menos raciocinio = menos token gasto e menos risco de estourar.
    reasoning_effort: "low",
    messages: mensagens,
  };

  let texto = "";
  try {
    // Tentativa 1: modo JSON nativo (mais confiavel quando funciona).
    texto = await chamarGroq({ ...base, response_format: { type: "json_object" } });
  } catch (e) {
    // Se o modelo estourar o orcamento no modo JSON, ele devolve 400 com
    // geracao vazia. Tentamos de novo SEM o modo JSON: o prompt ja pede JSON
    // puro, e o parser abaixo limpa eventuais cercas de markdown.
    console.error("Interpretacao em modo JSON falhou, tentando sem:", e.message);
    texto = await chamarGroq(base);
  }

  // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
  console.log("DEBUG resposta crua da IA (interpretar):", JSON.stringify(texto));

  try {
    // Pega o primeiro objeto JSON que aparecer, mesmo com texto em volta.
    const bruto = (texto || "").replace(/```json|```/g, "").trim();
    const inicio = bruto.indexOf("{");
    const fim = bruto.lastIndexOf("}");
    const limpo = inicio >= 0 && fim > inicio ? bruto.slice(inicio, fim + 1) : "{}";
    const it = JSON.parse(limpo);

    const tiposValidos = ["busca", "saudacao", "listagem", "agregacao"];
    const tipo = tiposValidos.includes(it.tipo) ? it.tipo : "busca";

    // Valida a operacao: se a IA inventar uma que o sistema nao executa,
    // tratamos como busca comum (nunca deixamos a IA fazer conta).
    let operacao = typeof it.operacao === "string" ? it.operacao.trim() : "";
    if (!OPERACOES_VALIDAS.has(operacao)) operacao = "";

    return {
      tipo: tipo === "agregacao" && !operacao ? "busca" : tipo,
      termos: Array.isArray(it.termos)
        ? it.termos.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
        : [],
      detalhe: it.detalhe === "resumido" ? "resumido" : "completo",
      operacao,
      filtro_status: typeof it.filtro_status === "string" ? it.filtro_status.trim() : "",
      falhou: false,
    };
  } catch {
    // Sem JSON valido -> busca com a frase crua (o sistema ainda tenta buscar).
    return {
      tipo: "busca",
      termos: [],
      detalhe: "completo",
      operacao: "",
      filtro_status: "",
      falhou: true,
    };
  }
}

// ============================================================
//  PARTE 2 - REDACAO DA RESPOSTA FINAL (com memoria da conversa)
// ============================================================

const SYSTEM_PROMPT_RESPOSTA = `Voce e o assistente de obras publicas da Prefeitura de
Mamanguape, atendendo cidadaos pelo WhatsApp. Voce conduz a conversa de forma
natural e lembra do que ja foi dito (recebe o historico recente).

Na mensagem atual voce recebe um JSON com:
- "pergunta": o que o cidadao escreveu (pode ser informal).
- "detalhe": "resumido" ou "completo".
- "obras": as obras que o SISTEMA ja encontrou na planilha. Pode vir vazia.
- "fatos": (opcional) um resultado JA CALCULADO pelo sistema.

REGRAS QUE NAO PODEM SER QUEBRADAS

1) So use informacao que esteja em "obras" ou "fatos". Nunca invente, estime,
   arredonde ou complete dado. Se a pessoa pediu algo (valor, prazo, empresa,
   data) e o campo nao existe, diga com clareza que essa informacao nao consta
   na base - e diga o que voce TEM sobre aquela obra.

2) Se vier "fatos", esse texto e o resultado oficial do calculo do sistema.
   Reproduza os numeros dele exatamente. NUNCA refaca a conta nem some,
   compare ou ordene valores por conta propria.

3) Nunca diga que voce e uma IA, nem cite "os dados fornecidos", "a planilha",
   "o sistema" ou "o JSON". Fale como a propria prefeitura falaria.

COMO CONVERSAR

4) Responda exatamente o que foi pedido e nada mais. Se perguntaram so o valor,
   informe so o valor (citando o nome da obra) - nao despeje todos os campos.
   Exemplos:
   - "quanto custou?" -> "A obra X esta orcada em R$ ...".
   - "ta pronta?" -> informe o status em uma frase.
   - "me fala tudo dela" -> ai sim apresente os campos relevantes, organizados.

5) Se a mensagem tiver mais de uma pergunta, responda as duas, em frases
   separadas.

6) Seja curto. WhatsApp pede respostas enxutas: por padrao, poucas linhas.
   Detalhe so quando "detalhe" for "completo" ou a pessoa pedir.

7) Termine oferecendo o proximo passo natural, quando fizer sentido - uma linha
   curta, sem insistir. Ex.: "Quer saber o prazo ou a empresa responsavel?".

8) Espelhe o jeito da pessoa com gentileza: se ela falou "postinho", responda
   citando o nome oficial de forma natural ("a UBS do bairro X"), sem corrigir
   nem dar licao.

9) Se aparecer termo tecnico (licitacao, empenho, medicao), explique em poucas
   palavras, em linguagem simples.

10) Se "obras" e "fatos" vierem vazios, nao invente nada: peca a pista que
    falta (bairro, rua ou nome da obra) em uma frase curta e cordial.

FORMATO
- Portugues do Brasil, tom cordial e direto.
- WhatsApp: *asteriscos* para negrito, quebras de linha simples. Sem tabelas,
  sem titulos com #, no maximo um emoji sutil.
- Nao repita a pergunta antes de responder.

Responda apenas com o texto final da mensagem, sem JSON e sem aspas ao redor.`;

// Limpa as obras antes de mandar pra IA: tira o campo interno "_aba", remove
// campos vazios e corta textos muito longos.
function prepararObrasParaIA(obras) {
  return (obras || []).map((obra) => {
    const limpa = {};
    for (const [chave, valor] of Object.entries(obra)) {
      if (chave === "_aba" || valor == null || valor === "") continue;
      const texto = valor.toString();
      limpa[chave] = texto.length > 300 ? texto.slice(0, 300) + "…" : texto;
    }
    return limpa;
  });
}

export async function redigirResposta(pergunta, obras, detalhe, historico = [], fatos = "") {
  const obrasLimpo = prepararObrasParaIA(obras);

  const carga = {
    pergunta,
    detalhe: detalhe === "resumido" ? "resumido" : "completo",
    obras: obrasLimpo,
  };
  if (fatos) carga.fatos = fatos;
  if (CONTATO_SECRETARIA) carga.contato_para_duvidas = CONTATO_SECRETARIA;

  const texto = await chamarGroq({
    model: GROQ_MODEL_RESPOSTA,
    temperature: 0.2,
    // Cobre o raciocinio do modelo + o texto final da mensagem.
    max_completion_tokens: 2048,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_RESPOSTA },
      ...prepararHistorico(historico),
      { role: "user", content: JSON.stringify(carga) },
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
