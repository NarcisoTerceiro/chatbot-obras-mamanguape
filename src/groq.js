// ============================================================
//  groq.js  (modulo de IA do chatbot)
//
//  ESTRATEGIA DE PROVEDORES (com fallback automatico):
//    1. GEMINI (principal) - API do Google AI Studio. Gratis e de boa
//       qualidade. Usado primeiro em toda pergunta.
//    2. GROQ (reserva) - assume automaticamente quando o Gemini bate o
//       limite de cota (429) ou falha. O cidadao nao percebe a troca.
//
//  Quando um provedor bate o limite, ele fica de "descanso" por alguns
//  minutos: o sistema pula ele e usa o outro como principal, sem perder
//  tempo tentando o que esta bloqueado. Depois do descanso, volta a tentar.
//
//  Configuracao (variaveis de ambiente no Render / .env):
//    GEMINI_API_KEY -> chave do Google AI Studio (aistudio.google.com/apikey)
//    GEMINI_MODEL   -> opcional (padrao: gemini-flash-latest)
//    GROQ_API_KEY   -> chave do Groq (console.groq.com/keys)
//    GROQ_MODEL     -> opcional (padrao: openai/gpt-oss-120b)
// ============================================================

// --- Provedor 1: Gemini (principal) ---
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

// --- Provedor 2: Groq (reserva) ---
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Lista de provedores, na ordem de tentativa. Se um falhar ou bater limite,
// o sistema passa para o proximo automaticamente.
const PROVEDORES = [];

if (GEMINI_KEY) {
  PROVEDORES.push({ nome: "gemini", url: GEMINI_URL, key: GEMINI_KEY, model: GEMINI_MODEL });
}

if (GROQ_KEY) {
  PROVEDORES.push({ nome: "groq", url: GROQ_URL, key: GROQ_KEY, model: GROQ_MODEL });
}

if (PROVEDORES.length === 0) {
  console.warn(
    "AVISO: Nenhum provedor de IA configurado. Defina GEMINI_API_KEY e/ou GROQ_API_KEY no .env."
  );
}

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
  "media_valor",
  "contar_por_status",
  "contar_total",
]);

// ------------------------------------------------------------
//  Funcao auxiliar generica pra chamar a IA.
// ------------------------------------------------------------
// Tenta cada provedor na ordem: Gemini (principal) -> Groq (reserva).
// O "body" NAO deve conter "model": ele e definido aqui conforme o provedor.
// Quando um provedor bate o limite (429) ou falha, entra de "descanso" por
// 5 minutos: o sistema pula ele e usa o proximo direto - sem tentar de novo
// a cada mensagem. Apos o descanso, volta a tentar normalmente.
const DESCANSO_MS = 5 * 60 * 1000; // 5 minutos
const provedorDescansando = new Map(); // nome -> timestamp de quando pode voltar

