// ============================================================
// agente_v2.js
// Chatbot Obras Mamanguape - arquitetura V2
//
// Objetivo:
//   1) IA interpreta a pergunta e devolve SOMENTE um plano JSON pequeno.
//   2) Node valida o plano.
//   3) Node gera SQL parametrizada (a IA nunca escreve SQL).
//   4) PostgreSQL executa em modo somente leitura via queryReadOnly().
//   5) Node calcula e formata a resposta com dados reais.
//   6) Estado estruturado preserva conjunto atual e item/pessoa em foco.
//
// Esta V2 foi feita para rodar EM PARALELO com o agente atual durante testes.
// Nao grava aprendizado persistente e nao altera o banco.
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js";

const MAX_IDS_ESTADO = 200;
const MAX_LINHAS_SQL = 200;
const MAX_ITENS_RESPOSTA = 25;

const SCOPES = new Set([
  "inherit",
  "obras",
  "obras_fisicas",
  "pavimentacoes",
  "projetos",
  "licitacoes",
  "todos",
]);

const ACTIONS = new Set(["list", "count", "aggregate", "extreme", "group", "detail", "exists"]);
const CAMPOS = new Set([
  "objeto",
  "bairro",
  "status",
  "categoria",
  "engenheiro",
  "empresa",
  "valor_total",
  "valor_executado",
  "percentual_executado",
  "recurso",
  "aba_origem",
]);
const CAMPOS_NUMERICOS = new Set(["valor_total", "valor_executado", "percentual_executado"]);
const CAMPOS_GRUPO = new Set(["engenheiro", "empresa", "bairro", "status", "recurso"]);

const RECURSO_SQL = `COALESCE(
  NULLIF(BTRIM(dados_extras->>'RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'CONVÊNIO/RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'CONVENIO/RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'FONTE DO RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'FONTE RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'TIPO_RECURSO'), ''),
  NULLIF(BTRIM(dados_extras->>'TIPO RECURSO'), ''),
  ''
)`;

const STATUS_ORIGINAL_SQL = `COALESCE(dados_extras->>'STATUS ORIGINAL', dados_extras->>'STATUS', '')`;

const SELECT_BASE = `
  id,
  objeto,
  bairro,
  status,
  categoria,
  engenheiro,
  empresa,
  valor_total,
  valor_executado,
  percentual_executado,
  aba_origem,
  ${RECURSO_SQL} AS recurso
`;

const STOPWORDS_ENTIDADE = new Set([
  "a", "as", "o", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "e", "ou", "em", "no", "na", "nos", "nas", "para", "por", "com", "sem", "que", "qual",
  "quais", "quanto", "quantos", "quantas", "tem", "tenho", "existe", "existem", "alguma", "algum",
  "algumas", "alguns", "obra", "obras", "registro", "registros", "servico", "servicos", "serviço",
  "serviços", "relacionada", "relacionadas", "relacionado", "relacionados", "cadastrada", "cadastradas",
  "cadastrado", "cadastrados", "mostra", "mostrar", "liste", "listar", "me", "diga", "ver", "sao",
  "são", "seus", "suas", "seu", "sua", "deles", "delas", "dele", "dela", "essas", "esses", "estas",
  "estes", "essa", "esse", "esta", "este", "mais", "menos", "maior", "menor", "geral", "base",
  "aparecem", "aparece", "informado", "informada", "informados", "informadas", "municipal", "municipais",
  "estao", "esta", "ficam", "fica", "usam", "usa", "utilizam", "utiliza", "acompanha", "acompanham", "cuida", "cuidam", "ja", "foi", "milhao", "milhoes", "mil",
]);

function semAcento(s = "") {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizar(s = "") {
  return semAcento(s).toLowerCase().replace(/[^a-z0-9%]+/g, " ").replace(/\s+/g, " ").trim();
}

function tituloScope(scope) {
  switch (scope) {
    case "obras": return "obras";
    case "obras_fisicas": return "obras";
    case "pavimentacoes": return "pavimentações";
    case "projetos": return "projetos";
    case "licitacoes": return "licitações";
    default: return "registros";
  }
}

function estadoVazio() {
  return {
    version: 2,
    scope: "todos",
    filters: {},
    entity: null,
    current_ids: [],
    focus: null,
    last_action: null,
    last_fields: [],
  };
}

function sanitizarEstado(raw) {
  const e = raw && typeof raw === "object" ? raw : {};
  return {
    version: 2,
    scope: SCOPES.has(e.scope) && e.scope !== "inherit" ? e.scope : "todos",
    filters: e.filters && typeof e.filters === "object" ? {
      bairro: valorTexto(e.filters.bairro),
      status: valorTexto(e.filters.status),
      engenheiro: valorTexto(e.filters.engenheiro),
      empresa: valorTexto(e.filters.empresa),
      recurso: valorTexto(e.filters.recurso),
    } : {},
    entity: valorTexto(e.entity),
    current_ids: Array.isArray(e.current_ids)
      ? e.current_ids.map((x) => String(x)).filter(Boolean).slice(0, MAX_IDS_ESTADO)
      : [],
    focus: sanitizarFocus(e.focus),
    last_action: ACTIONS.has(e.last_action) ? e.last_action : null,
    last_fields: Array.isArray(e.last_fields) ? e.last_fields.filter((x) => CAMPOS.has(x)).slice(0, 10) : [],
  };
}

function sanitizarFocus(f) {
  if (!f || typeof f !== "object") return null;
  if (f.kind === "registro" && f.id !== null && f.id !== undefined && String(f.id).trim()) {
    return { kind: "registro", id: String(f.id), label: valorTexto(f.label) };
  }
  if ((f.kind === "engenheiro" || f.kind === "empresa") && valorTexto(f.value)) {
    return { kind: f.kind, value: valorTexto(f.value) };
  }
  return null;
}

function valorTexto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 180) : null;
}

function extrairEstadoHistorico(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const h = historico[i];
    if (h?.role === "assistant" && h?.estado?.version === 2) {
      return sanitizarEstado(h.estado);
    }
  }
  return estadoVazio();
}

