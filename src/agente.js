// ============================================================
// agente.js - AGENTE NOVO PEQUENO, COM FERRAMENTAS DETERMINISTICAS
// ============================================================
// Ideia central:
//   1) A IA NAO escreve SQL.
//   2) A IA transforma linguagem livre em um PLANO JSON pequeno.
//   3) O Node executa uma entre poucas ferramentas deterministicas.
//   4) Toda consulta ao PostgreSQL e parametrizada e somente leitura.
//   5) Os calculos (contagem, soma, ranking, comparacao) sao feitos pelo Node
//      sobre dados REAIS retornados do banco.
//
// Compatibilidade:
//   - Mantem a mesma exportacao: responderPergunta(pergunta, historico)
//   - Usa somente os arquivos que o projeto ja possui: db.js e groq.js
//   - Nao usa agent_patterns e nao aprende frases automaticamente.
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js";

const MAX_LINHAS_FERRAMENTA = Math.max(200, Math.min(Number(process.env.AGENTE_MAX_LINHAS || 5000), 10000));
const MAX_LISTA_RESPOSTA = Math.max(5, Math.min(Number(process.env.AGENTE_MAX_LISTA || 20), 40));
const CACHE_CATALOGO_MS = 5 * 60 * 1000;

const ACOES = new Set([
  "contar",
  "listar",
  "somar",
  "ranking",
  "comparar",
  "consultar_campo",
  "descrever",
  "buscar",
  "esclarecer",
]);

const ESCOPOS = new Set(["obras", "projetos", "pavimentacoes", "licitacoes", "registros"]);
const AGRUPAMENTOS = new Set(["engenheiro", "empresa", "bairro", "status", "categoria", "recurso"]);
const METRICAS = new Set([
  "quantidade",
  "valor_total",
  "valor_executado",
  "percentual_executado",
  "saldo_devedor",
]);
const CAMPOS_CONTAGEM = new Set(["registros", "engenheiro", "empresa", "bairro"]);
const CAMPOS = new Set([
  "objeto",
  "status",
  "categoria",
  "bairro",
  "engenheiro",
  "empresa",
  "valor_total",
  "valor_executado",
  "percentual_executado",
  "aba_origem",
  "recurso",
  "tipo_recurso",
  "contrato",
  "convenio",
  "aditivo",
  "data_inicio",
  "data_prev_termino",
  "saldo_devedor",
  "quanto_falta",
  "observacoes",
  "campo_extra",
]);

const CAMPOS_BASE_SELECT = [
  "id",
  "objeto",
  "bairro",
  "status",
  "categoria",
  "valor_total",
  "valor_executado",
  "percentual_executado",
  "engenheiro",
  "empresa",
  "aba_origem",
  "dados_extras",
];

let cacheCatalogo = { quando: 0, dados: null };

