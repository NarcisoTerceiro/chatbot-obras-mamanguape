// ============================================================
// agente.js - V9 - PADRAO DAVID ROBERTS / n8n (SEM SQL)
// ============================================================
// Arquitetura inspirada no workflow publico "Chat with a Google Sheet using AI":
// 1) listar_colunas   -> descobre o schema real da planilha
// 2) valores_coluna  -> pega uma coluna inteira + row_number
// 3) obter_linha     -> pega todos os campos de uma linha especifica
//
// A diferenca para o template original e que este projeto possui VARIAS abas.
// Por isso cada ferramenta recebe "aba". Tambem devolvemos resumos deterministicos
// (frequencias/soma/min/max) junto com os valores para reduzir erros de contagem da IA.
//
// Fluxo:
// pergunta -> listar_colunas (automatico) -> IA escolhe ferramenta -> resultado ->
// IA pode chamar outra ferramenta -> resposta final fundamentada nos resultados.
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";
import Decimal from "decimal.js";

const MAX_PASSOS = Math.max(3, Math.min(Number(process.env.AGENTE_SHEETS_PASSOS || 8), 12));
const MAX_HISTORICO = Math.max(2, Math.min(Number(process.env.AGENTE_SHEETS_HISTORICO || 6), 10));
const MAX_RESULTADO_TOOL = Math.max(12000, Math.min(Number(process.env.AGENTE_SHEETS_MAX_TOOL_CHARS || 26000), 50000));

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

function unico(arr = []) {
  return [...new Set(arr.filter((x) => texto(x) !== ""))];
}

function limitar(v, max = MAX_RESULTADO_TOOL) {
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
  let s = texto(v);
  if (!s || s === "-") return null;
  s = s.replace(/R\$/gi, "").replace(/%/g, "").replace(/\s+/g, "").replace(/[^0-9,.-]/g, "");
  if (!s) return null;
  const temV = s.includes(",");
  const temP = s.includes(".");
  if (temV && temP) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (temV) {
    const partes = s.split(",");
    if (partes.length === 2 && partes[1].length <= 4) s = partes[0].replace(/\./g, "") + "." + partes[1];
    else s = s.replace(/,/g, "");
  } else if (temP) {
    const partes = s.split(".");
    if (partes.length > 2 && partes.slice(1).every((p) => p.length === 3)) s = partes.join("");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function agruparPorAba(rows = []) {
  const mapa = new Map();
  for (const row of rows) {
    const aba = texto(row?._aba) || "SEM_ABA";
    if (!mapa.has(aba)) mapa.set(aba, []);
    mapa.get(aba).push(row);
  }
  return mapa;
}

function resolverAba(mapaAbas, solicitada) {
  const alvo = normalizar(solicitada);
  if (!alvo) return null;
  for (const nome of mapaAbas.keys()) {
    if (normalizar(nome) === alvo) return nome;
  }
  // tolera acentos/espacos e parte distintiva, mas evita adivinhar entre duas abas
  const candidatas = [...mapaAbas.keys()].filter((nome) => normalizar(nome).includes(alvo) || alvo.includes(normalizar(nome)));
  return candidatas.length === 1 ? candidatas[0] : null;
}

function colunasDaAba(rows = []) {
  const cols = [];
  const vistos = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row || {})) {
      if (k.startsWith("_")) continue;
      const n = normalizar(k);
      if (!n || vistos.has(n)) continue;
      vistos.add(n);
      cols.push(k);
    }
  }
  return cols;
}