function historicoCurto(historico = []) {
  return historico
    .slice(-6)
    .map((h) => `${h.role === "user" ? "USUARIO" : "ASSISTENTE"}: ${String(h.content || "").slice(0, 500)}`)
    .join("\n");
}

function singularVariantes(termo) {
  const base = valorTexto(termo);
  if (!base) return [];
  const n = normalizar(base);
  const set = new Set([n]);

  // Pequena normalizacao linguistica apenas para busca textual. Nao cria regras por entidade.
  for (const p of n.split(" ")) {
    if (p.length > 4 && p.endsWith("oes")) set.add(p.slice(0, -3) + "ao");
    if (p.length > 4 && p.endsWith("aes")) set.add(p.slice(0, -3) + "ao");
    if (p.length > 4 && p.endsWith("is")) set.add(p.slice(0, -2) + "l");
    if (p.length > 3 && p.endsWith("s")) set.add(p.slice(0, -1));
  }

  return [...set].filter(Boolean).slice(0, 6);
}


function variantesPalavra(termo) {
  const n = normalizar(termo);
  if (!n) return [];
  const set = new Set([n]);
  if (n.length > 4 && n.endsWith("oes")) set.add(n.slice(0, -3) + "ao");
  if (n.length > 4 && n.endsWith("aes")) set.add(n.slice(0, -3) + "ao");
  if (n.length > 4 && n.endsWith("is")) set.add(n.slice(0, -2) + "l");
  if (n.length > 3 && n.endsWith("s")) set.add(n.slice(0, -1));
  return [...set].filter(Boolean).slice(0, 4);
}

function gruposBuscaEntidade(termo) {
  const tokens = normalizar(termo).split(" ").filter(Boolean).slice(0, 8);
  return tokens.map((t) => variantesPalavra(t)).filter((g) => g.length);
}

