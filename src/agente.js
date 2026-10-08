// ============================================================
// agente.js - AGENTE GOOGLE SHEETS COM FERRAMENTAS (SEM SQL)
// ============================================================
// Inspirado no padrao de agentes de planilha do n8n:
// - a IA entende a pergunta e escolhe uma ferramenta;
// - o Node le a planilha real via getObras();
// - filtros, contagens, somas, agrupamentos e rankings sao calculados pelo Node;
// - a IA NAO recebe a planilha inteira e NAO gera SQL;
// - follow-ups usam somente o ultimo estado valido da conversa.
//
// Compatibilidade esperada com o projeto atual:
//   import { getObras } from "./sheets.js";
//   import { chamarIAbruta } from "./groq.js";
//   export async function responderPergunta(pergunta, historico = [])
//
// Troque SOMENTE o agente.js. Nao precisa criar outro arquivo.
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";

const MAX_PASSOS = Math.max(2, Math.min(Number(process.env.AGENTE_SHEETS_PASSOS || 4), 6));
const MAX_LISTA = Math.max(5, Math.min(Number(process.env.AGENTE_SHEETS_MAX_LISTA || 30), 100));
const MAX_HISTORICO = Math.max(2, Math.min(Number(process.env.AGENTE_SHEETS_HISTORICO || 8), 16));
const MAX_AMOSTRAS_COLUNA = 3;

