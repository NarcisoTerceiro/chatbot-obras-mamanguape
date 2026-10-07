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

// Limpa o cache, forcando a proxima leitura a buscar a planilha FRESCA.
// A sincronizacao (via webhook ou manual) chama isto ANTES de ler, pra
// garantir que uma edicao recente na planilha seja lida de verdade - e nao
// devolvida do cache velho (que causava "editei mas o banco nao mudou").
export function limparCache() {
  cache = { data: null, time: 0 };
  cacheAbas = { nomes: null, time: 0 };
  console.log("SHEETS: cache limpo - proxima leitura sera da planilha fresca.");
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
//  Deteccao robusta do cabecalho
//
//  PROBLEMA ANTIGO:
//  O codigo juntava a linha inteira e aceitava a PRIMEIRA linha que
//  contivesse uma palavra como "obra", "proposta", "empresa" etc.
//  Uma linha de titulo/subtitulo ou ate uma linha de dados podia ser
//  confundida com o cabecalho. Isso fazia o bot ignorar registros que
//  estavam acima do falso cabecalho (ex.: aba EM_LICITAÇÃO).
//
//  NOVA ESTRATEGIA:
//  - analisa cada CELULA separadamente;
//  - pontua nomes de coluna conhecidos;
//  - exige mais de uma evidencia de cabecalho;
//  - escolhe a linha com MAIOR pontuacao, nao a primeira encontrada;
//  - procura nas primeiras 40 linhas para suportar planilhas com titulos.
// ------------------------------------------------------------

// Nomes/fragmentos que caracterizam COLUNAS de verdade.
// Tudo ja e comparado sem acento e em minusculas.
const CAMPOS_CABECALHO = [
  "objeto da obra",
  "objeto",
  "rua",
  "logradouro",
  "situacao",
  "status",
  "n do contrato",
  "numero do contrato",
  "contrato",
  "empresa",
  "recurso",
  "fonte do recurso",
  "fonte",
  "engenheiro responsavel",
  "engenheiro arquiteto responsavel",
  "engenheiro",
  "arquiteto",
  "valor total da obra",
  "valor executado",
  "valor",
  "bairro",
  "endereco",
  "convenio recurso",
  "convenio proposta",
  "convenio",
  "proposta analisada",
  "habilitacao analisada",
  "data de envio",
  "data de entrega",
  "data inicio",
  "data prev termino",
  "prazo",
  "aditivo",
  "observacoes",
  "observacao",
  "comprimento m",
  "meio fio m",
  "area pavimentada m2",
];

const CAMPOS_CABECALHO_EXATOS = new Set(CAMPOS_CABECALHO);

function normaliza(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[º°ª]/g, "")
    .replace(/[_/\\()-]+/g, " ")
    .replace(/[^a-z0-9% ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contarPreenchidas(row) {
  return (row || []).filter((c) => (c ?? "").toString().trim() !== "").length;
}

function pontuarCelulaCabecalho(valor) {
  const c = normaliza(valor);
  if (!c) return 0;

  // Cabecalhos exatos/fortes valem mais.
  if (CAMPOS_CABECALHO_EXATOS.has(c)) return 4;

  // Alguns cabecalhos reais trazem sufixos/unidades, ex. "VALOR (R$)".
  if (/^(valor|status|situacao|bairro|empresa|recurso|fonte|contrato|rua|logradouro|objeto|engenheiro|arquiteto|convenio|proposta|habilitacao|data|observa)/.test(c)) {
    // Evita considerar frases longas de dados/titulo como cabecalho.
    const palavras = c.split(" ").filter(Boolean).length;
    if (palavras <= 6) return 2;
  }

  return 0;
}

function analisarLinhaCabecalho(row) {
  const preenchidas = contarPreenchidas(row);
  if (preenchidas < 2) return { score: 0, evidencias: 0, preenchidas };

  let score = 0;
  let evidencias = 0;

  for (const celula of row || []) {
    const p = pontuarCelulaCabecalho(celula);
    if (p > 0) {
      score += p;
      evidencias += 1;
    }
  }

  // Bonus quando a linha tem muitas celulas e varias delas sao colunas conhecidas.
  // Isso separa bem um cabecalho real de um titulo como "OBRAS EM LICITACAO".
  if (evidencias >= 3) score += 6;
  if (evidencias >= 5) score += 10;

  return { score, evidencias, preenchidas };
}

export function acharLinhaCabecalho(rows, maxLinhasAnalisadas = 40) {
  if (!rows || rows.length === 0) return -1;
  const limite = Math.min(rows.length, maxLinhasAnalisadas);

  let melhorIndice = -1;
  let melhorScore = -1;
  let melhoresEvidencias = -1;
  let maisPreenchidas = -1;

  for (let i = 0; i < limite; i++) {
    const analise = analisarLinhaCabecalho(rows[i]);

    // Para ser aceito como cabecalho sem fallback, exigimos pelo menos
    // duas celulas com cara de nome de coluna. Em abas relevantes
    // (obras/projetos/licitacoes/pavimentacao) normalmente ha 6+.
    if (analise.evidencias < 2) continue;

    const melhor =
      analise.score > melhorScore ||
      (analise.score === melhorScore && analise.evidencias > melhoresEvidencias) ||
      (analise.score === melhorScore && analise.evidencias === melhoresEvidencias && analise.preenchidas > maisPreenchidas);

    if (melhor) {
      melhorIndice = i;
      melhorScore = analise.score;
      melhoresEvidencias = analise.evidencias;
      maisPreenchidas = analise.preenchidas;
    }
  }

  if (melhorIndice >= 0) return melhorIndice;

  // Fallback conservador: usa a linha com mais celulas preenchidas.
  // Em caso de empate, mantem a primeira.
  let fallback = -1;
  let maior = 0;
  for (let i = 0; i < limite; i++) {
    const preenchidas = contarPreenchidas(rows[i]);
    if (preenchidas >= 2 && preenchidas > maior) {
      maior = preenchidas;
      fallback = i;
    }
  }
  return fallback;
}

function ehRepeticaoDeCabecalho(row, header) {
  if (!row || !header || !header.length) return false;
  let iguais = 0;
  let comparados = 0;
  const limite = Math.min(row.length, header.length);
  for (let i = 0; i < limite; i++) {
    const h = normaliza(header[i]);
    const v = normaliza(row[i]);
    if (!h || !v) continue;
    comparados += 1;
    if (h === v) iguais += 1;
  }
  return comparados >= 2 && iguais / comparados >= 0.7;
}

// Converte uma aba em lista de objetos, ignorando lixo.
export function rowsToObjects(rows, tabName) {
  const idxCabecalho = acharLinhaCabecalho(rows);
  if (idxCabecalho < 0) {
    return { obras: [], cabecalho: [], ignoradas: 0, linha_cabecalho: null, score_cabecalho: 0 };
  }

  const header = (rows[idxCabecalho] || []).map((h) => (h ?? "").toString().trim());
  const analiseCabecalho = analisarLinhaCabecalho(rows[idxCabecalho] || []);
  const obras = [];
  let ignoradas = 0;

  for (let i = idxCabecalho + 1; i < rows.length; i++) {
    const row = rows[i] || [];

    // Linha totalmente vazia -> descarta (nao conta como obra).
    const temAlgo = row.some((c) => (c ?? "").toString().trim() !== "");
    if (!temAlgo) {
      ignoradas += 1;
      continue;
    }

    // Algumas planilhas repetem o cabecalho no meio da tabela.
    // Nao transforme essa linha repetida em obra/licitacao/projeto.
    if (ehRepeticaoDeCabecalho(row, header)) {
      ignoradas += 1;
      continue;
    }

    const obj = { _aba: tabName };
    let campos = 0;
    header.forEach((col, j) => {
      if (!col) return;
      const valor = (row[j] ?? "").toString().trim();
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

  return {
    obras,
    cabecalho: header.filter(Boolean),
    ignoradas,
    linha_cabecalho: idxCabecalho + 1, // 1-based para facilitar leitura do log
    score_cabecalho: analiseCabecalho.score,
  };
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
    // Nao dependemos mais do formato visual/locale da planilha.
    // Ex.: 3,020,000.00 e 3.020.000,00 passam a chegar como 3020000.
    valueRenderOption: "UNFORMATTED_VALUE",
    // Mantem datas como texto legivel em vez de numero serial do Sheets.
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const todas = [];
  const relatorio = [];

  (resp.data.valueRanges || []).forEach((vr, idx) => {
    const nomeAba = tabs[idx];
    const { obras, cabecalho, ignoradas, linha_cabecalho, score_cabecalho } = rowsToObjects(vr.values, nomeAba);
    todas.push(...obras);
    relatorio.push({
      aba: nomeAba,
      linhas_lidas: (vr.values || []).length,
      obras: obras.length,
      linhas_ignoradas: ignoradas,
      linha_cabecalho,
      score_cabecalho,
      cabecalho,
    });
  });

  // Log de diagnostico: mostra o que foi lido de cada aba.
  relatorio.forEach((r) => {
    console.log(
      `DIAGNOSTICO aba "${r.aba}": ${r.obras} registro(s), ` +
        `${r.linhas_ignoradas} linha(s) ignorada(s), ` +
        `cabecalho na linha ${r.linha_cabecalho ?? "?"} (score ${r.score_cabecalho ?? 0}). ` +
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
