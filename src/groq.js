// ============================================================
//  groq.js
//  IA do chatbot: Groq principal + Gemini de reserva.
//
//  Estrategia:
//    1) Groq primeiro, com UM modelo configurado (padrao GPT-OSS-20B).
//    2) Se Groq falhar/atingir 429, cai imediatamente para Gemini.
//    3) Sem OpenRouter/Nemotron.
//    4) O classificador de intencao usa prompt curto; regras de negocio,
//       schema, SQL, calculos e validacoes ficam no Node/PostgreSQL.
//
//  Variaveis de ambiente:
//    GROQ_API_KEY
//    GROQ_MODEL       opcional; padrao openai/gpt-oss-20b
//    GEMINI_API_KEY   (tambem aceita GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY)
//    GEMINI_MODEL     opcional; padrao gemini-3.5-flash-lite
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
const GROQ_MODELOS = [GROQ_MODEL];

const GEMINI_KEY = (
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  ""
).trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();

const PROVEDORES = [];
// Ordem de prioridade: Groq -> Gemini.
if (GROQ_KEY) PROVEDORES.push({ nome: "groq" });
if (GEMINI_KEY) PROVEDORES.push({ nome: "gemini" });
if (PROVEDORES.length === 0) {
  console.warn("AVISO: configure GROQ_API_KEY e/ou GEMINI_API_KEY.");
}

// Contato para escalar quando o bot nao resolve (opcional, via .env).
const CONTATO_SECRETARIA = process.env.CONTATO_SECRETARIA || "";

// Mantem contexto pequeno para economizar TPM.
const MAX_HISTORICO_ENVIO = 2;
const MAX_CHARS_HISTORICO = 180;

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
const MAX_SAIDA_GLOBAL = 1000;
// Em 429, tenta outro modelo/provedor primeiro. Se todos estiverem limitados,
// pode aguardar uma unica janela curta indicada pelo Retry-After e tentar de novo.
const MAX_ESPERA_429_MS = Math.max(0, Math.min(Number(process.env.IA_MAX_ESPERA_429_MS || 3000), 30000));
const RETENTAR_429 = process.env.IA_RETENTAR_429 !== "false";

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
const modelosGroqDescansando = new Map();

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chamarGroq(body) {
  let ultimoErro = null;
  const limite = limiteSaida(body);

  let proximoModeloEm = null;
  for (const model of GROQ_MODELOS) {
    if (modelosGroqIndisponiveis.has(model)) continue;
    const agora = Date.now();
    const ate = modelosGroqDescansando.get(model) || 0;
    if (ate > agora) {
      proximoModeloEm = proximoModeloEm === null ? ate : Math.min(proximoModeloEm, ate);
      continue;
    }
    modelosGroqDescansando.delete(model);
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
      if (resp.status === 429) {
        err.retryAfterMs = retryDepoisMs(resp, erroTxt);
        const ate = Date.now() + Math.max(1000, err.retryAfterMs || DESCANSO_PADRAO_MS);
        modelosGroqDescansando.set(model, ate);
        proximoModeloEm = proximoModeloEm === null ? ate : Math.min(proximoModeloEm, ate);
        ultimoErro = err;
        console.warn(`DEBUG Groq: ${model} atingiu 429; tentando outro modelo antes de desistir.`);
        continue;
      }
      throw err;
    }

    const data = await resp.json();
    const texto = data.choices?.[0]?.message?.content?.trim() || "";
    if (!texto) throw new Error(`groq (${model}) devolveu resposta vazia`);
    const u = data?.usage || {};
    console.log(`DEBUG IA usada: Groq (principal) | modelo: ${model}`);
    if (u.prompt_tokens != null || u.completion_tokens != null) {
      console.log(`DEBUG TOKENS Groq | entrada=${u.prompt_tokens ?? "?"} | saida=${u.completion_tokens ?? "?"} | total=${u.total_tokens ?? "?"}`);
    }
    return texto;
  }

  if (!ultimoErro && proximoModeloEm !== null) {
    const err = new Error("Todos os modelos Groq estao temporariamente em rate limit.");
    err.status = 429;
    err.retryAfterMs = Math.max(500, proximoModeloEm - Date.now());
    throw err;
  }
  if (ultimoErro?.status === 429 && proximoModeloEm !== null) {
    ultimoErro.retryAfterMs = Math.max(500, proximoModeloEm - Date.now());
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
  const u = data?.usageMetadata || {};
  console.log(`DEBUG IA usada: Gemini (fallback 2) | modelo: ${GEMINI_MODEL}`);
  if (u.promptTokenCount != null || u.candidatesTokenCount != null) {
    console.log(`DEBUG TOKENS Gemini | entrada=${u.promptTokenCount ?? "?"} | saida=${u.candidatesTokenCount ?? "?"} | total=${u.totalTokenCount ?? "?"}`);
  }
  return texto;
}

