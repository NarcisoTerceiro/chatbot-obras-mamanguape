// ============================================================
// agente.js - AGENTE DE PLANILHA (Google Sheets) EM 3 ETAPAS
// ============================================================
//
//  pergunta
//     │
//     ▼
//  [1] IA PLANEJADORA   recebe: REGRAS DE NEGÓCIO (o que cada coluna de cada aba
//                       significa) + valores reais (status, engenheiros...) + pergunta.
//                       devolve: um PLANO em JSON (quais abas, filtros, agrupamento, métricas).
//     │
//     ▼
//  [2] FERRAMENTAS JS   validam o plano, lêem a planilha (getObras), filtram e CALCULAM
//                       (soma, média, contagem, ranking...). A IA nunca faz conta.
//     │
//     ▼
//  [3] IA RESPONDEDORA  recebe só o resultado já calculado e escreve a resposta.
//                       Se ela errar um número, o Node troca pela resposta determinística.
//
// Compatível com o projeto atual:
//   import { getObras } from "./sheets.js";          // linhas com { _aba, ...colunas }
//   import { chamarIAbruta } from "./groq.js";       // (mensagens, opts) => string
//   export async function responderPergunta(pergunta, historico = [])
//
// Para o agente aprender uma coluna/aba nova, edite SOMENTE o bloco REGRAS abaixo.
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";

const MAX_PASSOS = Math.max(2, Math.min(Number(process.env.AGENTE_SHEETS_PASSOS || 3), 5));
const MAX_LISTA = Math.max(5, Math.min(Number(process.env.AGENTE_SHEETS_MAX_LISTA || 30), 100));
const MAX_HISTORICO = Math.max(2, Math.min(Number(process.env.AGENTE_SHEETS_HISTORICO || 6), 16));
const MAX_CONSULTAS = 3;
const CACHE_SEG = Number(process.env.AGENTE_CACHE_SEG ?? 60);
const RESPOSTA_IA = process.env.AGENTE_RESPOSTA_IA !== "0"; // 0 = só resposta determinística
const FUSO = "America/Fortaleza";

// ============================================================
// 1) REGRAS DE NEGÓCIO  (é aqui que você "ensina" a planilha para a IA)
// ============================================================
// col(nomeRealDaColuna, tipo, conceito, descricao, menor?)
//   tipo     : texto | dinheiro | numero | percentual | data | link
//   conceito : nome único usado entre abas (ex.: "engenheiro" existe com nomes diferentes em cada aba)
//   menor    : true = coluna secundária, aparece só resumida no prompt
const col = (nome, tipo, conceito, desc, menor = false) => ({ nome, tipo, conceito, desc, menor });