function normalizar(s = "") {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%./\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textoSeguro(s = "", max = 240) {
  return String(s ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function numero(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moeda(v) {
  const n = numero(v);
  if (n === null) return "não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function percentual(v) {
  const n = numero(v);
  if (n === null) return "não informado";
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(n)}%`;
}

function valorFormatado(campo, v) {
  if (["valor_total", "valor_executado", "saldo_devedor", "quanto_falta"].includes(campo)) return moeda(v);
  if (campo === "percentual_executado") return percentual(v);
  if (v === null || v === undefined || v === "") return "não informado";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function singularEscopo(escopo = "registros") {
  return {
    obras: "obra",
    projetos: "projeto",
    pavimentacoes: "pavimentação",
    licitacoes: "licitação",
    registros: "registro",
  }[escopo] || "registro";
}

function pluralEscopo(escopo = "registros") {
  return {
    obras: "obras",
    projetos: "projetos",
    pavimentacoes: "pavimentações",
    licitacoes: "licitações",
    registros: "registros",
  }[escopo] || "registros";
}

function respostaSocial(pergunta = "") {
  const p = normalizar(pergunta);
  if (/^(oi|ola|opa|e ai|bom dia|boa tarde|boa noite)[!. ]*$/.test(p)) {
    return "Olá! Pode me perguntar sobre obras, projetos, pavimentações, licitações, valores, responsáveis e andamento.";
  }
  if (/^(obrigad[oa]|valeu|vlw|show|blz|beleza)[!. ]*$/.test(p)) return "Por nada! Se quiser, pode fazer outra pergunta sobre os dados.";
  return null;
}

async function carregarCatalogo() {
  const agora = Date.now();
  if (cacheCatalogo.dados && agora - cacheCatalogo.quando < CACHE_CATALOGO_MS) return cacheCatalogo.dados;

  const [basicos, objetos, extras] = await Promise.all([
    queryReadOnly(`
      SELECT campo, valor FROM (
        SELECT 'status'::text AS campo, status::text AS valor FROM obras WHERE status IS NOT NULL AND BTRIM(status::text) <> ''
        UNION
        SELECT 'categoria', categoria::text FROM obras WHERE categoria IS NOT NULL AND BTRIM(categoria::text) <> ''
        UNION
        SELECT 'bairro', bairro::text FROM obras WHERE bairro IS NOT NULL AND BTRIM(bairro::text) <> ''
        UNION
        SELECT 'engenheiro', engenheiro::text FROM obras WHERE engenheiro IS NOT NULL AND BTRIM(engenheiro::text) <> ''
        UNION
        SELECT 'empresa', empresa::text FROM obras WHERE empresa IS NOT NULL AND BTRIM(empresa::text) <> ''
        UNION
        SELECT 'aba_origem', aba_origem::text FROM obras WHERE aba_origem IS NOT NULL AND BTRIM(aba_origem::text) <> ''
      ) x
      ORDER BY campo, valor
    `),
    queryReadOnly(`SELECT DISTINCT objeto FROM obras WHERE objeto IS NOT NULL AND BTRIM(objeto) <> '' ORDER BY objeto LIMIT 120`),
    queryReadOnly(`
      SELECT DISTINCT jsonb_object_keys(COALESCE(dados_extras, '{}'::jsonb)) AS chave
      FROM obras
      ORDER BY chave
      LIMIT 120
    `),
  ]);

  const dados = {
    status: [], categoria: [], bairro: [], engenheiro: [], empresa: [], aba_origem: [],
    objetos: objetos.rows.map((r) => r.objeto).filter(Boolean),
    chaves_extras: extras.rows.map((r) => r.chave).filter(Boolean),
  };
  for (const r of basicos.rows) {
    if (dados[r.campo]) dados[r.campo].push(r.valor);
  }

  cacheCatalogo = { quando: agora, dados };
  return dados;
}

function resumoHistorico(historico = []) {
  if (!Array.isArray(historico) || !historico.length) return "(sem conversa anterior)";
  return historico.slice(-6).map((m) => {
    const papel = m?.role === "assistant" ? "BOT" : "USUARIO";
    const conteudo = textoSeguro(m?.content || "", 350);
    const sql = m?.role === "assistant" && m?.sql ? ` | consulta anterior: ${textoSeguro(m.sql, 500)}` : "";
    return `${papel}: ${conteudo}${sql}`;
  }).join("\n");
}

function catalogoParaPrompt(c = {}) {
  const resumir = (arr, max = 35) => (arr || []).slice(0, max).join(" | ") || "(nenhum)";
  return [
    `STATUS REAIS: ${resumir(c.status, 35)}`,
    `BAIRROS REAIS: ${resumir(c.bairro, 40)}`,
    `ENGENHEIROS REAIS: ${resumir(c.engenheiro, 40)}`,
    `EMPRESAS REAIS: ${resumir(c.empresa, 30)}`,
    `CATEGORIAS REAIS: ${resumir(c.categoria, 30)}`,
    `ORIGENS REAIS: ${resumir(c.aba_origem, 10)}`,
    `OBJETOS/NOMES REAIS: ${resumir(c.objetos, 80)}`,
    `CHAVES JSON REAIS: ${resumir(c.chaves_extras, 100)}`,
  ].join("\n");
}

function extrairJSON(texto = "") {
  const t = String(texto || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const ini = t.indexOf("{");
  const fim = t.lastIndexOf("}");
  if (ini >= 0 && fim > ini) {
    try { return JSON.parse(t.slice(ini, fim + 1)); } catch {}
  }
  return null;
}

function sanitizarPlano(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const acao = ACOES.has(raw.acao) ? raw.acao : null;
  if (!acao) return null;

  const escopo = ESCOPOS.has(raw.escopo) ? raw.escopo : "registros";
  const filtrosRaw = raw.filtros && typeof raw.filtros === "object" ? raw.filtros : {};
  const filtros = {
    status: textoSeguro(filtrosRaw.status || "", 100),
    bairro: textoSeguro(filtrosRaw.bairro || "", 100),
    engenheiro: textoSeguro(filtrosRaw.engenheiro || "", 120),
    empresa: textoSeguro(filtrosRaw.empresa || "", 160),
    recurso: textoSeguro(filtrosRaw.recurso || "", 120),
    alvo: textoSeguro(filtrosRaw.alvo || "", 180),
    valor_total_min: numero(filtrosRaw.valor_total_min),
    valor_total_max: numero(filtrosRaw.valor_total_max),
    valor_executado_min: numero(filtrosRaw.valor_executado_min),
    valor_executado_max: numero(filtrosRaw.valor_executado_max),
    percentual_min: numero(filtrosRaw.percentual_min),
    percentual_max: numero(filtrosRaw.percentual_max),
  };

  const campos = [...new Set((Array.isArray(raw.campos) ? raw.campos : [])
    .map((x) => String(x || "").trim())
    .filter((x) => CAMPOS.has(x)))].slice(0, 8);

  let campo = CAMPOS.has(raw.campo) ? raw.campo : (campos[0] || null);
  if (campo && !campos.includes(campo)) campos.unshift(campo);

  return {
    acao,
    escopo,
    filtros,
    campos,
    campo,
    campo_extra: textoSeguro(raw.campo_extra || "", 120),
    campo_contagem: CAMPOS_CONTAGEM.has(raw.campo_contagem) ? raw.campo_contagem : "registros",
    metrica: METRICAS.has(raw.metrica) ? raw.metrica : "quantidade",
    agrupar_por: AGRUPAMENTOS.has(raw.agrupar_por) ? raw.agrupar_por : null,
    ordem: raw.ordem === "menor" ? "menor" : "maior",
    incluir_contagem: raw.incluir_contagem === true,
    incluir_lista: raw.incluir_lista === true,
    usar_contexto: raw.usar_contexto === true,
    pergunta_esclarecimento: textoSeguro(raw.pergunta_esclarecimento || "", 220),
  };
}

function validarPlano(plano) {
  if (!plano) return "plano ausente";
  if (plano.acao === "ranking" && !plano.agrupar_por) return "ranking precisa de agrupar_por";
  if (plano.acao === "comparar" && !METRICAS.has(plano.metrica)) return "comparar precisa de metrica";
  if (plano.acao === "somar" && !["valor_total", "valor_executado", "saldo_devedor"].includes(plano.metrica)) {
    return "somar precisa usar valor_total, valor_executado ou saldo_devedor";
  }
  if (plano.acao === "consultar_campo" && !plano.campos.length && !plano.campo_extra) {
    return "consultar_campo precisa indicar ao menos um campo";
  }
  return null;
}

async function planejar(pergunta, historico, catalogo) {
  const base = `Você é o PLANEJADOR de um chatbot de obras públicas.\n` +
    `Sua única função é converter a mensagem em UM PLANO JSON. NÃO escreva SQL e NÃO responda ao usuário.\n\n` +
    `REGRAS DE NEGÓCIO FIXAS:\n` +
    `- obras = registros de EM_ANDAMENTO + PAVIMENTAÇÃO.\n` +
    `- projetos = somente EM_PROJETO.\n` +
    `- pavimentações = somente PAVIMENTAÇÃO.\n` +
    `- licitações = somente EM_LICITAÇÃO.\n` +
    `- "obras em andamento" inclui EM_ANDAMENTO com status de andamento E PAVIMENTAÇÃO com status de execução/andamento.\n` +
    `- projeto e licitação nunca entram escondidos quando a pessoa pede apenas obras.\n` +
    `- recurso e tipo de recurso são campos diferentes quando existirem.\n` +
    `- dados mutáveis (status, valores, responsáveis) SEMPRE serão lidos do banco; não memorize resultados.\n\n` +
    `FERRAMENTAS DISPONÍVEIS (ações):\n` +
    `contar, listar, somar, ranking, comparar, consultar_campo, descrever, buscar, esclarecer.\n` +
    `Você deve escolher apenas uma.\n\n` +
    `SEMÂNTICA DAS AÇÕES:\n` +
    `- contar: quantidade de registros ou quantidade distinta de engenheiros/empresas/bairros.\n` +
    `- listar: mostrar quais são os registros. Se a pessoa pedir "quantas e quais", use listar + incluir_contagem=true.\n` +
    `- somar: somar valor_total, valor_executado ou saldo_devedor.\n` +
    `- ranking: comparar GRUPOS (engenheiro, empresa, bairro, status, categoria, recurso). Ex.: "quem tem mais obras" = ranking/engenheiro/quantidade/maior.\n` +
    `- comparar: escolher ITEM maior/menor por valor/percentual. Ex.: "obra mais avançada" = comparar/percentual_executado/maior.\n` +
    `- consultar_campo: ler um ou mais campos de um item/conjunto (status, engenheiro, recurso, contrato etc.).\n` +
    `- descrever: ficha de um item.\n` +
    `- buscar: descobrir se existem registros relacionados a um assunto livre (drenagem, escola, praça etc.).\n` +
    `- esclarecer: somente quando falta informação indispensável e o histórico também não resolve.\n\n` +
    `CONTEXTO:\n` +
    `- "ela", "ele", "delas", "desses", "quais são?", "e o valor?" etc. podem usar a conversa anterior.\n` +
    `- Quando houver um NOVO alvo explícito no turno atual, ele vence o assunto anterior.\n` +
    `- "em geral", "no total", "ao todo" em um ranking normalmente remove filtros de status anteriores, mas mantém o escopo explicitamente pedido.\n` +
    `- Para follow-up, preencha de novo filtros concretos (engenheiro, alvo, bairro etc.) usando o que está explícito na resposta anterior. Não devolva apenas "usar_contexto=true" sem os filtros necessários quando puder recuperá-los do histórico.\n\n` +
    `CAMPOS CANÔNICOS: objeto,status,categoria,bairro,engenheiro,empresa,valor_total,valor_executado,percentual_executado,aba_origem,recurso,tipo_recurso,contrato,convenio,aditivo,data_inicio,data_prev_termino,saldo_devedor,quanto_falta,observacoes,campo_extra.\n` +
    `Se o usuário pedir uma chave JSON que aparece no catálogo e não está na lista, use campo="campo_extra" e campo_extra com o nome real da chave.\n\n` +
    `FORMATO EXATO:\n` +
    `{"acao":"...","escopo":"obras|projetos|pavimentacoes|licitacoes|registros",` +
    `"filtros":{"status":"","bairro":"","engenheiro":"","empresa":"","recurso":"","alvo":"",` +
    `"valor_total_min":null,"valor_total_max":null,"valor_executado_min":null,"valor_executado_max":null,"percentual_min":null,"percentual_max":null},` +
    `"campos":[],"campo":null,"campo_extra":"","campo_contagem":"registros|engenheiro|empresa|bairro",` +
    `"metrica":"quantidade|valor_total|valor_executado|percentual_executado|saldo_devedor",` +
    `"agrupar_por":"engenheiro|empresa|bairro|status|categoria|recurso|null","ordem":"maior|menor",` +
    `"incluir_contagem":false,"incluir_lista":false,"usar_contexto":false,"pergunta_esclarecimento":""}\n\n` +
    `REGRAS DE INTERPRETAÇÃO:\n` +
    `1. "quem tem mais obras?", "qual profissional concentra mais serviços?", "quem aparece em mais obras?" = ranking por engenheiro, métrica quantidade.\n` +
    `2. "quantas obras existem?" = contar, escopo obras.\n` +
    `3. "quais quantas obras existem?" ou "quantas são e quais?" = listar, escopo obras, incluir_contagem=true.\n` +
    `4. "qual delas está mais avançada?" = comparar, percentual_executado, usar o conjunto do histórico.\n` +
    `5. "quanto somam as obras dele?" = somar valor_total e recuperar o engenheiro do histórico.\n` +
    `6. "qual o valor?" sem alvo e sem contexto = esclarecer.\n` +
    `7. Nomes de bairros/engenheiros/empresas devem preferir os valores reais do catálogo.\n` +
    `8. Termos como drenagem, escola, UBS, praça, rua etc. normalmente são alvo/assunto em filtros.alvo, não status.\n` +
    `9. "status de X" = consultar_campo(status) com alvo X; não use status como filtro.\n` +
    `10. "recurso de X" = consultar_campo(recurso) com alvo X; "quais usam recurso próprio" = filtro.recurso="recurso próprio".\n` +
    `11. Não invente nomes, status, bairros, engenheiros ou empresas.\n` +
    `12. Retorne SOMENTE JSON válido.\n\n` +
    `CATÁLOGO REAL DO BANCO:\n${catalogoParaPrompt(catalogo)}\n\n` +
    `HISTÓRICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `MENSAGEM ATUAL: ${JSON.stringify(pergunta)}`;

  let erroAnterior = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const prompt = erroAnterior ? `${base}\n\nA tentativa anterior foi inválida: ${erroAnterior}. Corrija e retorne somente JSON.` : base;
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 520,
      temperature: 0,
      reasoning_effort: "low",
    });
    const plano = sanitizarPlano(extrairJSON(bruto));
    const erro = validarPlano(plano);
    if (!erro) return plano;
    erroAnterior = erro;
  }
  throw new Error(`planejador não produziu plano válido: ${erroAnterior || "JSON inválido"}`);
}