// ------------------------------------------------------------
// Utilitarios gerais
// ------------------------------------------------------------
function texto(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function normalizar(v) {
  return texto(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chaveNormalizada(v) {
  return normalizar(v).replace(/\s+/g, "_");
}

function unico(arr) {
  return [...new Set((arr || []).filter((x) => x !== null && x !== undefined && texto(x) !== ""))];
}

function limitarTexto(v, max = 7000) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function parseJSONSeguro(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(s); } catch {}
  const ini = s.indexOf("{");
  const fim = s.lastIndexOf("}");
  if (ini >= 0 && fim > ini) {
    try { return JSON.parse(s.slice(ini, fim + 1)); } catch {}
  }
  return null;
}

function parseNumero(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  let s = String(v).trim();
  if (!s || s === "-") return null;

  let negativo = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negativo = true;
    s = s.slice(1, -1);
  }

  s = s
    .replace(/R\$/gi, "")
    .replace(/%/g, "")
    .replace(/\s+/g, "")
    .replace(/[^0-9,.-]/g, "");

  if (!s || s === "-" || s === "." || s === ",") return null;

  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");

  if (temVirgula && temPonto) {
    // O ultimo separador e tratado como decimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (temVirgula) {
    const partes = s.split(",");
    if (partes.length === 2 && partes[1].length <= 4) {
      s = partes[0].replace(/\./g, "") + "." + partes[1];
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (temPonto) {
    const partes = s.split(".");
    // 1.234.567 -> milhares; 1234.56 -> decimal.
    if (partes.length > 2 && partes.slice(1).every((p) => p.length === 3)) {
      s = partes.join("");
    }
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

function formatarNumero(n) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(n) || 0);
}

function formatarMoeda(n) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}

function pareceCampoDinheiro(nome = "") {
  const n = normalizar(nome);
  return ["valor", "pago", "invest", "custo", "saldo", "aditivo", "reajuste", "contrapartida", "orcamento", "montante"]
    .some((p) => n.includes(p));
}

function pareceCampoPercentual(nome = "") {
  const n = normalizar(nome);
  return n.includes("%") || n.includes("percent") || n.includes("porcent");
}

function formatarValorCampo(campo, v) {
  if (v === null || v === undefined || texto(v) === "") return "não informado";
  const n = parseNumero(v);
  if (n !== null && pareceCampoDinheiro(campo)) return formatarMoeda(n);
  if (n !== null && pareceCampoPercentual(campo)) {
    const valor = Math.abs(n) <= 1 ? n * 100 : n;
    return `${formatarNumero(valor)}%`;
  }
  return texto(v);
}

// ------------------------------------------------------------
// Semantica minima de abas/campos.
// Isto NAO e regex por pergunta. E apenas o dicionario da fonte de dados.
// ------------------------------------------------------------
const ESCOPOS = {
  obra: ["EM_ANDAMENTO", "PAVIMENTAÇÃO", "PAVIMENTACAO"],
  projeto: ["EM_PROJETO"],
  licitacao: ["EM_LICITAÇÃO", "EM_LICITACAO"],
  pavimentacao: ["PAVIMENTAÇÃO", "PAVIMENTACAO"],
};

const ALIASES_CAMPOS = {
  objeto: [
    "objeto", "objeto da obra", "objeto do projeto", "objeto da licitacao",
    "obra", "descricao da obra", "descricao", "servico", "nome do projeto",
  ],
  bairro: ["bairro"],
  endereco: ["endereco", "logradouro", "local", "localizacao"],
  status: ["status", "situacao", "situacao atual", "andamento"],
  engenheiro: ["engenheiro", "engenheiro responsavel", "responsavel tecnico", "responsavel"],
  empresa: ["empresa", "empresa executora", "construtora", "contratada"],
  recurso: ["recurso", "fonte de recurso", "fonte", "origem do recurso"],
  tipo_recurso: ["tipo recurso", "tipo de recurso"],
  contrato: ["contrato", "n do contrato", "numero do contrato", "nº do contrato"],
  convenio: ["convenio", "proposta", "n do convenio proposta", "nº do convenio proposta"],
  valor_total: [
    "valor total da obra", "valor total", "valor global", "valor contratado",
    "valor contratado mais aditivo", "valor contratadomaisaditivo",
  ],
  valor_executado: ["valor executado", "valor medido", "executado"],
  percentual_executado: ["% executada", "% executado", "percentual executado", "percentual executada"],
  saldo_devedor: ["saldo devedor", "saldo"],
  pago_gestao_atual: ["pago gestao atual", "pago gestão atual"],
  pago_gestao_anterior: ["pago gestao anterior", "pago gestão anterior"],
  valor_pago_2023: ["valor pago 2023"],
  valor_pago_2024: ["valor pago 2024"],
  valor_pago_2025: ["valor pago 2025"],
  valor_pago_2026: ["valor pago 2026"],
  data_inicio: ["data inicio", "data_inicio", "inicio"],
  data_prev_termino: ["data prev termino", "data_prev_termino", "previsao de termino", "previsao termino"],
  observacoes: ["observacoes", "observações", "observacao", "observação"],
};

const ALIASES_NORMALIZADOS = Object.fromEntries(
  Object.entries(ALIASES_CAMPOS).map(([k, vs]) => [k, unico([k, ...vs].map(normalizar))])
);

function escopoDaAba(aba) {
  const n = normalizar(aba);
  for (const [escopo, abas] of Object.entries(ESCOPOS)) {
    if (abas.some((a) => normalizar(a) === n)) return escopo;
  }
  return "outro";
}

function linhaNoEscopo(row, escopos = []) {
  const lista = Array.isArray(escopos) ? escopos : [escopos];
  if (!lista.length || lista.includes("todas") || lista.includes("todos") || lista.includes("auto")) return true;
  const e = escopoDaAba(row?._aba);
  return lista.includes(e) || lista.some((x) => normalizar(x) === normalizar(row?._aba));
}

function colunasDaLinha(row) {
  return Object.keys(row || {}).filter((k) => k !== "_aba");
}

function resolverCampoNaLinha(row, campo) {
  if (!row || !campo) return null;
  const alvo = normalizar(campo);
  const cols = colunasDaLinha(row);

  // Nome exato real da planilha.
  let achou = cols.find((c) => normalizar(c) === alvo);
  if (achou) return achou;

  // Nome canonico -> aliases.
  const canon = chaveNormalizada(campo);
  const aliases = ALIASES_NORMALIZADOS[canon] || [];
  if (aliases.length) {
    achou = cols.find((c) => aliases.includes(normalizar(c)));
    if (achou) return achou;
  }

  // Se a IA passou um alias conhecido, descobre qual conceito canonico e tenta novamente.
  for (const [conceito, lista] of Object.entries(ALIASES_NORMALIZADOS)) {
    if (lista.includes(alvo)) {
      achou = cols.find((c) => lista.includes(normalizar(c)));
      if (achou) return achou;
      if (conceito !== canon) {
        const alvoCanonico = cols.find((c) => normalizar(c) === normalizar(conceito));
        if (alvoCanonico) return alvoCanonico;
      }
    }
  }

  return null;
}

function valorCampo(row, campo) {
  if (campo === "_aba" || campo === "aba") return row?._aba ?? null;
  if (campo === "status_grupo") return grupoStatus(valorCampo(row, "status"));
  if (campo === "bairro_limpo") return bairroLimpo(row);
  const real = resolverCampoNaLinha(row, campo);
  return real ? row[real] : null;
}

function objetoDaLinha(row) {
  for (const c of ["objeto", "descricao", "obra", "servico"]) {
    const v = texto(valorCampo(row, c));
    if (v && parseNumero(v) === null && /[a-zA-Z]/.test(v)) return v;
  }
  return "Registro sem nome da obra";
}

// ------------------------------------------------------------
// Catalogo da planilha para o agente escolher as ferramentas.
// ------------------------------------------------------------
function construirCatalogo(rows) {
  const porAba = new Map();
  for (const row of rows || []) {
    const aba = texto(row?._aba) || "(sem aba)";
    if (!porAba.has(aba)) porAba.set(aba, new Map());
    const mapa = porAba.get(aba);
    for (const col of colunasDaLinha(row)) {
      if (!mapa.has(col)) mapa.set(col, []);
      const arr = mapa.get(col);
      const v = texto(row[col]);
      if (v && arr.length < MAX_AMOSTRAS_COLUNA && !arr.includes(v)) arr.push(v.slice(0, 100));
    }
  }

  return [...porAba.entries()].map(([aba, cols]) => ({
    aba,
    escopo: escopoDaAba(aba),
    colunas: [...cols.keys()],
    amostras: Object.fromEntries([...cols.entries()].filter(([, vals]) => vals.length).slice(0, 14)),
  }));
}

function resumoCatalogo(catalogo) {
  return catalogo.map((a) => ({
    aba: a.aba,
    escopo: a.escopo,
    colunas: a.colunas,
  }));
}

// ------------------------------------------------------------
// Filtros deterministas
// ------------------------------------------------------------
function compararFiltro(row, filtro = {}) {
  const campo = filtro.campo || filtro.field;
  const op = normalizar(filtro.operador || filtro.operator || "eq").replace(/ /g, "_");
  const esperado = filtro.valor ?? filtro.value;
  const bruto = valorCampo(row, campo);
  const atualTxt = normalizar(bruto);

  if (op === "is_empty" || op === "vazio") return !texto(bruto);
  if (op === "not_empty" || op === "nao_vazio") return !!texto(bruto);

  if (["gt", "gte", "lt", "lte", "maior", "maior_igual", "menor", "menor_igual"].includes(op)) {
    const a = parseNumero(bruto);
    const b = parseNumero(esperado);
    if (a === null || b === null) return false;
    if (op === "gt" || op === "maior") return a > b;
    if (op === "gte" || op === "maior_igual") return a >= b;
    if (op === "lt" || op === "menor") return a < b;
    return a <= b;
  }

  if (op === "contains" || op === "contem") return atualTxt.includes(normalizar(esperado));
  if (op === "not_contains" || op === "nao_contem") return !atualTxt.includes(normalizar(esperado));

  if (op === "one_of" || op === "in") {
    const vals = Array.isArray(esperado) ? esperado : [esperado];
    return vals.some((v) => atualTxt === normalizar(v));
  }

  if (op === "not_one_of" || op === "not_in") {
    const vals = Array.isArray(esperado) ? esperado : [esperado];
    return !vals.some((v) => atualTxt === normalizar(v));
  }

  if (op === "neq" || op === "diferente") return atualTxt !== normalizar(esperado);
  return atualTxt === normalizar(esperado);
}

function linhaContemTermo(row, termo, camposBusca = []) {
  const t = normalizar(termo);
  if (!t) return true;
  const campos = camposBusca?.length ? camposBusca : ["objeto", "bairro", "status", "engenheiro", "empresa", "recurso", "tipo_recurso"];
  return campos.some((campo) => normalizar(valorCampo(row, campo)).includes(t));
}

function filtrarLinhas(rows, args = {}) {
  let out = [...(rows || [])];
  const escopos = unico(Array.isArray(args.escopo) ? args.escopo : [args.escopo].filter(Boolean));
  if (escopos.length) out = out.filter((r) => linhaNoEscopo(r, escopos));

  const filtros = Array.isArray(args.filtros) ? args.filtros : [];
  if (filtros.length) out = out.filter((r) => filtros.every((f) => compararFiltro(r, f)));

  const termos = unico(Array.isArray(args.termos) ? args.termos : [args.termos].filter(Boolean));
  if (termos.length) {
    const modo = normalizar(args.modo_termos || "any");
    const camposBusca = Array.isArray(args.campos_busca) ? args.campos_busca : [];
    out = out.filter((r) => {
      const checks = termos.map((t) => linhaContemTermo(r, t, camposBusca));
      return modo === "all" ? checks.every(Boolean) : checks.some(Boolean);
    });
  }
  return out;
}

function ordenarLinhas(rows, ordenarPor, direcao = "asc") {
  if (!ordenarPor) return rows;
  const dir = normalizar(direcao) === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = valorCampo(a, ordenarPor);
    const vb = valorCampo(b, ordenarPor);
    const na = parseNumero(va);
    const nb = parseNumero(vb);
    if (na !== null && nb !== null) return (na - nb) * dir;
    return texto(va).localeCompare(texto(vb), "pt-BR", { sensitivity: "base" }) * dir;
  });
}