function extrairJson(texto) {
  const t = String(texto || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const ini = t.indexOf("{");
  const fim = t.lastIndexOf("}");
  if (ini < 0 || fim <= ini) throw new Error("IA nao devolveu JSON valido");
  return JSON.parse(t.slice(ini, fim + 1));
}


let cacheMetadados = { quando: 0, dados: null };
const CACHE_METADADOS_MS = 5 * 60 * 1000;

async function obterMetadadosLocais() {
  if (cacheMetadados.dados && Date.now() - cacheMetadados.quando < CACHE_METADADOS_MS) {
    return cacheMetadados.dados;
  }
  try {
    const r = await queryReadOnly(`
      SELECT
        COALESCE(ARRAY_AGG(DISTINCT bairro ORDER BY bairro) FILTER (WHERE bairro IS NOT NULL AND BTRIM(bairro) <> ''), ARRAY[]::text[]) AS bairros,
        COALESCE(ARRAY_AGG(DISTINCT engenheiro ORDER BY engenheiro) FILTER (WHERE engenheiro IS NOT NULL AND BTRIM(engenheiro) <> ''), ARRAY[]::text[]) AS engenheiros,
        COALESCE(ARRAY_AGG(DISTINCT empresa ORDER BY empresa) FILTER (WHERE empresa IS NOT NULL AND BTRIM(empresa) <> ''), ARRAY[]::text[]) AS empresas
      FROM obras
    `);
    const row = r.rows?.[0] || {};
    const dados = {
      bairros: Array.isArray(row.bairros) ? row.bairros : [],
      engenheiros: Array.isArray(row.engenheiros) ? row.engenheiros : [],
      empresas: Array.isArray(row.empresas) ? row.empresas : [],
    };
    cacheMetadados = { quando: Date.now(), dados };
    return dados;
  } catch {
    return { bairros: [], engenheiros: [], empresas: [] };
  }
}

function acharValorMencionado(pergunta, valores = []) {
  const q = ` ${normalizar(pergunta)} `;
  return [...valores]
    .filter(Boolean)
    .sort((a, b) => normalizar(b).length - normalizar(a).length)
    .find((v) => q.includes(` ${normalizar(v)} `)) || null;
}

const PROMPT_PLANO = `Voce interpreta perguntas sobre uma tabela municipal de obras.
Sua unica tarefa e devolver UM JSON de plano. Nunca escreva SQL e nunca responda a pergunta.

Escopos permitidos:
- obras = EM_ANDAMENTO + PAVIMENTAÇÃO (obras fisicas/pavimentacoes em geral)
- obras_fisicas = somente EM_ANDAMENTO
- pavimentacoes = somente PAVIMENTAÇÃO
- projetos = somente EM_PROJETO
- licitacoes = somente EM_LICITAÇÃO
- todos = todas as categorias
- inherit = manter o escopo anterior

Regras de negocio importantes:
- "obras em andamento" sem mencionar pavimentacao => obras_fisicas. Nao misture licitacoes.
- "obras concluidas" => obras e status concluido.
- "pavimentacoes em execucao" => pavimentacoes e status em execucao.
- Se a pessoa perguntar apenas por uma entidade, ex. "quantas UBS existem?", sem dizer obras/projetos, use todos.
- "habilitacao" em licitacoes e filtro de STATUS, nao nome da obra.
- Palavras como alguma, relacionada, cadastrada, existem, mostra, obras, registros sao linguagem; nao sao parte da entidade.
- Preserve a entidade util: drenagem, escola, praca, UBS, mercado etc. Nao invente sinonimos especificos.
- Perguntas com "essas/estas/dessas/delas/eles/deles" normalmente usam use_previous_set=true.
- Pergunta curta que apenas acrescenta um campo ou filtro ao assunto anterior, sem citar um assunto novo, tambem usa use_previous_set=true. Ex.: depois de listar obras concluidas, "quais usam recurso proprio?" continua no mesmo conjunto.
- "ela/ele" depois de escolher um registro usa use_focus="registro".
- "dele/dela" quando o foco e uma pessoa/empresa usa use_focus="pessoa" ou "empresa".
- Se a pergunta mudar claramente de assunto, nao herde o conjunto anterior.

Acoes permitidas:
- list: listar registros
- count: contar
- aggregate: soma/media de campo numerico
- extreme: registro com maior/menor valor de campo numerico
- group: agrupar/contar por engenheiro, empresa, bairro, status ou recurso
- detail: detalhes de um registro em foco
- exists: verificar existencia

Campos permitidos:
objeto,bairro,status,categoria,engenheiro,empresa,valor_total,valor_executado,percentual_executado,recurso,aba_origem

Formato EXATO:
{
  "scope":"inherit|obras|obras_fisicas|pavimentacoes|projetos|licitacoes|todos",
  "action":"list|count|aggregate|extreme|group|detail|exists",
  "use_previous_set":false,
  "use_focus":"none|registro|pessoa|empresa",
  "entity":null,
  "filters":{"bairro":null,"status":null,"engenheiro":null,"empresa":null,"recurso":null},
  "numeric_filters":[{"field":"percentual_executado","op":">","value":50}],
  "fields":["objeto"],
  "include_count":false,
  "include_list":false,
  "aggregate":{"fn":"sum|avg","field":"valor_total|valor_executado|percentual_executado"},
  "extreme":{"direction":"max|min","field":"valor_total|valor_executado|percentual_executado"},
  "group_by":null,
  "top":null,
  "limit":25
}

Use null para aggregate/extreme quando nao se aplicarem.
Para "qual engenheiro tem mais obras", use action=group, group_by=engenheiro, top=1.
Para "quais valores ... nelas", use action=aggregate, aggregate sum valor_total, include_list=true, use_previous_set=true.
Para "quantas X e quais sao", use action=list, include_count=true.
Para "qual o valor total e executado dela", use detail, use_focus=registro e fields apropriados.
Para comparacoes numericas como "mais de 50% executado" ou "acima de 1 milhao", use numeric_filters com numero real (1000000 para 1 milhao).`;

async function planejarComIA(pergunta, estado, historico) {
  const mensagens = [
    { role: "system", content: PROMPT_PLANO },
    {
      role: "user",
      content:
        `ESTADO ATUAL:\n${JSON.stringify(estado)}\n\n` +
        `HISTORICO CURTO:\n${historicoCurto(historico) || "(vazio)"}\n\n` +
        `PERGUNTA:\n${pergunta}\n\nDevolva apenas o JSON.`,
    },
  ];

  const bruto = await chamarIAbruta(mensagens, { max_tokens: 420, temperature: 0 });
  return extrairJson(bruto);
}

function detectarScopeLocal(q, estado) {
  if (/\blicita(c|ç)(a|ã)o|\blicitacoes\b|\blicitações\b/.test(q)) return "licitacoes";
  if (/\bprojeto(s)?\b/.test(q)) return "projetos";
  if (/\bpavimenta(c|ç)(a|ã)o|\bpavimentacoes\b|\bpavimentações\b|\brua(s)?\b/.test(q)) return "pavimentacoes";
  if (/\bobras?\s+em\s+andamento\b/.test(q)) return "obras_fisicas";
  if (/\bobras?\b|\bservicos?\b/.test(q)) return "obras";
  if (/\b(essas|esses|estas|estes|elas|eles|delas|deles|dessas|desses|ela|ele|dele|dela)\b/.test(q)) return "inherit";
  return "todos";
}

function extrairEntidadeLocal(pergunta) {
  const original = semAcento(pergunta).toLowerCase();
  const palavras = original
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((p) => !STOPWORDS_ENTIDADE.has(p))
    .filter((p) => !/^(concluid|concluida|concluido|finalizad|andamento|execucao|execucao|habilitacao|proprio|federal)$/.test(p))
    .filter((p) => !/^\d+$/.test(p));

  // Remove termos que normalmente sao campos/operacoes, nao assunto.
  const remove = new Set([
    "valor", "valores", "total", "investido", "investidos", "executado", "executados", "percentual",
    "recurso", "recursos", "engenheiro", "engenheiros", "responsavel", "responsaveis", "empresa", "empresas",
    "bairro", "bairros", "status", "situacao", "quantidade", "soma", "somam", "custam", "custa",
    "projeto", "projetos", "licitacao", "licitacoes", "pavimentacao", "pavimentacoes", "execucao",
    "andamento", "concluidas", "concluidos", "concluida", "concluido", "finalizados", "finalizadas",
    "proprio", "proprios", "federal", "federais",
  ]);

  const uteis = palavras.filter((p) => !remove.has(p));
  if (!uteis.length) return null;
  // Para evitar transformar frase inteira em ANDs impossiveis, entidade local e curta.
  return uteis.slice(-3).join(" ");
}

function numeroHumano(txt) {
  if (txt === null || txt === undefined) return null;
  const s = normalizar(txt).replace(/\s+/g, " ");
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*(milhao|milhoes|mil)?/);
  if (!m) return null;
  let n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (m[2] === "mil") n *= 1000;
  if (m[2] === "milhao" || m[2] === "milhoes") n *= 1000000;
  return n;
}

function extrairFiltrosNumericosLocal(q) {
  const regras = [
    { re: /(?:mais de|acima de|maior que|superior a)\s+([0-9.,]+\s*(?:milhao|milhoes|mil)?)(?:\s*%|\s*por cento)?/, op: ">" },
    { re: /(?:menos de|abaixo de|menor que|inferior a)\s+([0-9.,]+\s*(?:milhao|milhoes|mil)?)(?:\s*%|\s*por cento)?/, op: "<" },
  ];
  for (const r of regras) {
    const m = q.match(r.re);
    if (!m) continue;
    const value = numeroHumano(m[1]);
    if (value === null) continue;
    const field = /%|percentual|executad/.test(q) && !/valor executad/.test(q)
      ? "percentual_executado"
      : /valor executad/.test(q)
        ? "valor_executado"
        : "valor_total";
    return [{ field, op: r.op, value }];
  }
  return [];
}