function resolverColuna(rows, solicitada) {
  const alvo = normalizar(solicitada);
  if (!alvo) return null;
  const cols = colunasDaAba(rows);
  const exata = cols.find((c) => normalizar(c) === alvo);
  if (exata) return exata;

  // aliases minimos para tolerar nomes naturais. A ferramenta ainda devolve o nome real.
  const aliases = {
    objeto: ["objeto", "objeto da obra", "obra", "projeto", "nome", "rua"],
    status: ["status", "situacao", "situação"],
    engenheiro: ["engenheiro", "engenheiro responsavel", "engenheiro/arquiteto responsavel", "responsavel", "responsavel tecnico"],
    empresa: ["empresa", "construtora", "contratada"],
    bairro: ["bairro", "localidade", "comunidade"],
    recurso: ["recurso", "fonte do recurso", "fonte de recurso", "convenio/recurso", "convênio/recurso"],
    valor_total: ["valor total da obra", "valor total", "valor (r$)", "valor r$", "valor"],
    valor_executado: ["valor executado"],
    proposta_analisada: ["proposta analisada"],
    habilitacao_analisada: ["habilitacao analisada", "habilitação analisada"],
  };
  const aliasAlvo = Object.entries(aliases).find(([canon, lista]) => normalizar(canon) === alvo || lista.some((a) => normalizar(a) === alvo));
  if (aliasAlvo) {
    const [, lista] = aliasAlvo;
    for (const c of cols) {
      const nc = normalizar(c);
      if (lista.some((a) => nc === normalizar(a) || nc.includes(normalizar(a)))) return c;
    }
  }

  const candidatas = cols.filter((c) => normalizar(c).includes(alvo) || alvo.includes(normalizar(c)));
  return candidatas.length === 1 ? candidatas[0] : null;
}

// ------------------------------------------------------------------
// AS 3 FERRAMENTAS DO PADRAO DAVID ROBERTS
// ------------------------------------------------------------------
export function ferramentaListarColunas(rows = [], args = {}) {
  const mapa = agruparPorAba(rows);
  const abaPedida = texto(args.aba);
  const saida = [];

  for (const [aba, linhas] of mapa.entries()) {
    if (abaPedida && normalizar(aba) !== normalizar(abaPedida)) continue;
    saida.push({
      aba,
      total_linhas: linhas.length,
      colunas: colunasDaAba(linhas),
    });
  }

  return {
    ferramenta: "listar_colunas",
    abas: saida,
    total_abas: saida.length,
  };
}

function resumoDaColuna(valores) {
  const preenchidos = valores.filter((x) => texto(x.valor) !== "");
  const vazios = valores.length - preenchidos.length;
  const freq = new Map();
  for (const x of preenchidos) {
    const k = normalizar(x.valor);
    if (!k) continue;
    if (!freq.has(k)) freq.set(k, { valor: texto(x.valor), quantidade: 0 });
    freq.get(k).quantidade += 1;
  }
  const frequencias = [...freq.values()].sort((a, b) => b.quantidade - a.quantidade || a.valor.localeCompare(b.valor, "pt-BR"));

  const nums = preenchidos.map((x) => parseNumero(x.valor)).filter((x) => x !== null);
  let numerico = null;
  if (nums.length && nums.length >= Math.ceil(preenchidos.length * 0.7)) {
    let soma = new Decimal(0);
    let min = null;
    let max = null;
    for (const n of nums) {
      soma = soma.plus(String(n));
      if (min === null || n < min) min = n;
      if (max === null || n > max) max = n;
    }
    numerico = { quantidade_numerica: nums.length, soma: soma.toFixed(), minimo: min, maximo: max };
  }

  return {
    total_linhas: valores.length,
    preenchidos: preenchidos.length,
    vazios,
    valores_unicos: frequencias.length,
    frequencias,
    numerico,
  };
}

