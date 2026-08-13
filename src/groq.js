// ============================================================
//  groq.js  (nome mantido por compatibilidade - hoje e o modulo de IA)
//
//  ESTRATEGIA DE PROVEDORES:
//    1. GEMINI (principal) - chamado diretamente pela API do Google.
//       Gratis, rapido e de alta qualidade.
//    2. OMNIROUTE (fallback) - gateway open-source que roteia para
//       270+ provedores automaticamente (Groq, OpenRouter, DeepSeek,
//       Kimi, etc.). Assume quando o Gemini bate o limite de cota (429)
//       ou retorna erro. O cidadao nunca percebe a troca.
//
//  Configuracao (variaveis de ambiente no Render / .env):
//    GEMINI_API_KEY   -> chave do Google AI Studio (OBRIGATORIO)
//    GEMINI_MODEL     -> opcional (padrao: gemini-2.5-flash)
//    OMNIROUTE_URL    -> URL do OmniRoute (ex: http://localhost:4000/v1
//                        ou https://SEU-OMNIROUTE.onrender.com/v1)
//    OMNIROUTE_KEY    -> chave do OmniRoute (opcional, se configurou auth)
//    OMNIROUTE_MODEL  -> modelo preferido no OmniRoute (padrao: gemini-2.5-flash)
//                        O OmniRoute faz fallback automatico se esse modelo
//                        tambem estiver sem cota.
//
//  Como instalar o OmniRoute (uma vez):
//    npx omniroute   (requer Node >= 22)
//  Ou via Docker:
//    docker run -p 4000:4000 diegosouzapw/omniroute
//  Repositorio: https://github.com/diegosouzapw/OmniRoute
// ============================================================

// --- Provedor 1: Gemini direto ---
const GEMINI_URL  = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// --- Provedor 2: Groq (fallback direto) ---
// OpenAI-compativel: base https://api.groq.com/openai/v1. Entra em acao quando
// o Gemini bate cota (429) ou falha. Modelo gratuito atual: openai/gpt-oss-120b.
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// --- Provedor 3: OmniRoute (DESATIVADO) ---
// Removido de proposito: nunca teve creditos (dava erro 402 constante) e so
// poluia os logs. O sistema opera so com Gemini (principal) + Groq (fallback).
// Para reativar no futuro, defina OMNIROUTE_URL no .env e mude a condicao abaixo.
const OMNIROUTE_ATIVO = false; // <- mude para true se um dia configurar o OmniRoute
const OMNIROUTE_URL   = OMNIROUTE_ATIVO && process.env.OMNIROUTE_URL
  ? process.env.OMNIROUTE_URL.replace(/\/$/, "") + "/chat/completions"
  : null;
const OMNIROUTE_KEY   = process.env.OMNIROUTE_KEY || "omniroute";
const OMNIROUTE_MODEL = process.env.OMNIROUTE_MODEL || "openai/gpt-oss-120b";

// Lista de provedores na ordem de tentativa.
// O sistema tenta cada um em sequencia; se um bater limite ou falhar, passa pro proximo.
// Ordem: Gemini (principal, melhor qualidade) -> Groq (fallback rapido) -> OmniRoute.
// Quando o Gemini sai do "descanso" de 5 min, ele volta a ser tentado primeiro.
const PROVEDORES = [];

if (GEMINI_KEY) {
  PROVEDORES.push({
    nome: "gemini",
    url: GEMINI_URL,
    key: GEMINI_KEY,
    model: GEMINI_MODEL,
  });
}

if (GROQ_KEY) {
  PROVEDORES.push({
    nome: "groq",
    url: GROQ_URL,
    key: GROQ_KEY,
    model: GROQ_MODEL,
  });
}

if (OMNIROUTE_URL) {
  PROVEDORES.push({
    nome: "omniroute",
    url: OMNIROUTE_URL,
    key: OMNIROUTE_KEY,
    model: OMNIROUTE_MODEL,
  });
}