async function chamarIA(body) {
  if (PROVEDORES.length === 0) {
    throw new Error("Nenhuma chave de IA configurada (GEMINI_API_KEY ou GROQ_API_KEY).");
  }

  let ultimoErro = null;
  const agora = Date.now();

  for (const prov of PROVEDORES) {
    // Pula provedores em descanso (bateram limite recentemente).
    const voltaEm = provedorDescansando.get(prov.nome);
    if (voltaEm && agora < voltaEm) {
      console.log(
        `DEBUG ${prov.nome} em descanso ainda por ${Math.ceil((voltaEm - agora) / 1000)}s - pulando`
      );
      continue;
    }

    try {
      const resp = await fetch(prov.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${prov.key}`,
        },
        body: JSON.stringify({ ...body, model: prov.model }),
      });

      if (!resp.ok) {
        const erro = await resp.text();
        const err = new Error(`${prov.nome} respondeu ${resp.status}: ${erro.slice(0, 300)}`);
        err.status = resp.status;
        throw err;
      }

      const data = await resp.json();
      const texto = data.choices?.[0]?.message?.content?.trim() || "";
      if (!texto) throw new Error(`${prov.nome} devolveu resposta vazia`);
      // Respondeu com sucesso: se estava de descanso, tira do descanso.
      provedorDescansando.delete(prov.nome);
      console.log(`DEBUG IA usada: ${prov.nome} (modelo ${prov.model})`);
      return texto;
    } catch (e) {
      console.error(`IA (${prov.nome}) falhou:`, e.message);
      ultimoErro = e;
      // 429 = limite de cota: poe esse provedor de descanso, evitando
      // tentar ele de novo nas proximas mensagens ate o tempo passar.
      if (e.status === 429) {
        provedorDescansando.set(prov.nome, Date.now() + DESCANSO_MS);
        console.log(`DEBUG ${prov.nome} atingiu limite - descansando ${DESCANSO_MS / 60000} min`);
      }
      // tenta o proximo provedor da lista
    }
  }

  throw ultimoErro || new Error("Todos os provedores de IA falharam.");
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

const SYSTEM_PROMPT_INTERPRETAR = `Voce interpreta a pergunta de um cidadao sobre obras
publicas de uma prefeitura (WhatsApp, linguagem informal, com girias e erros de
digitacao) e devolve um JSON dizendo o que o sistema deve fazer.

Voce recebe o historico recente + a mensagem atual. Use o historico para entender
referencias ("e o prazo?", "quanto custou?" = a mesma obra ja tratada).

Responda SEMPRE com um unico JSON valido, neste formato:
{"tipo":"...","termos":[...],"detalhe":"resumido"|"completo","operacao":"","filtro_status":"","pista_valor":"","receita":null,"usar_contexto":false}

TIPO (escolha um):
- "saudacao": so cumprimento/agradecimento/despedida, sem pedido de info ("oi", "obrigado", "tchau").
- "listagem": pedido generico da lista de obras ("quais obras existem", "o que esta sendo feito").
- "agregacao": exige conta ou comparacao ("mais cara", "quantas paralisadas", "total gasto", "media", "segunda maior", "top 3", "quantas por bairro").
- "engenheiro": listar obras de um responsavel ("obras do engenheiro Carlos"). Em "termos", so o nome da pessoa.
- "busca": qualquer pergunta sobre uma obra ou grupo especifico (bairro, rua, tipo, nome, empresa).

TERMOS: palavras que DISTINGUEM a obra (bairro, tipo, nome). Nunca palavras vazias nem o nome da cidade.

DETALHE: "resumido" para perguntas diretas; "completo" quando a pessoa quer tudo sobre a obra.

USAR_CONTEXTO: coloque true quando a pergunta se refere ao resultado que voce acabou de
mostrar ("liste essas com o engenheiro", "quantas dessas estao paradas", "e o valor de cada uma").
Nesse caso NAO repita os filtros anteriores - o sistema aplica sobre as obras ja mostradas.
Se for um assunto novo, deixe false.

AGREGACAO - quando tipo="agregacao", preencha a "receita" descrevendo o calculo:
  "receita": { "filtros": [ {"campo":"BAIRRO","operador":"igual","valor":"Centro"} ],
               "agregacao": {"tipo":"somar","campo":"VALOR TOTAL DA OBRA"} }
- Operadores: igual, diferente, contem, maior_que, menor_que, entre.
- Tipos de agregacao:
  - "somar" / "media" / "contar": soma, media ou contagem (use "campo" para somar/mediar valor).
  - "maior" / "menor": a obra de maior/menor valor.
  - "top": as N obras de maior valor em dinheiro. Use "n":3. Para menores, "menores".
  - "ordinal": a N-esima por valor. Use "posicao":2 (segunda), 3 (terceira).
  - "listar" com "campo": mostra esse campo de cada obra ("engenheiro de cada obra" -> campo "ENGENHEIRO").
  - "contar_por" com "campo": quantas por grupo ("quantas por bairro" -> campo "BAIRRO").
    Para "quem tem mais/menos" de um campo de texto (engenheiro/bairro/empresa), use
    "contar_por" com "top":1 (mais) ou "top":1,"ordem":"asc" (menos).
Colunas reais: BAIRRO, STATUS, EMPRESA, ENGENHEIRO, VALOR TOTAL DA OBRA, OBJETO DA OBRA.

Deixe "operacao", "filtro_status" e "pista_valor" como "" (o sistema usa a receita).

EXEMPLOS:
"oi" -> {"tipo":"saudacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":null,"usar_contexto":false}
"obras no centro" -> {"tipo":"busca","termos":["centro"],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":null,"usar_contexto":false}
"qual a obra mais cara?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[],"agregacao":{"tipo":"maior","campo":"VALOR TOTAL DA OBRA"}},"usar_contexto":false}
"segunda obra mais cara?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[],"agregacao":{"tipo":"ordinal","posicao":2,"campo":"VALOR TOTAL DA OBRA"}},"usar_contexto":false}
"quanto foi investido no centro?" -> {"tipo":"agregacao","termos":["centro"],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[{"campo":"BAIRRO","operador":"igual","valor":"Centro"}],"agregacao":{"tipo":"somar","campo":"VALOR TOTAL DA OBRA"}},"usar_contexto":false}
"quantas obras por bairro" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"BAIRRO"}},"usar_contexto":false}
"obras do engenheiro Carlos" -> {"tipo":"engenheiro","termos":["Carlos"],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":null,"usar_contexto":false}
"liste essas com o engenheiro" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[],"agregacao":{"tipo":"listar","campo":"ENGENHEIRO"}},"usar_contexto":true}`;

export async function interpretarPergunta(pergunta, historico = []) {
  const mensagens = [
    { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
    ...prepararHistorico(historico),
    { role: "user", content: pergunta },
  ];

  const base = {
    temperature: 0,
    // Orcamento generoso: cobre o raciocinio do modelo + o JSON final.
    // (max_tokens e aceito tanto pelo Gemini quanto pelo Groq.)
    max_tokens: 1024,
    // Menos raciocinio = menos token e menos risco de estourar.
    reasoning_effort: "low",
    messages: mensagens,
  };

  let texto = "";
  try {
    // Tentativa 1: modo JSON nativo (mais confiavel quando funciona).
    texto = await chamarIA({ ...base, response_format: { type: "json_object" } });
  } catch (e) {
    // Se o modelo estourar o orcamento no modo JSON, ele devolve 400 com
    // geracao vazia. Tentamos de novo SEM o modo JSON: o prompt ja pede JSON
    // puro, e o parser abaixo limpa eventuais cercas de markdown.
    console.error("Interpretacao em modo JSON falhou, tentando sem:", e.message);
    texto = await chamarIA(base);
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

    const tiposValidos = ["busca", "saudacao", "listagem", "agregacao", "engenheiro"];
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
      pista_valor: typeof it.pista_valor === "string" ? it.pista_valor.trim() : "",
      receita: it.receita && typeof it.receita === "object" ? it.receita : null,
      // A propria IA ja decidiu, lendo o historico, se a pergunta se refere
      // ao resultado anterior. Isso e mais confiavel que uma lista fixa de
      // pronomes/expressoes no server.js (que sempre fica incompleta).
      usar_contexto: it.usar_contexto === true,
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
      pista_valor: "",
      receita: null,
      usar_contexto: false,
      falhou: true,
    };
  }
}

// ============================================================
//  PARTE 2 - REDACAO DA RESPOSTA FINAL (com memoria da conversa)
// ============================================================

const SYSTEM_PROMPT_RESPOSTA = `Voce e o assistente de obras publicas da Prefeitura de
Mamanguape, atendendo cidadaos pelo WhatsApp.