export function ferramentaValoresColuna(rows = [], args = {}) {
  const mapa = agruparPorAba(rows);
  const aba = resolverAba(mapa, args.aba);
  if (!aba) {
    return { ferramenta: "valores_coluna", erro: `Aba não encontrada ou ambígua: ${texto(args.aba) || "(vazia)"}` };
  }

  const linhas = mapa.get(aba) || [];
  const coluna = resolverColuna(linhas, args.coluna);
  if (!coluna) {
    return {
      ferramenta: "valores_coluna",
      erro: `Coluna não encontrada ou ambígua na aba ${aba}: ${texto(args.coluna) || "(vazia)"}`,
      colunas_disponiveis: colunasDaAba(linhas),
    };
  }

  const valores = linhas.map((r, idx) => ({
    row_number: Number(r._row_number || idx + 1),
    valor: r[coluna] ?? "",
  }));

  return {
    ferramenta: "valores_coluna",
    aba,
    coluna,
    resumo: resumoDaColuna(valores),
    valores,
  };
}

export function ferramentaObterLinha(rows = [], args = {}) {
  const mapa = agruparPorAba(rows);
  const aba = resolverAba(mapa, args.aba);
  if (!aba) return { ferramenta: "obter_linha", erro: `Aba não encontrada ou ambígua: ${texto(args.aba) || "(vazia)"}` };

  const n = Number(args.row_number);
  if (!Number.isFinite(n)) return { ferramenta: "obter_linha", erro: "row_number inválido" };

  const linhas = mapa.get(aba) || [];
  const row = linhas.find((r, idx) => Number(r._row_number || idx + 1) === n);
  if (!row) return { ferramenta: "obter_linha", erro: `Linha ${n} não encontrada na aba ${aba}` };

  const dados = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "_aba") continue;
    if (k === "_row_number") continue;
    dados[k] = v;
  }

  return { ferramenta: "obter_linha", aba, row_number: n, dados };
}

function executarFerramenta(nome, rows, args) {
  if (nome === "listar_colunas") return ferramentaListarColunas(rows, args);
  if (nome === "valores_coluna") return ferramentaValoresColuna(rows, args);
  if (nome === "obter_linha") return ferramentaObterLinha(rows, args);
  return { erro: `Ferramenta desconhecida: ${nome}` };
}

// ------------------------------------------------------------------
// Memoria curta, no estilo Simple Memory do n8n.
// Nao aplicamos filtros antigos automaticamente; a IA interpreta apenas a
// conversa recente. Isso evita o vazamento de "concluida"/"bairro" para uma
// pergunta nova, que foi um dos problemas das versoes anteriores.
// ------------------------------------------------------------------
function historicoCurto(historico = []) {
  const h = Array.isArray(historico) ? historico.slice(-MAX_HISTORICO) : [];
  return h.map((m) => {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = texto(m?.content ?? m?.resposta ?? m?.texto ?? "");
    return { role, content: limitar(content, 1800) };
  }).filter((x) => x.content);
}

function ehSaudacao(q) {
  const n = normalizar(q);
  return /^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa|hey)$/.test(n);
}