// ============================================================
// CAMADA DETERMINISTICA (correcoes)
// A IA so sugere; status, escopo, dimensao, campo financeiro e
// heranca de contexto sao decididos aqui, por regra fixa.
// ============================================================

// ---------- Cabecalhos de abas mal lidos (ex.: EM_LICITACAO) ----------
function colunaGenerica(c) {
  const s = texto(c);
  return !s || /^(_?\d+|col(una|umn)?\s*\d*|field\s*\d+|unnamed.*|__empty.*|[a-z])$/i.test(s) || parseNumero(s) !== null;
}

function pontuacaoCabecalho(valores) {
  let pts = 0;
  for (const v of valores) {
    const n = normalizar(v);
    if (!n) continue;
    if (Object.values(ALIASES_NORMALIZADOS).some((lista) => lista.includes(n))) pts += 1;
  }
  return pts;
}

function corrigirCabecalhos(rows) {
  const porAba = new Map();
  for (const r of rows || []) {
    const aba = texto(r?._aba) || "(sem aba)";
    if (!porAba.has(aba)) porAba.set(aba, []);
    porAba.get(aba).push(r);
  }
  const saida = [];
  for (const [aba, lista] of porAba) {
    const cols = unico(lista.flatMap((r) => colunasDaLinha(r)));
    const genericas = cols.filter(colunaGenerica).length;
    const ptsAtual = pontuacaoCabecalho(cols);
    let idxCab = -1;
    let melhor = ptsAtual;
    if (genericas / Math.max(cols.length, 1) >= 0.4 || ptsAtual < 2) {
      for (let i = 0; i < Math.min(6, lista.length); i++) {
        const pts = pontuacaoCabecalho(cols.map((c) => lista[i][c]));
        if (pts >= 2 && pts > melhor) { melhor = pts; idxCab = i; }
      }
    }
    if (idxCab >= 0) {
      const cab = lista[idxCab];
      const mapa = cols.map((c) => [c, texto(cab[c]) || c]);
      for (const r of lista.slice(idxCab + 1)) {
        const novo = { _aba: aba };
        for (const [antigo, nome] of mapa) novo[nome] = r[antigo];
        saida.push(novo);
      }
    } else {
      saida.push(...lista);
    }
  }
  // Remove linhas totalmente vazias.
  return saida.filter((r) => colunasDaLinha(r).some((c) => texto(r[c])));
}

// ---------- Status: grupos fixos, nunca misturados ----------
const ORDEM_STATUS = ["a_executar", "paralisada", "em_execucao", "concluida", "executada", "em_projeto", "em_licitacao"];
const STATUS_GRUPOS = {
  a_executar: ["a executar", "nao iniciada", "nao iniciado", "aguardando inicio", "a iniciar"],
  paralisada: ["paralisada", "paralisado", "suspensa", "suspenso"],
  em_execucao: ["em execucao", "em andamento", "andamento", "em obras", "executando"],
  concluida: ["concluida", "concluido", "finalizada", "finalizado", "entregue", "inaugurada"],
  executada: ["executada", "executado"],
  em_projeto: ["em projeto", "em elaboracao"],
  em_licitacao: ["em licitacao", "licitando"],
};

function grupoStatus(v) {
  const n = normalizar(v);
  if (!n) return "";
  for (const g of ORDEM_STATUS) {
    if (STATUS_GRUPOS[g].some((p) => n === p || n.includes(p))) return g;
  }
  return "outro";
}

function statusDaPergunta(n) {
  const out = [];
  if (/\b(a executar|nao iniciad|a iniciar)/.test(n)) out.push("a_executar");
  if (/\bparalisad|suspens/.test(n)) out.push("paralisada");
  if (/\b(em andamento|andamento|em execucao|executando|em obras)\b/.test(n)) out.push("em_execucao");
  if (/\bconcluid/.test(n)) out.push("concluida");
  if (/\bexecutad/.test(n)) out.push("executada");
  if (/\b(finalizad|pront|terminad|entregue)/.test(n)) out.push("concluida", "executada");
  return unico(out);
}

// ---------- Bairro limpo ----------
const RUIDO_BAIRRO = /^(rua|r|av|avenida|travessa|tv|trav|rodovia|estrada|alameda|praca|trecho|trechos|diversas|diversos|varias|varios|ce|br|km|lote|quadra|construcao|reforma|pavimentacao|ampliacao|implantacao)\b/;

function tituloCaso(s) {
  return texto(s).toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
}

function extrairBairroDeTexto(v) {
  const n = normalizar(v);
  const m = n.match(/\bbairros? (?:do |da |de |dos |das )?([a-z0-9][a-z0-9 ]{2,40})/);
  if (!m) return null;
  const nome = m[1].split(/ (?:rua|av|avenida|travessa|no|na|e|com|trecho|ate)\b/)[0].trim();
  return nome.length >= 3 ? tituloCaso(nome) : null;
}

function bairroLimpo(row) {
  const bruto = texto(valorCampo(row, "bairro"));
  const n = normalizar(bruto);
  if (n) {
    if (/zona rural|area rural|sitio|distrito|assentamento/.test(n)) return "Zona rural";
    const doTexto = extrairBairroDeTexto(bruto);
    if (doTexto) return doTexto;
    const partes = bruto.split(/[,;/–-]/).map((x) => x.trim()).filter(Boolean);
    for (const p of [bruto, ...partes.reverse()]) {
      const pn = normalizar(p);
      if (pn && !RUIDO_BAIRRO.test(pn) && !/^\d/.test(pn) && pn.split(" ").length <= 5) return tituloCaso(p);
    }
  }
  for (const c of ["endereco", "objeto"]) {
    const b = extrairBairroDeTexto(valorCampo(row, c));
    if (b) return b;
  }
  return "Sem bairro identificado";
}