======================= COMO VOCE DEVE AGIR =======================
Voce interpreta a intencao do usuario e entende exatamente o que ele deseja.
Identifica as informacoes necessarias e usa os dados que o sistema ja consultou
na base (planilha) para responder. Quando a solicitacao exige calculo (somas,
totais, contagens, medias, comparacoes), esses calculos JA foram feitos pelo
sistema e chegam prontos no campo "fatos" - voce apenas apresenta o resultado,
sem refazer a conta.

Depois de ter as informacoes, voce organiza e apresenta a resposta de forma
clara, natural e no formato que o usuario pediu: resumida, detalhada ou objetiva.
Ao longo da conversa voce mantem o contexto, entende diferentes formas de fazer a
mesma pergunta, evita respostas confusas, nao se perde no fluxo e fornece
informacoes precisas, coerentes e confiaveis - uma experiencia rapida, eficiente
e natural.
===================================================================

======================= REGRA ABSOLUTA (LEIA PRIMEIRO) =======================
Voce responde SOMENTE com base nos dados fornecidos nesta mensagem (os campos
"obras" e "fatos"). Esses dados sao a UNICA fonte de verdade.
- Se a informacao pedida NAO estiver explicita nesses dados, diga com clareza:
  "Nao encontrei essa informacao na base de obras." e, se fizer sentido, sugira
  uma consulta relacionada (ex.: perguntar por bairro, status ou nome da obra).