const REGRAS = {
  // Grupos de abas que o usuário cita no dia a dia.
  escopos: {
    obra: ["EM_ANDAMENTO", "PAVIMENTAÇÃO"],
    projeto: ["EM_PROJETO"],
    licitacao: ["EM_LICITAÇÃO"],
    pavimentacao: ["PAVIMENTAÇÃO"],
    pendencia: ["PENDÊNCIAS"],
    todas: ["EM_ANDAMENTO", "PAVIMENTAÇÃO", "EM_PROJETO", "EM_LICITAÇÃO"],
  },

  // Abas que nunca entram (rascunhos, modelos vazios).
  ignorar: ["Sheet6"],

  regras_gerais: [
    "\"Obra\" = abas EM_ANDAMENTO + PAVIMENTAÇÃO. \"Projeto\" = EM_PROJETO. \"Licitação\" = EM_LICITAÇÃO. Pendências = PENDÊNCIAS.",
    "Só EM_ANDAMENTO e PAVIMENTAÇÃO têm valores em R$. Projetos e licitações NÃO têm valor (estimativas aparecem só no texto de observações).",
    "O STATUS é literal da planilha. NÃO deduza status por % executada. \"Retomada\" é um status separado de \"Em andamento\": só inclua se o usuário pedir.",
    "Valor total da obra = valor inicial do contrato + aditivos + reajustes. Saldo devedor = valor total − valor executado.",
    "\"Total investido\" ou \"valor da obra\" = valor_total. \"Quanto foi pago\" = valor_pago_total (ou valor_pago_2023..2026 se o usuário citar o ano). \"Quanto foi executado/medido\" = valor_executado. Nunca troque um pelo outro.",
    "Campo percentual é lido como 0–100 (ex.: 50 = 50%). Ao filtrar percentual, use o número em %, ex.: 50.",
    "O campo recurso pode ter várias fontes separadas por vírgula (ex.: \"FNDE, EMENDA PIX\"). Para filtrar uma fonte use op=contains.",
    "Bairro de projetos e licitações não existe como coluna: aparece só dentro do texto do objeto. Para isso use termos (busca de texto), não filtro de bairro.",
    "Quando falar em \"responsável\", \"fiscal\" ou \"engenheiro\" use o conceito engenheiro (pode ser engenheiro ou arquiteto).",
  ],

  abas: {
    EM_ANDAMENTO: {
      descricao: "Contratos de obras em execução. Uma linha por contrato, com financeiro completo.",
      campos_padrao: ["objeto", "status", "bairro", "engenheiro", "empresa", "valor_total", "percentual_executado"],
      colunas: [
        col("Nº DO CONTRATO", "texto", "contrato", "Número do contrato (ex.: 001/2026). Ligação com a aba PENDÊNCIAS (OBRA 001)."),
        col("OBJETO DA OBRA", "texto", "objeto", "Nome/descrição da obra."),
        col("RECURSO", "texto", "recurso", "Fonte(s) do recurso (ministério/programa). Pode ter vários separados por vírgula."),
        col("Nº DO CONVÊNIO/ PROPOSTA", "texto", "convenio", "Número do convênio ou proposta. Vazio em recurso próprio."),
        col("EMPRESA", "texto", "empresa", "Empresa contratada/executora."),
        col("VALOR INICIAL DO CONTRATO", "dinheiro", "valor_inicial", "Valor original do contrato, antes de aditivos e reajustes."),
        col("VALOR TOTAL DOS ADITIVOS", "dinheiro", "valor_aditivos", "Soma de todos os aditivos."),
        col("% DOS ADITIVOS", "percentual", "percentual_aditivos", "Aditivos sobre o valor inicial."),
        col("VALOR TOTAL DOS REAJUSTES", "dinheiro", "valor_reajustes", "Soma dos reajustes."),
        col("ADITIVO 01", "dinheiro", null, "", true), col("ADITIVO 02", "dinheiro", null, "", true),
        col("ADITIVO 03", "dinheiro", null, "", true), col("ADITIVO 04", "dinheiro", null, "", true),
        col("ADITIVO 05", "dinheiro", null, "", true), col("ADITIVO 06", "dinheiro", null, "", true),
        col("ADITIVO 07", "dinheiro", null, "", true), col("ADITIVO 08", "dinheiro", null, "", true),
        col("ADITIVO 09", "dinheiro", null, "", true), col("ADITIVO 10", "dinheiro", null, "", true),
        col("REAJUSTE 01", "dinheiro", null, "", true), col("REAJUSTE 02", "dinheiro", null, "", true),
        col("REAJUSTE 03", "dinheiro", null, "", true),
        col("VALOR TOTAL DA OBRA", "dinheiro", "valor_total", "Valor atual da obra = inicial + aditivos + reajustes. É o \"total investido\"."),
        col("VALOR EXECUTADO", "dinheiro", "valor_executado", "Valor já executado/medido até agora."),
        col("% EXECUTADA", "percentual", "percentual_executado", "Avanço financeiro = executado / total."),
        col("STATUS", "texto", "status", "Situação da obra, texto literal da planilha."),
        col("Data_Inicio", "data", "data_inicio", "Data de início da obra."),
        col("Data_Prev_Termino", "data", "data_prev_termino", "Data prevista de término."),
        col("SALDO DEVEDOR", "dinheiro", "saldo_devedor", "Quanto ainda falta pagar = total − executado."),
        col("BAIRRO", "texto", "bairro", "Bairro/localidade da obra."),
        col("TIPO_RECURSO", "texto", "tipo_recurso", "Classe do recurso: Convênio Federal ou Recurso Próprio."),
        col("ENGENHEIRO", "texto", "engenheiro", "Engenheiro/arquiteto responsável."),
        col("LATITUDE", "numero", null, "", true), col("LONGITUDE", "numero", null, "", true),
        col("LINK_DOCUMENTO", "link", "link_documento", "Link do documento/contrato.", true),
        col("Valor_ContratadoMaisAditivo", "dinheiro", "valor_contratado_mais_aditivo", "Inicial + aditivos (sem reajuste)."),
        col("CONTRAPARTIDA + REAJUSTE + ADITIVO ", "dinheiro", "contrapartida", "Acréscimo sobre o valor inicial (contrapartida + reajuste + aditivo)."),
        col("PAGO_GESTAO_ANTERIOR ", "dinheiro", "pago_gestao_anterior", "Pago na gestão anterior."),
        col("PAGO_GESTÃO_ATUAL", "dinheiro", "pago_gestao_atual", "Pago na gestão atual."),
        col("VALOR PAGO 2023", "dinheiro", "valor_pago_2023", "Pago em 2023."),
        col("VALOR PAGO 2024", "dinheiro", "valor_pago_2024", "Pago em 2024."),
        col("VALOR PAGO 2025", "dinheiro", "valor_pago_2025", "Pago em 2025."),
        col("VALOR PAGO 2026", "dinheiro", "valor_pago_2026", "Pago em 2026."),
        col("OBSERVAÇÕES", "texto", "observacoes", "Anotações livres."),
      ],
      derivados: [
        {
          nome: "valor_pago_total", tipo: "dinheiro", conceito: "valor_pago_total",
          desc: "CALCULADO: pago gestão anterior + pago gestão atual (= total já pago).",
          calc: (g) => somaNaoNula(g("pago_gestao_anterior"), g("pago_gestao_atual")),
        },
        {
          nome: "atrasada", tipo: "texto", conceito: "atrasada",
          desc: "CALCULADO: \"Sim\" se a data prevista de término já passou e o status não é concluída/executada; senão \"Não\".",
          calc: (g) => {
            const fim = g("data_prev_termino");
            if (fim === null) return null;
            const st = normStatus(g("status") || "");
            if (/^(conclu|execut|finaliz)/.test(st)) return "Não";
            return fim < agoraMs() ? "Sim" : "Não";
          },
        },
      ],
    },

    "PAVIMENTAÇÃO": {
      descricao: "Ruas pavimentadas ou em pavimentação. Uma linha por rua. Só tem situação, responsável, empresa, metragem e valor.",
      campos_padrao: ["objeto", "status", "bairro", "engenheiro", "empresa", "valor_total", "comprimento", "area_pavimentada"],
      colunas: [
        col("RUA", "texto", "objeto", "Nome da rua no formato \"Rua X - Bairro\". É o \"objeto\" desta aba."),
        col("SITUAÇÃO", "texto", "status", "Situação da pavimentação (Concluída / Em andamento)."),
        col("ENGENHEIRO RESPONSÁVEL", "texto", "engenheiro", "Engenheiro/arquiteto responsável."),
        col("CONVÊNIO/RECURSO", "texto", "recurso", "Fonte do recurso."),
        col("EMPRESA", "texto", "empresa", "Empresa executora."),
        col("COMPRIMENTO (M)", "numero", "comprimento", "Comprimento da via em metros."),
        col("MEIO FIO (M)", "numero", "meio_fio", "Metros de meio-fio."),
        col("ÁREA PAVIMENTADA (M²)", "numero", "area_pavimentada", "Área pavimentada em m²."),
        col("VALOR (R$)", "dinheiro", "valor_total", "Valor da pavimentação da rua em R$."),
      ],
      derivados: [
        {
          nome: "bairro", tipo: "texto", conceito: "bairro",
          desc: "CALCULADO: parte depois do \" - \" no nome da rua.",
          calc: (g) => {
            const rua = texto(g("objeto"));
            const i = rua.lastIndexOf(" - ");
            return i >= 0 ? rua.slice(i + 3).trim() || null : null;
          },
        },
      ],
    },

    "EM_LICITAÇÃO": {
      descricao: "Obras em processo de licitação. Sem valores em R$.",
      campos_padrao: ["objeto", "status", "recurso", "engenheiro", "data_envio", "observacoes"],
      colunas: [
        col("OBJETO DA OBRA", "texto", "objeto", "Nome/descrição do que será licitado."),
        col("FONTE DO RECURSO", "texto", "recurso", "Fonte do recurso."),
        col("DATA DE ENVIO", "data", "data_envio", "Data de envio do processo."),
        col("PROPOSTA ANALISADA", "texto", "proposta_analisada", "Sim/Não."),
        col("HABILITAÇÃO ANALISADA", "texto", "habilitacao_analisada", "Sim/Não."),
        col("STATUS", "texto", "status", "Etapa da licitação (Edital publicado, Em análise de propostas, Homologada...)."),
        col("ENGENHEIRO RESPONSÁVEL", "texto", "engenheiro", "Engenheiro/arquiteto responsável."),
        col("OBSERVAÇÕES", "texto", "observacoes", "Anotações: empresa vencedora, datas de sessão, estimativas."),
      ],
      derivados: [],
    },

    "EM_PROJETO": {
      descricao: "Projetos em elaboração/revisão. Sem valores em R$.",
      campos_padrao: ["objeto", "status", "recurso", "engenheiro", "data_entrega", "observacoes"],
      colunas: [
        col("OBJETO DA OBRA", "texto", "objeto", "Nome do projeto."),
        col("FONTE DO RECURSO", "texto", "recurso", "Fonte do recurso."),
        col("ENGENHEIRO/ARQUITETO RESPONSÁVEL", "texto", "engenheiro", "Engenheiro/arquiteto responsável."),
        col("STATUS", "texto", "status", "Etapa do projeto (Em elaboração, Em revisão, Aguardando aprovação, Concluído)."),
        col("DATA DE ENTREGA", "data", "data_entrega", "Data de entrega prevista ou realizada."),
        col("OBSERVAÇÕES", "texto", "observacoes", "Anotações livres."),
      ],
      derivados: [],
    },

    "PENDÊNCIAS": {
      descricao: "Pendências que travam início/continuidade de obras. Uma linha por pendência, ligada ao contrato de EM_ANDAMENTO.",
      campos_padrao: ["contrato", "objeto", "status", "pendencia"],
      colunas: [
        col("Nº DO CONTRATO", "texto", "contrato", "Número do contrato da obra (ex.: 001)."),
        col("OBRA", "texto", "objeto", "Nome da obra (buscado em EM_ANDAMENTO pelo número do contrato)."),
        col("STATUS DA OBRA", "texto", "status", "Status da obra em EM_ANDAMENTO."),
        col("PENDÊNCIA", "texto", "pendencia", "Descrição da pendência."),
      ],
      derivados: [],
    },
  },
};

