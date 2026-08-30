// ============================================================
//  groq.js
//  IA do chatbot: SOMENTE Groq + Gemini.
//
//  Estrategia:
//    1) Groq primeiro, usando modelo leve/atual.
//    2) Se o modelo configurado nao existir, tenta outro modelo Groq atual.
//    3) Em 429/erro, cai imediatamente para Gemini.
//    4) Gemini usa a API nativa + x-goog-api-key (mais robusto que a camada
//       OpenAI-compatible para chaves do Google AI Studio).
//
//  Variaveis de ambiente:
//    GROQ_API_KEY
//    GROQ_MODEL       opcional; padrao openai/gpt-oss-20b
//    GEMINI_API_KEY   (tambem aceita GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY)
//    GEMINI_MODEL     opcional; padrao gemini-3.5-flash-lite
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || "").trim();
// 20B primeiro: menor custo/latencia. 120B fica somente como reserva dentro
// do proprio Groq. Se o Render ainda tiver um modelo antigo, ele e tentado
// primeiro; se vier model_not_found/404, o codigo troca sozinho.
const GROQ_MODELOS = [...new Set([
  GROQ_MODEL_ENV,
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
].filter(Boolean))];

const GEMINI_KEY = (
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  ""
).trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();

const PROVEDORES = [];
if (GROQ_KEY) PROVEDORES.push({ nome: "groq" });
if (GEMINI_KEY) PROVEDORES.push({ nome: "gemini" });
if (PROVEDORES.length === 0) {
  console.warn("AVISO: configure GROQ_API_KEY e/ou GEMINI_API_KEY.");
}

// Contato para escalar quando o bot nao resolve (opcional, via .env).
const CONTATO_SECRETARIA = process.env.CONTATO_SECRETARIA || "";

// Mantem contexto pequeno para economizar TPM.
const MAX_HISTORICO_ENVIO = 4;
const MAX_CHARS_HISTORICO = 220;

const OPERACOES_VALIDAS = new Set([
  "maior_valor",
  "menor_valor",
  "soma_valor",
  "media_valor",
  "contar_por_status",
  "contar_total",
]);

const provedorDescansando = new Map();
const DESCANSO_PADRAO_MS = 15 * 1000;
const TIMEOUT_IA_MS = 18 * 1000;
const MAX_SAIDA_GLOBAL = 700;

function limiteSaida(body) {
  const pedido = Number(body.max_completion_tokens ?? body.max_tokens ?? 384);
  return Math.max(48, Math.min(Number.isFinite(pedido) ? pedido : 384, MAX_SAIDA_GLOBAL));
}

function retryDepoisMs(resp, corpoErro = "") {
  const cab = resp.headers?.get?.("retry-after");
  if (cab) {
    const seg = Number(cab);
    if (Number.isFinite(seg) && seg > 0) return Math.min(seg * 1000, 60_000);
  }
  const m = String(corpoErro).match(/try again in\s+([0-9.]+)s/i);
  if (m) return Math.min(Math.ceil(Number(m[1]) * 1000) + 500, 60_000);
  return DESCANSO_PADRAO_MS;
}

async function fetchComTimeout(url, opcoes) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), TIMEOUT_IA_MS);
  try {
    return await fetch(url, { ...opcoes, signal: controlador.signal });
  } finally {
    clearTimeout(timer);
  }
}

const modelosGroqIndisponiveis = new Set();