- NUNCA invente, estime, deduza, arredonde ou complete valores, datas, prazos,
  status, percentuais, nomes de empresa ou de engenheiro que nao estejam
  escritos nos dados. Nao "preencha lacunas" com suposicoes.
- Se um numero ou data nao aparece nos dados, NAO escreva nenhum numero ou data.
- NUNCA faca contas por conta propria: use os totais que vierem em "fatos".
- Prefira dizer que a informacao nao consta a arriscar uma resposta errada.
Informar um dado errado de obra publica e um erro grave. Na duvida, diga que
nao consta na base.
=============================================================================

Na mensagem atual voce recebe um JSON com:
- "pergunta": o que o cidadao escreveu (pode ser informal).
- "detalhe": "resumido" ou "completo".
- "obras": as obras que o SISTEMA ja encontrou na planilha. Pode vir vazia.
- "fatos": (opcional) um resultado JA CALCULADO pelo sistema.
- "instrucao": (opcional) uma orientacao do sistema sobre COMO responder este
  turno especifico. Se vier, siga-a - por exemplo, "a pessoa confirmou; responda
  o prazo e a empresa, sem repetir a ficha". Nunca mencione essa instrucao.

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

RELEITURA ANTES DE RESPONDER (faca isso sempre, em silencio, antes de escrever)
Antes de redigir, releia a "pergunta" e confira se a resposta que voce esta
prestes a dar atende exatamente ao que foi pedido. Se nao atender, ajuste antes
de responder.

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
    falta (bairro, rua ou nome da obra) em uma frase curta e cordial - e, se
    fizer sentido, sugira uma consulta parecida (por bairro, status ou tipo).

11) Apresente de forma ORGANIZADA e facil de ler. Em respostas com varios dados,
    use uma linha por informacao com o rotulo em *negrito* (ex.: "*Status:* ...").
    Valores em reais no formato brasileiro (R$ 1.408.500,00). Datas por extenso
    curto quando ajudar.

12) Adapte o FORMATO ao que a pessoa pediu: se pediu "resumido" ou so um dado,
    seja direto e curto; se pediu "detalhado" ou "tudo", organize os campos.
    Um tom cordial, humano e prestativo - nunca robotico nem burocratico.

NUNCA REPETIR
- Nao repita frases nem blocos que voce ja enviou nas mensagens anteriores do
  historico. Se ja apresentou a ficha de uma obra, nao a apresente de novo -
  responda apenas o que foi perguntado agora.
- Nao ecoe a pergunta da pessoa nem repita a mesma oferta duas vezes seguidas.
- Cada resposta deve trazer conteudo NOVO em relacao a sua mensagem anterior.

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

