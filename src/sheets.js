// ============================================================
//  sheets.js
//  Le a planilha configurada em GOOGLE_SHEETS_ID usando uma
//  Conta de Servico (Service Account) so de leitura.
//
//  MODO AUTOMATICO: por padrao, o bot detecta sozinho TODAS as
//  abas que existem na planilha (nao precisa listar SHEETS_TABS).
//  Isso permite trocar de planilha livremente, sem reconfigurar.
//
//  Se quiser limitar manualmente a certas abas, defina a variavel
//  de ambiente SHEETS_TABS (separadas por virgula). Deixe vazia
//  ou remova para usar o modo automatico (recomendado).
//
//  Cada linha vira um objeto { coluna: valor } usando a 1a linha
//  da aba como cabecalho -> funciona com qualquer conjunto de colunas.
// ============================================================

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;

// Se SHEETS_TABS estiver definida (e nao vazia), usa so essas abas.
// Caso contrario, o bot detecta sozinho todas as abas da planilha.
const TABS_MANUAIS = (process.env.SHEETS_TABS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// Monta as credenciais a partir do arquivo .json OU do conteudo em variavel de ambiente.
function getAuth() {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

  if (inlineJson && inlineJson.trim()) {
    // OPCAO B: credencial colada numa variavel (ideal para Render/Railway)
    const credentials = JSON.parse(inlineJson);
    return new google.auth.GoogleAuth({ credentials, scopes });
  }
  // OPCAO A: usa o arquivo apontado por GOOGLE_APPLICATION_CREDENTIALS
  return new google.auth.GoogleAuth({ scopes });
}

const sheetsApi = google.sheets({ version: "v4", auth: getAuth() });

// --- Cache simples para nao bater na API do Sheets a cada mensagem ---
let cache = { data: null, time: 0 };
const CACHE_MS = 60 * 1000; // 60 segundos

// --- Cache separado da LISTA de abas (nomes mudam bem menos que os dados) ---
let cacheAbas = { nomes: null, time: 0 };
const CACHE_ABAS_MS = 5 * 60 * 1000; // 5 minutos

// Descobre sozinho todos os nomes de abas que existem na planilha atual.
async function listarAbasDaPlanilha() {
  const agora = Date.now();
  if (cacheAbas.nomes && agora - cacheAbas.time < CACHE_ABAS_MS) {
    return cacheAbas.nomes;
  }

  const resp = await sheetsApi.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties.title",
  });

  const nomes = (resp.data.sheets || []).map((s) => s.properties.title);
  cacheAbas = { nomes, time: agora };
  return nomes;
}

// Converte uma aba (matriz de linhas) em lista de objetos usando o cabecalho.
function rowsToObjects(rows, tabName) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((h) => (h || "").toString().trim());
  return rows.slice(1).map((row) => {
    const obj = { _aba: tabName };
    header.forEach((col, i) => {
      if (col) obj[col] = (row[i] || "").toString().trim();
    });
    return obj;
  });
}

// Retorna TODAS as obras de TODAS as abas (manuais ou detectadas automaticamente).
export async function getObras() {
  const agora = Date.now();
  if (cache.data && agora - cache.time < CACHE_MS) {
    return cache.data;
  }

  // Usa as abas manuais se configuradas; senao, detecta sozinho.
  const tabs = TABS_MANUAIS.length > 0
    ? TABS_MANUAIS
    : await listarAbasDaPlanilha();

  if (tabs.length === 0) {
    cache = { data: [], time: agora };
    return [];
  }

  // Le todas as abas de uma vez
  const resp = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: tabs, // pegar a aba inteira: basta passar o nome da aba
  });

  const todas = [];
  (resp.data.valueRanges || []).forEach((vr, idx) => {
    const nomeAba = tabs[idx];
    todas.push(...rowsToObjects(vr.values, nomeAba));
  });

  cache = { data: todas, time: agora };
  return todas;
}