// ---------- Escopo, dimensao, financeiro ----------
function escopoDaPergunta(n) {
  if (/\blicita/.test(n)) return "licitacao";
  if (/\bprojeto/.test(n) && !/\bobra/.test(n)) return "projeto";
  if (/\bpavimenta/.test(n)) return "pavimentacao";
  if (/\bobra/.test(n)) return "obra";
  if (/\b(tudo|todas as abas|geral)\b/.test(n)) return "todas";
  return null;
}

function dimensaoDaPergunta(n) {
  if (/\b(engenheir|responsav|fiscal)/.test(n)) return "engenheiro";
  if (/\b(empresa|construtora|contratada|empreiteira)/.test(n)) return "empresa";
  if (/\b(bairro|localidade|regiao)/.test(n)) return "bairro_limpo";
  if (/\b(fonte de recurso|recursos?|fonte)\b/.test(n)) return "recurso";
  if (/\b(status|situac)/.test(n)) return "status";
  return null;
}

function existeCampo(rows, canon) {
  return (rows || []).some((r) => resolverCampoNaLinha(r, canon));
}

function camposFinanceiros(n, rows) {
  if (/\b(pago|paga|pagos|pagamento|pagou|gasto|gastou|gastos|desembols)/.test(n)) {
    const ano = n.match(/\b(202\d)\b/);
    if (ano && existeCampo(rows, `valor_pago_${ano[1]}`)) return [`valor_pago_${ano[1]}`];
    if (/gestao atual/.test(n) && existeCampo(rows, "pago_gestao_atual")) return ["pago_gestao_atual"];
    if (/gestao anterior/.test(n) && existeCampo(rows, "pago_gestao_anterior")) return ["pago_gestao_anterior"];
    const gestoes = ["pago_gestao_atual", "pago_gestao_anterior"].filter((c) => existeCampo(rows, c));
    if (gestoes.length) return gestoes;
    const anos = ["valor_pago_2023", "valor_pago_2024", "valor_pago_2025", "valor_pago_2026"].filter((c) => existeCampo(rows, c));
    if (anos.length) return anos;
    return null; // nao existe coluna de pagamento: nao troca por executado
  }
  if (/\bsaldo/.test(n)) return ["saldo_devedor"];
  if (/\b(executad|medid)/.test(n) && /\b(valor|quanto|total|r)\b/.test(n)) return ["valor_executado"];
  if (/\b(invest|valor total|valor global|custo|orcamento|valor|mais car|caras|caro|r)\b/.test(n)) return ["valor_total"];
  return null;
}

// ---------- Conversa ----------
function ehSaudacao(n) {
  if (!n) return false;
  const temDado = /\b(obra|projeto|licita|bairro|engenheir|valor|quant|quais|status|empresa|lista)/.test(n);
  return !temDado && n.split(" ").length <= 6 &&
    /^(oi|ola|opa|bom dia|boa tarde|boa noite|e ai|eai|tudo bem|tudo bom|obrigad|valeu|ok|blz|beleza|hello|hi)\b/.test(n);
}

function ehFollowUp(n) {
  if (/\b(dessas|desses|delas|deles|essas|esses|nelas|neles|dentre|destas|destes)\b/.test(n)) return true;
  const palavras = n.split(" ").length;
  if (palavras > 7) return false;
  if (escopoDaPergunta(n)) return false; // novo universo explicito
  return /^(e |quais|qual|mostra|mostre|liste|lista|listar|quem|quanto|quantos|quantas|onde|detalh)/.test(n);
}

const RESPOSTA_SAUDACAO =
  "Olá! 👋 Posso consultar as obras, projetos e licitações da planilha. Exemplos: \"quantas obras em andamento?\", \"quem tem mais obras?\", \"qual o valor total investido?\".";

// ---------- Corrige o plano da IA ----------
function aplicarRegras(pergunta, planoIA, estado, rows) {
  const n = normalizar(pergunta);
  const p = { ...(planoIA || {}), args: { ...(planoIA?.args || {}) } };
  const follow = !!estado && ehFollowUp(n);
  p.inherit_scope = follow;

  const esc = escopoDaPergunta(n);
  if (esc) p.args.escopo = [esc];

  // Status: SEMPRE deterministico. Remove qualquer filtro de status inventado pela IA.
  const st = statusDaPergunta(n);
  let filtros = (Array.isArray(p.args.filtros) ? p.args.filtros : [])
    .filter((f) => !/status|situac/.test(normalizar(f?.campo || f?.field)));
  if (st.length) filtros.push({ campo: "status_grupo", operador: "one_of", valor: st });
  p.args.filtros = filtros;
  p._statusExplicito = st.length > 0;

  // Ignora termos que sao, na verdade, palavras de status/escopo.
  if (Array.isArray(p.args.termos)) {
    p.args.termos = p.args.termos.filter((t) => {
      const tn = normalizar(t);
      return tn && !statusDaPergunta(tn).length && !/^(obras?|projetos?|licitac\w*|pavimentac\w*)$/.test(tn);
    });
  }

  const dim = dimensaoDaPergunta(n);
  const fin = camposFinanceiros(n, rows);
  const ranking = /\b(mais|maior|maiores|menor|menores|ranking|top|lidera|primeir)\b/.test(n);
  const pedeSoma = /\b(quanto|total|soma|somar|montante)\b/.test(n);
  const pedeQuantos = /\bquant[oa]s\b/.test(n);
  const pedeLista = /\b(quais|liste|lista|listar|mostre|mostra|nomes?|quem sao)\b/.test(n);
  const ehValorFollow = follow && /\bvalor|quanto custa|investimento/.test(n);

  const label = texto(p.label) || "registros";

  if (fin && (pedeSoma || ehValorFollow) && !(ranking && !dim)) {
    p.tool = "somar";
    p.args.campos = fin;
    delete p.args.campo;
    if (dim && (ranking || /\bpor\b/.test(n))) p.args.agrupar_por = dim; else delete p.args.agrupar_por;
    p.args.direcao = /\bmenor/.test(n) ? "asc" : "desc";
  } else if (fin && ranking) {
    if (dim) {
      p.tool = "somar";
      p.args.campos = fin;
      p.args.agrupar_por = dim;
      p.args.direcao = /\bmenor/.test(n) ? "asc" : "desc";
    } else {
      p.tool = "buscar_obras";
      p.args.ordenar_por = fin[0];
      p.args.direcao = /\bmenor|baratas?\b/.test(n) ? "asc" : "desc";
      p.args.campos = unico(["objeto", ...fin, "bairro_limpo", "status", "empresa"]);
      p.args.filtros.push({ campo: fin[0], operador: "not_empty" });
      p.args.limite = Number(n.match(/\b(\d{1,2})\b/)?.[1]) || 10;
    }
  } else if (ranking && /\bobras?|projetos?|licitac|registros?\b|quem\b/.test(n)) {
    // "quem tem mais obras" -> responsavel, nunca bairro escolhido pela IA.
    p.tool = "agrupar_por";
    p.args.campo = dim || "engenheiro";
    p.args.direcao = /\bmenos|menor/.test(n) ? "asc" : "desc";
    p.args.ordenar_por = "quantidade";
  } else if (dim && pedeQuantos && new RegExp(`quant[oa]s (${["engenheir", "responsav", "empresa", "construtora", "bairro", "fonte", "recurso"].join("|")})`).test(n)) {
    p.tool = "contar_obras";
    p.args.distinto_por = dim;
  } else if (dim && (pedeLista || follow) && !fin) {
    p.tool = "agrupar_por";
    p.args.campo = dim;
    p.args.ordenar_por = dim === "status" ? "quantidade" : "grupo";
  } else if (pedeQuantos && !dim && p.tool !== "contar_obras" && p.tool !== "responder") {
    p.tool = "contar_obras";
  }

  // Saneamento final
  if (p.tool === "agrupar_por") {
    if (/bairro|localidade/.test(normalizar(p.args.campo))) p.args.campo = "bairro_limpo";
    p.args.normalizar_dimensao = false; // bairro_limpo ja e deterministico
  }
  if (p.tool === "somar" && fin) p.args.campos = fin;
  if (p.tool === "somar" && p.args.agrupar_por && /bairro/.test(normalizar(p.args.agrupar_por))) p.args.agrupar_por = "bairro_limpo";
  if (p.tool === "buscar_obras") {
    const campos = Array.isArray(p.args.campos) && p.args.campos.length ? p.args.campos : ["objeto", "status", "bairro", "engenheiro", "empresa", "valor_total"];
    p.args.campos = unico(["objeto", ...campos]);
  }
  if (!esc && !follow && !p.args.escopo) p.args.escopo = ["todas"];
  p.label = label;
  return p;
}