async function chamarIA(body, tentativa429 = 0) {
  if (PROVEDORES.length === 0) {
    throw new Error("Nenhuma chave de IA configurada (GROQ_API_KEY ou GEMINI_API_KEY).");
  }

  const agora = Date.now();
  const ordem = PROVEDORES.filter((p) => (provedorDescansando.get(p.nome) || 0) <= agora);

  if (ordem.length === 0) {
    const proximo = Math.min(...PROVEDORES.map((p) => provedorDescansando.get(p.nome) || agora));
    const espera = Math.max(250, proximo - agora);
    if (RETENTAR_429 && tentativa429 === 0 && espera <= MAX_ESPERA_429_MS) {
      console.warn(`DEBUG IA: todos provedores em cooldown; aguardando ${Math.ceil(espera / 1000)}s para uma retentativa.`);
      await dormir(espera + 150);
      return chamarIA(body, 1);
    }
    const erro = new Error(`Provedores temporariamente indisponiveis. Tente novamente em ${Math.max(1, Math.ceil(espera / 1000))}s.`);
    erro.status = 429;
    erro.retryAfterMs = espera;
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
        const pausa = Math.max(1000, Math.min(e.retryAfterMs || DESCANSO_PADRAO_MS, 60_000));
        provedorDescansando.set(prov.nome, Date.now() + pausa);
        console.log(`DEBUG ${prov.nome} em limite - cooldown de ${Math.ceil(pausa / 1000)}s; tentando outro provedor se existir.`);
        // NAO interrompe: o proximo provedor da fila e tentado imediatamente.
        continue;
      }

      if ((e.status === 401 || e.status === 403)) {
        provedorDescansando.set(prov.nome, Date.now() + 10 * 60 * 1000);
        if (prov.nome === "groq") {
          console.error("DEBUG Groq: confira GROQ_API_KEY no Render.");
        } else if (prov.nome === "gemini") {
          console.error("DEBUG Gemini: confira GEMINI_API_KEY no Render (chave do Google AI Studio).");
        }
      }
      // Erro de um provedor nao impede tentar o seguinte.
    }
  }

  // Se TODOS falharam por 429, faz uma unica espera curta baseada no menor
  // cooldown. Isso cobre exatamente o caso em que a Groq pede ~10-12s.
  if (ultimoErro?.status === 429 && RETENTAR_429 && tentativa429 === 0) {
    const agora2 = Date.now();
    const futuros = PROVEDORES
      .map((p) => provedorDescansando.get(p.nome) || 0)
      .filter((t) => t > agora2);
    const espera = futuros.length ? Math.min(...futuros) - agora2 : (ultimoErro.retryAfterMs || DESCANSO_PADRAO_MS);
    if (espera > 0 && espera <= MAX_ESPERA_429_MS) {
      console.warn(`DEBUG IA: rate limit geral; aguardando ${Math.ceil(espera / 1000)}s e tentando uma ultima vez.`);
      await dormir(espera + 150);
      return chamarIA(body, 1);
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
//  PARTE 1 - INTERPRETACAO LEVE
//  A IA SOMENTE entende a pergunta e devolve uma intencao estruturada.
//  Regras de negocio, schema, SQL, calculos e validacoes ficam no Node.
// ============================================================

const SYSTEM_PROMPT_INTERPRETAR = `Voce e um CLASSIFICADOR SEMANTICO de perguntas sobre obras publicas.
NAO gere SQL. NAO calcule. NAO responda ao cidadao.
Entenda girias, erros de digitacao e referencias como "essas", "delas", "ele/ela".

Retorne SOMENTE JSON com:
{
 "acao":"listar|buscar|contar|somar|media|ranking|campo|existencia|valores_unicos|complexa",
 "universo":"obra|projeto|licitacao|auto",
 "campo":"",
 "agrupar_por":"",
 "medida":"",
 "direcao":"maior|menor|",
 "filtros":[{"campo":"","valor":""}],
 "termos":[],
 "usar_contexto":false,
 "limite":20,
 "detalhe":"resumido|completo"
}

VOCABULARIO SEMANTICO (use estes nomes; o sistema faz o mapeamento real):
- valor investido/custo/valor total -> campo "valor_total"
- valor executado/pago -> "valor_executado"
- percentual/execucao -> "percentual_executado"
- responsavel/engenheiro/arquiteto -> "engenheiro"
- etapa da licitacao -> "status_original"
- situacao/status -> "status"
- recurso -> "recurso"; tipo/fonte do recurso -> "tipo_recurso"
- bairro, empresa, categoria, contrato, convenio, data_inicio, data_prev_termino
- concluida/pronta/finalizada -> filtro {"campo":"situacao","valor":"concluido"}
- em andamento/sendo feita -> filtro {"campo":"situacao","valor":"em_andamento"}

REGRAS DE INTENCAO:
- "qual o valor investido nessas obras?" => somar valor_total + usar_contexto=true.
- "valor de cada uma" => campo valor_total + usar_contexto=true (NAO somar).
- "qual engenheiro tem mais obras?" => ranking, agrupar_por=engenheiro, medida=quantidade, direcao=maior, limite=1.
- "qual engenheiro tem maior valor investido?" => ranking, agrupar_por=engenheiro, campo=valor_total, medida=soma, direcao=maior, limite=1.
- "quais obras concluidas?" => listar universo=obra + filtro situacao=concluido.
- "quais os recursos dessas?" => campo=recurso + usar_contexto=true.
- AREA/TEMA: expressoes como "area da educacao", "area da saude" ou "do setor de educacao" NAO significam necessariamente coluna categoria. Coloque o tema em "termos" e deixe o sistema aplicar a semantica aos dados reais.
- Ex.: "tem alguma licitacao da area da educacao?" => acao="existencia", universo="licitacao", filtros=[], termos=["educacao"].
- Se o usuario disser explicitamente "categoria X" ou pedir o campo categoria, ai sim use campo/filtro categoria.
- PEDIDO DE VALORES UNICOS: se a pessoa pedir apenas todos/quais/nomes de bairros, engenheiros, empresas, status, categorias ou recursos, use acao="valores_unicos" e coloque a dimensao em "campo". NAO use acao="listar" nesses casos.
- Ex.: "me informa todos os bairros?" => acao="valores_unicos", campo="bairro".
- Ex.: "quais empresas?" => acao="valores_unicos", campo="empresa".
- Se pedir "bairro/engenheiro de cada obra", ai use acao="campo" para manter a associacao com cada registro.
- Se a frase pedir algo que nao cabe com seguranca nesses campos/acoes, use acao="complexa".
- "usar_contexto" so e true quando a pergunta depende do conjunto/entidade anterior.
`;

function limparJsonIA(texto = "") {
  const bruto = String(texto || "").replace(/```json|```/gi, "").trim();
  const ini = bruto.indexOf("{");
  const fim = bruto.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(bruto.slice(ini, fim + 1)); } catch { return null; }
}

function intencaoFallback() {
  return {
    acao: "complexa", universo: "auto", campo: "", agrupar_por: "", medida: "",
    direcao: "", filtros: [], termos: [], usar_contexto: false, limite: 20,
    detalhe: "resumido", falhou: true,
    // compatibilidade com o fluxo antigo
    tipo: "busca", operacao: "", filtro_status: "", pista_valor: "", receita: null,
  };
}

export async function interpretarPergunta(pergunta, historico = []) {
  const mensagens = [
    { role: "system", content: SYSTEM_PROMPT_INTERPRETAR },
    ...prepararHistorico(historico),
    { role: "user", content: String(pergunta || "").slice(0, 1200) },
  ];

  let texto = "";
  const base = {
    temperature: 0,
    max_tokens: 300,
    reasoning_effort: "low",
    messages: mensagens,
  };

  // Uma unica chamada: o prompt ja exige JSON e o parser limpa cercas Markdown.
  // Isso evita gastar uma segunda chamada apenas por incompatibilidade de
  // response_format em algum modelo/provedor.
  try {
    texto = await chamarIA(base);
  } catch (e) {
    console.error("CLASSIFICADOR: falhou:", e.message);
    return intencaoFallback();
  }

  const it = limparJsonIA(texto);
  if (!it) return intencaoFallback();

  const acoes = new Set(["listar","buscar","contar","somar","media","ranking","campo","existencia","valores_unicos","complexa"]);
  const universos = new Set(["obra","projeto","licitacao","auto"]);
  const direcoes = new Set(["maior","menor",""]);
  const acao = acoes.has(it.acao) ? it.acao : "complexa";
  const universo = universos.has(it.universo) ? it.universo : "auto";
  const direcao = direcoes.has(it.direcao) ? it.direcao : "";
  const limiteBruto = Number(it.limite);
  const limite = Number.isFinite(limiteBruto) ? Math.max(1, Math.min(Math.trunc(limiteBruto), 20)) : (acao === "ranking" ? 1 : 20);

  const filtros = Array.isArray(it.filtros)
    ? it.filtros.slice(0, 8).map((f) => ({
        campo: typeof f?.campo === "string" ? f.campo.trim() : "",
        valor: typeof f?.valor === "string" || typeof f?.valor === "number" || typeof f?.valor === "boolean"
          ? String(f.valor).trim() : "",
      })).filter((f) => f.campo && f.valor !== "")
    : [];

  const termos = Array.isArray(it.termos)
    ? it.termos.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()).slice(0, 6)
    : [];

  // Campos antigos continuam presentes para nao quebrar nenhum import legado.
  let tipo = ["contar","somar","media","ranking"].includes(acao) ? "agregacao"
    : acao === "listar" ? "listagem" : "busca";
  let operacao = "";
  if (acao === "somar") operacao = "soma_valor";
  if (acao === "media") operacao = "media_valor";
  if (acao === "contar") operacao = "contar_total";

  const resultado = {
    acao, universo,
    campo: typeof it.campo === "string" ? it.campo.trim() : "",
    agrupar_por: typeof it.agrupar_por === "string" ? it.agrupar_por.trim() : "",
    medida: typeof it.medida === "string" ? it.medida.trim() : "",
    direcao,
    filtros,
    termos,
    usar_contexto: it.usar_contexto === true,
    limite,
    detalhe: it.detalhe === "completo" ? "completo" : "resumido",
    falhou: false,
    tipo, operacao, filtro_status: "", pista_valor: "", receita: null,
  };

  console.log("DEBUG INTENCAO:", JSON.stringify(resultado));
  return resultado;
}

