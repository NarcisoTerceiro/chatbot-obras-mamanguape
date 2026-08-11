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
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// --- Provedor 3: OmniRoute (fallback opcional) ---
const OMNIROUTE_URL   = process.env.OMNIROUTE_URL
  ? process.env.OMNIROUTE_URL.replace(/\/$/, "") + "/chat/completions"
  : null;
const OMNIROUTE_KEY   = process.env.OMNIROUTE_KEY || "omniroute"; // valor padrao se sem auth
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
// Tenta cada provedor na ordem: Gemini (principal) -> OmniRoute (fallback).
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
      // Cada provedor aceita parametros diferentes. O GEMINI 3.x (3.5/3.6) NAO
      // aceita reasoning_effort/temperature/top_p/top_k e rejeita a requisicao
      // inteira com 400 "INVALID_ARGUMENT". Ja o GROQ (gpt-oss) ACEITA esses
      // parametros normalmente. Entao so limpamos quando o provedor e o Gemini.
      const corpo = { ...body, model: prov.model };
      if (prov.nome === "gemini") {
        delete corpo.reasoning_effort;
        delete corpo.temperature;
        delete corpo.top_p;
        delete corpo.top_k;
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
      // Respondeu com sucesso: se estava de descanso, tira do descanso.
      provedorDescansando.delete(prov.nome);
      const via = prov.nome === "omniroute" ? "OmniRoute (fallback)" : "Gemini (principal)";
      console.log(`DEBUG IA usada: ${via} | modelo: ${prov.model}`);
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

const SYSTEM_PROMPT_INTERPRETAR = `Voce interpreta perguntas de cidadaos sobre obras publicas
de uma prefeitura, enviadas por WhatsApp de forma informal, formal, com girias,
abreviacoes ou erros de digitacao.

PRINCIPIOS (siga sempre):
0. ACOMPANHAMENTO: a pessoa pode se referir ao RESULTADO ANTERIOR (o grupo de
   obras que voce acabou de mostrar), com qualquer jeito de falar - nao so as
   palavras classicas "essas/dessas/delas", mas tambem "cada uma", "a de cima",
   "todas elas", "o mesmo grupo", ou ate sem nenhum pronome explicito, quando o
   sentido da frase claramente continua o assunto anterior. Julgue pelo SENTIDO
   da conversa, nao por uma lista fixa de palavras.
   Quando a pergunta se referir ao resultado anterior, marque
   "usar_contexto":true e monte a operacao para ser aplicada sobre essas
   mesmas obras (o sistema ja aplica automaticamente nas obras do contexto,
   voce so precisa da receita/operacao, sem repetir os filtros da pergunta
   anterior). Ex.: apos listar obras em licitacao, "liste com o nome do
   engenheiro" ->
   {"tipo":"agregacao","termos":[],"usar_contexto":true,"receita":{"filtros":[],"agregacao":{"tipo":"listar","campo":"ENGENHEIRO"}}}
   "e o valor de cada uma?" -> listar com campo do valor, "usar_contexto":true.
   "quantas dessas estao paradas?" -> contar com filtro de status,
   "usar_contexto":true.
   Se a pergunta for sobre a base inteira (novo assunto, sem relacao com o que
   foi mostrado), marque "usar_contexto":false.
1. Foque no que a pessoa REALMENTE quer, nao nas palavras exatas. "ta pronta a
   creche?", "a creche ja acabou?" e "situacao da creche" pedem a mesma coisa.
2. Entenda a mesma pergunta escrita de varios jeitos (formal, informal, com erro).
3. Na duvida entre dois tipos, escolha o mais especifico que caiba. Ex.: se cita
   o nome de uma pessoa como responsavel, e "engenheiro"; se pede um total/quantos,
   e "agregacao"; caso contrario, "busca".
4. So classifique como "saudacao" se NAO houver nenhum pedido de informacao junto.
5. Extraia termos que DISTINGUEM a obra (bairro, tipo, nome), nunca palavras vazias.
6. Responda SEMPRE com um JSON valido e completo - nunca texto solto.


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
- "engenheiro": pedido para LISTAR/VER as obras de um ENGENHEIRO ou responsavel
  especifico (ex: "obras do engenheiro Carlos", "o que o Paulo Nunes toca",
  "obras da arquiteta Ana"). Coloque em "termos" APENAS o nome da pessoa
  (ex: ["Carlos"]). NAO use este tipo se a pergunta pede uma CONTAGEM ("quantas
  obras tem/teve", "quantos projetos") - nesse caso use "agregacao" (veja abaixo),
  porque "engenheiro" so lista, nao calcula um numero.
- "busca": qualquer pergunta sobre uma obra ou grupo de obras especifico
  (por bairro, rua, tipo, nome, empresa).

Quando o tipo for "agregacao", escolha a "operacao":
- "maior_valor"  -> obra mais cara / de maior valor
- "menor_valor"  -> obra mais barata / de menor valor
- "soma_valor"   -> total investido / quanto foi gasto somando
- "media_valor"  -> valor medio das obras
- "contar_por_status" -> quantas obras estao em determinada situacao. Nesse caso
  preencha "filtro_status" com o status citado (ex: "paralisada", "concluida",
  "em andamento"). Se a pessoa pedir a contagem geral por situacao, deixe
  "filtro_status" vazio.
- "contar_total" -> quantas obras existem no total

Alem das operacoes acima, para perguntas de agregacao MAIS COMPLEXAS (com
filtros combinados, comparacoes por valor, por empresa, por engenheiro, etc.),
voce PODE montar uma RECEITA generica no campo "receita", assim:
  "receita": {
    "filtros": [
      { "campo": "BAIRRO", "operador": "igual", "valor": "Centro" },
      { "campo": "VALOR TOTAL DA OBRA", "operador": "maior_que", "valor": 500000 }
    ],
    "agregacao": { "tipo": "somar", "campo": "VALOR TOTAL DA OBRA" }
  }
Operadores validos: igual, diferente, contem, maior_que, menor_que, entre.
Tipos de agregacao: contar, somar, media, maior, menor, listar, top, ordinal,
contar_por.
- "top": as N obras de MAIOR VALOR EM DINHEIRO (nunca use para contar quem tem
  mais obras - isso e "contar_por" com "top", veja mais abaixo). Use "n": 3
  (ou o numero pedido). Para as
  menores, use tipo "menores". Ex.: "top 3 obras mais caras" ->
  {"agregacao":{"tipo":"top","n":3,"campo":"VALOR TOTAL DA OBRA"}}
- "ordinal": a N-esima obra por valor. Use "posicao": 2 para "segunda", 3 para
  "terceira". Para menor, use tipo "ordinal_menor". Ex.: "segunda obra mais
  cara" -> {"agregacao":{"tipo":"ordinal","posicao":2,"campo":"VALOR TOTAL DA OBRA"}}
- "contar_por": quantas obras em cada grupo. Ex.: "quantas obras por bairro" ->
  {"agregacao":{"tipo":"contar_por","campo":"BAIRRO"}}
  Se a pergunta pedir so QUEM TEM MAIS/MENOS de um campo de TEXTO (engenheiro,
  bairro, empresa, status - nao e um valor em dinheiro), use "contar_por" com
  "top" (NUNCA use "top"/"ordinal" sozinho aqui - esses sao so para VALOR em
  dinheiro). Ex.: "qual engenheiro tem mais obras?" ->
  {"agregacao":{"tipo":"contar_por","campo":"ENGENHEIRO","top":1}}
  "quais 3 bairros tem mais obras?" ->
  {"agregacao":{"tipo":"contar_por","campo":"BAIRRO","top":3}}
  "qual empresa tem menos obras?" ->
  {"agregacao":{"tipo":"contar_por","campo":"EMPRESA","top":1,"ordem":"asc"}}
Use nomes de coluna reais da planilha (BAIRRO, STATUS, EMPRESA, ENGENHEIRO,
VALOR TOTAL DA OBRA, OBJETO DA OBRA...). Prefira a "receita" quando a pergunta
combina condicoes (ex.: "obras da Construtora Ativa acima de 500 mil", "qual
engenheiro tem mais obras concluidas", "media das escolas do centro").
Quando usar "receita", ainda coloque "tipo":"agregacao".
Se a pessoa pedir UM CAMPO especifico DE CADA obra, EM PARES obra+campo (ex.:
"nome dos engenheiros de cada obra", "o status de todas", "a empresa de cada
obra"), use tipo "agregacao" com uma receita de listar apontando o campo:
  {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[],"agregacao":{"tipo":"listar","campo":"ENGENHEIRO"}}}
Troque "ENGENHEIRO" pela coluna pedida (STATUS, EMPRESA, BAIRRO, etc.). Se houver
recorte (ex.: "engenheiros das obras do centro"), adicione o filtro do bairro.

MUITO IMPORTANTE - nao confunda os TRES casos parecidos:
(a) "campo X de CADA obra", em pares obra+valor (sem condicao) -> "listar" com
    campo. Ex.: "os engenheiros de cada obra", "o status de todas".
(b) SO os valores distintos de um campo, SEM repetir por obra - a pessoa pede
    "so os nomes", "so a lista", "sem repetir", ou faz essa pergunta LOGO DEPOIS
    de voce ja ter mostrado o campo em pares (ela quer o mesmo campo, mas
    enxuto) -> use "contar_por" com esse campo (ele ja agrupa e nao repete):
    "liste so os nomes dos engenheiros" ->
    {"tipo":"agregacao","termos":[],...,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"ENGENHEIRO"}}}
    "quais bairros tem obra", "lista as empresas responsaveis" -> mesma logica
    (campo BAIRRO ou EMPRESA). NUNCA repita "listar" com o mesmo campo que voce
    acabou de usar quando a pessoa pedir algo "mais enxuto" ou "so os nomes" -
    isso devolveria a MESMA resposta de novo, o que e um erro.
(c) pergunta com CONDICOES/FILTROS (empresa, valor, status, bairro) -> use
    filtros e a agregacao adequada (contar/somar/listar), NUNCA listar-campo com
    o nome da obra. Ex.: "obras da Construtora Ativa acima de 500 mil" ->
    {"tipo":"agregacao","termos":[],...,"receita":{"filtros":[{"campo":"EMPRESA","operador":"contem","valor":"Ativa"},{"campo":"VALOR TOTAL DA OBRA","operador":"maior_que","valor":500000}],"agregacao":{"tipo":"listar"}}}
    (sem "campo" na agregacao: assim ele lista as obras que passam no filtro).
Nunca use "campo":"OBJETO DA OBRA" numa agregacao listar - isso repete o nome.

CONTAGEM sobre UMA pessoa/empresa especifica ("quantas obras tem/teve o
engenheiro X", "quantos projetos a empresa Y fez"): NUNCA use tipo "engenheiro"
aqui (ele nao conta, so lista). Use "agregacao" com receita: filtro pelo nome
(operador "contem", que tolera nome parcial ou digitado com pequeno erro) e
agregacao "contar":
  "quantas obras a engenheira Marina Costa tem?" ->
  {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","receita":{"filtros":[{"campo":"ENGENHEIRO","operador":"contem","valor":"Marina Costa"}],"agregacao":{"tipo":"contar"}}}
Se a agregacao for limitada a um RECORTE (ex: "quanto foi investido no Centro",
"media das escolas", "total gasto em pavimentacao"), coloque o recorte em
"termos" (ex: ["centro"], ["escola"], ["pavimentacao"]). O sistema filtra por
esses termos ANTES de calcular.
Se a pergunta indicar QUAL valor usar (ex: "valor inicial", "executado", "pago",
"aditivo"), coloque a pista em "pista_valor". Senao, deixe vazio (usa o total).

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
{"tipo":"busca"|"saudacao"|"listagem"|"agregacao"|"engenheiro","termos":["termo1"],"detalhe":"resumido"|"completo","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":null}

Deixe "operacao", "filtro_status" e "pista_valor" vazios quando nao se aplicarem.

Exemplos:
"bom dia" -> {"tipo":"saudacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":""}
"quais obras tem?" -> {"tipo":"listagem","termos":[],"detalhe":"resumido","operacao":"","filtro_status":""}
"quanto custou o asfalto do centro?" -> {"tipo":"busca","termos":["pavimentacao","centro"],"detalhe":"completo","operacao":"","filtro_status":""}
"qual a obra mais cara?" -> {"tipo":"agregacao","termos":[],"detalhe":"completo","operacao":"maior_valor","filtro_status":""}
"quantas estao paradas?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"contar_por_status","filtro_status":"paralisada"}\n"obras do engenheiro Carlos" -> {"tipo":"engenheiro","termos":["Carlos"],"detalhe":"resumido","operacao":"","filtro_status":""}\n"quanto foi investido no centro?" -> {"tipo":"agregacao","termos":["centro"],"detalhe":"resumido","operacao":"soma_valor","filtro_status":"","pista_valor":""}\n"media de valor das escolas?" -> {"tipo":"agregacao","termos":["escola"],"detalhe":"resumido","operacao":"media_valor","filtro_status":"","pista_valor":""}
"lista so os nomes dos engenheiros" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"ENGENHEIRO"}}}
"so os nomes dos engenheiros" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"ENGENHEIRO"}}}
"quais empresas estao tocando obras?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"EMPRESA"}}}
"quais bairros tem obra?" -> {"tipo":"agregacao","termos":[],"detalhe":"resumido","operacao":"","filtro_status":"","pista_valor":"","usar_contexto":false,"receita":{"filtros":[],"agregacao":{"tipo":"contar_por","campo":"BAIRRO"}}}
LEMBRETE CRITICO: quando a pessoa pede "SO os nomes", "so a lista", "sem repetir", ou logo apos voce ter mostrado obra+campo ela pede "so os nomes/engenheiros/empresas", isso e SEMPRE "contar_por" com o campo pedido - NUNCA "listar" que repete a ficha da obra. Repetir a mesma lista de antes e considerado ERRO.`;

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