async function chamarGroq(body) {
  let ultimoErro = null;
  const limite = limiteSaida(body);

  for (const model of GROQ_MODELOS) {
    if (modelosGroqIndisponiveis.has(model)) continue;
    const corpo = { ...body, model };
    delete corpo.max_tokens;
    corpo.max_completion_tokens = limite;
    if (corpo.reasoning_effort && !["low", "medium", "high"].includes(corpo.reasoning_effort)) {
      delete corpo.reasoning_effort;
    }

    const resp = await fetchComTimeout(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify(corpo),
    });

    if (!resp.ok) {
      const erroTxt = await resp.text();
      const ehModeloInexistente = resp.status === 404 || /model_not_found|does not exist|do not have access/i.test(erroTxt);
      if (ehModeloInexistente) {
        modelosGroqIndisponiveis.add(model);
        ultimoErro = new Error(`groq modelo ${model} indisponivel (${resp.status})`);
        ultimoErro.status = resp.status;
        console.warn(`DEBUG Groq: modelo ${model} indisponivel; tentando outro modelo.`);
        continue;
      }
      const err = new Error(`groq respondeu ${resp.status}: ${erroTxt.slice(0, 320)}`);
      err.status = resp.status;
      if (resp.status === 429) err.retryAfterMs = retryDepoisMs(resp, erroTxt);
      throw err;
    }

    const data = await resp.json();
    const texto = data.choices?.[0]?.message?.content?.trim() || "";
    if (!texto) throw new Error(`groq (${model}) devolveu resposta vazia`);
    console.log(`DEBUG IA usada: Groq (principal) | modelo: ${model}`);
    return texto;
  }

  throw ultimoErro || new Error("Nenhum modelo Groq disponivel para esta conta.");
}

function corpoGeminiNativo(body) {
  const mensagens = Array.isArray(body.messages) ? body.messages : [];
  const sistemas = mensagens
    .filter((m) => m?.role === "system")
    .map((m) => String(m.content || ""))
    .filter(Boolean);

  const contents = mensagens
    .filter((m) => m?.role !== "system" && m?.content)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));

  const generationConfig = { maxOutputTokens: limiteSaida(body) };
  if (body.temperature !== undefined && Number.isFinite(Number(body.temperature))) {
    generationConfig.temperature = Number(body.temperature);
  }
  if (body.response_format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }

  const payload = { contents, generationConfig };
  if (sistemas.length) {
    payload.system_instruction = { parts: [{ text: sistemas.join("\n") }] };
  }
  return payload;
}

async function chamarGemini(body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const resp = await fetchComTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY,
    },
    body: JSON.stringify(corpoGeminiNativo(body)),
  });

  if (!resp.ok) {
    const erroTxt = await resp.text();
    const err = new Error(`gemini respondeu ${resp.status}: ${erroTxt.slice(0, 320)}`);
    err.status = resp.status;
    if (resp.status === 429) err.retryAfterMs = retryDepoisMs(resp, erroTxt);
    throw err;
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const texto = parts.map((p) => typeof p?.text === "string" ? p.text : "").join("").trim();
  if (!texto) throw new Error("gemini devolveu resposta vazia");
  console.log(`DEBUG IA usada: Gemini (fallback) | modelo: ${GEMINI_MODEL}`);
  return texto;
}