function planejarLocal(pergunta, estado, metadados = {}) {
  const q = normalizar(pergunta);
  const pronomeConjunto = /\b(essas|esses|estas|estes|elas|eles|dessas|desses|delas|deles|nelas|neles|essas obras|esses registros)\b/.test(q);
  const pronomeRegistro = /\b(ela|ele|dela|dele)\b/.test(q) && estado.focus?.kind === "registro";
  const pronomePessoa = /\b(dele|dela)\b/.test(q) && ["engenheiro", "empresa"].includes(estado.focus?.kind);

  let action = "list";
  let include_count = false;
  let include_list = false;
  let aggregate = null;
  let extreme = null;
  let group_by = null;
  let top = null;

  if (/\b(quantas|quantos)\b/.test(q)) action = "count";
  if (/\b(?:quantas|quantos)\b.*\bquais\b/.test(q)) {
    action = "list";
    include_count = true;
  }
  if (/\b(existe|existem|tem alguma|tem algum)\b/.test(q) && !/\bquais\b/.test(q) && !/\b(quantas|quantos)\b/.test(q)) action = "exists";

  if (/\b(soma|somam|total dos valores|valor total|quanto.*valor|quanto.*investid|valores investid)\b/.test(q)) {
    action = "aggregate";
    aggregate = { fn: "sum", field: "valor_total" };
    include_list = /\b(valores|quais)\b/.test(q);
  }
  if (/\bquanto.*executad|total executad\b/.test(q)) {
    action = "aggregate";
    aggregate = { fn: "sum", field: "valor_executado" };
  }
  if (/\bqual (?:e |é )?o valor\b|\bquais (?:sao |são )?os valores\b|\bvalor dessas?\b|\bvalor deles?\b/.test(q)) {
    action = "aggregate";
    aggregate = { fn: "sum", field: "valor_total" };
    include_list = true;
  }

  if (/\b(maior|mais avancad[oa]s?|mais caro|maior valor)\b/.test(q)) {
    action = "extreme";
    extreme = {
      direction: "max",
      field: /avancad|percentual/.test(q) ? "percentual_executado" : "valor_total",
    };
  }
  if (/\b(menor|menos avancad[oa]s?|menor valor)\b/.test(q)) {
    action = "extreme";
    extreme = {
      direction: "min",
      field: /avancad|percentual/.test(q) ? "percentual_executado" : "valor_total",
    };
  }

  if (/\b(quem.*respons|quem cuida|responsaveis|responsáveis|engenheiros?)\b/.test(q)) {
    action = "group";
    group_by = "engenheiro";
    if (/\bmais obras|maior quantidade|mais registros\b/.test(q)) top = 1;
  }
  if (/\bqual engenheiro.*mais\b/.test(q)) {
    action = "group";
    group_by = "engenheiro";
    top = 1;
  }
  if (/\bempresa\b/.test(q) && /\b(mais obras|mais registros|aparece mais|maior quantidade)\b/.test(q)) {
    action = "group";
    group_by = "empresa";
    top = 1;
  }

  const fields = ["objeto"];
  if (/\brecurso/.test(q)) fields.push("recurso");
  if (/\bstatus|situacao/.test(q)) fields.push("status");
  if (/\bbairro/.test(q)) fields.push("bairro");
  if (/\bengenheiro|responsavel/.test(q)) fields.push("engenheiro");
  if (/\bempresa/.test(q)) fields.push("empresa");
  if (/\bvalor total|valor investid|valores investid|cust/.test(q)) fields.push("valor_total");
  if (/\bexecutad/.test(q) && !/%/.test(q)) fields.push("valor_executado");
  if (/%|\bpercentual|avancad/.test(q)) fields.push("percentual_executado");

  if (pronomeRegistro && (fields.length > 1 || /^qual\b/.test(q))) action = "detail";

  const filters = { bairro: null, status: null, engenheiro: null, empresa: null, recurso: null };

  const bairroConhecido = acharValorMencionado(pergunta, metadados.bairros || []);
  if (bairroConhecido) filters.bairro = bairroConhecido;
  else if (/\bcentro\b/.test(q)) filters.bairro = "Centro";

  const engenheiroConhecido = acharValorMencionado(pergunta, metadados.engenheiros || []);
  if (engenheiroConhecido) filters.engenheiro = engenheiroConhecido;
  const empresaConhecida = acharValorMencionado(pergunta, metadados.empresas || []);
  if (empresaConhecida) filters.empresa = empresaConhecida;

  if (/\bconclu|finalizad/.test(q)) filters.status = "conclu";
  if (/\bexecucao\b/.test(q)) filters.status = "execu";
  if (/\bhabilitacao\b/.test(q)) filters.status = "habilita";
  if (/\brecurso proprio\b|\bproprios\b/.test(q)) filters.recurso = "proprio";
  if (/\bfederal\b/.test(q) && /\brecurso/.test(q)) filters.recurso = "federal";

  const nomeResponsavel = pergunta.match(/\b(?:Eng\.|Arq\.)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ]+){1,3})/);
  if (!filters.engenheiro && nomeResponsavel && nomeResponsavel[1]) filters.engenheiro = nomeResponsavel[1].trim();

  let scope = detectarScopeLocal(q, estado);
  const referenciaPossessiva = estado.current_ids.length > 0 && /\b(seus|suas)\b/.test(q);
  const candidatoEntidade = extrairEntidadeLocal(pergunta);
  const categoriaExplicita = /\b(obras?|servicos?|projetos?|licitacao|licitacoes|pavimentacao|pavimentacoes)\b/.test(q);
  const perguntaDeContinuidade = /\b(recurso|recursos|valor|valores|bairro|status|responsavel|responsaveis|engenheiro|engenheiros|empresa|empresas|percentual|executad|quais|quanto|quem)\b/.test(q);
  const referenciaImplicita = estado.current_ids.length > 0 && !categoriaExplicita && !candidatoEntidade && perguntaDeContinuidade;
  const usaContexto = pronomeConjunto || referenciaPossessiva || referenciaImplicita || /\b(essas|esses|destas|destes)\b/.test(q);
  if (usaContexto && scope === "todos") scope = "inherit";
  const numeric_filters = extrairFiltrosNumericosLocal(q);
  let entity = usaContexto || pronomeRegistro || pronomePessoa ? null : candidatoEntidade;
  if (entity) {
    const ignorar = new Set();
    for (const v of [filters.engenheiro, filters.empresa, filters.bairro]) {
      if (v) for (const t of normalizar(v).split(" ")) ignorar.add(t);
    }
    const resto = normalizar(entity).split(" ").filter((t) => !ignorar.has(t) && t !== "eng" && t !== "arq");
    entity = resto.length ? resto.join(" ") : null;
  }

  return {
    scope,
    action,
    use_previous_set: usaContexto,
    use_focus: pronomeRegistro ? "registro" : pronomePessoa ? (estado.focus?.kind === "empresa" ? "empresa" : "pessoa") : "none",
    entity,
    filters,
    numeric_filters,
    fields: [...new Set(fields)],
    include_count,
    include_list,
    aggregate,
    extreme,
    group_by,
    top,
    limit: 25,
    _fallback: true,
  };
}

