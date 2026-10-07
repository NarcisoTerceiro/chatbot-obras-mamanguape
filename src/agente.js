// ============================================================
// agente.js - AGENTE GOOGLE SHEETS COM FERRAMENTAS (SEM SQL) - V4 BAIRROS RIGOROSOS + ESCOPO
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

function capitalizarRotuloDimensao(v, conceito = "") {
  const original = texto(v).replace(/\s+/g, " ");
  if (!original) return original;

  // Para dimensoes de localidade, padroniza caixa sem alterar o conteudo.
  // Ex.: AREAL -> Areal; PITANGA DA ESTRADA -> Pitanga da Estrada.
  const c = normalizar(conceito);
  if (!(c.includes("bairro") || c.includes("localidade"))) return original;

  const minusculas = new Set(["da", "de", "do", "das", "dos", "e"]);
  return original
    .toLocaleLowerCase("pt-BR")
    .split(" ")
    .map((palavra, idx) => {
      if (!palavra) return palavra;
      if (idx > 0 && minusculas.has(palavra)) return palavra;
      return palavra.charAt(0).toLocaleUpperCase("pt-BR") + palavra.slice(1);
    })
    .join(" ");
}

function unidadeDoEscopo(escopo) {
  const lista = Array.isArray(escopo) ? escopo : [escopo].filter(Boolean);
  const unicos = unico(lista.map(normalizar));
  if (unicos.length !== 1) return { singular: "registro", plural: "registros" };
  if (unicos[0] === "obra") return { singular: "obra", plural: "obras" };
  if (unicos[0] === "projeto") return { singular: "projeto", plural: "projetos" };
  if (unicos[0] === "licitacao") return { singular: "licitação", plural: "licitações" };
  if (unicos[0] === "pavimentacao") return { singular: "pavimentação", plural: "pavimentações" };
  return { singular: "registro", plural: "registros" };
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
  localidade: ["localidade", "comunidade", "distrito", "loteamento"],
  rua: ["rua", "logradouro", "via", "avenida"],
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
  const real = resolverCampoNaLinha(row, campo);
  return real ? row[real] : null;
}