const SYSTEM_AGENT = `Você é um agente que consulta uma PLANILHA REAL. Você não usa SQL e não responde fatos da planilha de memória.

ARQUITETURA OBRIGATÓRIA (mesmo padrão do workflow público de David Roberts no n8n):
1. listar_colunas({aba?})
   Descobre as abas, colunas reais e quantidade de linhas. Deve ser a primeira descoberta do schema.
2. valores_coluna({aba, coluna})
   Retorna TODOS os valores de uma coluna com row_number. Também retorna um resumo determinístico com preenchidos, vazios, frequências e, quando numérica, soma/min/max.
3. obter_linha({aba, row_number})
   Retorna todas as colunas de uma linha específica. Use para detalhes de um registro depois de descobrir o row_number.

COMO RACIOCINAR:
- Você pode chamar várias ferramentas em sequência. Não tente resolver tudo com uma única chamada.
- Para saber "quais valores existem", ranking, responsáveis, status ou contagens por valor, use valores_coluna e prefira o bloco resumo/frequencias em vez de contar manualmente.
- Para filtrar registros por um status/valor e depois listar nomes, consulte primeiro a coluna do filtro e depois a coluna do nome/objeto da MESMA aba; correlacione pelo row_number.
- Para detalhes de um registro específico, depois de achar o row_number use obter_linha.
- Nunca invente nome de coluna. Use exatamente nomes retornados por listar_colunas.
- Se uma coluna não existir, diga isso. Não substitua por outra métrica sem avisar.
- Fatos finais só podem vir dos RESULTADOS DAS FERRAMENTAS deste turno ou da conversa imediatamente relevante.

REGRAS DA PLANILHA DE MAMANGUAPE:
- "obras" = abas EM_ANDAMENTO + PAVIMENTAÇÃO/PAVIMENTACAO.
- "projetos" = aba EM_PROJETO.
- "licitações" = aba EM_LICITAÇÃO/EM_LICITACAO.
- EXECUTADA e CONCLUÍDA são estados diferentes. Não misture.
- EM EXECUÇÃO/EM ANDAMENTO significa em andamento; À EXECUTAR/NÃO INICIADA significa a iniciar.
- "valor total"/"valor investido" não é automaticamente "valor pago". Para pago/gasto/desembolsado, procure colunas de pagamento. Se não houver base suficiente, diga que não dá para afirmar.
- Em licitação, PROPOSTA ANALISADA e HABILITAÇÃO ANALISADA são conceitos diferentes.
- Se o usuário disser apenas "não analisadas" em licitações, pergunte se é proposta ou habilitação.
- Se houver duas abas de obras, consulte ambas quando a pergunta for sobre obras em geral.

FORMATO DE SAÍDA OBRIGATÓRIO: responda SOMENTE JSON.
Para chamar ferramenta:
{"tipo":"tool","tool":"valores_coluna","args":{"aba":"EM_PROJETO","coluna":"STATUS"},"motivo":"curto"}
Ou:
{"tipo":"tool","tool":"obter_linha","args":{"aba":"EM_PROJETO","row_number":12},"motivo":"curto"}
Para resposta final:
{"tipo":"final","answer":"resposta em português, curta e natural"}
Para esclarecimento necessário:
{"tipo":"final","answer":"pergunta curta de esclarecimento"}

Nunca coloque texto fora do JSON.`;

async function decidirProximoPasso(pergunta, historico, eventos) {
  const mensagens = [
    { role: "system", content: SYSTEM_AGENT },
    ...historicoCurto(historico),
    { role: "user", content: pergunta },
  ];

  for (const ev of eventos) {
    mensagens.push({ role: "assistant", content: JSON.stringify(ev.acao) });
    mensagens.push({ role: "user", content: `RESULTADO_DA_FERRAMENTA ${ev.acao.tool}:\n${limitar(ev.resultado)}` });
  }

  const raw = await chamarIAbruta(mensagens, {
    max_tokens: 900,
    temperature: 0,
    reasoning_effort: "low",
  });

  const obj = parseJSONSeguro(raw);
  if (!obj || !["tool", "final"].includes(obj.tipo)) return null;
  return obj;
}

function perguntaFactual(q) {
  return !ehSaudacao(q);
}

function estadoDaConversa(eventos, pergunta) {
  const usadas = eventos.map((e) => ({ tool: e.acao.tool, args: e.acao.args || {} }));
  return {
    versao: 9,
    fonte: "google_sheets_david_roberts_pattern",
    pergunta: texto(pergunta),
    ferramentas_usadas: usadas,
    momento: Date.now(),
  };
}