function sanitizarPlano(raw, estado, pergunta) {
  const p = raw && typeof raw === "object" ? raw : {};
  const plano = {
    scope: SCOPES.has(p.scope) ? p.scope : "inherit",
    action: ACTIONS.has(p.action) ? p.action : "list",
    use_previous_set: Boolean(p.use_previous_set),
    use_focus: ["none", "registro", "pessoa", "empresa"].includes(p.use_focus) ? p.use_focus : "none",
    entity: valorTexto(p.entity),
    filters: {
      bairro: valorTexto(p.filters?.bairro),
      status: valorTexto(p.filters?.status),
      engenheiro: valorTexto(p.filters?.engenheiro),
      empresa: valorTexto(p.filters?.empresa),
      recurso: valorTexto(p.filters?.recurso),
    },
    numeric_filters: Array.isArray(p.numeric_filters)
      ? p.numeric_filters
          .filter((x) => x && CAMPOS_NUMERICOS.has(x.field) && [">", ">=", "<", "<=", "="].includes(x.op) && Number.isFinite(Number(x.value)))
          .slice(0, 4)
          .map((x) => ({ field: x.field, op: x.op, value: Number(x.value) }))
      : [],
    fields: Array.isArray(p.fields) ? p.fields.filter((x) => CAMPOS.has(x)).slice(0, 10) : ["objeto"],
    include_count: Boolean(p.include_count),
    include_list: Boolean(p.include_list),
    aggregate: null,
    extreme: null,
    group_by: CAMPOS_GRUPO.has(p.group_by) ? p.group_by : null,
    top: p.top !== null && p.top !== undefined && Number.isFinite(Number(p.top)) ? Math.max(1, Math.min(Number(p.top), 20)) : null,
    limit: Number.isFinite(Number(p.limit)) ? Math.max(1, Math.min(Number(p.limit), MAX_ITENS_RESPOSTA)) : MAX_ITENS_RESPOSTA,
  };

  if (p.aggregate && ["sum", "avg"].includes(p.aggregate.fn) && CAMPOS_NUMERICOS.has(p.aggregate.field)) {
    plano.aggregate = { fn: p.aggregate.fn, field: p.aggregate.field };
  }
  if (p.extreme && ["max", "min"].includes(p.extreme.direction) && CAMPOS_NUMERICOS.has(p.extreme.field)) {
    plano.extreme = { direction: p.extreme.direction, field: p.extreme.field };
  }

  if (!plano.fields.length) plano.fields = ["objeto"];
  if (!plano.fields.includes("objeto")) plano.fields.unshift("objeto");

  // Protecoes semanticas deterministicas para os erros observados nos testes.
  const q = normalizar(pergunta);
  if (/\b(quantas|quantos)\b/.test(q) && /\bquais\b/.test(q)) {
    plano.action = "list";
    plano.include_count = true;
  } else if (/\b(quantas|quantos)\b/.test(q)) {
    plano.action = "count";
  }
  const categoriaExplicita = /\b(obras?|servicos?|projetos?|licitacao|licitacoes|pavimentacao|pavimentacoes)\b/.test(q);
  const temFiltroNovo = Object.values(plano.filters || {}).some(Boolean) || (plano.numeric_filters || []).length > 0;
  const pedeCampo = plano.fields.some((f) => f !== "objeto") || ["aggregate", "extreme", "group", "detail"].includes(plano.action);
  if (estado.current_ids.length && !plano.use_previous_set && plano.use_focus === "none" &&
      !categoriaExplicita && !plano.entity && (temFiltroNovo || pedeCampo || /\b(quais|quanto|quem)\b/.test(q))) {
    plano.use_previous_set = true;
    plano.scope = "inherit";
  }
  // Follow-ups singulares usam o foco estruturado, independentemente do que a IA sugerir.
  // Isso evita que "qual o responsável por ela?" volte para todo o conjunto anterior.
  const referenciaRegistro = estado.focus?.kind === "registro" && /\b(ela|ele|dela|dele)\b/.test(q);
  if (referenciaRegistro) {
    plano.use_focus = "registro";
    plano.use_previous_set = false;
    plano.scope = "inherit";
    plano.entity = null;
    if (/\brespons/.test(q)) {
      plano.action = "detail";
      if (!plano.fields.includes("engenheiro")) plano.fields.push("engenheiro");
    }
    if (/\bempresa\b/.test(q)) {
      plano.action = "detail";
      if (!plano.fields.includes("empresa")) plano.fields.push("empresa");
    }
    if (/\brecurso/.test(q)) {
      plano.action = "detail";
      if (!plano.fields.includes("recurso")) plano.fields.push("recurso");
    }
    if (/\bstatus|situacao\b/.test(q)) {
      plano.action = "detail";
      if (!plano.fields.includes("status")) plano.fields.push("status");
    }
  }

  // Quando o foco e um engenheiro/empresa, "dele/dela" aponta para esse foco,
  // e nao para o ultimo subconjunto filtrado. Ex.: ranking -> obras dele -> concluidas -> valores dele.
  if (!referenciaRegistro && /\b(dele|dela)\b/.test(q) && estado.focus?.kind === "engenheiro") {
    plano.use_focus = "pessoa";
    plano.use_previous_set = false;
    plano.scope = "inherit";
    plano.entity = null;
  }
  if (!referenciaRegistro && /\b(dele|dela)\b/.test(q) && estado.focus?.kind === "empresa") {
    plano.use_focus = "empresa";
    plano.use_previous_set = false;
    plano.scope = "inherit";
    plano.entity = null;
  }

  if (/\bobras?\s+em\s+andamento\b/.test(q)) {
    plano.scope = "obras_fisicas";
    plano.filters.status = null; // a aba EM_ANDAMENTO ja define o recorte de negocio
  }
  if (/\bobras?\s+conclu/.test(q)) {
    plano.scope = "obras";
    plano.filters.status = plano.filters.status || "conclu";
  }
  if (/\bpavimenta/.test(q) && /\bexecu/.test(q)) {
    plano.scope = "pavimentacoes";
    plano.filters.status = plano.filters.status || "execu";
  }
  if (/\blicita/.test(q) && /\bhabilita/.test(q)) {
    plano.scope = "licitacoes";
    plano.filters.status = plano.filters.status || "habilita";
    if (plano.entity && normalizar(plano.entity).includes("habilita")) plano.entity = null;
  }
  if (/\b(mostra|liste|quais)\b/.test(q) && /\brespons/.test(q) && plano.entity) {
    plano.action = "list";
    if (!plano.fields.includes("engenheiro")) plano.fields.push("engenheiro");
    plano.group_by = null;
    plano.top = null;
  }

  if (plano.entity && plano.filters.bairro) {
    const e = normalizar(plano.entity);
    const b = normalizar(plano.filters.bairro);
    if (e === b || e.includes(b) || b.includes(e)) plano.entity = null;
  }
  if (plano.entity && plano.filters.engenheiro) {
    const ignorar = new Set(normalizar(plano.filters.engenheiro).split(" "));
    const resto = normalizar(plano.entity).split(" ").filter((t) => !ignorar.has(t) && t !== "eng" && t !== "arq");
    plano.entity = resto.length ? resto.join(" ") : null;
  }

  // Nao deixe palavras conversacionais virarem entidade mesmo se a IA exagerar.
  if (plano.entity) {
    const toks = normalizar(plano.entity).split(" ").filter(Boolean);
    const limpos = toks.filter((t) => !STOPWORDS_ENTIDADE.has(t));
    plano.entity = limpos.length ? limpos.join(" ") : null;
  }

  // Se a IA pediu heranca sem haver conjunto, cai para o escopo semantico anterior.
  if (plano.use_previous_set && !estado.current_ids.length) plano.use_previous_set = false;
  if (plano.use_focus === "registro" && estado.focus?.kind !== "registro") plano.use_focus = "none";
  if (plano.use_focus === "pessoa" && estado.focus?.kind !== "engenheiro") plano.use_focus = "none";
  if (plano.use_focus === "empresa" && estado.focus?.kind !== "empresa") plano.use_focus = "none";

  if (plano.action === "aggregate" && !plano.aggregate) {
    plano.aggregate = { fn: "sum", field: "valor_total" };
  }
  if (plano.action === "extreme" && !plano.extreme) {
    plano.extreme = { direction: "max", field: "valor_total" };
  }
  if (plano.action === "group" && !plano.group_by) plano.group_by = "engenheiro";

  return plano;
}