function tokens(s = "") {
  return normalizar(s).split(" ").filter((x) => x.length >= 2);
}

function similaridade(a = "", b = "") {
  const na = normalizar(a), nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return Math.min(0.95, Math.min(na.length, nb.length) / Math.max(na.length, nb.length) + 0.3);
  const A = new Set(tokens(na)), B = new Set(tokens(nb));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uniao = new Set([...A, ...B]).size || 1;
  return inter / uniao;
}

function resolverValor(valor, lista = [], limiar = 0.58) {
  if (!valor || !lista.length) return valor;
  let melhor = valor, score = 0;
  for (const candidato of lista) {
    const s = similaridade(valor, candidato);
    if (s > score) { score = s; melhor = candidato; }
  }
  return score >= limiar ? melhor : valor;
}

function resolverPlanoComCatalogo(plano, catalogo) {
  const p = structuredClone(plano);
  if (p.filtros.bairro) p.filtros.bairro = resolverValor(p.filtros.bairro, catalogo.bairro, 0.52);
  if (p.filtros.engenheiro) p.filtros.engenheiro = resolverValor(p.filtros.engenheiro, catalogo.engenheiro, 0.52);
  if (p.filtros.empresa) p.filtros.empresa = resolverValor(p.filtros.empresa, catalogo.empresa, 0.52);

  // Só canoniza alvo quando parece ser nome específico. Assuntos genéricos como
  // "drenagem" ou "escola" continuam livres para buscar vários registros.
  if (p.filtros.alvo && tokens(p.filtros.alvo).length >= 2) {
    p.filtros.alvo = resolverValor(p.filtros.alvo, catalogo.objetos, 0.72);
  }
  if (p.campo === "campo_extra" && p.campo_extra) {
    p.campo_extra = resolverValor(p.campo_extra, catalogo.chaves_extras, 0.50);
  }
  return p;
}