// ============================================================
//  PARTE 2 - REDACAO DA RESPOSTA FINAL (com memoria da conversa)
// ============================================================

const SYSTEM_PROMPT_RESPOSTA = `Voce e o Assistente de Obras da Prefeitura de Mamanguape no WhatsApp.
Sua funcao nesta etapa e SOMENTE REDIGIR. O sistema ja entendeu a pergunta, consultou
o banco, aplicou as regras e fez os calculos. Voce nao decide filtros, nao gera SQL e
nao recalcula nada.

Voce recebe:
- "pergunta": mensagem original do cidadao;
- "fatos": resposta factual pronta e autoritativa produzida pelo sistema;
- "obras": dados adicionais somente quando forem necessarios;
- "instrucao": orientacao de apresentacao, nunca um novo fato.

REGRA ABSOLUTA DE VERDADE:
- Use SOMENTE fatos/obras recebidos.
- NUNCA altere numero, valor, nome, bairro, status, engenheiro, quantidade ou item.
- NUNCA complete por conhecimento proprio, memoria ou suposicao.
- NUNCA refaca soma, media, contagem ou ranking. Se "fatos" disser 7, responda 7.
- Se um dado nao estiver presente, diga apenas que essa informacao nao consta no
  resultado recebido.

COMO REDIGIR:
- Dê a resposta principal JA NA PRIMEIRA FRASE.
- Depois, se ajudar, acrescente uma explicacao curta e natural baseada nos fatos.
- Se o usuario pediu "todos", "quais" ou uma lista e fatos trouxerem uma lista,
  mantenha TODOS os itens recebidos (ate 20). Nao troque a lista por um resumo.
- Se for ranking, cite sempre a entidade E a medida: ex. "Centro, com 7 obras".
- Se for valor, destaque o valor e diga em uma frase o que ele representa.
- Se for contagem, informe a quantidade e o universo correto (obras/projetos/licitacoes).
- Se for follow-up ("essas", "delas", "e o valor?"), responda diretamente sem
  recontar toda a conversa.
- Preserve conceitos diferentes: recurso != tipo de recurso; valor total != valor
  executado; obra != projeto != licitacao.
- Nao transforme pedido de bairros/engenheiros/empresas em lista de obras.
- Nao fale "segundo a IA", "segundo o sistema", "consulta", "SQL", "banco" ou
  "planilha".
- Portugues do Brasil, claro e humano. Poucas linhas quando a pergunta for simples.
- Formato WhatsApp: lista numerada ou marcadores quando houver varios itens; sem tabela.
- Negrito pode usar *asteriscos*. Valores no formato R$ 1.408.500,00.
- Nao termine com explicacoes tecnicas nem frases mecanicas.

Responda apenas com a mensagem final ao cidadao, sem JSON e sem aspas.`;

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
    // Redacao apenas: o sistema ja resolveu a consulta.
    max_tokens: 500,
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
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_KEY_CE,
    },
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