export async function responderPergunta(pergunta, historico = []) {
  const q = texto(pergunta);
  if (!q) {
    return { resposta: "Digite uma pergunta sobre a planilha.", sql: "", linhas: 0, erro: "pergunta vazia", modoAgente: "sheets_tools_david_v9" };
  }

  if (ehSaudacao(q)) {
    return {
      resposta: "Oi! Pode perguntar sobre obras, projetos, licitações, valores, responsáveis e status da planilha.",
      sql: "", linhas: 0, erro: "", estado: { versao: 9, fonte: "google_sheets_david_roberts_pattern" }, modoAgente: "sheets_tools_david_v9", fonte: "Google Sheets",
    };
  }

  let rows;
  try {
    rows = await getObras();
  } catch (e) {
    return { resposta: `Não consegui ler a planilha agora: ${e?.message || e}`, sql: "", linhas: 0, erro: e?.message || String(e), modoAgente: "sheets_tools_david_v9" };
  }

  const eventos = [];

  // O workflow do David recomenda list_columns primeiro. Aqui fazemos isso
  // automaticamente para garantir que a IA sempre conheça o schema real.
  const acaoSchema = { tipo: "tool", tool: "listar_colunas", args: {}, motivo: "descobrir schema real" };
  const schema = executarFerramenta("listar_colunas", rows, {});
  eventos.push({ acao: acaoSchema, resultado: schema });
  console.log("AGENTE DAVID - FERRAMENTA: listar_colunas");
  console.log("AGENTE DAVID - RESULTADO:", limitar(schema, 5000));

  let answer = null;
  let erro = "";

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    let decisao;
    try {
      decisao = await decidirProximoPasso(q, historico, eventos);
    } catch (e) {
      erro = e?.message || String(e);
      break;
    }

    if (!decisao) {
      erro = "IA retornou ação inválida";
      break;
    }

    if (decisao.tipo === "final") {
      // Para perguntas factuais, não aceitamos resposta baseada somente no schema.
      // É obrigatório consultar pelo menos uma coluna ou uma linha real.
      const consultouDados = eventos.some((e) => ["valores_coluna", "obter_linha"].includes(e.acao.tool));
      if (perguntaFactual(q) && !consultouDados) {
        eventos.push({
          acao: { tipo: "tool", tool: "_validacao", args: {}, motivo: "resposta final sem consultar dados" },
          resultado: { erro: "Antes de responder fatos, consulte valores_coluna ou obter_linha." },
        });
        continue;
      }
      answer = texto(decisao.answer);
      break;
    }

    const tool = texto(decisao.tool);
    if (!["listar_colunas", "valores_coluna", "obter_linha"].includes(tool)) {
      eventos.push({ acao: decisao, resultado: { erro: `Ferramenta não permitida: ${tool}` } });
      continue;
    }

    const args = decisao.args && typeof decisao.args === "object" ? decisao.args : {};
    const resultado = executarFerramenta(tool, rows, args);
    eventos.push({ acao: { ...decisao, args }, resultado });

    console.log("AGENTE DAVID - FERRAMENTA:", tool);
    console.log("AGENTE DAVID - ARGS:", limitar(args, 2500));
    console.log("AGENTE DAVID - RESULTADO:", limitar(resultado, 5000));
  }

  if (!answer) {
    answer = erro
      ? "Não consegui concluir essa consulta com segurança agora. Tente novamente; se persistir, me envie o log AGENTE DAVID."
      : "Não consegui concluir a consulta com segurança usando os dados disponíveis.";
  }

  const consultados = eventos.filter((e) => ["valores_coluna", "obter_linha"].includes(e.acao.tool));
  let linhas = 0;
  for (const e of consultados) {
    if (e.acao.tool === "valores_coluna") linhas = Math.max(linhas, Number(e.resultado?.resumo?.total_linhas || 0));
    if (e.acao.tool === "obter_linha") linhas = Math.max(linhas, e.resultado?.dados ? 1 : 0);
  }

  return {
    resposta: answer,
    sql: "",
    linhas,
    erro,
    estado: estadoDaConversa(eventos, q),
    ferramenta: eventos.at(-1)?.acao?.tool || null,
    ferramentas: eventos.map((e) => e.acao.tool),
    modoAgente: "sheets_tools_david_v9",
    fonte: "Google Sheets",
  };
}