function origemSQL(escopo) {
  if (escopo === "obras") return "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
  if (escopo === "projetos") return "aba_origem = 'EM_PROJETO'";
  if (escopo === "pavimentacoes") return "aba_origem = 'PAVIMENTAÇÃO'";
  if (escopo === "licitacoes") return "aba_origem = 'EM_LICITAÇÃO'";
  return "";
}

function raizesStatus(status = "") {
  const p = normalizar(status);
  const especiais = [
    ["conclu", "conclu"], ["finaliz", "conclu"], ["terminad", "conclu"], ["pront", "conclu"],
    ["habilit", "habilit"], ["homolog", "homolog"], ["adjudic", "adjudic"],
    ["revis", "revis"], ["paralis", "paralis"], ["execu", "execu"], ["andament", "andament"],
    ["aguard", "aguard"], ["contrat", "contrat"], ["iniciar", "iniciar"], ["licit", "licit"],
  ];
  const saida = [];
  for (const [acha, raiz] of especiais) if (p.includes(acha) && !saida.includes(raiz)) saida.push(raiz);
  if (saida.length) return saida;
  const stop = new Set(["em", "de", "da", "do", "das", "dos", "e", "para", "com", "status", "situacao"]);
  return tokens(p).filter((x) => x.length >= 4 && !stop.has(x)).slice(0, 4);
}

