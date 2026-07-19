// ============================================================
//  sheets.js
//  Le a planilha "ChatBot - Obras Mamanguape" no Google Sheets
//  usando uma Conta de Servico (Service Account) so de leitura.
//  Cada linha vira um objeto { coluna: valor } usando a 1a linha
//  da aba como cabecalho -> funciona com qualquer conjunto de colunas.
// ============================================================

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const TABS = (process.env.SHEETS_TABS || "EM_ANDAMENTO")
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

// Retorna TODAS as obras de TODAS as abas configuradas (com cache).
export async function getObras() {
  const agora = Date.now();
  if (cache.data && agora - cache.time < CACHE_MS) {
    return cache.data;
  }

  // Le todas as abas de uma vez
  const resp = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: TABS, // pegar a aba inteira: basta passar o nome da aba
  });

  const todas = [];
  (resp.data.valueRanges || []).forEach((vr, idx) => {
    const nomeAba = TABS[idx];
    todas.push(...rowsToObjects(vr.values, nomeAba));
  });

  cache = { data: todas, time: agora };
  return todas;
}