export async function redigirResposta(pergunta, obras, detalhe, historico = [], fatos = "", dica = "") {
  const obrasLimpo = prepararObrasParaIA(obras);

  const carga = {
    pergunta,
    detalhe: detalhe === "resumido" ? "resumido" : "completo",
    obras: obrasLimpo,
  };
  if (fatos) carga.fatos = fatos;
  // "instrucao" e uma orientacao do sistema sobre COMO responder este turno
  // (ex.: a pessoa disse "sim" confirmando uma oferta). Nao e um dado da obra.
  if (dica) carga.instrucao = dica;
  if (CONTATO_SECRETARIA) carga.contato_para_duvidas = CONTATO_SECRETARIA;

  const texto = await chamarIA({
    temperature: 0.2,
    // Cobre o raciocinio do modelo + o texto final da mensagem.
    max_tokens: 2048,
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


// ============================================================
//  PLANO B - CODE EXECUTION DO GEMINI (Opcao B do guia)
//  So e usado quando o DSL generico (Opcao A) nao deu conta.
//  O Gemini escreve e roda Python no SANDBOX ISOLADO do Google
//  (nao no nosso servidor), calcula e devolve a resposta pronta.
//  Requer GEMINI_API_KEY. Enviamos SO as obras ja filtradas por
//  termos, nunca a planilha inteira, para nao estourar tokens.
//
//  NOTA: Code Execution usa o endpoint NATIVO do Gemini (nao o
//  compativel com OpenAI), entao sempre vai direto ao Google -
//  diretamente pela API do Google. Se o Gemini estiver sem cota,
//  esta funcao vai lancar erro e o server.js cai no formatador local.
// ============================================================

const GEMINI_KEY_CE = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_CE = process.env.GEMINI_MODEL || "gemini-flash-latest";

const SYSTEM_PROMPT_CODE_EXEC = `Voce e o assistente de obras publicas da Prefeitura de
Mamanguape. Voce recebe a pergunta do cidadao e uma lista de obras em JSON.
Use a ferramenta de execucao de codigo (Python/pandas) para CALCULAR a resposta
a partir SOMENTE desses dados. Regras:
- Baseie-se apenas nos dados recebidos. Nunca invente valores.
- Valores estao em formato brasileiro (ex.: "1.408.500,00" = 1408500.00).
  Converta corretamente antes de somar/comparar.
- Se os dados nao permitirem responder, diga que a informacao nao consta.
- Responda de forma curta, clara e cordial, em portugues do Brasil, pronta para
  enviar no WhatsApp. Use *asteriscos* para negrito. Nao mostre o codigo.`;

// Retorna o texto final ja redigido, ou lanca erro se nao for possivel.
export async function calcularComCodeExecution(pergunta, obras) {
  if (!GEMINI_KEY_CE) throw new Error("Code Execution requer GEMINI_API_KEY");

  // Limita e enxuga os dados enviados (economia de tokens).
  const dados = prepararObrasParaIA(obras).slice(0, 60);

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${GEMINI_MODEL_CE}:generateContent?key=${GEMINI_KEY_CE}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT_CODE_EXEC }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Pergunta do cidadao: " + pergunta +
              "\n\nObras (JSON):\n" + JSON.stringify(dados),
          },
        ],
      },
    ],
    tools: [{ code_execution: {} }], // ativa o sandbox do Google
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error(`Gemini code_execution ${resp.status}: ${erro.slice(0, 300)}`);
  }

  const data = await resp.json();
  // Junta os pedacos de texto da resposta (ignora blocos de codigo/execucao).
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const texto = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!texto) throw new Error("Code Execution devolveu resposta vazia");
  return texto;
}


// ============================================================
//  GERACAO DE CODIGO PARA O SANDBOX PROPRIO
//  A IA escreve um trecho de Python/pandas que responde a pergunta,
//  terminando na variavel `resultado`. Quem EXECUTA e o microsservico
//  sandbox (isolado) - aqui so pedimos o codigo a IA.
// ============================================================

const SYSTEM_PROMPT_GERAR_CODIGO = `Voce escreve um trecho curto de codigo Python (pandas)
para responder a pergunta do cidadao sobre uma tabela de obras publicas.

CONTEXTO DE EXECUCAO:
- Existe um DataFrame chamado df, ja carregado com as obras (uma linha por obra).
- As colunas sao exatamente as chaves dos objetos recebidos.
- Valores monetarios estao em texto no formato brasileiro (ex.: "1.408.500,00").
  Para calcular, converta: df["X"].str.replace(".","",regex=False)
  .str.replace(",",".",regex=False).astype(float).
- pandas ja esta importado como pd. NAO escreva 'import'.

REGRAS OBRIGATORIAS:
- Seu codigo DEVE terminar definindo a variavel resultado (o valor final).
- NAO use import, open, exec, eval, os, sys, requests, arquivos ou rede.
- Baseie-se SO nas colunas que existem. Se a pergunta nao puder ser respondida
  com os dados, faca resultado = "NAO_TEM_DADO".
- Responda APENAS com o codigo Python. Sem explicacao, sem crases, sem texto.`;

// Pede a IA o codigo Python. Retorna a string de codigo (sem crases).
export async function gerarCodigoPython(pergunta, colunas) {
  const carga = {
    pergunta,
    colunas_disponiveis: colunas,
  };
  const codigo = await chamarIA({
    temperature: 0,
    max_tokens: 800,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_GERAR_CODIGO },
      { role: "user", content: JSON.stringify(carga) },
    ],
  });
  // Remove crases/blocos markdown que a IA as vezes coloca.
  return codigo
    .replace(/```python/gi, "")
    .replace(/```/g, "")
    .trim();
}