function montarConsultaBase(plano) {
  const cond = [];
  const params = [];
  const addParam = (v) => { params.push(v); return `$${params.length}`; };

  const origem = origemSQL(plano.escopo);
  if (origem) cond.push(`(${origem})`);

  const statusNorm = normalizar(plano.filtros.status);
  if (statusNorm) {
    if (plano.escopo === "obras" && /andament/.test(statusNorm)) {
      cond.push(`((aba_origem='EM_ANDAMENTO' AND unaccent(COALESCE(status,'')) ILIKE unaccent('%andament%')) OR (aba_origem='PAVIMENTAÇÃO' AND (unaccent(COALESCE(status,'')) ILIKE unaccent('%andament%') OR unaccent(COALESCE(status,'')) ILIKE unaccent('%execu%'))))`);
    } else {
      const expr = `unaccent(COALESCE(NULLIF(BTRIM(dados_extras->>'STATUS ORIGINAL'),''), status, ''))`;
      for (const raiz of raizesStatus(plano.filtros.status)) {
        const ph = addParam(`%${raiz}%`);
        cond.push(`${expr} ILIKE unaccent(${ph})`);
      }
    }
  }

  const filtrosTexto = [
    ["bairro", plano.filtros.bairro],
    ["engenheiro", plano.filtros.engenheiro],
    ["empresa", plano.filtros.empresa],
  ];
  for (const [campo, valor] of filtrosTexto) {
    if (!valor) continue;
    const ph = addParam(`%${valor}%`);
    cond.push(`unaccent(COALESCE(${campo},'')) ILIKE unaccent(${ph})`);
  }

  if (plano.filtros.recurso) {
    const ph = addParam(`%${plano.filtros.recurso}%`);
    cond.push(`unaccent(COALESCE(dados_extras::text,'')) ILIKE unaccent(${ph})`);
  }

  if (plano.filtros.alvo) {
    const ph = addParam(`%${plano.filtros.alvo}%`);
    cond.push(`(
      unaccent(COALESCE(objeto,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(bairro,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(engenheiro,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(empresa,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(categoria,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(status,'')) ILIKE unaccent(${ph}) OR
      unaccent(COALESCE(dados_extras::text,'')) ILIKE unaccent(${ph})
    )`);
  }

  const numericos = [
    ["valor_total", "min", plano.filtros.valor_total_min], ["valor_total", "max", plano.filtros.valor_total_max],
    ["valor_executado", "min", plano.filtros.valor_executado_min], ["valor_executado", "max", plano.filtros.valor_executado_max],
    ["percentual_executado", "min", plano.filtros.percentual_min], ["percentual_executado", "max", plano.filtros.percentual_max],
  ];
  for (const [campo, tipo, valor] of numericos) {
    if (valor === null) continue;
    const ph = addParam(valor);
    cond.push(`${campo} ${tipo === "min" ? ">=" : "<="} ${ph}`);
  }

  const where = cond.length ? ` WHERE ${cond.join(" AND ")}` : "";
  const sql = `SELECT ${CAMPOS_BASE_SELECT.join(", ")} FROM obras${where} ORDER BY objeto NULLS LAST LIMIT ${MAX_LINHAS_FERRAMENTA}`;
  return { sql, params };
}

function sqlParaHistorico(sql, params = []) {
  let s = sql;
  for (let i = params.length; i >= 1; i--) {
    const v = params[i - 1];
    const rep = typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
    s = s.replace(new RegExp(`\\$${i}(?!\\d)`, "g"), rep);
  }
  return s.replace(/\s+/g, " ").trim();
}

function extrasObjeto(row) {
  const x = row?.dados_extras;
  if (!x) return {};
  if (typeof x === "object" && !Array.isArray(x)) return x;
  try { return JSON.parse(x); } catch { return {}; }
}

function acharExtra(row, nomes = []) {
  const extras = extrasObjeto(row);
  const chaves = Object.keys(extras);
  const normalizadas = chaves.map((k) => [k, normalizar(k)]);
  for (const nome of nomes) {
    const n = normalizar(nome);
    const exato = normalizadas.find(([, nk]) => nk === n);
    if (exato) return extras[exato[0]];
  }
  for (const nome of nomes) {
    const n = normalizar(nome);
    const parcial = normalizadas.find(([, nk]) => nk.includes(n) || n.includes(nk));
    if (parcial) return extras[parcial[0]];
  }
  return null;
}