// ------------------------------------------------------------
// Ferramentas internas - equivalentes aos tools de um agente n8n.
// ------------------------------------------------------------
function ferramentaListarColunas(rows, args = {}) {
  const catalogo = construirCatalogo(rows);
  const aba = texto(args.aba);
  const filtrado = aba ? catalogo.filter((x) => normalizar(x.aba) === normalizar(aba)) : catalogo;
  return {
    tipo: "colunas",
    abas: filtrado,
    total_abas: filtrado.length,
  };
}

function ferramentaBuscar(rows, args = {}) {
  let encontrados = filtrarLinhas(rows, args);
  encontrados = ordenarLinhas(encontrados, args.ordenar_por, args.direcao);
  const limite = Math.max(1, Math.min(Number(args.limite || MAX_LISTA), 100));
  const campos = unico(Array.isArray(args.campos) && args.campos.length ? args.campos : ["objeto", "status", "bairro", "engenheiro", "empresa", "valor_total"]);
  const fatia = encontrados.slice(0, limite);

  const itens = fatia.map((row, idx) => {
    const dados = { _numero: idx + 1, _aba: row._aba };
    for (const campo of campos) {
      const v = valorCampo(row, campo);
      if (v !== null && v !== undefined && texto(v) !== "") dados[campo] = v;
    }
    if (!dados.objeto) dados.objeto = objetoDaLinha(row);
    return dados;
  });

  return {
    tipo: "lista",
    total: encontrados.length,
    exibidos: itens.length,
    itens,
    campos,
  };
}

function ferramentaContar(rows, args = {}) {
  const encontrados = filtrarLinhas(rows, args);
  const distinto = args.distinto_por;
  if (distinto) {
    const valores = unico(encontrados.map((r) => normalizar(valorCampo(r, distinto))).filter(Boolean));
    return { tipo: "contagem", total: valores.length, distinto_por: distinto };
  }
  return { tipo: "contagem", total: encontrados.length };
}

function somaCamposDaLinha(row, campos) {
  let soma = 0;
  let usados = 0;
  for (const c of campos) {
    const n = parseNumero(valorCampo(row, c));
    if (n !== null) {
      soma += n;
      usados += 1;
    }
  }
  return usados ? soma : null;
}

function ferramentaSomar(rows, args = {}) {
  const encontrados = filtrarLinhas(rows, args);
  const campos = unico(Array.isArray(args.campos) && args.campos.length ? args.campos : [args.campo].filter(Boolean));
  if (!campos.length) return { tipo: "erro_ferramenta", erro: "somar exige campo ou campos" };

  const agruparPor = args.agrupar_por;
  if (agruparPor) {
    const grupos = new Map();
    for (const row of encontrados) {
      const gBruto = valorCampo(row, agruparPor);
      const g = texto(gBruto);
      if (!g) continue;
      const val = somaCamposDaLinha(row, campos);
      if (val === null) continue;
      const key = normalizar(g);
      if (!grupos.has(key)) grupos.set(key, { grupo: g, valor: 0, registros: 0 });
      const obj = grupos.get(key);
      obj.valor += val;
      obj.registros += 1;
    }
    let itens = [...grupos.values()];
    itens.sort((a, b) => (args.direcao === "asc" ? a.valor - b.valor : b.valor - a.valor));
    const limite = Math.max(1, Math.min(Number(args.limite || MAX_LISTA), 100));
    itens = itens.slice(0, limite);
    return { tipo: "soma_agrupada", total_registros: encontrados.length, campo_grupo: agruparPor, campos, itens };
  }

  let total = 0;
  let comValor = 0;
  for (const row of encontrados) {
    const val = somaCamposDaLinha(row, campos);
    if (val !== null) {
      total += val;
      comValor += 1;
    }
  }
  return { tipo: "soma", total, registros: encontrados.length, registros_com_valor: comValor, campos };
}