function addParam(ctx, valor) {
  ctx.params.push(valor);
  return `$${ctx.params.length}`;
}

function escopoEfetivo(plano, estado) {
  if (plano.scope !== "inherit") return plano.scope;
  return estado.scope || "todos";
}

function whereDoPlano(plano, estado) {
  const ctx = { clauses: [], params: [] };
  const scope = escopoEfetivo(plano, estado);

  // Base do recorte: item focado, conjunto anterior ou novo escopo.
  if (plano.use_focus === "registro" && estado.focus?.kind === "registro") {
    ctx.clauses.push(`id::text = ${addParam(ctx, String(estado.focus.id))}`);
  } else if (plano.use_previous_set && estado.current_ids.length) {
    ctx.clauses.push(`id::text = ANY(${addParam(ctx, estado.current_ids)}::text[])`);
  } else {
    if (scope === "obras") ctx.clauses.push(`aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')`);
    else if (scope === "obras_fisicas") ctx.clauses.push(`aba_origem = 'EM_ANDAMENTO'`);
    else if (scope === "pavimentacoes") ctx.clauses.push(`aba_origem = 'PAVIMENTAÇÃO'`);
    else if (scope === "projetos") ctx.clauses.push(`aba_origem = 'EM_PROJETO'`);
    else if (scope === "licitacoes") ctx.clauses.push(`aba_origem = 'EM_LICITAÇÃO'`);
  }

  // Foco em pessoa/empresa cria recorte dentro do escopo atual.
  if (plano.use_focus === "pessoa" && estado.focus?.kind === "engenheiro") {
    ctx.clauses.push(`unaccent(COALESCE(engenheiro,'')) = unaccent(${addParam(ctx, estado.focus.value)})`);
  }
  if (plano.use_focus === "empresa" && estado.focus?.kind === "empresa") {
    ctx.clauses.push(`unaccent(COALESCE(empresa,'')) = unaccent(${addParam(ctx, estado.focus.value)})`);
  }

  if (plano.entity) {
    const grupos = gruposBuscaEntidade(plano.entity);
    if (grupos.length) {
      const ands = grupos.map((variantes) => {
        const ors = variantes.map((v) => `unaccent(COALESCE(objeto,'')) ILIKE unaccent(${addParam(ctx, `%${v}%`)})`);
        return `(${ors.join(" OR ")})`;
      });
      ctx.clauses.push(`(${ands.join(" AND ")})`);
    }
  }

  // Filtros novos sempre se aplicam, inclusive sobre current_ids.
  const f = plano.filters || {};
  if (f.bairro) {
    ctx.clauses.push(`unaccent(COALESCE(bairro,'')) ILIKE unaccent(${addParam(ctx, `%${f.bairro}%`)})`);
  }
  if (f.status) {
    const p = addParam(ctx, `%${f.status}%`);
    ctx.clauses.push(`(unaccent(COALESCE(status,'')) ILIKE unaccent(${p}) OR unaccent(${STATUS_ORIGINAL_SQL}) ILIKE unaccent(${p}))`);
  }
  if (f.engenheiro) {
    ctx.clauses.push(`unaccent(COALESCE(engenheiro,'')) ILIKE unaccent(${addParam(ctx, `%${f.engenheiro}%`)})`);
  }
  if (f.empresa) {
    ctx.clauses.push(`unaccent(COALESCE(empresa,'')) ILIKE unaccent(${addParam(ctx, `%${f.empresa}%`)})`);
  }
  if (f.recurso) {
    ctx.clauses.push(`unaccent(${RECURSO_SQL}) ILIKE unaccent(${addParam(ctx, `%${f.recurso}%`)})`);
  }

  for (const nf of plano.numeric_filters || []) {
    ctx.clauses.push(`${nf.field} ${nf.op} ${addParam(ctx, nf.value)}`);
  }

  return {
    where: ctx.clauses.length ? `WHERE ${ctx.clauses.join(" AND ")}` : "",
    params: ctx.params,
    scope,
  };
}