function extrairCampo(row, campo, campoExtra = "") {
  if (!row) return null;
  if (["objeto", "status", "categoria", "bairro", "engenheiro", "empresa", "valor_total", "valor_executado", "percentual_executado", "aba_origem"].includes(campo)) {
    return row[campo];
  }
  if (campo === "recurso") return acharExtra(row, ["RECURSO", "FONTE DO RECURSO", "FONTE RECURSO"]);
  if (campo === "tipo_recurso") return acharExtra(row, ["TIPO_RECURSO", "TIPO RECURSO", "TIPO DE RECURSO"]);
  if (campo === "contrato") return acharExtra(row, ["CONTRATO", "Nº CONTRATO", "NUMERO CONTRATO"]);
  if (campo === "convenio") return acharExtra(row, ["CONVENIO", "CONVÊNIO", "Nº CONVENIO"]);
  if (campo === "aditivo") return acharExtra(row, ["ADITIVO", "TERMO ADITIVO"]);
  if (campo === "data_inicio") return acharExtra(row, ["DATA INICIO", "DATA_INICIO", "INICIO"]);
  if (campo === "data_prev_termino") return acharExtra(row, ["DATA PREV TERMINO", "DATA_PREV_TERMINO", "PREVISAO TERMINO", "PREVISÃO TÉRMINO"]);
  if (campo === "observacoes") return acharExtra(row, ["OBSERVACOES", "OBSERVAÇÕES", "OBSERVACAO", "OBS"]);
  if (campo === "saldo_devedor") {
    const extra = acharExtra(row, ["SALDO DEVEDOR", "SALDO_DEVEDOR", "SALDO"]);
    if (extra !== null && extra !== undefined && extra !== "") return extra;
    const total = numero(row.valor_total), exec = numero(row.valor_executado);
    return total !== null && exec !== null ? total - exec : null;
  }
  if (campo === "quanto_falta") {
    const total = numero(row.valor_total), exec = numero(row.valor_executado);
    if (total !== null && exec !== null) return total - exec;
    return extrairCampo(row, "saldo_devedor");
  }
  if (campo === "campo_extra" && campoExtra) return acharExtra(row, [campoExtra]);
  return null;
}

function rotuloCampo(campo, campoExtra = "") {
  return {
    objeto: "obra/objeto", status: "status", categoria: "categoria", bairro: "bairro",
    engenheiro: "engenheiro/responsável", empresa: "empresa", valor_total: "valor total",
    valor_executado: "valor executado", percentual_executado: "percentual executado",
    aba_origem: "origem", recurso: "recurso", tipo_recurso: "tipo de recurso",
    contrato: "contrato", convenio: "convênio", aditivo: "aditivo", data_inicio: "data de início",
    data_prev_termino: "previsão de término", saldo_devedor: "saldo devedor",
    quanto_falta: "quanto falta", observacoes: "observações", campo_extra: campoExtra || "campo",
  }[campo] || campo;
}

function campoAgrupamento(row, agrupamento) {
  if (agrupamento === "recurso") return extrairCampo(row, "recurso") || "Não informado";
  return row?.[agrupamento] || "Não informado";
}

function valorMetrica(row, metrica) {
  if (metrica === "quantidade") return 1;
  if (metrica === "saldo_devedor") return numero(extrairCampo(row, "saldo_devedor")) || 0;
  return numero(row?.[metrica]) || 0;
}

function registrosUnicos(rows, campo) {
  return new Set(rows.map((r) => normalizar(r?.[campo])).filter(Boolean)).size;
}

