// ============================================================
//  sheets.js
//  Le a planilha configurada em GOOGLE_SHEETS_ID usando uma
//  Conta de Servico (Service Account) so de leitura.
//
//  MODO AUTOMATICO: por padrao, o bot detecta sozinho todas as
//  abas da planilha. Para limitar, defina SHEETS_TABS no .env
//  (nomes separados por virgula).
//
//  LEITURA ROBUSTA (importante):
//  - O cabecalho NAO e necessariamente a primeira linha. Muitas
//    planilhas tem titulo, subtitulo ou linhas em branco antes.
//    O codigo procura a linha que realmente parece cabecalho.
//  - Linhas totalmente vazias sao descartadas (senao a contagem
//    de obras fica inflada).
//  - Linhas sem nenhum conteudo util tambem sao descartadas.
// ============================================================

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;

// Se SHEETS_TABS estiver definida, usa so essas abas.
const TABS_MANUAIS = (process.env.SHEETS_TABS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// Abas que normalmente NAO sao lista de obras (ajuste se precisar).
const ABAS_IGNORADAS = (process.env.SHEETS_TABS_IGNORAR || "")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

function getAuth() {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

  if (inlineJson && inlineJson.trim()) {
    const credentials = JSON.parse(inlineJson);
    return new google.auth.GoogleAuth({ credentials, scopes });
  }
  return new google.auth.GoogleAuth({ scopes });
}

const sheetsApi = google.sheets({ version: "v4", auth: getAuth() });

// --- Cache dos dados ---
let cache = { data: null, time: 0 };
const CACHE_MS = 3 * 60 * 1000; // 3 minutos

// --- Cache da lista de abas ---
let cacheAbas = { nomes: null, time: 0 };
const CACHE_ABAS_MS = 5 * 60 * 1000;

// --- Diagnostico da ultima leitura (usado pela rota /diagnostico) ---
let ultimoDiagnostico = { abas: [], total: 0, quando: null };

export function getDiagnostico() {
  return ultimoDiagnostico;
}

async function listarAbasDaPlanilha() {
  const agora = Date.now();
  if (cacheAbas.nomes && agora - cacheAbas.time < CACHE_ABAS_MS) {
    return cacheAbas.nomes;
  }

  const resp = await sheetsApi.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties.title",
  });

  const nomes = (resp.data.sheets || [])
    .map((s) => s.properties.title)
    .filter((t) => !ABAS_IGNORADAS.includes((t || "").toLowerCase()));

  cacheAbas = { nomes, time: agora };
  return nomes;
}

// ------------------------------------------------------------
//  Deteccao do cabecalho
//  Nesta planilha o cabecalho NEM SEMPRE esta na linha 1 (em varias
//  abas ele esta na linha 7 ou 8, com titulo antes). E linhas de dados
//  podem ter tantas celulas quanto o cabecalho, entao "a linha com mais
//  celulas" nao basta. Estrategia em duas etapas:
//   1) procura a PRIMEIRA linha que contem palavras tipicas de cabecalho
//      de obras (objeto, rua, situacao, status, contrato, empresa...);
//   2) se nao achar por palavra, cai para a linha com mais celulas.
// ------------------------------------------------------------

// Palavras que so aparecem em CABECALHO de uma tabela de obras.
const PALAVRAS_CABECALHO = [
  "objeto", "obra", "rua", "situacao", "status", "contrato", "empresa",
  "recurso", "engenheiro", "arquiteto", "valor", "bairro", "endereco",
  "fonte", "convenio", "proposta", "data", "prazo", "aditivo", "logradouro",
];