async function executarPlano(plano, estado) {
  const w = whereDoPlano(plano, estado);
  const sql = `SELECT ${SELECT_BASE} FROM obras ${w.where} ORDER BY objeto LIMIT ${MAX_LINHAS_SQL}`;
  const r = await queryReadOnly(sql, w.params);
  return { rows: r.rows || [], sql, params: w.params, scope: w.scope };
}

function numero(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moeda(v) {
  const n = numero(v);
  if (n === null) return "não informado";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function percentual(v) {
  const n = numero(v);
  if (n === null) return "não informado";
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

function valorCampo(row, campo) {
  switch (campo) {
    case "valor_total": return moeda(row.valor_total);
    case "valor_executado": return moeda(row.valor_executado);
    case "percentual_executado": return percentual(row.percentual_executado);
    case "recurso": return row.recurso || "Não informado";
    default: return row[campo] || "Não informado";
  }
}

function rotuloCampo(campo) {
  return ({
    bairro: "bairro",
    status: "status",
    categoria: "categoria",
    engenheiro: "responsável",
    empresa: "empresa",
    valor_total: "valor total",
    valor_executado: "valor executado",
    percentual_executado: "% executado",
    recurso: "recurso",
    aba_origem: "origem",
  })[campo] || campo;
}

function linhaRegistro(row, fields = ["objeto"]) {
  const extras = fields
    .filter((f) => f !== "objeto")
    .map((f) => `${rotuloCampo(f)}: ${valorCampo(row, f)}`);
  return `• ${row.objeto || "Sem nome"}${extras.length ? ` — ${extras.join("; ")}` : ""}`;
}

function resumoSemResultado(plano, scope) {
  if (plano.entity) return `Não encontrei registros relacionados a “${plano.entity}” nesse recorte.`;
  return `Não encontrei ${tituloScope(scope)} com esse critério.`;
}

function formatarPlano(pergunta, plano, rows, scope, estadoAnterior) {
  if (!rows.length) {
    return { resposta: resumoSemResultado(plano, scope), focus: null };
  }

  const total = rows.length;
  const noun = tituloScope(scope);

  if (plano.action === "exists") {
    const lista = rows.slice(0, Math.min(plano.limit, 10)).map((r) => linhaRegistro(r, plano.fields)).join("\n");
    return {
      resposta: `Sim. Encontrei ${total} ${total === 1 ? "registro" : "registros"}.${plano.include_list ? `\n\n${lista}` : ""}`,
      focus: total === 1 ? { kind: "registro", id: String(rows[0].id), label: rows[0].objeto } : null,
    };
  }

  if (plano.action === "count") {
    const alvo = plano.entity ? `registros relacionados a “${plano.entity}”` : noun;
    return {
      resposta: `Encontrei ${total} ${alvo}.`,
      focus: null,
    };
  }

  if (plano.action === "aggregate") {
    const { fn, field } = plano.aggregate;
    const nums = rows.map((r) => numero(r[field])).filter((n) => n !== null);
    if (!nums.length) return { resposta: `Os registros foram encontrados, mas não há valores informados para ${rotuloCampo(field)}.`, focus: null };
    const val = fn === "avg" ? nums.reduce((a, b) => a + b, 0) / nums.length : nums.reduce((a, b) => a + b, 0);
    const formatado = field === "percentual_executado" ? percentual(val) : moeda(val);
    const titulo = fn === "avg" ? "Média" : "Total";
    let resposta = `${titulo} de ${rotuloCampo(field)}: ${formatado}.`;
    if (plano.include_list) {
      const camposLista = [...new Set(["objeto", field, ...plano.fields])];
      resposta += `\n\n${rows.slice(0, plano.limit).map((r) => linhaRegistro(r, camposLista)).join("\n")}`;
      if (rows.length > plano.limit) resposta += `\n\nMostrando ${plano.limit} de ${rows.length} registros.`;
    }
    return { resposta, focus: null };
  }

  if (plano.action === "extreme") {
    const { direction, field } = plano.extreme;
    const validas = rows.filter((r) => numero(r[field]) !== null);
    if (!validas.length) return { resposta: `Não há ${rotuloCampo(field)} informado nesse recorte.`, focus: null };
    validas.sort((a, b) => direction === "max" ? numero(b[field]) - numero(a[field]) : numero(a[field]) - numero(b[field]));
    const x = validas[0];
    const fields = [...new Set(["objeto", field, ...plano.fields])];
    return {
      resposta: linhaRegistro(x, fields),
      focus: { kind: "registro", id: String(x.id), label: x.objeto },
      current_ids: [String(x.id)],
    };
  }

  if (plano.action === "group") {
    const campo = plano.group_by || "engenheiro";
    const mapa = new Map();
    for (const r of rows) {
      const chave = String(r[campo] || "").trim();
      if (!chave) continue;
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave).push(r);
    }
    let grupos = [...mapa.entries()].map(([nome, itens]) => ({ nome, itens, total: itens.length }));
    grupos.sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR"));
    if (plano.top) grupos = grupos.slice(0, plano.top);
    if (!grupos.length) return { resposta: `Não há ${rotuloCampo(campo)} informado nesse recorte.`, focus: null };

    if (plano.top === 1) {
      const g = grupos[0];
      const tipo = campo === "engenheiro" ? "engenheiro" : campo === "empresa" ? "empresa" : null;
      return {
        resposta: `• ${g.nome} — ${g.total} ${g.total === 1 ? "registro" : noun}`,
        focus: tipo ? { kind: tipo, value: g.nome } : estadoAnterior.focus,
        current_ids: g.itens.map((r) => String(r.id)).filter(Boolean).slice(0, MAX_IDS_ESTADO),
      };
    }

    const resposta = grupos
      .slice(0, plano.limit)
      .map((g) => {
        const itens = g.itens.slice(0, 10).map((r) => `  - ${r.objeto}`).join("\n");
        const resto = g.itens.length > 10 ? `\n  - ... e mais ${g.itens.length - 10}` : "";
        return `• ${g.nome} — ${g.total} ${g.total === 1 ? "registro" : "registros"}\n${itens}${resto}`;
      })
      .join("\n\n");
    return { resposta: `Encontrei ${grupos.length} grupos em ${rows.length} registros:\n\n${resposta}`, focus: null };
  }

  if (plano.action === "detail") {
    const x = rows[0];
    const fields = plano.fields.length > 1 ? plano.fields : ["objeto", "bairro", "status", "engenheiro", "empresa", "valor_total", "valor_executado", "percentual_executado", "recurso"];
    return {
      resposta: linhaRegistro(x, fields),
      focus: { kind: "registro", id: String(x.id), label: x.objeto },
      current_ids: [String(x.id)],
    };
  }

  // list
  const limite = Math.min(plano.limit, MAX_ITENS_RESPOSTA);
  const linhas = rows.slice(0, limite).map((r) => linhaRegistro(r, plano.fields)).join("\n");
  let cabecalho = "";
  if (plano.include_count) cabecalho = `Encontrei ${total} ${plano.entity ? `registros relacionados a “${plano.entity}”` : noun}:\n\n`;
  let resposta = `${cabecalho}${linhas}`;
  if (!plano.include_count) resposta += `\n\nTotal: ${total}.`;
  if (rows.length > limite) resposta += `\nMostrando ${limite} de ${rows.length}.`;
  return {
    resposta,
    focus: rows.length === 1 ? { kind: "registro", id: String(rows[0].id), label: rows[0].objeto } : null,
  };
}

function novoEstado(estadoAnterior, plano, rows, scope, focusNovo, currentIdsNovo = null) {
  const herdaConjunto = plano.use_previous_set;
  const novosFiltros = Object.fromEntries(Object.entries(plano.filters || {}).filter(([, v]) => v));
  const filtros = herdaConjunto ? { ...estadoAnterior.filters, ...novosFiltros } : { ...novosFiltros };
  const entity = herdaConjunto ? estadoAnterior.entity : plano.entity;
  const consultaFresca = !plano.use_previous_set && plano.use_focus === "none";
  const ids = Array.isArray(currentIdsNovo)
    ? currentIdsNovo.map(String).filter(Boolean).slice(0, MAX_IDS_ESTADO)
    : rows.map((r) => String(r.id)).filter(Boolean).slice(0, MAX_IDS_ESTADO);
  // Resultado vazio nunca deve manter um foco antigo, pois isso faria o proximo pronome
  // apontar para um registro/pessoa que nao pertence ao resultado mais recente.
  const focoFinal = rows.length === 0 ? null : (focusNovo || (consultaFresca ? null : estadoAnterior.focus));

  return sanitizarEstado({
    version: 2,
    scope,
    filters: filtros,
    entity,
    current_ids: ids,
    focus: focoFinal,
    last_action: plano.action,
    last_fields: plano.fields,
  });
}

async function obterPlano(pergunta, estado, historico) {
  try {
    const ia = await planejarComIA(pergunta, estado, historico);
    return { plano: sanitizarPlano(ia, estado, pergunta), origem: "ia" };
  } catch (e) {
    console.warn("AGENTE V2: planejador IA indisponivel, usando fallback local:", e.message);
    const metadados = await obterMetadadosLocais();
    return { plano: sanitizarPlano(planejarLocal(pergunta, estado, metadados), estado, pergunta), origem: "local" };
  }
}

export async function responderPergunta(pergunta, historico = []) {
  const texto = valorTexto(pergunta);
  if (!texto) {
    return {
      resposta: "Envie uma pergunta sobre as obras, projetos, pavimentações ou licitações.",
      sql: null,
      linhas: 0,
      estado: extrairEstadoHistorico(historico),
    };
  }

  const estadoAnterior = extrairEstadoHistorico(historico);

  try {
    const { plano, origem } = await obterPlano(texto, estadoAnterior, historico);
    const exec = await executarPlano(plano, estadoAnterior);
    const fmt = formatarPlano(texto, plano, exec.rows, exec.scope, estadoAnterior);
    const estado = novoEstado(estadoAnterior, plano, exec.rows, exec.scope, fmt.focus, fmt.current_ids || null);

    return {
      resposta: fmt.resposta,
      sql: exec.sql,
      linhas: exec.rows.length,
      erro: null,
      estado,
      plano,
      planejador: origem,
    };
  } catch (e) {
    console.error("AGENTE V2 erro:", e);
    return {
      resposta: "Não consegui consultar os dados com segurança agora. Tente novamente em instantes.",
      sql: null,
      linhas: null,
      erro: e.message,
      estado: estadoAnterior,
    };
  }
}

// Exportados apenas para teste local/regressao. Nao sao usados pelo servidor.
export const __v2 = {
  normalizar,
  planejarLocal,
  sanitizarPlano,
  singularVariantes,
  gruposBuscaEntidade,
  estadoVazio,
  whereDoPlano,
  formatarPlano,
  novoEstado,
};