function executarFerramenta(plano, rows) {
  const acao = plano.acao;

  if (acao === "contar") {
    let valor;
    if (plano.campo_contagem === "registros") valor = rows.length;
    else valor = registrosUnicos(rows, plano.campo_contagem);
    return { tipo: "contagem", valor, rows };
  }

  if (acao === "listar" || acao === "buscar") {
    return { tipo: "lista", total: rows.length, rows: rows.slice(0, MAX_LISTA_RESPOSTA) };
  }

  if (acao === "somar") {
    const total = rows.reduce((acc, r) => acc + valorMetrica(r, plano.metrica), 0);
    return { tipo: "soma", total, quantidade: rows.length, metrica: plano.metrica, rows };
  }

  if (acao === "ranking") {
    const mapa = new Map();
    for (const r of rows) {
      const chave = String(campoAgrupamento(r, plano.agrupar_por) ?? "Não informado").trim() || "Não informado";
      if (!mapa.has(chave)) mapa.set(chave, { grupo: chave, valor: 0, quantidade: 0 });
      const x = mapa.get(chave);
      x.quantidade++;
      x.valor += plano.metrica === "quantidade" ? 1 : valorMetrica(r, plano.metrica);
    }
    const arr = [...mapa.values()].filter((x) => x.grupo !== "Não informado" || mapa.size === 1);
    arr.sort((a, b) => plano.ordem === "menor" ? a.valor - b.valor : b.valor - a.valor);
    if (!arr.length) return { tipo: "ranking", ranking: [], vencedores: [] };
    const melhor = arr[0].valor;
    const vencedores = arr.filter((x) => Math.abs(x.valor - melhor) < 1e-9);
    return { tipo: "ranking", ranking: arr, vencedores, melhor, rows };
  }

  if (acao === "comparar") {
    const comValor = rows.map((r) => ({ row: r, valor: valorMetrica(r, plano.metrica) }))
      .filter((x) => Number.isFinite(x.valor));
    comValor.sort((a, b) => plano.ordem === "menor" ? a.valor - b.valor : b.valor - a.valor);
    if (!comValor.length) return { tipo: "comparacao", vencedores: [] };
    const melhor = comValor[0].valor;
    const vencedores = comValor.filter((x) => Math.abs(x.valor - melhor) < 1e-9);
    return { tipo: "comparacao", vencedores, melhor, rows };
  }

  if (acao === "consultar_campo") {
    const campos = plano.campos.length ? plano.campos : [plano.campo].filter(Boolean);
    const saida = rows.slice(0, MAX_LISTA_RESPOSTA).map((r) => ({
      row: r,
      valores: campos.map((campo) => ({ campo, valor: extrairCampo(r, campo, plano.campo_extra) })),
    }));
    return { tipo: "campos", total: rows.length, saida, rows };
  }

  if (acao === "descrever") {
    return { tipo: "descricao", total: rows.length, rows: rows.slice(0, Math.min(5, MAX_LISTA_RESPOSTA)) };
  }

  return { tipo: "lista", total: rows.length, rows: rows.slice(0, MAX_LISTA_RESPOSTA) };
}

function formatarMetrica(metrica, valor) {
  if (["valor_total", "valor_executado", "saldo_devedor"].includes(metrica)) return moeda(valor);
  if (metrica === "percentual_executado") return percentual(valor);
  return new Intl.NumberFormat("pt-BR").format(valor);
}

function nomeRegistro(r) {
  return textoSeguro(r?.objeto || "Registro sem nome", 180);
}

function respostaSemResultados(plano) {
  const alvo = plano.filtros.alvo ? ` relacionado a “${plano.filtros.alvo}”` : "";
  return `Não encontrei ${pluralEscopo(plano.escopo)}${alvo} com esses filtros nos dados atuais.`;
}

function redigirDeterministico(plano, resultado) {
  if (!resultado) return "Não consegui montar a resposta.";

  if (resultado.tipo === "contagem") {
    const campo = plano.campo_contagem;
    if (campo === "registros") {
      const nome = resultado.valor === 1 ? singularEscopo(plano.escopo) : pluralEscopo(plano.escopo);
      return `Encontrei ${resultado.valor} ${nome} com esses critérios.`;
    }
    const rotulo = campo === "engenheiro" ? "engenheiro(s)/responsável(is)" : campo === "empresa" ? "empresa(s)" : "bairro(s)";
    return `Encontrei ${resultado.valor} ${rotulo} distintos nesse conjunto.`;
  }

  if (resultado.tipo === "lista") {
    if (!resultado.total) return respostaSemResultados(plano);
    const cab = plano.incluir_contagem ? `Encontrei ${resultado.total} ${pluralEscopo(plano.escopo)}:` : `Aqui estão ${pluralEscopo(plano.escopo)} encontradas:`;
    const itens = resultado.rows.map((r, i) => {
      const partes = [r.status ? `status: ${r.status}` : "", r.engenheiro ? `responsável: ${r.engenheiro}` : ""].filter(Boolean);
      return `${i + 1}. ${nomeRegistro(r)}${partes.length ? ` — ${partes.join(" | ")}` : ""}`;
    });
    const resto = resultado.total > resultado.rows.length ? `\n… e mais ${resultado.total - resultado.rows.length}.` : "";
    return `${cab}\n${itens.join("\n")}${resto}`;
  }

  if (resultado.tipo === "soma") {
    if (!resultado.quantidade) return respostaSemResultados(plano);
    return `O total de ${rotuloCampo(resultado.metrica)} é ${formatarMetrica(resultado.metrica, resultado.total)} considerando ${resultado.quantidade} ${resultado.quantidade === 1 ? singularEscopo(plano.escopo) : pluralEscopo(plano.escopo)}.`;
  }

  if (resultado.tipo === "ranking") {
    if (!resultado.vencedores.length) return respostaSemResultados(plano);
    const grupoLabel = rotuloCampo(plano.agrupar_por);
    const linhas = resultado.vencedores.map((x) => `- ${x.grupo}: ${formatarMetrica(plano.metrica, x.valor)}${plano.metrica === "quantidade" ? ` ${x.valor === 1 ? singularEscopo(plano.escopo) : pluralEscopo(plano.escopo)}` : ""}`);
    const empate = resultado.vencedores.length > 1 ? "Há empate no topo" : `O ${grupoLabel} com ${plano.ordem === "menor" ? "menor" : "maior"} resultado é`;
    return `${empate}:\n${linhas.join("\n")}`;
  }

  if (resultado.tipo === "comparacao") {
    if (!resultado.vencedores.length) return respostaSemResultados(plano);
    const linhas = resultado.vencedores.map((x) => `- ${nomeRegistro(x.row)} — ${rotuloCampo(plano.metrica)}: ${formatarMetrica(plano.metrica, x.valor)}`);
    const inicio = resultado.vencedores.length > 1 ? "Há empate entre:" : `A ${singularEscopo(plano.escopo)} com ${plano.ordem === "menor" ? "menor" : "maior"} ${rotuloCampo(plano.metrica)} é:`;
    return `${inicio}\n${linhas.join("\n")}`;
  }

  if (resultado.tipo === "campos") {
    if (!resultado.total) return respostaSemResultados(plano);
    const blocos = resultado.saida.map((item) => {
      const vals = item.valores.map((x) => `${rotuloCampo(x.campo, plano.campo_extra)}: ${valorFormatado(x.campo, x.valor)}`).join(" | ");
      return `- ${nomeRegistro(item.row)} — ${vals}`;
    });
    const resto = resultado.total > resultado.saida.length ? `\n… e mais ${resultado.total - resultado.saida.length}.` : "";
    return `${blocos.join("\n")}${resto}`;
  }

  if (resultado.tipo === "descricao") {
    if (!resultado.total) return respostaSemResultados(plano);
    const blocos = resultado.rows.map((r) => {
      const linhas = [
        `**${nomeRegistro(r)}**`,
        r.status ? `Status: ${r.status}` : null,
        r.bairro ? `Bairro/local: ${r.bairro}` : null,
        r.engenheiro ? `Responsável: ${r.engenheiro}` : null,
        r.empresa ? `Empresa: ${r.empresa}` : null,
        numero(r.valor_total) !== null ? `Valor total: ${moeda(r.valor_total)}` : null,
        numero(r.valor_executado) !== null ? `Valor executado: ${moeda(r.valor_executado)}` : null,
        numero(r.percentual_executado) !== null ? `Percentual executado: ${percentual(r.percentual_executado)}` : null,
        extrairCampo(r, "recurso") ? `Recurso: ${extrairCampo(r, "recurso")}` : null,
        extrairCampo(r, "contrato") ? `Contrato: ${extrairCampo(r, "contrato")}` : null,
      ].filter(Boolean);
      return linhas.join("\n");
    });
    return blocos.join("\n\n");
  }

  return "Não consegui formatar o resultado.";
}