function objetoDaLinha(row) {
  return valorCampo(row, "objeto") || valorCampo(row, "descricao") || "Registro";
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

const TERMOS_GENERICOS_ESCOPO = {
  obra: ["obra", "obras", "obra publica", "obras publicas"],
  projeto: ["projeto", "projetos"],
  licitacao: ["licitacao", "licitacoes", "processo licitatorio", "processos licitatorios", "certame", "certames"],
  pavimentacao: ["pavimentacao", "pavimentacoes"],
};

function sanitizarArgsDeEscopo(args = {}) {
  const a = { ...args };
  const escopos = unico(Array.isArray(a.escopo) ? a.escopo : [a.escopo].filter(Boolean)).map(normalizar);
  const genericos = new Set();
  for (const e of escopos) {
    for (const t of TERMOS_GENERICOS_ESCOPO[e] || []) genericos.add(normalizar(t));
  }

  const termos = unico(Array.isArray(a.termos) ? a.termos : [a.termos].filter(Boolean));
  a.termos = termos.filter((t) => !genericos.has(normalizar(t)));

  const filtros = Array.isArray(a.filtros) ? a.filtros : [];
  a.filtros = filtros.filter((f) => {
    const campo = normalizar(f?.campo || f?.field || "");
    const valor = normalizar(f?.valor ?? f?.value ?? "");
    const op = normalizar(f?.operador || f?.operator || "eq").replace(/ /g, "_");
    const campoObjeto = ["objeto", "objeto da obra", "descricao", "nome"].includes(campo);
    const opTexto = ["eq", "contains", "contem", "one_of", "in"].includes(op);
    return !(campoObjeto && opTexto && genericos.has(valor));
  });

  return a;
}

function filtrarLinhas(rows, args = {}) {
  args = sanitizarArgsDeEscopo(args);
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

// ------------------------------------------------------------
// Extracao deterministica de bairro/localidade.
// Nao inventa: usa apenas texto existente na propria linha.
// ------------------------------------------------------------
function valorColunaExata(row, nomes = []) {
  const desejados = new Set(nomes.map(normalizar));
  for (const [k, v] of Object.entries(row || {})) {
    if (k === "_aba") continue;
    if (desejados.has(normalizar(k)) && texto(v)) return texto(v);
  }
  return "";
}

function ehDescricaoLocalGenerica(v = "") {
  const n = normalizar(v);
  if (!n) return true;

  // Localizadores que descrevem uma area ampla, trecho viario ou o proprio
  // servico, mas NAO identificam um bairro especifico.
  const genericos = [
    "diversas ruas", "ruas diversas", "diversas localidades", "localidades rurais",
    "zona rural", "zona urbana", "estradas diversas", "varias ruas", "várias ruas",
    "todo municipio", "todo o municipio", "municipio de mamanguape", "margens da br",
    "zonas rural e urbana", "zona rural e zona urbana"
  ].map(normalizar);
  if (genericos.some((g) => n === g || n.includes(g))) return true;

  // "Trecho 03", "TRECHO 04" etc. nunca sao bairro.
  if (/^trecho\s*[0-9a-z]+\b/.test(n)) return true;

  // Textos de objeto/servico que por erro foram colocados na coluna BAIRRO.
  // A regra e estrutural: rejeita descricoes de obra, nao nomes cadastrados.
  if (/^(recuperacao|ampliacao|manutencao|reforma|construcao|implantacao|pavimentacao|revitalizacao|requalificacao|restauracao|adequacao|execucao|urbanizacao|drenagem|melhoria|servicos?)\b/.test(n)) {
    return true;
  }
  if (/\b(unidades? de ensino|estradas? vicinais|pavimentacao de vias|recuperacao de trechos)\b/.test(n)) {
    return true;
  }

  return false;
}

function ehTrechoEndereco(v = "") {
  const n = normalizar(v);
  if (!n) return true;
  if (/^(s n|sn|n|numero|no)\b/.test(n)) return true;
  if (/^trecho\s*[0-9a-z]+\b/.test(n)) return true;
  if (/^\d+[a-z]?$/.test(n)) return true;
  if (/^(pb|paraiba|mamanguape|mamanguape pb)$/.test(n)) return true;
  if (/^(rua|r |avenida|av |travessa|rodovia|br |estrada|sitio)\b/.test(n)) return true;
  return false;
}

function removerSufixosDeEndereco(v = "") {
  let s = texto(v).trim();
  let anterior = null;
  // Repete para lidar com "Santa Edwiges, S/N, Mamanguape - PB".
  while (s && s !== anterior) {
    anterior = s;
    s = s
      .replace(/\s*,?\s*(?:mamanguape)\s*(?:-\s*pb)?\.?\s*$/i, "")
      .replace(/\s*,?\s*(?:pb|para[ií]ba)\s*$/i, "")
      .replace(/\s*,?\s*(?:s\s*\/?\s*n|sn)\.?\s*$/i, "")
      .replace(/\s*,?\s*(?:n[º°o]?\.?\s*\d+[a-z]?)\s*$/i, "")
      .replace(/^[,;\-\s]+|[,;\-\s]+$/g, "")
      .trim();
  }
  return s;
}

function limparRotuloLocalidade(v = "") {
  let s = removerSufixosDeEndereco(v)
    .replace(/^bairro\s*[:\-]\s*/i, "")
    .replace(/^localidade\s*[:\-]\s*/i, "")
    .replace(/\s*-\s*pb\s*$/i, "")
    .replace(/^[,;\-\s]+|[,;\-\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s || ehDescricaoLocalGenerica(s) || ehTrechoEndereco(s)) return "";
  return capitalizarRotuloDimensao(s, "bairro");
}

function extrairLocalidadeDeTexto(bruto = "", { permitirValorInteiro = false } = {}) {
  const original = texto(bruto);
  if (!original) return "";

  // Evidencia explicita vence descricoes genericas ao redor.
  // Ex.: "Diversas Ruas; Bairro: Centro e Gurguri; s/n".
  let m = original.match(/\bbairro\s*[:\-]\s*([^;|]+)/i);
  if (m?.[1]) {
    const r = limparRotuloLocalidade(m[1]);
    if (r) return r;
  }

  // Evidencia explicita em nomes/descricoes: preserva o nome completo da localidade.
  m = original.match(/\b((?:bairro|distrito\s+de|loteamento|comunidade)\s+[^,;|\-]{2,80})/i);
  if (m?.[1]) {
    const r = limparRotuloLocalidade(m[1]);
    if (r) return r;
  }

  if (ehDescricaoLocalGenerica(original)) return "";

  // Endereco no formato "Rua X, s/n - Centro" ou "Rua X - Bela Vista".
  const partesHifen = original.split(/\s+-\s+/).map(texto).filter(Boolean);
  if (partesHifen.length >= 2) {
    for (let i = partesHifen.length - 1; i >= 1; i--) {
      const candidato = limparRotuloLocalidade(partesHifen[i]);
      if (candidato && !ehTrechoEndereco(candidato)) return candidato;
    }
  }

  // Endereco no formato "Rua X, S/N, Centro, Mamanguape - PB" ou
  // "Santa Edwiges, S/N" / "Campo, Mamanguape".
  const semSufixos = removerSufixosDeEndereco(original);
  const partes = semSufixos.split(/[,;]/).map(texto).filter(Boolean);
  if (partes.length >= 2) {
    for (let i = partes.length - 1; i >= 0; i--) {
      const p = partes[i];
      if (ehTrechoEndereco(p) || ehDescricaoLocalGenerica(p)) continue;
      const candidato = limparRotuloLocalidade(p);
      if (candidato) return candidato;
    }
  }

  if (permitirValorInteiro) {
    const inteiro = limparRotuloLocalidade(semSufixos || original);
    if (!inteiro || ehDescricaoLocalGenerica(inteiro)) return "";
    return inteiro;
  }
  return "";
}


function extrairLocalidadeMarcadaDeTexto(bruto = "") {
  const original = texto(bruto);
  if (!original) return "";

  let m = original.match(/\bbairro\s*[:\-]?\s+([^,;|\-]{2,80})/i);
  if (m?.[1]) {
    const r = limparRotuloLocalidade(m[1]);
    if (r) return r;
  }

  m = original.match(/\b((?:distrito\s+de|loteamento|comunidade)\s+[^,;|\-]{2,80})/i);
  if (m?.[1]) {
    const r = limparRotuloLocalidade(m[1]);
    if (r) return r;
  }

  return "";
}

function bairroDerivadoDaLinha(row) {
  // 1) Campo BAIRRO e a fonte preferida. Pode conter bairro puro ou endereco sujo.
  const brutoBairro = valorColunaExata(row, ["bairro"]);
  if (brutoBairro) {
    const b = extrairLocalidadeDeTexto(brutoBairro, { permitirValorInteiro: true });
    if (b) return { grupo: b, fonte: "bairro", bruto: brutoBairro };
  }

  // 2) Colunas de localidade explicitas.
  const local = valorColunaExata(row, ["localidade", "comunidade", "distrito", "loteamento"]);
  if (local) {
    const b = extrairLocalidadeDeTexto(local, { permitirValorInteiro: true });
    if (b) return { grupo: b, fonte: "localidade", bruto: local };
  }

  // 3) Pavimentacao normalmente guarda o bairro/localidade no proprio nome da RUA.
  const rua = valorColunaExata(row, ["rua", "logradouro", "endereco", "endereço"]);
  if (rua) {
    const b = extrairLocalidadeDeTexto(rua, { permitirValorInteiro: false });
    if (b) return { grupo: b, fonte: "rua/endereco", bruto: rua };
  }

  // 4) Ultimo recurso: no OBJETO aceitamos SOMENTE marcadores explicitos
  // ("Bairro X", "Distrito de Y", "Loteamento Z", "Comunidade W").
  // Nao usamos sufixo apos hifen, pois "PASSAGEM MOLHADA - TEREZA SOARES"
  // e nome de obra/local de referencia, nao prova de bairro.
  const objeto = objetoDaLinha(row);
  if (objeto) {
    const b = extrairLocalidadeMarcadaDeTexto(objeto);
    if (b) return { grupo: b, fonte: "objeto", bruto: objeto };
  }
  return null;
}

function grupoDimensaoDaLinha(row, campo, normalizarDimensao = false) {
  const c = normalizar(campo);
  // Bairro/localidade SEMPRE passa pelo extrator seguro. Nao depende de a IA
  // lembrar de marcar normalizar_dimensao=true.
  if (c.includes("bairro") || c.includes("localidade")) {
    return bairroDerivadoDaLinha(row);
  }
  const bruto = valorCampo(row, campo);
  const g = texto(bruto);
  return g ? { grupo: g, fonte: campo, bruto: g } : null;
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

async function ferramentaSomar(rows, args = {}) {
  args = sanitizarArgsDeEscopo(args);
  const encontrados = filtrarLinhas(rows, args);
  const campos = unico(Array.isArray(args.campos) && args.campos.length ? args.campos : [args.campo].filter(Boolean));
  if (!campos.length) return { tipo: "erro_ferramenta", erro: "somar exige campo ou campos" };

  const agruparPor = args.agrupar_por;
  if (agruparPor) {
    const grupos = new Map();
    let registrosComValor = 0;
    let registrosIdentificados = 0;
    let valorIdentificado = 0;
    let valorNaoIdentificado = 0;

    for (const row of encontrados) {
      const val = somaCamposDaLinha(row, campos);
      if (val === null) continue;
      registrosComValor += 1;

      const infoGrupo = grupoDimensaoDaLinha(row, agruparPor, args.normalizar_dimensao === true);
      if (!infoGrupo?.grupo) {
        valorNaoIdentificado += val;
        continue;
      }

      const rotulo = capitalizarRotuloDimensao(infoGrupo.grupo, args.conceito || agruparPor);
      const key = normalizar(rotulo);
      if (!key) {
        valorNaoIdentificado += val;
        continue;
      }
      if (!grupos.has(key)) grupos.set(key, { grupo: rotulo, valor: 0, registros: 0 });
      const obj = grupos.get(key);
      obj.valor += val;
      obj.registros += 1;
      registrosIdentificados += 1;
      valorIdentificado += val;
    }

    let itens = [...grupos.values()];
    itens.sort((a, b) => (normalizar(args.direcao || "desc") === "asc" ? a.valor - b.valor : b.valor - a.valor));
    const limite = Math.max(1, Math.min(Number(args.limite || MAX_LISTA), 100));
    const totalGrupos = itens.length;
    itens = itens.slice(0, limite);

    return {
      tipo: "soma_agrupada",
      total_registros: encontrados.length,
      registros_com_valor: registrosComValor,
      registros_identificados: registrosIdentificados,
      registros_nao_identificados: Math.max(0, registrosComValor - registrosIdentificados),
      cobertura_percentual: registrosComValor ? Number(((registrosIdentificados / registrosComValor) * 100).toFixed(1)) : 0,
      valor_identificado: valorIdentificado,
      valor_nao_identificado: valorNaoIdentificado,
      campo_grupo: agruparPor,
      campos,
      itens,
      total_grupos: totalGrupos,
      truncado: totalGrupos > limite,
      normalizacao_aplicada: normalizar(agruparPor).includes("bairro") || normalizar(agruparPor).includes("localidade") || args.normalizar_dimensao === true,
    };
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
    const info = grupoDimensaoDaLinha(row, campo, args.normalizar_dimensao === true);
    const g = texto(info?.grupo);
    if (!g) continue;
    const rotulo = capitalizarRotuloDimensao(g, args.conceito || campo);
    const key = normalizar(rotulo);
    if (!grupos.has(key)) grupos.set(key, { grupo: rotulo, quantidade: 0 });
    grupos.get(key).quantidade += 1;
  }

  const itensBrutos = [...grupos.values()];
  const registrosComValorDimensao = itensBrutos.reduce((acc, x) => acc + (Number(x.quantidade) || 0), 0);
  const registrosSemValorDimensao = Math.max(0, encontrados.length - registrosComValorDimensao);
  let itens = [...itensBrutos];
  const conceitoNorm = normalizar(args.conceito || campo);
  const dimensaoLocalidade = conceitoNorm.includes("bairro") || conceitoNorm.includes("localidade") || normalizar(campo).includes("bairro");
  let normalizacaoAplicada = dimensaoLocalidade || args.normalizar_dimensao === true;
  let registrosIdentificados = registrosComValorDimensao;
  let registrosNaoIdentificados = registrosSemValorDimensao;

  if (args.normalizar_dimensao === true && itensBrutos.length && !dimensaoLocalidade) {
    const conceito = args.conceito || campo;
    const mapeados = await normalizarDimensaoComIA(itensBrutos, conceito);
    if (mapeados.length) {
      normalizacaoAplicada = true;
      const canon = new Map();
      const fontesMapeadas = new Set();

      for (const m of mapeados) {
        const rotulo = capitalizarRotuloDimensao(m.canonico, conceito);
        const k = normalizar(rotulo);
        if (!k) continue;
        if (!canon.has(k)) canon.set(k, { grupo: rotulo, quantidade: 0, fontes: [] });
        const c = canon.get(k);
        c.quantidade += m.quantidade;
        c.fontes.push(m.bruto);
        fontesMapeadas.add(normalizar(m.bruto));
      }

      itens = [...canon.values()];
      registrosIdentificados = itensBrutos
        .filter((x) => fontesMapeadas.has(normalizar(x.grupo)))
        .reduce((acc, x) => acc + (Number(x.quantidade) || 0), 0);
      registrosNaoIdentificados = Math.max(0, encontrados.length - registrosIdentificados);
    } else {
      // Se a normalizacao foi pedida e nada pôde ser classificado com evidencia,
      // nao apresenta os valores crus como se fossem dimensoes confiaveis.
      itens = [];
      registrosIdentificados = 0;
      registrosNaoIdentificados = encontrados.length;
    }
  }

  itens.sort((a, b) => {
    if (normalizar(args.ordenar_por || "quantidade") === "grupo") {
      return texto(a.grupo).localeCompare(texto(b.grupo), "pt-BR", { sensitivity: "base" });
    }
    return normalizar(args.direcao || "desc") === "asc" ? a.quantidade - b.quantidade : b.quantidade - a.quantidade;
  });

  const limite = Math.max(1, Math.min(Number(args.limite || MAX_LISTA), 100));
  const unidade = unidadeDoEscopo(args.escopo);
  const coberturaPercentual = encontrados.length
    ? Number(((registrosIdentificados / encontrados.length) * 100).toFixed(1))
    : 0;

  return {
    tipo: "agrupamento",
    campo,
    total_registros: encontrados.length,
    total_grupos: itens.length,
    itens: itens.slice(0, limite),
    truncado: itens.length > limite,
    unidade,
    normalizacao_aplicada: normalizacaoAplicada,
    registros_com_valor_dimensao: registrosComValorDimensao,
    registros_sem_valor_dimensao: registrosSemValorDimensao,
    registros_identificados: registrosIdentificados,
    registros_nao_identificados: registrosNaoIdentificados,
    cobertura_percentual: coberturaPercentual,
  };
}

async function executarFerramenta(nome, rows, args = {}) {
  switch (nome) {
    case "listar_colunas": return ferramentaListarColunas(rows, args);
    case "buscar_obras": return ferramentaBuscar(rows, args);
    case "contar_obras": return ferramentaContar(rows, args);
    case "agrupar_por": return await ferramentaAgrupar(rows, args);
    case "somar": return await ferramentaSomar(rows, args);
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

  const anteriores = Array.isArray(estado.filtros) ? estado.filtros : [];
  const atuais = Array.isArray(a.filtros) ? a.filtros : [];
  a.filtros = [...anteriores, ...atuais];

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
5) somar({escopo, campo?, campos?, termos, modo_termos, campos_busca, filtros, agrupar_por?, normalizar_dimensao?, conceito?, direcao, limite})
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
- ESCOLHA DA FERRAMENTA: buscar_obras serve para identificar/listar QUAIS registros atendem a uma condicao e/ou mostrar detalhes. agrupar_por serve SOMENTE para distribuicao por dimensao (ex.: quantos em cada bairro/status/engenheiro).
- Portanto, se o usuario pedir quais registros estao em um status especifico (ex.: quais projetos estao concluidos), use buscar_obras + filtro de status; NAO use agrupar_por status.
- Se uma pergunta pedir "bairros e quantidade", use agrupar_por campo=bairro e normalizar_dimensao=true.
- Nunca trate TRECHO numerado, nome de servico/obra (reforma, recuperacao, manutencao, pavimentacao etc.), rua/avenida ou endereco como bairro. O Node tambem valida isso.
- Se pedir soma/valor por bairro ou localidade, use somar com agrupar_por="bairro", normalizar_dimensao=true e conceito="bairro". NUNCA agrupe valor financeiro pelo texto bruto de endereco.
- Palavras que apenas nomeiam o universo ("obras", "projetos", "licitacoes") definem escopo; NAO as coloque em termos nem em filtro de objeto. Ex.: "quantas licitacoes existem?" = contar_obras({escopo:["licitacao"]}) sem termos.
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
    const notas = [];
    if (resultado.truncado) notas.push(`Mostrando ${resultado.itens.length} de ${resultado.total_grupos} grupos.`);
    if (resultado.normalizacao_aplicada) {
      notas.push(`Foram alocados com segurança ${resultado.registros_identificados} de ${resultado.registros_com_valor} registros com valor (${formatarNumero(resultado.cobertura_percentual)}% de cobertura).`);
      if (resultado.registros_nao_identificados > 0) {
        const vf = resultado.campos?.some(pareceCampoDinheiro) ? formatarMoeda(resultado.valor_nao_identificado) : formatarNumero(resultado.valor_nao_identificado);
        notas.push(`${resultado.registros_nao_identificados} registros com valor não foram atribuídos a um bairro/localidade específica; valor não alocado: ${vf}.`);
      }
    }
    const extra = notas.length ? `\n\n_${notas.join(" ")}_` : "";
    return `📋 *${label}*\n\n${linhas.join("\n")}${extra}`;
  }

  if (resultado.tipo === "agrupamento") {
    if (!resultado.itens.length) {
      if (resultado.total_registros > 0 && resultado.registros_nao_identificados === resultado.total_registros) {
        return `Encontrei *${resultado.total_registros}* registros no recorte, mas não consegui identificar ${label} com segurança nos dados da planilha.`;
      }
      return `Não encontrei ${label} com esses critérios.`;
    }

    const unidade = resultado.unidade || { singular: "registro", plural: "registros" };
    const linhas = resultado.itens.map((x) =>
      `• *${x.grupo}* — ${x.quantidade} ${x.quantidade === 1 ? unidade.singular : unidade.plural}`
    );

    const notas = [];
    if (resultado.truncado) {
      notas.push(`Mostrando os primeiros ${resultado.itens.length} de ${resultado.total_grupos} grupos.`);
    }
    if (resultado.normalizacao_aplicada || resultado.registros_nao_identificados > 0) {
      notas.push(
        `Foi possível classificar com segurança ${resultado.registros_identificados} de ${resultado.total_registros} ` +
        `${resultado.total_registros === 1 ? unidade.singular : unidade.plural} em ${resultado.total_grupos} grupos ` +
        `(${formatarNumero(resultado.cobertura_percentual)}% de cobertura).`
      );
      if (resultado.registros_nao_identificados > 0) {
        notas.push(
          `${resultado.registros_nao_identificados} ${resultado.registros_nao_identificados === 1 ? unidade.singular : unidade.plural} ` +
          `ficaram sem classificação segura porque o campo estava vazio, ambíguo ou continha apenas endereço/localização sem evidência suficiente.`
        );
      }
    }

    const extra = notas.length ? `\n\n_${notas.join(" ")}_` : "";
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
      modoAgente: "google_sheets_tools_v3",
    };
  }

  let rows;
  try {
    rows = await getObras();
  } catch (e) {
    return {
      resposta: `Não consegui ler a planilha agora: ${e?.message || e}`,
      sql: "",
      linhas: 0,
      erro: e?.message || String(e),
      estado: ultimoEstadoValido(historico),
      modoAgente: "google_sheets_tools_v3",
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
        modoAgente: "google_sheets_tools_v3",
      };
    }

    if (!plano || !plano.tool) {
      return {
        resposta: "Não consegui entender qual informação da planilha você quer consultar.",
        sql: "",
        linhas: 0,
        erro: "planner sem ferramenta",
        estado: estadoAtual,
        modoAgente: "google_sheets_tools_v3",
      };
    }

    if (plano.tool === "responder") {
      return {
        resposta: texto(plano.answer) || "Pode perguntar sobre as obras, projetos e licitações da planilha.",
        sql: "",
        linhas: 0,
        erro: "",
        estado: estadoAtual,
        modoAgente: "google_sheets_tools_v3",
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
    modoAgente: "google_sheets_tools_v3",
    fonte: "Google Sheets",
  };
}