async function chamarIA(body) {
  if (PROVEDORES.length === 0) {
    throw new Error("Nenhuma chave de IA configurada (GROQ_API_KEY ou GEMINI_API_KEY).");
  }

  const agora = Date.now();
  const ordem = PROVEDORES.filter((p) => (provedorDescansando.get(p.nome) || 0) <= agora);
  if (ordem.length === 0) {
    const proximo = Math.min(...PROVEDORES.map((p) => provedorDescansando.get(p.nome) || agora));
    const erro = new Error(`Provedores temporariamente indisponiveis. Tente novamente em ${Math.max(1, Math.ceil((proximo - agora) / 1000))}s.`);
    erro.status = 429;
    throw erro;
  }

  let ultimoErro = null;
  for (const prov of ordem) {
    try {
      const texto = prov.nome === "groq" ? await chamarGroq(body) : await chamarGemini(body);
      provedorDescansando.delete(prov.nome);
      return texto;
    } catch (e) {
      ultimoErro = e;
      console.error(`IA (${prov.nome}) falhou:`, e.message);

      if (e.status === 429) {
        const pausa = Math.max(5_000, Math.min(e.retryAfterMs || DESCANSO_PADRAO_MS, 60_000));
        provedorDescansando.set(prov.nome, Date.now() + pausa);
        console.log(`DEBUG ${prov.nome} em limite - ignorando por ${Math.ceil(pausa / 1000)}s`);
      } else if (prov.nome === "gemini" && (e.status === 401 || e.status === 403)) {
        // Credencial errada nao melhora tentando a cada mensagem. No proximo deploy
        // (apos corrigir a chave no Render) este estado e zerado automaticamente.
        provedorDescansando.set(prov.nome, Date.now() + 10 * 60 * 1000);
        console.error("DEBUG Gemini: confira GEMINI_API_KEY no Render (chave do Google AI Studio).");
      }
    }
  }

  throw ultimoErro || new Error("Groq e Gemini falharam.");
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

const SYSTEM_PROMPT_INTERPRETAR = `Voce interpreta perguntas de cidadaos sobre obras publicas de uma prefeitura
(WhatsApp, linguagem informal, com girias, abreviacoes e erros de digitacao).
Sua unica tarefa: entender a INTENCAO e devolver um JSON. Voce NAO escreve
resposta ao cidadao - quem faz isso e outra etapa. Voce so classifica.

Entenda o SENTIDO, nao as palavras exatas. "ta pronta a creche?", "a creche ja
acabou?" e "situacao da creche" pedem a mesma coisa.

Use o HISTORICO da conversa para resolver referencias. Se a pergunta claramente
continua o assunto anterior (ex.: "e o valor de cada uma?", "quantas dessas estao
paradas?", "os engenheiros dessas", "cada uma"), marque "usar_contexto":true e
monte so a operacao - o sistema ja aplica sobre as obras que voce mostrou antes.
Se for assunto novo sobre a base inteira, "usar_contexto":false.

TIPOS possiveis:
- "saudacao": so cumprimento/agradecimento, SEM pedido de informacao ("oi", "bom dia", "valeu").
- "listagem": pedido generico da lista de obras, SEM citar bairro/nome/tipo
  especifico ("quais obras existem", "me mostra as obras", "o que ta sendo feito
  na cidade", "quais obras tem", "o que ta rolando de obra", "que obras a
  prefeitura ta tocando"). Se NAO menciona um lugar/obra especifica, e listagem.
- "agregacao": exige CONTA ou COMPARACAO ("mais cara", "quantas concluidas", "total gasto", "quantas por bairro").
- "engenheiro": listar obras de um responsavel especifico ("obras do engenheiro Carlos") - poe SO o nome em "termos". (Se pedir CONTAGEM de obras de alguem, e "agregacao", nao "engenheiro".)
- "busca": qualquer pergunta sobre uma obra/grupo especifico (bairro, rua, tipo, nome, empresa).

Para "agregacao", use "operacao":
  maior_valor | menor_valor | soma_valor | media_valor | contar_total
  contar_por_status (preencha "filtro_status" com o status citado, ou vazio para contagem geral)

REGRA sobre VALOR TOTAL: qualquer pergunta pedindo o valor/custo/investimento de
um CONJUNTO de obras e SEMPRE soma_valor - nao importa como foi escrita. Trate
como iguais: "qual o valor investido", "quais os valores", "quanto foi investido",
"quanto custou tudo", "quanto gastou", "deu quanto no total", "soma dos valores".
Singular ou plural NAO muda: as duas sao soma_valor. Se refere as obras ja
mostradas, marque usar_contexto:true.

Para "listar nomes sem repetir" (ex.: "so os nomes dos engenheiros", "quais
empresas", "quais bairros tem obra"), use "receita" com contar_por:
  "receita": { "filtros": [], "agregacao": { "tipo":"contar_por", "campo":"ENGENHEIRO" } }
  Campos possiveis: ENGENHEIRO, EMPRESA, BAIRRO, STATUS.
  Isso agrupa sem repetir a ficha da obra.

Para "liste cada obra com seu X" (ex.: "quais engenheiros dessas obras", "liste
cada obra com o valor", "cada uma com o engenheiro", "o valor de cada obra"), use
"receita" com listar + campo - mostra cada obra e o valor daquele campo:
  "receita": { "filtros": [], "agregacao": { "tipo":"listar", "campo":"ENGENHEIRO" } }
  Campo pode ser: ENGENHEIRO, EMPRESA, VALOR TOTAL DA OBRA, BAIRRO, STATUS.
  Se a pergunta se refere as obras ja mostradas, marque usar_contexto:true.

Em "termos" (para busca e agregacao com recorte), coloque so o que IDENTIFICA a
obra (bairro, rua, tipo, nome, empresa), normalizando girias: asfalto->pavimentacao,
colegio->escola, postinho/posto->UBS, pracinha->praca, quadra->quadra poliesportiva.
NAO inclua palavras vazias (obra, valor, prazo, situacao) nem "Mamanguape" sozinho
(quase toda obra fica la). Se a pergunta indicar qual valor (executado, inicial,
pago, aditivo), poe em "pista_valor". Se for vaga demais, "termos":[] vazio.

"detalhe": "completo" se pede detalhes especificos ou uma obra so; senao "resumido".

Responda SOMENTE com um JSON valido, sem texto antes ou depois:
{"tipo":"busca","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}

Exemplos:
"bom dia" -> {"tipo":"saudacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}
"quais obras tem?" -> {"tipo":"listagem","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}
"o que ta sendo feito ai?" -> {"tipo":"listagem","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}
"quanto custou o asfalto do centro?" -> {"tipo":"busca","termos":["pavimentacao","centro"],"detalhe":"completo","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}
"qual a obra mais cara?" -> {"tipo":"agregacao","termos":[],"detalhe":"completo","operacao":"maior_valor","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}
"quantas estao concluidas?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"contar_por_status","filtro_status":"concluida","pista_valor":"","usar_contexto":false,"receita":null}
"quanto foi o total executado dessas?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"soma_valor","filtro_status":"","pista_valor":"executado","usar_contexto":true,"receita":null}
"quais os valores investidos nessas obras?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"soma_valor","filtro_status":"","pista_valor":"","usar_contexto":true,"receita":null}
"quanto custou tudo isso?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"soma_valor","filtro_status":"","pista_valor":"","usar_contexto":true,"receita":null}
"so os nomes dos engenheiros" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"ENGENHEIRO"}}}
"quais engenheiros dessas obras?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":true,"receita":{"filtros":[],"agregacao":{"tipo":"listar","campo":"ENGENHEIRO"}}}
"liste cada obra com seu valor investido" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":true,"receita":{"filtros":[],"agregacao":{"tipo":"listar","campo":"VALOR TOTAL DA OBRA"}}}
`;

export async function interpretarPergunta(pergunta, historico = []) {
  const mensagens = [
    { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
    ...prepararHistorico(historico),
    { role: "user", content: pergunta },
  ];

  const base = {
    temperature: 0,
    // IMPORTANTE: o gemini-2.5-flash e um modelo "pensante" - ele gasta tokens
    // RACIOCINANDO antes de escrever, e esse raciocinio conta no max_tokens.
    // Com 1024 + thinking ligado, perguntas complexas gastavam tudo pensando e
    // sobrava zero para o JSON -> resposta vazia -> fallback de busca crua ->
    // respostas repetidas ou sem sentido. (Bug confirmado: modelos de reasoning
    // devolvem content vazio quando max_tokens e baixo demais.)
    //
    // CORRECAO: interpretar e so CLASSIFICAR (nao precisa raciocinio profundo).
    // Desligamos o thinking com "none" (suportado nos modelos Gemini 2.5): o
    // modelo vai direto ao JSON, mais rapido, mais barato e sem estourar. O
    // max_tokens generoso fica como rede de seguranca para o JSON completo.
    max_tokens: 450,
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
    try {
      texto = await chamarIA(base);
    } catch (e2) {
      // Ultima tentativa: orcamento ainda maior e sem modo JSON. Cobre o caso
      // raro de o modelo precisar de muito raciocinio numa pergunta ambigua.
      console.error("Interpretacao (2a tentativa) falhou, tentando com folga:", e2.message);
      texto = await chamarIA({ ...base, max_tokens: 650 });
    }
  }

  // Se mesmo assim veio vazio, nao adianta parsear: sinaliza falha para o
  // server.js pedir a pista que falta, em vez de chutar uma busca crua.
  if (!texto || !texto.trim()) {
    console.error("Interpretacao devolveu vazio apos todas as tentativas.");
    return {
      tipo: "busca", termos: [], detalhe: "completo", operacao: "",
      filtro_status: "", pista_valor: "", receita: null,
      usar_contexto: false, falhou: true,
    };
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

const SYSTEM_PROMPT_RESPOSTA = `Voce e o Assistente de Obras da Prefeitura de Mamanguape, atendendo cidadaos
pelo WhatsApp. Sua tarefa: entender o que a pessoa quer e entregar exatamente
isso, de forma clara e curta.

Voce recebe um JSON com:
- "pergunta": o que o cidadao escreveu (pode ser informal).
- "obras": as obras que o sistema ja filtrou da base. Pode vir vazia.
- "fatos": (opcional) um calculo ja pronto (soma, total, contagem, media).
- "instrucao": (opcional) orientacao de como responder este turno. Siga-a, mas
  nunca a mencione.

REGRA QUE NAO PODE SER QUEBRADA:
Responda SOMENTE com o que estiver em "obras" e "fatos" - essa e a unica fonte de
verdade. NUNCA invente, estime ou complete valores, datas, status, nomes de
empresa ou engenheiro. Se um dado nao esta ali, diga com naturalidade que nao
consta na base e ofereca ajudar de outro jeito. Se vier "fatos", use os numeros
dele exatamente, sem refazer conta. Informar dado errado de obra publica e grave.

COMO RESPONDER:
- Responda so o que foi pedido, sem despejar todos os campos. Se pediu o valor,
  de o valor; se pediu o status, de o status.
- Seja curto (formato WhatsApp, poucas linhas). Detalhe so se a pessoa pedir.
- Entenda a pessoa mesmo com girias e erros. Status tem sinonimos: concluida =
  concluido = pronta = finalizada; em andamento = sendo feita = tocando; parada =
  atrasada = paralisada.
- Se "obras" e "fatos" vierem vazios, peca a pista que falta (bairro, rua ou nome
  da obra) em uma frase curta e cordial.
- Nao repita o que ja disse antes no historico. Cada resposta traz algo novo.
- Fale como a prefeitura falaria: cordial e humano. Nunca diga que e uma IA nem
  cite "os dados", "a planilha" ou "o sistema".
- Portugues do Brasil. Negrito com *asteriscos*, valores em R$ 1.408.500,00.
  No maximo um emoji sutil.

Responda apenas com o texto final da mensagem, sem JSON e sem aspas ao redor.
`;

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
    max_tokens: 700,
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
//  Se o Gemini estiver sem cota,
//  esta funcao vai lancar erro e o server.js cai no formatador local.
// ============================================================

const GEMINI_KEY_CE = GEMINI_KEY;
const GEMINI_MODEL_CE = process.env.GEMINI_MODEL || "gemini-3.6-flash";

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
    `${GEMINI_MODEL_CE}:generateContent`;

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
    max_tokens: 500,
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
// ============================================================
//  chamarIAbruta — funcao simples para o agente SQL.
//  Recebe uma lista de mensagens [{role, content}] e devolve o
//  texto da resposta. Reaproveita o chamarIA interno (com
//  fallback Groq -> Gemini e limpeza de parametros por provedor).
// ============================================================
export async function chamarIAbruta(mensagens, opcoes = {}) {
  const body = {
    max_tokens: Math.min(Number(opcoes.max_tokens) || 384, MAX_SAIDA_GLOBAL),
    messages: mensagens,
  };
  if (opcoes.temperature !== undefined) body.temperature = opcoes.temperature;
  if (opcoes.reasoning_effort !== undefined) body.reasoning_effort = opcoes.reasoning_effort;
  return await chamarIA(body);
}