if (PROVEDORES.length === 0) {
  console.warn(
    "AVISO: Nenhum provedor de IA configurado. " +
    "Defina GEMINI_API_KEY e/ou GROQ_API_KEY no .env."
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
// Tenta cada provedor na ordem: Gemini (principal) -> Groq (fallback).
// O "body" NAO deve conter "model": ele e definido aqui conforme o provedor.
// Quando um provedor bate o limite (429), entra de "descanso" curto: o sistema
// prefere os outros por um tempo. MAS, se TODOS estiverem descansando, ele ainda
// tenta o que esta mais perto de voltar - nunca desiste sem ao menos tentar.
// O limite gratuito do Gemini/Groq e POR MINUTO, entao 60s de descanso basta.
const DESCANSO_MS = 60 * 1000; // 60 segundos (era 5 min - agressivo demais)
const provedorDescansando = new Map(); // nome -> timestamp de quando pode voltar

async function chamarIA(body) {
  if (PROVEDORES.length === 0) {
    throw new Error("Nenhuma chave de IA configurada (GEMINI_API_KEY ou GROQ_API_KEY).");
  }

  let ultimoErro = null;
  const agora = Date.now();

  // Monta a ordem de tentativa: primeiro os que NAO estao descansando (na ordem
  // normal), depois - como ultimo recurso - os que estao descansando, do que
  // volta mais cedo para o que volta mais tarde. Assim, mesmo com todos em
  // descanso, sempre tentamos alguem em vez de falhar direto.
  const livres = [];
  const descansando = [];
  for (const prov of PROVEDORES) {
    const voltaEm = provedorDescansando.get(prov.nome);
    if (voltaEm && agora < voltaEm) {
      descansando.push({ prov, voltaEm });
    } else {
      livres.push(prov);
    }
  }
  descansando.sort((a, b) => a.voltaEm - b.voltaEm);
  const ordem = [...livres, ...descansando.map((d) => d.prov)];

  for (const prov of ordem) {
    try {
      // Cada provedor aceita parametros diferentes:
      //  - GEMINI 3.x (3.5/3.6): NAO aceita reasoning_effort/temperature/top_p/
      //    top_k e rejeita a requisicao com 400. Removemos todos.
      //  - GROQ: aceita temperature, mas reasoning_effort SO pode ser
      //    "low"|"medium"|"high". Se vier "none"/invalido, removemos.
      const corpo = { ...body, model: prov.model };

      if (prov.nome === "gemini") {
        delete corpo.reasoning_effort;
        delete corpo.temperature;
        delete corpo.top_p;
        delete corpo.top_k;
      } else if (prov.nome === "groq") {
        const validos = ["low", "medium", "high"];
        if (!validos.includes(corpo.reasoning_effort)) {
          delete corpo.reasoning_effort;
        }
      }

      const resp = await fetch(prov.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${prov.key}`,
        },
        body: JSON.stringify(corpo),
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
      // Sucesso: tira do descanso e loga qual provedor respondeu de verdade.
      provedorDescansando.delete(prov.nome);
      const via = prov.nome === "gemini" ? "Gemini (principal)" : "Groq (fallback)";
      console.log(`DEBUG IA usada: ${via} | modelo: ${prov.model}`);
      return texto;
    } catch (e) {
      console.error(`IA (${prov.nome}) falhou:`, e.message);
      ultimoErro = e;
      // 429 = limite de cota: poe de descanso curto (o proximo assume).
      if (e.status === 429) {
        provedorDescansando.set(prov.nome, Date.now() + DESCANSO_MS);
        console.log(`DEBUG ${prov.nome} bateu limite - descanso de ${DESCANSO_MS / 1000}s`);
      }
      // tenta o proximo provedor
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
    max_tokens: 4096,
    reasoning_effort: "none",
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
      texto = await chamarIA({ ...base, max_tokens: 8192 });
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
//  sem passar pelo OmniRoute. Se o Gemini estiver sem cota,
//  esta funcao vai lancar erro e o server.js cai no formatador local.
// ============================================================

const GEMINI_KEY_CE = process.env.GEMINI_API_KEY;
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