function normaliza(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function contarPreenchidas(row) {
  return (row || []).filter((c) => (c || "").toString().trim() !== "").length;
}

function pareceCabecalho(row) {
  const texto = normaliza((row || []).join(" "));
  return PALAVRAS_CABECALHO.some((p) => texto.includes(p));
}

export function acharLinhaCabecalho(rows, maxLinhasAnalisadas = 15) {
  if (!rows || rows.length === 0) return -1;
  const limite = Math.min(rows.length, maxLinhasAnalisadas);

  // Etapa 1: primeira linha com >= 2 celulas E palavra tipica de cabecalho.
  for (let i = 0; i < limite; i++) {
    if (contarPreenchidas(rows[i]) >= 2 && pareceCabecalho(rows[i])) {
      return i;
    }
  }

  // Etapa 2 (fallback): a linha com mais celulas preenchidas.
  let melhorIndice = -1;
  let melhorContagem = 0;
  for (let i = 0; i < limite; i++) {
    const preenchidas = contarPreenchidas(rows[i]);
    if (preenchidas >= 2 && preenchidas > melhorContagem) {
      melhorContagem = preenchidas;
      melhorIndice = i;
    }
  }
  return melhorIndice;
}

// Converte uma aba em lista de objetos, ignorando lixo.
export function rowsToObjects(rows, tabName) {
  const idxCabecalho = acharLinhaCabecalho(rows);
  if (idxCabecalho < 0) return { obras: [], cabecalho: [], ignoradas: 0 };

  const header = (rows[idxCabecalho] || []).map((h) => (h || "").toString().trim());
  const obras = [];
  let ignoradas = 0;

  for (let i = idxCabecalho + 1; i < rows.length; i++) {
    const row = rows[i] || [];

    // Linha totalmente vazia -> descarta (nao conta como obra).
    const temAlgo = row.some((c) => (c || "").toString().trim() !== "");
    if (!temAlgo) {
      ignoradas += 1;
      continue;
    }

    const obj = { _aba: tabName };
    let campos = 0;
    header.forEach((col, j) => {
      if (!col) return;
      const valor = (row[j] || "").toString().trim();
      if (valor) {
        obj[col] = valor;
        campos += 1;
      }
    });

    // Linha que nao produziu nenhum campo util -> descarta.
    if (campos === 0) {
      ignoradas += 1;
      continue;
    }

    obras.push(obj);
  }

  return { obras, cabecalho: header.filter(Boolean), ignoradas };
}

// Retorna TODAS as obras de TODAS as abas.
export async function getObras() {
  const agora = Date.now();
  if (cache.data && agora - cache.time < CACHE_MS) {
    return cache.data;
  }

  const tabs = TABS_MANUAIS.length > 0 ? TABS_MANUAIS : await listarAbasDaPlanilha();

  if (tabs.length === 0) {
    cache = { data: [], time: agora };
    ultimoDiagnostico = { abas: [], total: 0, quando: new Date().toISOString() };
    return [];
  }

  const resp = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: tabs,
  });

  const todas = [];
  const relatorio = [];

  (resp.data.valueRanges || []).forEach((vr, idx) => {
    const nomeAba = tabs[idx];
    const { obras, cabecalho, ignoradas } = rowsToObjects(vr.values, nomeAba);
    todas.push(...obras);
    relatorio.push({
      aba: nomeAba,
      linhas_lidas: (vr.values || []).length,
      obras: obras.length,
      linhas_ignoradas: ignoradas,
      cabecalho,
    });
  });

  // Log de diagnostico: mostra o que foi lido de cada aba.
  relatorio.forEach((r) => {
    console.log(
      `DIAGNOSTICO aba "${r.aba}": ${r.obras} obra(s), ` +
        `${r.linhas_ignoradas} linha(s) ignorada(s). ` +
        `Colunas: ${r.cabecalho.join(" | ") || "(nenhuma detectada)"}`
    );
  });
  console.log(`DIAGNOSTICO total de obras carregadas: ${todas.length}`);

  ultimoDiagnostico = {
    abas: relatorio,
    total: todas.length,
    quando: new Date().toISOString(),
  };

  cache = { data: todas, time: agora };
  return todas;
}