function estadoPublico(plano, resultado) {
  const estado = {
    acao: plano.acao,
    escopo: plano.escopo,
    filtros: plano.filtros,
    campos: plano.campos,
    metrica: plano.metrica,
    agrupar_por: plano.agrupar_por,
  };
  if (resultado?.tipo === "ranking" && resultado.vencedores?.length === 1) {
    estado.foco_grupo = resultado.vencedores[0].grupo;
  }
  if (resultado?.tipo === "comparacao" && resultado.vencedores?.length === 1) {
    estado.foco_objeto = nomeRegistro(resultado.vencedores[0].row);
  }
  return estado;
}

export async function responderPergunta(pergunta, historico = []) {
  const texto = textoSeguro(pergunta, 1200);
  if (!texto) return { resposta: "Pode enviar sua pergunta sobre as obras?", erro: "pergunta_vazia" };

  const social = respostaSocial(texto);
  if (social) return { resposta: social, social: true, modoAgente: "social" };

  try {
    const catalogo = await carregarCatalogo();
    let plano = await planejar(texto, historico, catalogo);
    plano = resolverPlanoComCatalogo(plano, catalogo);

    console.log("AGENTE NOVO - PLANO:", JSON.stringify(plano));

    if (plano.acao === "esclarecer") {
      return {
        resposta: plano.pergunta_esclarecimento || "Preciso de um pouco mais de contexto. Qual obra, projeto, pavimentação ou licitação você quer consultar?",
        plano,
        modoAgente: "ferramentas_deterministicas_v1",
      };
    }

    const consulta = montarConsultaBase(plano);
    const r = await queryReadOnly(consulta.sql, consulta.params);
    const rows = r.rows || [];

    if (rows.length >= MAX_LINHAS_FERRAMENTA) {
      console.warn(`AGENTE NOVO: consulta atingiu o limite de ${MAX_LINHAS_FERRAMENTA} linhas.`);
    }

    const resultado = executarFerramenta(plano, rows);
    const resposta = redigirDeterministico(plano, resultado);
    const sqlDebug = sqlParaHistorico(consulta.sql, consulta.params);

    return {
      resposta,
      sql: sqlDebug,
      linhas: rows.length,
      plano,
      estado: estadoPublico(plano, resultado),
      modoAgente: "ferramentas_deterministicas_v1",
    };
  } catch (e) {
    console.error("AGENTE NOVO: falha:", e);
    return {
      resposta: "Tive um problema para interpretar ou consultar os dados agora. Tente novamente em instantes.",
      erro: e.message,
      modoAgente: "ferramentas_deterministicas_v1_erro",
    };
  }
}