// Normalizacao generica para dimensoes textuais sujas (ex.: bairro contendo endereco).
// A IA classifica SOMENTE os valores unicos. O Node valida evidencia e refaz as contagens.
async function normalizarDimensaoComIA(itensBrutos, conceito) {
  if (!itensBrutos?.length) return [];
  const entrada = itensBrutos.slice(0, 120).map((x, i) => ({ id: i + 1, valor: x.grupo, quantidade: x.quantidade }));
  const mensagens = [
    {
      role: "system",
      content:
        `Voce normaliza valores de uma DIMENSAO de planilha. Conceito pedido: ${conceito}.\n` +
        `Retorne SOMENTE JSON: {"itens":[{"id":1,"canonicos":["Nome"],"evidencia":["trecho exato"]}]}.\n` +
        `REGRAS: nao invente. Um canonico deve estar explicitamente escrito no valor bruto ou o valor inteiro deve ser claramente esse conceito. ` +
        `Rua, avenida, travessa, trecho, numero, endereco completo e descricao generica NAO viram ${conceito} por si so. ` +
        `Se nao houver evidencia segura, canonicos deve ser []. Se houver dois ${conceito}s explicitamente informados, pode retornar os dois.`,
    },
    { role: "user", content: JSON.stringify(entrada) },
  ];

  let raw = "";
  try {
    raw = await chamarIAbruta(mensagens, { max_tokens: 1500, temperature: 0, reasoning_effort: "low" });
  } catch {
    return [];
  }
  const obj = parseJSONSeguro(raw);
  if (!obj || !Array.isArray(obj.itens)) return [];

  const porId = new Map(entrada.map((x) => [Number(x.id), x]));
  const saida = [];
  for (const item of obj.itens) {
    const base = porId.get(Number(item.id));
    if (!base) continue;
    const brutoNorm = normalizar(base.valor);
    const canonicos = unico(Array.isArray(item.canonicos) ? item.canonicos : []);
    for (const canonico of canonicos) {
      const cNorm = normalizar(canonico);
      // Protecao: o nome canonico precisa existir literalmente no valor bruto.
      if (!cNorm || !brutoNorm.includes(cNorm)) continue;
      saida.push({ canonico: texto(canonico), bruto: base.valor, quantidade: Number(base.quantidade) || 0 });
    }
  }
  return saida;
}

async function ferramentaAgrupar(rows, args = {}) {
  const campo = args.campo;
  if (!campo) return { tipo: "erro_ferramenta", erro: "agrupar_por exige campo" };
  const encontrados = filtrarLinhas(rows, args);
  const grupos = new Map();

  for (const row of encontrados) {
    const bruto = valorCampo(row, campo);
    const g = texto(bruto);
    if (!g) continue;
    const key = normalizar(g);
    if (!grupos.has(key)) grupos.set(key, { grupo: g, quantidade: 0 });
    grupos.get(key).quantidade += 1;
  }

  let itens = [...grupos.values()];

  if (args.normalizar_dimensao === true && itens.length) {
    const mapeados = await normalizarDimensaoComIA(itens, args.conceito || campo);
    if (mapeados.length) {
      const canon = new Map();
      for (const m of mapeados) {
        const k = normalizar(m.canonico);
        if (!canon.has(k)) canon.set(k, { grupo: m.canonico, quantidade: 0, fontes: [] });
        const c = canon.get(k);
        c.quantidade += m.quantidade;
        c.fontes.push(m.bruto);
      }
      itens = [...canon.values()];
    }
  }

  itens.sort((a, b) => {
    if (normalizar(args.ordenar_por || "quantidade") === "grupo") {
      return texto(a.grupo).localeCompare(texto(b.grupo), "pt-BR", { sensitivity: "base" });
    }
    return normalizar(args.direcao || "desc") === "asc" ? a.quantidade - b.quantidade : b.quantidade - a.quantidade;
  });

  const limite = Math.max(1, Math.min(Number(args.limite || MAX_LISTA), 100));
  return {
    tipo: "agrupamento",
    campo,
    total_registros: encontrados.length,
    total_grupos: itens.length,
    itens: itens.slice(0, limite),
    truncado: itens.length > limite,
  };
}

async function executarFerramenta(nome, rows, args = {}) {
  switch (nome) {
    case "listar_colunas": return ferramentaListarColunas(rows, args);
    case "buscar_obras": return ferramentaBuscar(rows, args);
    case "contar_obras": return ferramentaContar(rows, args);
    case "agrupar_por": return await ferramentaAgrupar(rows, args);
    case "somar": return ferramentaSomar(rows, args);
    default: return { tipo: "erro_ferramenta", erro: `Ferramenta desconhecida: ${nome}` };
  }
}

// ------------------------------------------------------------
// Estado conversacional: usa SOMENTE o ultimo estado valido.
// ------------------------------------------------------------
function ultimoEstadoValido(historico = []) {
  if (!Array.isArray(historico)) return null;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m?.role === "assistant" && m?.estado && typeof m.estado === "object") return m.estado;
  }
  return null;
}

function historicoCompacto(historico = []) {
  if (!Array.isArray(historico)) return [];
  return historico.slice(-MAX_HISTORICO).map((m) => ({
    role: m.role,
    content: texto(m.content).slice(0, 700),
  })).filter((m) => m.role && m.content);
}