// Conceitos cujos valores reais são mostrados para a IA (evita ela inventar "Em execução" quando é "Em andamento").
const CONCEITOS_COM_VALORES = ["status", "engenheiro", "empresa", "recurso", "tipo_recurso", "bairro"];

// ============================================================
// Utilitários
// ============================================================
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

function unico(arr) {
  return [...new Set((arr || []).filter((x) => x !== null && x !== undefined && texto(x) !== ""))];
}

function limitarTexto(v, max = 7000) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function somaNaoNula(...vals) {
  const v = vals.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

// Aceita número puro, "1.234,56", "R$ 1.234,56", "(1.234)", "50.000,00", "0.05882", "2.520" (milhar pt-BR).
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

  s = s.replace(/R\$/gi, "").replace(/%/g, "").replace(/\s+/g, "").replace(/[^0-9,.-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return null;

  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");

  if (temVirgula && temPonto) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (temVirgula) {
    const partes = s.split(",");
    if (partes.length === 2 && partes[1].length <= 4) s = partes[0].replace(/\./g, "") + "." + partes[1];
    else s = s.replace(/,/g, "");
  } else if (temPonto) {
    const partes = s.split(".");
    const ultimo = partes[partes.length - 1];
    if (partes.length > 2 && partes.slice(1).every((p) => p.length === 3)) {
      s = partes.join(""); // 1.234.567
    } else if (partes.length === 2 && ultimo.length === 3 && /^-?\d{1,3}$/.test(partes[0]) && partes[0].replace("-", "") !== "0") {
      s = partes.join(""); // 2.520 / 1.800 = milhar pt-BR (0.500 e 1.5 continuam decimais)
    }
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

// Percentual sempre na escala 0–100. A planilha guarda 0.5 (=50%); "50%" e 50 também funcionam.
function parsePercentual(v) {
  const n = parseNumero(v);
  if (n === null) return null;
  if (typeof v === "string" && v.includes("%")) return n;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

// ---------- Datas (dd/mm/aaaa, ISO, serial do Excel/Sheets, Date) ----------
function hojeISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(new Date());
}

function agoraMs() {
  const [a, m, d] = hojeISO().split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

function parseData(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  const s = texto(v);
  if (!s) return null;
  if (normalizar(s) === "hoje") return agoraMs();

  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) return Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000; // serial
    return null;
  }
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let a = Number(m[3]);
    if (a < 100) a += 2000;
    return Date.UTC(a, Number(m[2]) - 1, Number(m[1]));
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function formatarData(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function formatarNumero(n) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(n) || 0);
}

function formatarMoeda(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
}

function fmt(tipo, v) {
  if (v === null || v === undefined || v === "") return "não informado";
  switch (tipo) {
    case "dinheiro": return formatarMoeda(v);
    case "percentual": return `${formatarNumero(v)}%`;
    case "data": return formatarData(v);
    case "numero": return formatarNumero(v);
    default: return texto(v);
  }
}

// "Concluído" == "Concluída", "Paralisado" == "Paralisada"
function normStatus(s) {
  return normalizar(s).replace(/\b(\w+?)(ad|id)o\b/g, "$1$2a");
}

// ============================================================
// 2) CARGA DA PLANILHA: cabeçalhos, abas especiais, esquema por aba
// ============================================================
function colunasDaLinha(row) {
  return Object.keys(row || {}).filter((k) => k !== "_aba");
}

function regraDaAba(aba) {
  const k = Object.keys(REGRAS.abas).find((x) => normalizar(x) === normalizar(aba));
  return k ? REGRAS.abas[k] : null;
}

function abaIgnorada(aba) {
  return REGRAS.ignorar.some((x) => normalizar(x) === normalizar(aba));
}

function colunaGenerica(c) {
  const s = texto(c);
  return !s || /^(_?\d+|col(una|umn)?\s*\d*|field\s*\d+|unnamed.*|__empty.*|[a-z])$/i.test(s) || parseNumero(s) !== null;
}

function pontuacaoCabecalho(valores, aba) {
  const regra = regraDaAba(aba);
  if (!regra) return 0;
  const conhecidos = new Set(regra.colunas.flatMap((c) => [normalizar(c.nome), c.conceito ? normalizar(c.conceito) : ""]).filter(Boolean));
  return valores.reduce((pts, v) => pts + (conhecidos.has(normalizar(v)) ? 1 : 0), 0);
}

// Abas cujo cabeçalho não está na 1ª linha (ex.: título acima do cabeçalho).
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
    const ptsAtual = pontuacaoCabecalho(cols, aba);
    let idxCab = -1;
    let melhor = ptsAtual;
    if (regraDaAba(aba) && (genericas / Math.max(cols.length, 1) >= 0.4 || ptsAtual < 2)) {
      for (let i = 0; i < Math.min(6, lista.length); i++) {
        const pts = pontuacaoCabecalho(cols.map((c) => lista[i][c]), aba);
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
  return saida.filter((r) => colunasDaLinha(r).some((c) => texto(r[c])));
}

// PENDÊNCIAS vem como texto solto: "OBRA 001 — Aguardando licença". Vira linhas estruturadas
// ligadas ao contrato de EM_ANDAMENTO.
function prepararPendencias(rows) {
  const andamento = rows.filter((r) => normalizar(r._aba) === "em andamento");
  const achaObra = (num) => andamento.find((r) => {
    const k = Object.keys(r).find((c) => normalizar(c) === "n do contrato");
    return k && parseInt(texto(r[k]).split("/")[0], 10) === parseInt(num, 10);
  });
  const pega = (r, nome) => {
    const k = Object.keys(r).find((c) => normalizar(c) === normalizar(nome));
    return k ? r[k] : "";
  };

  const saida = [];
  for (const r of rows) {
    if (normalizar(r._aba) !== "pendencias") { saida.push(r); continue; }
    const linha = colunasDaLinha(r).map((c) => texto(r[c])).find(Boolean) || "";
    const m = linha.match(/^OBRA\s*0*(\d+)\s*[—–-]+\s*(.+)$/i);
    if (!m) continue; // título/linha solta
    const obra = achaObra(m[1]);
    saida.push({
      _aba: r._aba,
      "Nº DO CONTRATO": obra ? pega(obra, "Nº DO CONTRATO") : m[1].padStart(3, "0"),
      "OBRA": obra ? pega(obra, "OBJETO DA OBRA") : "",
      "STATUS DA OBRA": obra ? pega(obra, "STATUS") : "",
      "PENDÊNCIA": m[2].trim(),
    });
  }
  return saida;
}

function inferirTipo(linhas, c) {
  const vals = linhas.map((r) => r[c]).filter((v) => texto(v) !== "").slice(0, 20);
  if (!vals.length) return "texto";
  const nums = vals.filter((v) => parseNumero(v) !== null).length;
  return nums / vals.length >= 0.8 ? "numero" : "texto";
}

function montarEsquema(aba, linhas) {
  const regra = regraDaAba(aba);
  const colsDados = unico(linhas.flatMap(colunasDaLinha));
  const porNome = new Map();
  const defs = [];
  const registrar = (d) => {
    porNome.set(normalizar(d.nome), d);
    if (d.col) porNome.set(normalizar(d.col), d);
    if (d.conceito) porNome.set(normalizar(d.conceito), d);
    defs.push(d);
  };

  const usadas = new Set();
  for (const def of regra?.colunas || []) {
    const real = colsDados.find((c) => normalizar(c) === normalizar(def.nome));
    if (!real) continue;
    usadas.add(real);
    registrar({ ...def, col: real });
  }
  for (const c of colsDados) {
    if (usadas.has(c)) continue;
    registrar({ nome: c, col: c, tipo: inferirTipo(linhas, c), conceito: null, desc: "(coluna sem documentação)", menor: false });
  }
  for (const dv of regra?.derivados || []) registrar({ ...dv, derivado: true, col: null, menor: false });
  porNome.set("aba", { nome: "aba", col: "_aba", tipo: "texto", conceito: null });

  return { aba, regra, porNome, defs, colunasDados: colsDados };
}

// Lê a planilha UMA vez por CACHE_SEG segundos e monta tudo que o agente precisa.
let _cache = null;

export function limparCache() { _cache = null; }

async function carregarPlanilha() {
  if (_cache && Date.now() - _cache.ts < CACHE_SEG * 1000) return _cache.dados;

  let rows = corrigirCabecalhos(await getObras());
  rows = prepararPendencias(rows);
  rows = rows.filter((r) => !abaIgnorada(r._aba));

  const abas = new Map();
  const porAba = new Map();
  for (const r of rows) {
    if (!porAba.has(r._aba)) porAba.set(r._aba, []);
    porAba.get(r._aba).push(r);
  }
  for (const [aba, linhas] of porAba) {
    const esq = montarEsquema(aba, linhas);
    abas.set(aba, { esq, regs: linhas.map((row) => ({ aba, row, esq })) });
  }

  const dados = { abas };
  dados.promptCatalogo = montarPromptCatalogo(dados);
  _cache = { ts: Date.now(), dados };
  return dados;
}

// ============================================================
// Acesso tipado a campos
// ============================================================
function resolver(esq, campo) {
  if (!campo) return null;
  return esq.porNome.get(normalizar(campo)) || null;
}

function lerDef(reg, def) {
  if (def.calc) {
    const v = def.calc((c) => {
      const d = resolver(reg.esq, c);
      return d ? lerDef(reg, d) : null;
    });
    return v === undefined ? null : v;
  }
  const raw = reg.row[def.col];
  if (raw === undefined || raw === null || texto(raw) === "") return null;
  switch (def.tipo) {
    case "dinheiro":
    case "numero": return parseNumero(raw);
    case "percentual": return parsePercentual(raw);
    case "data": return parseData(raw);
    default: return texto(raw);
  }
}

function valorDe(reg, campo) {
  const def = resolver(reg.esq, campo);
  return def ? lerDef(reg, def) : null;
}

const chaveDef = (d) => d.conceito || d.nome;

function ehNumerico(tipo) {
  return ["dinheiro", "numero", "percentual", "data"].includes(tipo);
}

// ============================================================
// Catálogo em texto para a IA planejadora
// ============================================================
function montarPromptCatalogo(dados) {
  const L = [];
  L.push("REGRAS DE NEGÓCIO:");
  REGRAS.regras_gerais.forEach((r) => L.push(`- ${r}`));

  L.push("", "ESCOPOS (use em abas):");
  for (const [k, v] of Object.entries(REGRAS.escopos)) L.push(`- ${k}: ${v.join(" + ")}`);

  L.push("", "ABAS E COLUNAS (use SEMPRE o nome do campo em destaque; ele funciona em todas as abas que o possuem):");
  for (const [aba, { esq }] of dados.abas) {
    L.push("", `ABA ${aba} — ${esq.regra?.descricao || "(aba sem documentação)"}`);
    const menores = [];
    for (const d of esq.defs) {
      if (d.menor) { menores.push(d.nome.trim()); continue; }
      if (d.nome === "aba") continue;
      const real = d.col && d.col.trim() !== chaveDef(d) ? ` (coluna "${d.col.trim()}")` : "";
      L.push(`- ${chaveDef(d)} [${d.tipo}]${real}: ${d.desc || ""}`.trim());
    }
    if (menores.length) L.push(`- Colunas secundárias (pode usá-las pelo nome exato): ${menores.join(", ")}`);
  }

  L.push("", "VALORES REAIS ENCONTRADOS NA PLANILHA (copie exatamente ao filtrar):");
  const uniao = new Map();
  for (const [aba, { esq, regs }] of dados.abas) {
    for (const d of esq.defs) {
      if (!d.conceito || !CONCEITOS_COM_VALORES.includes(d.conceito)) continue;
      const vals = unico(regs.map((r) => texto(lerDef(r, d))));
      if (d.conceito === "status") {
        L.push(`- status em ${aba}: ${vals.slice(0, 25).join(" | ")}`);
      } else {
        if (!uniao.has(d.conceito)) uniao.set(d.conceito, new Set());
        vals.forEach((v) => uniao.get(d.conceito).add(v));
      }
    }
  }
  for (const [conceito, set] of uniao) {
    const vals = [...set];
    L.push(`- ${conceito}: ${vals.slice(0, 40).map((v) => v.slice(0, 45)).join(" | ")}${vals.length > 40 ? " | …" : ""}`);
  }
  return L.join("\n");
}

// ============================================================
// 3) FERRAMENTAS JS: normalizar plano → validar → filtrar → calcular
// ============================================================
const ALIAS_ESCOPO = {
  obras: "obra", projetos: "projeto", licitacoes: "licitacao", licitacao: "licitacao",
  pendencias: "pendencia", todos: "todas", tudo: "todas", geral: "todas", pavimentacoes: "pavimentacao",
};

const OPS = {
  "=": "eq", "==": "eq", igual: "eq", eq: "eq",
  "!=": "neq", "<>": "neq", diferente: "neq", neq: "neq",
  ">": "gt", gt: "gt", maior: "gt", ">=": "gte", gte: "gte", "<": "lt", lt: "lt", menor: "lt", "<=": "lte", lte: "lte",
  contem: "contains", contains: "contains", nao_contem: "not_contains", not_contains: "not_contains",
  in: "one_of", one_of: "one_of", not_in: "not_one_of", not_one_of: "not_one_of",
  entre: "between", between: "between",
  vazio: "is_empty", is_empty: "is_empty", nao_vazio: "not_empty", not_empty: "not_empty",
};
const OPS_METRICA = ["soma", "media", "min", "max", "contagem", "contagem_distinta"];

function resolverAbas(tokens, dados) {
  const lista = unico(Array.isArray(tokens) ? tokens : [tokens]);
  const alvo = lista.length ? lista : ["todas"];
  const out = new Set();
  const invalidos = [];
  for (const t of alvo) {
    const n = normalizar(t).replace(/ /g, "");
    const chave = ALIAS_ESCOPO[n] || n;
    const escopo = Object.keys(REGRAS.escopos).find((k) => normalizar(k) === chave);
    const nomes = escopo ? REGRAS.escopos[escopo] : [t];
    let achou = false;
    for (const nome of nomes) {
      const aba = [...dados.abas.keys()].find((a) => normalizar(a) === normalizar(nome));
      if (aba) { out.add(aba); achou = true; }
    }
    if (!achou && !escopo) invalidos.push(t);
  }
  return { abas: [...out], invalidos };
}

function normalizarConsulta(c = {}) {
  const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);
  const filtros = arr(c.filtros).map((f) => ({
    campo: texto(f?.campo ?? f?.field),
    op: OPS[normalizar(f?.op ?? f?.operador ?? "eq").replace(/ /g, "_")] || OPS[texto(f?.op ?? f?.operador)] || "eq",
    valor: f?.valor ?? f?.value,
  })).filter((f) => f.campo);

  const termos = unico(arr(c.termos).map(texto));
  const buscas = termos.length
    ? [{ termos, modo: normalizar(c.modo_termos || "any") === "all" ? "all" : "any", campos: unico(arr(c.campos_busca).map(texto)) }]
    : [];

  return {
    rotulo: texto(c.rotulo) || "registros",
    abas: arr(c.abas).map(texto),
    filtros,
    buscas,
    agrupar_por: arr(c.agrupar_por).map(texto).slice(0, 2),
    metricas: arr(c.metricas).map((m) => ({
      op: normalizar(m?.op || "contagem").replace(/ /g, "_"),
      campo: texto(m?.campo),
      como: texto(m?.como) || null,
    })).slice(0, 5),
    campos: unico(arr(c.campos).map(texto)),
    ordenar_por: texto(c.ordenar_por) || null,
    direcao: normalizar(c.direcao) === "asc" ? "asc" : "desc",
    limite: Math.max(1, Math.min(Number(c.limite) || MAX_LISTA, 100)),
  };
}

// Follow-up: herda abas, filtros e buscas da consulta anterior. Filtro novo no mesmo campo SUBSTITUI o antigo.
function herdarEstado(c, estado) {
  const base = estado?.consultas?.[0];
  if (!base) return c;
  const campoDe = (f) => normalizar(f.campo);
  const novosCampos = new Set(c.filtros.map(campoDe));
  const antigos = (base.filtros || []).filter((f) => !novosCampos.has(campoDe(f)));
  const vistos = new Set();
  const filtros = [...antigos, ...c.filtros].filter((f) => {
    const k = JSON.stringify(f);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  return {
    ...c,
    abas: c.abas.length ? c.abas : base.abas || [],
    filtros,
    buscas: [...(base.buscas || []), ...c.buscas],
  };
}

function validarConsulta(c, dados) {
  const erros = [];
  const { abas, invalidos } = resolverAbas(c.abas, dados);
  invalidos.forEach((t) => erros.push(`Aba/escopo inexistente: "${t}". Use: ${Object.keys(REGRAS.escopos).join(", ")} ou o nome de uma aba.`));
  if (!abas.length && !invalidos.length) erros.push("Nenhuma aba encontrada para esse escopo.");

  const existeEmAlguma = (campo) => abas.some((a) => resolver(dados.abas.get(a).esq, campo));
  const checa = (campo, onde) => {
    if (!campo) return;
    if (/^(ano|mes)\(.+\)$/i.test(campo)) return checa(campo.replace(/^(ano|mes)\(|\)$/gi, ""), onde);
    if (!existeEmAlguma(campo)) erros.push(`Campo "${campo}" (${onde}) não existe nas abas ${abas.join(", ")}.`);
  };

  c.filtros.forEach((f) => checa(f.campo, "filtro"));
  c.buscas.forEach((b) => b.campos.forEach((x) => checa(x, "busca")));
  c.agrupar_por.forEach((x) => checa(x, "agrupar_por"));
  c.campos.forEach((x) => checa(x, "campos"));
  for (const m of c.metricas) {
    if (!OPS_METRICA.includes(m.op)) erros.push(`Métrica inválida "${m.op}". Use: ${OPS_METRICA.join(", ")}.`);
    if (m.op !== "contagem") {
      if (!m.campo) erros.push(`Métrica ${m.op} exige "campo".`);
      else checa(m.campo, "metrica");
    }
  }
  return { erros, abas };
}

// ---------- filtros ----------
function passaFiltro(reg, f) {
  const def = resolver(reg.esq, f.campo);
  const v = def ? lerDef(reg, def) : null;
  if (f.op === "is_empty") return v === null;
  if (f.op === "not_empty") return v !== null;
  if (!def || v === null) return false;

  const listaValores = () => (Array.isArray(f.valor) ? f.valor : [f.valor]);

  if (ehNumerico(def.tipo)) {
    const conv = def.tipo === "data" ? parseData : def.tipo === "percentual" ? parsePercentual : parseNumero;
    if (f.op === "between") {
      const [a, b] = (Array.isArray(f.valor) ? f.valor : texto(f.valor).split(/[;,]| a /)).map(conv);
      return a !== null && b !== null && v >= Math.min(a, b) && v <= Math.max(a, b);
    }
    if (f.op === "one_of" || f.op === "not_one_of") {
      const dentro = listaValores().map(conv).includes(v);
      return f.op === "one_of" ? dentro : !dentro;
    }
    const e = conv(f.valor);
    if (e === null) return false;
    switch (f.op) {
      case "eq": return v === e;
      case "neq": return v !== e;
      case "gt": return v > e;
      case "gte": return v >= e;
      case "lt": return v < e;
      case "lte": return v <= e;
      default: return false;
    }
  }

  const n = (x) => (def.conceito === "status" ? normStatus(x) : normalizar(x));
  const nv = n(v);
  switch (f.op) {
    case "eq": return nv === n(f.valor);
    case "neq": return nv !== n(f.valor);
    case "contains": return nv.includes(n(f.valor));
    case "not_contains": return !nv.includes(n(f.valor));
    case "one_of": return listaValores().some((x) => nv === n(x));
    case "not_one_of": return !listaValores().some((x) => nv === n(x));
    default: return false;
  }
}

const CAMPOS_BUSCA_PADRAO = ["objeto", "bairro", "empresa", "engenheiro", "recurso", "observacoes", "pendencia"];

function passaBusca(reg, b) {
  const campos = b.campos.length ? b.campos : CAMPOS_BUSCA_PADRAO;
  const textos = campos.map((c) => normalizar(valorDe(reg, c))).filter(Boolean);
  const acha = (t) => {
    const re = new RegExp(`(^| )${escapeRegex(normalizar(t))}`); // início de palavra: "escola" acha "escolas", "ubs" não acha "subsolo"
    return textos.some((x) => re.test(x));
  };
  return b.modo === "all" ? b.termos.every(acha) : b.termos.some(acha);
}

// ---------- agrupadores: campo, ano(campo), mes(campo) ----------
function chaveGrupo(reg, token) {
  const m = token.match(/^(ano|mes)\((.+)\)$/i);
  if (m) {
    const ms = valorDe(reg, m[2]);
    if (ms === null) return null;
    const d = new Date(ms);
    return m[1].toLowerCase() === "ano" ? String(d.getUTCFullYear()) : `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  }
  const def = resolver(reg.esq, token);
  if (!def) return null;
  const v = lerDef(reg, def);
  return v === null ? null : fmt(def.tipo, v);
}

function defGlobal(campo, abas, dados) {
  const base = campo.replace(/^(ano|mes)\(|\)$/gi, "");
  for (const a of abas) {
    const d = resolver(dados.abas.get(a).esq, base);
    if (d) return d;
  }
  return null;
}

// ---------- métricas ----------
function calcularMetrica(regs, m, tipoCampo) {
  if (m.op === "contagem") return { valor: regs.length, texto: formatarNumero(regs.length) };

  const vals = regs.map((r) => valorDe(r, m.campo)).filter((v) => v !== null);
  if (m.op === "contagem_distinta") {
    const n = new Set(vals.map((v) => normalizar(v))).size;
    return { valor: n, texto: formatarNumero(n) };
  }
  const nums = vals.filter((v) => typeof v === "number");
  if (!nums.length) return { valor: null, texto: "não informado", registros_com_valor: 0 };

  let valor;
  if (m.op === "soma") valor = nums.reduce((a, b) => a + b, 0);
  else if (m.op === "media") valor = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (m.op === "min") valor = Math.min(...nums);
  else valor = Math.max(...nums);

  const tipo = tipoCampo || "numero";
  return { valor, texto: fmt(tipo === "texto" ? "numero" : tipo, valor), registros_com_valor: nums.length };
}

function aliasMetrica(m) {
  return m.como || (m.op === "contagem" ? "quantidade" : `${m.op}_${m.campo}`.replace(/[^a-z0-9_]/gi, "_"));
}

function comparar(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // vazios sempre no fim
  if (b === null) return -1;
  const r = typeof a === "number" && typeof b === "number" ? a - b : texto(a).localeCompare(texto(b), "pt-BR", { sensitivity: "base" });
  return dir === "asc" ? r : -r;
}

const ROTULOS_EXTRA = {
  "valor r": "Valor", "area pavimentada m": "Área pavimentada (m²)", "comprimento m": "Comprimento (m)",
  "meio fio m": "Meio-fio (m)", "n do convenio proposta": "Nº do convênio/proposta",
  "contrapartida reajuste aditivo": "Contrapartida + reajuste + aditivo",
};

function rotuloDef(def) {
  if (def.conceito === "objeto") return "objeto"; // título do item
  return ROTULOS_EXTRA[normalizar(def.nome)] || prettify(def.nome);
}

function prettify(s) {
  const t = texto(s).replace(/_/g, " ").toLowerCase().trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- executor ----------
function executarConsulta(c, dados) {
  const { abas } = resolverAbas(c.abas, dados);
  let regs = abas.flatMap((a) => dados.abas.get(a).regs);
  const avisos = [];

  // filtros + buscas
  regs = regs.filter((r) => c.filtros.every((f) => passaFiltro(r, f)) && c.buscas.every((b) => passaBusca(r, b)));

  // aviso: campo usado que não existe em alguma aba consultada
  const usados = unico([...c.filtros.map((f) => f.campo), ...c.agrupar_por, ...c.metricas.map((m) => m.campo)].filter(Boolean));
  for (const campo of usados) {
    const base = campo.replace(/^(ano|mes)\(|\)$/gi, "");
    const sem = abas.filter((a) => !resolver(dados.abas.get(a).esq, base));
    if (sem.length && sem.length < abas.length) avisos.push(`O campo "${base}" não existe em ${sem.join(", ")}; essas abas ficaram fora desse critério.`);
  }

  const base = {
    rotulo: c.rotulo,
    abas_consultadas: abas,
    filtros_aplicados: c.filtros.map((f) => `${f.campo} ${f.op} ${Array.isArray(f.valor) ? f.valor.join("/") : f.valor ?? ""}`.trim()),
    buscas_aplicadas: c.buscas.map((b) => `${b.termos.join(b.modo === "all" ? " E " : " OU ")}`),
    registros_filtrados: regs.length,
    avisos,
  };

  const metricas = c.metricas.length ? c.metricas : c.agrupar_por.length ? [{ op: "contagem", campo: "", como: null }] : [];
  const tipoDe = (m) => (m.op === "contagem" || m.op === "contagem_distinta" ? "numero" : defGlobal(m.campo, abas, dados)?.tipo || "numero");

  // ----- agrupado -----
  if (c.agrupar_por.length) {
    const grupos = new Map();
    for (const r of regs) {
      const partes = c.agrupar_por.map((t) => chaveGrupo(r, t) ?? "(não informado)");
      const k = partes.join(" | ");
      if (!grupos.has(k)) grupos.set(k, { grupo: k, regs: [] });
      grupos.get(k).regs.push(r);
    }
    let itens = [...grupos.values()].map((g) => {
      const valores = {};
      const brutos = {};
      for (const m of metricas) {
        const res = calcularMetrica(g.regs, m, tipoDe(m));
        valores[aliasMetrica(m)] = res;
        brutos[aliasMetrica(m)] = res.valor;
      }
      return { grupo: g.grupo, registros: g.regs.length, valores, _brutos: brutos };
    });
    const chaveOrd = c.ordenar_por && itens[0]?._brutos && c.ordenar_por in itens[0]._brutos ? c.ordenar_por : aliasMetrica(metricas[0]);
    if (normalizar(c.ordenar_por) === "grupo") itens.sort((a, b) => comparar(a.grupo, b.grupo, c.direcao === "desc" ? "desc" : "asc"));
    else itens.sort((a, b) => comparar(a._brutos[chaveOrd] ?? null, b._brutos[chaveOrd] ?? null, c.direcao));
    const total = itens.length;
    itens = itens.slice(0, c.limite).map(({ _brutos, ...resto }) => resto);
    return { ...base, tipo: "agrupado", agrupado_por: c.agrupar_por, total_grupos: total, itens, truncado: total > itens.length };
  }

  // ----- agregado (um número) -----
  if (metricas.length) {
    const valores = {};
    for (const m of metricas) valores[aliasMetrica(m)] = calcularMetrica(regs, m, tipoDe(m));
    return { ...base, tipo: "agregado", valores };
  }

  // ----- lista -----
  if (c.ordenar_por) {
    const dir = c.direcao;
    regs = [...regs].sort((a, b) => comparar(valorDe(a, c.ordenar_por), valorDe(b, c.ordenar_por), dir));
  }
  const fatia = regs.slice(0, c.limite);
  const itens = fatia.map((r) => {
    const campos = c.campos.length ? unico(["objeto", ...c.campos]) : r.esq.regra?.campos_padrao || ["objeto", "status"];
    const item = { aba: r.aba };
    for (const campo of campos) {
      const def = resolver(r.esq, campo);
      if (!def) continue;
      const v = lerDef(r, def);
      if (v !== null) item[rotuloDef(def)] = fmt(def.tipo, v);
    }
    if (!item.objeto) item.objeto = "(sem nome)";
    return item;
  });
  return { ...base, tipo: "lista", total: regs.length, exibidos: itens.length, itens, truncado: regs.length > itens.length };
}

// ============================================================
// Estado da conversa (follow-ups: "dessas", "e os responsáveis?")
// ============================================================
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
  return historico.slice(-MAX_HISTORICO)
    .map((m) => ({ role: m.role, content: texto(m.content).slice(0, 600) }))
    .filter((m) => m.role && m.content);
}

function construirEstado(consultas, resultados) {
  return {
    versao: 2,
    fonte: "google_sheets_tools",
    consultas: consultas.map((c) => ({ rotulo: c.rotulo, abas: c.abas, filtros: c.filtros, buscas: c.buscas })),
    objetos_recentes: resultados.flatMap((r) => (r.tipo === "lista" ? r.itens.slice(0, 15).map((x) => x.objeto) : [])).slice(0, 20),
    grupos_recentes: resultados.flatMap((r) => (r.tipo === "agrupado" ? r.itens.slice(0, 10).map((x) => x.grupo) : [])).slice(0, 10),
    momento: Date.now(),
  };
}

// ============================================================
// 4) IA PLANEJADORA
// ============================================================
function montarSystemPlanner(dados) {
  return `Você é o PLANEJADOR de consultas de um assistente de obras públicas. Você NÃO responde fatos e NÃO faz contas.
Sua única tarefa é transformar a pergunta em um PLANO JSON. O sistema executa o plano em JavaScript sobre a planilha real e outra etapa escreve a resposta.

HOJE: ${hojeISO()} (fuso ${FUSO}). Para datas use ISO (aaaa-mm-dd) ou a palavra "hoje".

${dados.promptCatalogo}

FORMATO DE SAÍDA (somente JSON, sem texto fora dele):
{
  "tipo": "consulta" | "conversa" | "esclarecer",
  "mensagem": "só quando tipo=conversa ou esclarecer",
  "herdar_contexto": false,
  "consultas": [
    {
      "rotulo": "nome humano curto do que está sendo consultado",
      "abas": ["obra"],                      // escopos ou nomes de abas; vazio = todas
      "filtros": [{"campo":"status","op":"eq","valor":"Em andamento"}],
      "termos": ["UBS"], "modo_termos": "any|all", "campos_busca": ["objeto"],   // busca por assunto no texto
      "agrupar_por": ["engenheiro"],         // também aceita ano(data_inicio) e mes(data_inicio)
      "metricas": [{"op":"soma","campo":"valor_total","como":"total"}],
      "campos": ["objeto","status"],         // colunas a mostrar quando for LISTA
      "ordenar_por": "total", "direcao": "desc", "limite": 10
    }
  ]
}

OPERADORES de filtro: eq, neq, contains, not_contains, one_of, not_one_of, gt, gte, lt, lte, between, is_empty, not_empty.
MÉTRICAS: soma, media, min, max, contagem (sem campo), contagem_distinta.
COMO ESCOLHER:
- Só filtros (sem agrupar e sem métricas) = LISTA dos registros. "Quantos" = métrica contagem. "Quanto/total" = métrica soma. "Por X / quem tem mais" = agrupar_por (sem métrica = contagem).
- Ranking de registros ("as 5 obras mais caras") = lista com ordenar_por + limite, SEM métricas.
- Use no máximo ${MAX_CONSULTAS} consultas; só mais de uma quando a pergunta compara coisas distintas.
- Para status use os VALORES REAIS acima. Nunca invente status, nomes, empresas ou bairros.
- Assunto livre (UBS, escola, creche, drenagem) = termos + campos_busca ["objeto"], não filtro.
- Nome de pessoa/empresa: filtro contains no campo certo.
- herdar_contexto=true SOMENTE em follow-up claro ("dessas", "e os responsáveis?", "quais são?"). Nesse caso coloque apenas as restrições NOVAS; o sistema junta com a consulta anterior. Pergunta nova com assunto próprio = false.
- Se a pergunta pede um dado que a planilha NÃO tem na aba (ex.: valor de projetos/licitações, bairro de licitação), use tipo conversa e explique em uma frase o que existe. Se o sistema devolver "erros_do_plano_anterior", corrija o plano usando só campos listados acima (ou explique com tipo conversa).
- Saudação/agradecimento = tipo conversa. Pergunta ambígua demais = tipo esclarecer (com UMA pergunta curta).

EXEMPLOS:
P: "quantas obras em andamento?"
{"tipo":"consulta","herdar_contexto":false,"consultas":[{"rotulo":"obras em andamento","abas":["obra"],"filtros":[{"campo":"status","op":"eq","valor":"Em andamento"}],"metricas":[{"op":"contagem"}]}]}
P: "quem tem mais obras?"
{"tipo":"consulta","herdar_contexto":false,"consultas":[{"rotulo":"obras por responsável","abas":["obra"],"agrupar_por":["engenheiro"],"ordenar_por":"quantidade","direcao":"desc"}]}
P: "quanto já foi pago em 2025?"
{"tipo":"consulta","herdar_contexto":false,"consultas":[{"rotulo":"total pago em 2025","abas":["EM_ANDAMENTO"],"metricas":[{"op":"soma","campo":"valor_pago_2025","como":"total"}]}]}
P: "licitações com edital publicado"
{"tipo":"consulta","herdar_contexto":false,"consultas":[{"rotulo":"licitações com edital publicado","abas":["licitacao"],"filtros":[{"campo":"status","op":"eq","valor":"Edital publicado"}]}]}
P: (depois) "e dessas, quais são do Ricardo?"
{"tipo":"consulta","herdar_contexto":true,"consultas":[{"rotulo":"do Ricardo","filtros":[{"campo":"engenheiro","op":"contains","valor":"Ricardo"}]}]}`;
}

async function planejar(pergunta, historico, estado, dados, observacao = null) {
  const payload = {
    pergunta,
    estado_anterior: estado ? { consultas: estado.consultas, objetos_recentes: estado.objetos_recentes, grupos_recentes: estado.grupos_recentes } : null,
    erros_do_plano_anterior: observacao,
  };
  const mensagens = [
    { role: "system", content: montarSystemPlanner(dados) },
    ...historicoCompacto(historico),
    { role: "user", content: limitarTexto(payload, 6000) },
  ];
  let raw = await chamarIAbruta(mensagens, { max_tokens: 1000, temperature: 0, reasoning_effort: "low" });
  let plano = parseJSONSeguro(raw);
  if (!plano) {
    raw = await chamarIAbruta(
      [...mensagens, { role: "assistant", content: texto(raw).slice(0, 500) }, { role: "user", content: "Responda SOMENTE com o JSON do plano, sem nenhum texto fora dele." }],
      { max_tokens: 1000, temperature: 0, reasoning_effort: "low" }
    );
    plano = parseJSONSeguro(raw);
  }
  return plano;
}

// ============================================================
// 5) IA RESPONDEDORA  (+ resposta determinística de segurança)
// ============================================================
const SYSTEM_RESPONDEDOR = `Você é o assistente de obras da prefeitura, respondendo pelo WhatsApp em português do Brasil.
Você recebe a PERGUNTA e o RESULTADO já calculado pelo sistema a partir da planilha oficial.

REGRAS:
- Use SOMENTE os dados do resultado. Não calcule, não estime, não arredonde, não invente nomes ou valores.
- Copie números e valores EXATAMENTE como estão nos campos "texto" (ex.: "R$ 1.234,56").
- Se "truncado" for true, diga que está mostrando só parte e quantos existem no total.
- Se houver "avisos", mencione-os de forma curta e natural.
- Se o resultado não cobre o que foi perguntado, diga isso com honestidade.
- Formato WhatsApp: *negrito* com um asterisco, listas com "•", sem tabelas, sem markdown de título. Direto ao ponto, no máximo ~15 linhas.
- Não mencione "JSON", "ferramenta", "plano" ou "sistema". Pode citar de onde veio em linguagem natural (ex.: "nas obras em andamento").`;

function paraIA(r) {
  const { filtros_aplicados, buscas_aplicadas, ...resto } = r;
  return { ...resto, critérios: [...filtros_aplicados, ...buscas_aplicadas.map((b) => `assunto: ${b}`)] };
}

function textosObrigatorios(resultados) {
  const out = [];
  for (const r of resultados) {
    if (r.tipo === "agregado") Object.values(r.valores).forEach((v) => v.valor !== null && out.push(v.texto));
    if (r.tipo === "lista" && r.total > 0 && r.total > r.exibidos) out.push(String(r.total));
  }
  return out;
}

const semEspaco = (s) => texto(s).replace(/[\s\u00a0\u202f]+/g, "");

function respostaConfere(resposta, resultados) {
  const alvo = semEspaco(resposta);
  return textosObrigatorios(resultados).every((t) => alvo.includes(semEspaco(t)));
}

async function responderComIA(pergunta, resultados) {
  const mensagens = [
    { role: "system", content: SYSTEM_RESPONDEDOR },
    { role: "user", content: limitarTexto({ pergunta, resultado: resultados.map(paraIA) }, 14000) },
  ];
  const resp = texto(await chamarIAbruta(mensagens, { max_tokens: 1200, temperature: 0.2, reasoning_effort: "low" }));
  return resp;
}

function descreverCriterios(r) {
  const c = [...r.filtros_aplicados, ...r.buscas_aplicadas.map((b) => `assunto: ${b}`)];
  return c.length ? ` (critérios: ${c.join("; ")})` : "";
}

function formatarDeterministico(resultados) {
  return resultados.map((r) => {
    const rot = r.rotulo || "registros";
    const aviso = r.avisos?.length ? `\n_${r.avisos.join(" ")}_` : "";

    if (r.tipo === "agregado") {
      const vals = Object.entries(r.valores);
      if (r.registros_filtrados === 0) return `Não encontrei ${rot}${descreverCriterios(r)}.`;
      if (vals.length === 1 && vals[0][0] === "quantidade") return `Encontrei *${vals[0][1].texto}* ${rot}.${aviso}`;
      return `📊 *${prettify(rot)}*\n${vals.map(([k, v]) => `• ${prettify(k)}: *${v.texto}*`).join("\n")}${aviso}`;
    }

    if (r.tipo === "agrupado") {
      if (!r.itens.length) return `Não encontrei ${rot}${descreverCriterios(r)}.`;
      const linhas = r.itens.map((x, i) => {
        const vs = Object.entries(x.valores).map(([k, v]) => (k === "quantidade" ? `${v.texto} ${v.valor === 1 ? "registro" : "registros"}` : `${prettify(k)}: ${v.texto}`));
        return `${i + 1}. *${x.grupo}* — ${vs.join(" • ")}`;
      });
      const extra = r.truncado ? `\n\n(Mostrando ${r.itens.length} de ${r.total_grupos}.)` : "";
      return `📋 *${prettify(rot)}*\n\n${linhas.join("\n")}${extra}${aviso}`;
    }

    if (!r.total) return `Não encontrei ${rot}${descreverCriterios(r)}.`;
    const blocos = r.itens.map((it, i) => {
      const det = Object.entries(it).filter(([k]) => !["aba", "objeto"].includes(k)).map(([k, v]) => `• *${k}:* ${v}`).join("\n");
      return `*${i + 1}. ${it.objeto}*${det ? `\n${det}` : ""}`;
    });
    const cab = r.truncado ? `📋 *${prettify(rot)}* (mostrando ${r.exibidos} de ${r.total})` : `Encontrei *${r.total}* ${rot}.`;
    return `${cab}\n\n${blocos.join("\n\n")}${aviso}`;
  }).join("\n\n");
}

// ============================================================
// Conversa simples
// ============================================================
function ehSaudacao(n) {
  if (!n) return false;
  const temDado = /\b(obra|projeto|licita|bairro|engenheir|valor|quant|quais|status|empresa|lista|pendenc)/.test(n);
  return !temDado && n.split(" ").length <= 6 &&
    /^(oi|ola|opa|bom dia|boa tarde|boa noite|e ai|eai|tudo bem|tudo bom|obrigad|valeu|ok|blz|beleza|hello|hi)\b/.test(n);
}

const RESPOSTA_SAUDACAO =
  "Olá! 👋 Posso consultar as obras, projetos, licitações e pendências da planilha. Exemplos: \"quantas obras em andamento?\", \"quem tem mais obras?\", \"qual o valor total investido?\".";

// ============================================================
// Entrada principal
// ============================================================
function retorno(base) {
  return { resposta: "", sql: "", linhas: 0, erro: "", estado: null, modoAgente: "google_sheets_tools", ...base };
}

export async function responderPergunta(pergunta, historico = []) {
  const q = texto(pergunta);
  const estadoAtual = ultimoEstadoValido(historico);
  if (!q) return retorno({ resposta: "Digite uma pergunta sobre a planilha.", erro: "pergunta vazia", estado: estadoAtual });

  let dados;
  try {
    dados = await carregarPlanilha();
  } catch (e) {
    return retorno({ resposta: `Não consegui ler a planilha agora: ${e?.message || e}`, erro: e?.message || String(e), estado: estadoAtual });
  }

  if (ehSaudacao(normalizar(q))) return retorno({ resposta: RESPOSTA_SAUDACAO, estado: estadoAtual });

  // ---- [1] planejar + [2] validar/executar (com até MAX_PASSOS tentativas se o plano vier inválido) ----
  let consultas = [];
  let resultados = [];
  let observacao = null;
  let ok = false;

  for (let passo = 0; passo < MAX_PASSOS && !ok; passo++) {
    let plano;
    try {
      plano = await planejar(q, historico, estadoAtual, dados, observacao);
    } catch (e) {
      return retorno({ resposta: "Não consegui interpretar a pergunta agora. Tente novamente em alguns segundos.", erro: e?.message || String(e), estado: estadoAtual });
    }
    if (!plano) { observacao = ["Resposta não era um JSON válido."]; continue; }

    if (plano.tipo === "conversa" || plano.tipo === "esclarecer") {
      return retorno({
        resposta: texto(plano.mensagem) || "Pode perguntar sobre as obras, projetos, licitações e pendências da planilha.",
        estado: estadoAtual,
      });
    }

    const brutas = (Array.isArray(plano.consultas) ? plano.consultas : []).slice(0, MAX_CONSULTAS);
    if (!brutas.length) { observacao = ["O plano veio sem consultas."]; continue; }

    const prontas = brutas.map((b) => {
      const n = normalizarConsulta(b);
      return plano.herdar_contexto && estadoAtual ? herdarEstado(n, estadoAtual) : n;
    });

    const erros = prontas.flatMap((c) => validarConsulta(c, dados).erros);
    if (erros.length) { observacao = erros; continue; }

    consultas = prontas;
    resultados = prontas.map((c) => executarConsulta(c, dados));
    ok = true;
  }

  if (!ok) {
    return retorno({
      resposta: "Não consegui montar essa consulta com segurança. Pode reformular a pergunta, dizendo se é sobre obras, projetos ou licitações?",
      erro: `plano inválido: ${limitarTexto(observacao, 500)}`,
      estado: estadoAtual,
    });
  }

  // ---- [3] responder ----
  const vazio = resultados.every((r) => (r.tipo === "lista" ? r.total === 0 : r.tipo === "agrupado" ? r.itens.length === 0 : r.registros_filtrados === 0));
  let resposta = "";
  let origem = "deterministica";

  if (RESPOSTA_IA && !vazio) {
    try {
      const r = await responderComIA(q, resultados);
      if (r && respostaConfere(r, resultados)) { resposta = r; origem = "ia"; }
      else console.log("AGENTE SHEETS - resposta da IA descartada (números não conferem).");
    } catch (e) {
      console.log("AGENTE SHEETS - falha na IA respondedora:", e?.message || e);
    }
  }
  if (!resposta) resposta = formatarDeterministico(resultados);

  console.log("AGENTE SHEETS - PLANO:", limitarTexto(consultas, 2500));
  console.log("AGENTE SHEETS - RESULTADO:", limitarTexto(resultados, 2500));
  console.log("AGENTE SHEETS - RESPOSTA VIA:", origem);

  const linhas = resultados.reduce((s, r) => s + (r.registros_filtrados || 0), 0);
  return retorno({
    resposta,
    linhas,
    estado: construirEstado(consultas, resultados),
    ferramenta: "consultar_planilha",
    respostaVia: origem,
    fonte: "Google Sheets",
  });
}