function mergeArgsComEstado(args = {}, plano = {}, estado = null) {
  const a = { ...args };
  if (!plano.inherit_scope || !estado) return a;

  if ((!a.escopo || (Array.isArray(a.escopo) && !a.escopo.length)) && estado.escopo) a.escopo = estado.escopo;
  if ((!a.termos || !a.termos.length) && estado.termos?.length) a.termos = [...estado.termos];
  if ((!a.campos_busca || !a.campos_busca.length) && estado.campos_busca?.length) a.campos_busca = [...estado.campos_busca];

  const atuais = Array.isArray(a.filtros) ? a.filtros : [];
  let anteriores = Array.isArray(estado.filtros) ? estado.filtros : [];
  // Status novo explicito substitui o anterior (nao acumula).
  if (plano._statusExplicito) anteriores = anteriores.filter((f) => f?.campo !== "status_grupo");
  const vistos = new Set();
  a.filtros = [...anteriores, ...atuais].filter((f) => {
    const k = JSON.stringify(f);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  return a;
}

function construirEstado(plano, args, resultado) {
  const estado = {
    versao: 1,
    fonte: "google_sheets_tools",
    escopo: Array.isArray(args.escopo) ? args.escopo : [args.escopo].filter(Boolean),
    termos: Array.isArray(args.termos) ? args.termos : [args.termos].filter(Boolean),
    campos_busca: Array.isArray(args.campos_busca) ? args.campos_busca : [],
    filtros: Array.isArray(args.filtros) ? args.filtros : [],
    ferramenta: plano.tool,
    label: texto(plano.label || "registros"),
    momento: Date.now(),
  };

  if (resultado?.tipo === "agrupamento") {
    estado.dimensao = resultado.campo;
    estado.grupos_recentes = resultado.itens.slice(0, 10).map((x) => x.grupo);
  }
  if (resultado?.tipo === "lista") {
    estado.objetos_recentes = resultado.itens.slice(0, 20).map((x) => x.objeto).filter(Boolean);
  }
  return estado;
}

// ------------------------------------------------------------
// Planner: IA escolhe ferramenta e argumentos. Nao gera SQL.
// ------------------------------------------------------------
const SYSTEM_PLANNER = `Voce e um AGENTE DE PLANILHA. Voce NAO gera SQL e NAO responde fatos de memoria.
Sua funcao e escolher UMA ferramenta para consultar os dados reais de um Google Sheets.

FERRAMENTAS DISPONIVEIS:
1) listar_colunas({aba?})
   - descobre colunas reais e exemplos.
2) buscar_obras({escopo, termos, modo_termos, campos_busca, filtros, campos, ordenar_por, direcao, limite})
   - lista registros e campos.
3) contar_obras({escopo, termos, modo_termos, campos_busca, filtros, distinto_por?})
   - conta registros ou valores distintos.
4) agrupar_por({escopo, campo, termos, modo_termos, campos_busca, filtros, ordenar_por, direcao, limite, normalizar_dimensao, conceito})
   - agrupa e conta por uma dimensao. Para dimensoes textuais sujas como bairro/localidade, use normalizar_dimensao=true.
5) somar({escopo, campo?, campos?, termos, modo_termos, campos_busca, filtros, agrupar_por?, direcao, limite})
   - soma valores numericos. campos permite somar mais de uma coluna por registro quando o conceito exigir.
6) responder
   - somente para saudacao, conversa social ou quando for indispensavel pedir esclarecimento.

ESCOPOS DO NEGOCIO:
- obra = abas EM_ANDAMENTO + PAVIMENTACAO/PAVIMENTAÇÃO
- projeto = aba EM_PROJETO
- licitacao = aba EM_LICITACAO/EM_LICITAÇÃO
- pavimentacao = somente PAVIMENTACAO/PAVIMENTAÇÃO
- todas = todas as abas

CONTEXTO:
- O bloco ESTADO_ATUAL abaixo e o UNICO estado anterior autorizado.
- Se a mensagem atual for follow-up como "quais sao?", "dessas", "e os responsaveis?", preserve o estado com inherit_scope=true.
- Se a mensagem atual trouxer um novo alvo/universo explicito, use inherit_scope=false. NUNCA ressuscite um assunto mais antigo.
- Mudar a acao (contar -> listar -> somar -> agrupar) nao deve apagar o recorte quando for follow-up.

SEMANTICA:
- Use os nomes de coluna reais informados no CATALOGO quando possivel; nomes canonicos como objeto, bairro, engenheiro, empresa, status, recurso, valor_total, valor_executado tambem sao aceitos.
- "valor pago" NAO e automaticamente "valor executado". Se houver colunas de pagamento, use as de pagamento.
- Para "total investido" use valor total da obra/contrato, salvo se o usuario pedir outra metrica.
- Nunca invente filtros, nomes, bairros, empresas, engenheiros ou valores.
- Se uma pergunta pedir "bairros e quantidade", use agrupar_por campo=bairro e normalizar_dimensao=true.
- Para um assunto literal como UBS, mercado, escola, drenagem etc., use termos e normalmente campos_busca=["objeto"].

OPERADORES DE FILTRO: eq, neq, contains, not_contains, one_of, not_one_of, gt, gte, lt, lte, is_empty, not_empty.

Retorne SOMENTE JSON neste formato:
{
  "tool":"buscar_obras|contar_obras|agrupar_por|somar|listar_colunas|responder",
  "inherit_scope":true,
  "label":"rotulo humano curto",
  "args":{},
  "answer":"texto somente se tool=responder"
}`;

async function planejar(pergunta, historico, estadoAtual, catalogo, observacaoFerramenta = null) {
  const userPayload = {
    pergunta,
    estado_atual: estadoAtual || null,
    catalogo: resumoCatalogo(catalogo),
    resultado_ferramenta_anterior: observacaoFerramenta || null,
  };

  const mensagens = [
    { role: "system", content: SYSTEM_PLANNER },
    ...historicoCompacto(historico),
    { role: "user", content: limitarTexto(userPayload, 16000) },
  ];

  const raw = await chamarIAbruta(mensagens, {
    max_tokens: 900,
    temperature: 0,
    reasoning_effort: "low",
  });
  return parseJSONSeguro(raw);
}

// ------------------------------------------------------------
// Resposta deterministica: fatos vem das ferramentas, nao da IA.
// ------------------------------------------------------------
function rotuloCampo(campo) {
  const mapa = {
    objeto: "Obra/objeto",
    bairro: "Bairro",
    bairro_limpo: "Bairro",
    valor_pago_2023: "Valor pago 2023",
    valor_pago_2024: "Valor pago 2024",
    valor_pago_2025: "Valor pago 2025",
    valor_pago_2026: "Valor pago 2026",
    status: "Status",
    engenheiro: "Responsável",
    empresa: "Empresa",
    recurso: "Recurso",
    tipo_recurso: "Tipo de recurso",
    valor_total: "Valor total",
    valor_executado: "Valor executado",
    saldo_devedor: "Saldo devedor",
    pago_gestao_atual: "Pago na gestão atual",
    pago_gestao_anterior: "Pago na gestão anterior",
  };
  return mapa[campo] || texto(campo).replace(/_/g, " ");
}

function formatarResultado(plano, resultado) {
  const label = texto(plano?.label) || "registros";

  if (!resultado || resultado.tipo === "erro_ferramenta") {
    return resultado?.erro || "Não consegui consultar os dados da planilha.";
  }

  if (resultado.tipo === "colunas") {
    if (!resultado.abas.length) return "Não encontrei abas/colunas na planilha.";
    return resultado.abas.map((a) => `*${a.aba}*\n${a.colunas.join(" • ")}`).join("\n\n");
  }

  if (resultado.tipo === "contagem") {
    if (resultado.total === 0) return `Não encontrei ${label} com esses critérios.`;
    return `Encontrei *${resultado.total}* ${label}.`;
  }

  if (resultado.tipo === "soma") {
    if (!resultado.registros || resultado.registros_com_valor === 0) {
      return `Não encontrei valores cadastrados para ${label} com esses critérios.`;
    }
    const campoPrincipal = resultado.campos?.[0] || "valor";
    const valorFmt = pareceCampoDinheiro(campoPrincipal) || resultado.campos?.some(pareceCampoDinheiro)
      ? formatarMoeda(resultado.total)
      : formatarNumero(resultado.total);
    return `O total de ${label} é *${valorFmt}* (${resultado.registros_com_valor} registro(s) com valor).`;
  }

  if (resultado.tipo === "soma_agrupada") {
    if (!resultado.itens.length) return `Não encontrei valores para ${label} com esses critérios.`;
    const linhas = resultado.itens.map((x, i) => {
      const val = resultado.campos?.some(pareceCampoDinheiro) ? formatarMoeda(x.valor) : formatarNumero(x.valor);
      return `*${i + 1}. ${x.grupo}* — ${val}`;
    });
    return `📋 *${label}*\n\n${linhas.join("\n")}`;
  }

  if (resultado.tipo === "agrupamento") {
    if (!resultado.itens.length) return `Não encontrei ${label} com esses critérios.`;
    const linhas = resultado.itens.map((x) => `• *${x.grupo}* — ${x.quantidade} ${x.quantidade === 1 ? "registro" : "registros"}`);
    const extra = resultado.truncado ? `\n\n(Mostrando os primeiros ${resultado.itens.length} de ${resultado.total_grupos} grupos.)` : "";
    return `📋 *${resultado.total_grupos} ${label}*\n\n${linhas.join("\n")}${extra}`;
  }

  if (resultado.tipo === "lista") {
    if (!resultado.total) return `Não encontrei ${label} com esses critérios.`;
    const blocos = resultado.itens.map((item, i) => {
      const titulo = texto(item.objeto) || `Registro ${i + 1}`;
      const detalhes = Object.entries(item)
        .filter(([k, v]) => !["_numero", "_aba", "objeto"].includes(k) && texto(v))
        .map(([k, v]) => `• *${rotuloCampo(k)}:* ${formatarValorCampo(k, v)}`)
        .join("\n");
      return `*${i + 1}. ${titulo}*${detalhes ? `\n${detalhes}` : ""}`;
    });
    const extra = resultado.total > resultado.exibidos ? `\n\n(Foram encontrados ${resultado.total}; mostrando ${resultado.exibidos}.)` : "";
    return `Encontrei *${resultado.total}* ${label}.\n\n${blocos.join("\n\n")}${extra}`;
  }

  return "Consulta concluída, mas não consegui formatar o resultado.";
}

// ------------------------------------------------------------
// Entrada principal
// ------------------------------------------------------------
export async function responderPergunta(pergunta, historico = []) {
  const q = texto(pergunta);
  if (!q) {
    return {
      resposta: "Digite uma pergunta sobre a planilha.",
      sql: "",
      linhas: 0,
      erro: "pergunta vazia",
      estado: ultimoEstadoValido(historico),
      modoAgente: "google_sheets_tools",
    };
  }

  let rows;
  try {
    rows = corrigirCabecalhos(await getObras());
  } catch (e) {
    return {
      resposta: `Não consegui ler a planilha agora: ${e?.message || e}`,
      sql: "",
      linhas: 0,
      erro: e?.message || String(e),
      estado: ultimoEstadoValido(historico),
      modoAgente: "google_sheets_tools",
    };
  }

  if (ehSaudacao(normalizar(q))) {
    return {
      resposta: RESPOSTA_SAUDACAO,
      sql: "",
      linhas: 0,
      erro: "",
      estado: ultimoEstadoValido(historico),
      modoAgente: "google_sheets_tools",
    };
  }

  const catalogo = construirCatalogo(rows);
  const estadoAtual = ultimoEstadoValido(historico);
  let observacao = null;
  let plano = null;
  let argsFinais = null;
  let resultado = null;

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    try {
      plano = await planejar(q, historico, estadoAtual, catalogo, observacao);
    } catch (e) {
      return {
        resposta: "Não consegui interpretar a pergunta agora. Tente novamente em alguns segundos.",
        sql: "",
        linhas: 0,
        erro: e?.message || String(e),
        estado: estadoAtual,
        modoAgente: "google_sheets_tools",
      };
    }

    if (!plano || !plano.tool) plano = { tool: "buscar_obras", args: {}, label: "registros" };
    if (plano.tool !== "responder" && plano.tool !== "listar_colunas") {
      plano = aplicarRegras(q, plano, estadoAtual, rows);
    }

    if (!plano || !plano.tool) {
      return {
        resposta: "Não consegui entender qual informação da planilha você quer consultar.",
        sql: "",
        linhas: 0,
        erro: "planner sem ferramenta",
        estado: estadoAtual,
        modoAgente: "google_sheets_tools",
      };
    }

    if (plano.tool === "responder") {
      return {
        resposta: texto(plano.answer) || "Pode perguntar sobre as obras, projetos e licitações da planilha.",
        sql: "",
        linhas: 0,
        erro: "",
        estado: estadoAtual,
        modoAgente: "google_sheets_tools",
      };
    }

    const args = mergeArgsComEstado(plano.args || {}, plano, estadoAtual);
    argsFinais = args;
    resultado = await executarFerramenta(plano.tool, rows, args);

    // listar_colunas e uma ferramenta de descoberta: devolve para a IA escolher a consulta final.
    if (plano.tool === "listar_colunas" && passo < MAX_PASSOS - 1) {
      observacao = limitarTexto(resultado, 10000);
      continue;
    }

    break;
  }

  const resposta = formatarResultado(plano, resultado);
  const estado = construirEstado(plano || {}, argsFinais || {}, resultado || {});
  const linhas = resultado?.tipo === "lista" ? resultado.total
    : resultado?.tipo === "agrupamento" ? resultado.total_registros
    : resultado?.tipo === "contagem" ? resultado.total
    : resultado?.tipo === "soma" ? resultado.registros
    : resultado?.tipo === "soma_agrupada" ? resultado.total_registros
    : 0;

  console.log("AGENTE SHEETS - FERRAMENTA:", plano?.tool || "");
  console.log("AGENTE SHEETS - ARGS:", limitarTexto(argsFinais || {}, 3000));
  console.log("AGENTE SHEETS - RESULTADO:", limitarTexto(resultado || {}, 3000));

  return {
    resposta,
    sql: "", // este agente nao usa SQL
    linhas,
    erro: "",
    estado,
    ferramenta: plano?.tool || null,
    modoAgente: "google_sheets_tools",
    fonte: "Google Sheets",
  };
}
