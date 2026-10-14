// ============================================================
// agente.js - AGENTE DA PLANILHA (SEM BANCO) - V14
// ------------------------------------------------------------
// Fluxo:  pergunta -> plano JSON (IA ou regras locais) -> execução em JS
//         sobre as linhas da planilha (cache em memória) -> resposta.
//
// Por que não erra contas: a IA só escolhe filtros/colunas. Contagem, soma,
// média, máximo, mínimo e agrupamento são calculados pelo Node, sobre TODAS
// as linhas. A IA nunca inventa números.
//
// Mantém a mesma exportação: responderPergunta(pergunta, historico, opcoes)
// e o mesmo formato de retorno usado pelo server.js.
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";

const MAX_LISTA = Math.max(5, Math.min(Number(process.env.AGENTE_MAX_LISTA || 15), 50));
const MAX_VALORES_CATALOGO = 25;

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------
const norm = (s = "") => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();
const vazio = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const colunaInterna = (c) => c.startsWith("_");
const STOP = new Set("a o as os de da do das dos e em no na nos nas um uma uns umas para pra por com que qual quais quanto quantos quantas quanta me diga mostre mostrar liste listar tem ha existe existem sao foi foram esta estao obra obras sobre qual e ou ao aos se sua seu".split(" "));

function paraNumero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (vazio(v)) return null;
  let s = String(v).replace(/r\$|\s|%/gi, "");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (n) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const ehMonetaria = (c) => /valor|custo|preco|montante|recurso|pago|medido|contrat|r\$/.test(norm(c));
const fmtValor = (c, n) => (ehMonetaria(c) ? brl(n) : num(n));

function tokens(s) {
  return norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t));
}

// ------------------------------------------------------------
// Catálogo (colunas, tipos e valores frequentes) - recalculado só quando
// a lista de linhas muda (o sheets.js já mantém o cache).
// ------------------------------------------------------------
let catalogoCache = { ref: null, cat: null };

function montarCatalogo(linhas) {
  if (catalogoCache.ref === linhas) return catalogoCache.cat;
  const colunas = new Map();
  for (const l of linhas) {
    for (const [c, v] of Object.entries(l)) {
      if (colunaInterna(c)) continue;
      if (!colunas.has(c)) colunas.set(c, { nome: c, preenchidas: 0, numericas: 0, valores: new Map() });
      const info = colunas.get(c);
      if (vazio(v)) continue;
      info.preenchidas++;
      if (paraNumero(v) !== null) info.numericas++;
      const k = String(v).trim();
      if (k.length <= 80) info.valores.set(k, (info.valores.get(k) || 0) + 1);
    }
  }
  const lista = [...colunas.values()].map((i) => {
    const numerica = i.preenchidas > 0 && i.numericas / i.preenchidas >= 0.8;
    const distintos = [...i.valores.entries()].sort((a, b) => b[1] - a[1]);
    const categorica = !numerica && distintos.length > 0 && distintos.length <= Math.max(40, i.preenchidas * 0.3);
    return {
      nome: i.nome, preenchidas: i.preenchidas, numerica, categorica,
      distintos: distintos.map(([v]) => v),
      exemplos: distintos.slice(0, MAX_VALORES_CATALOGO).map(([v, n]) => `${v} (${n})`),
    };
  });
  const abas = [...new Set(linhas.map((l) => l._aba))];
  const cat = { colunas: lista, abas, total: linhas.length };
  catalogoCache = { ref: linhas, cat };
  return cat;
}

function acharColuna(cat, nome) {
  if (!nome) return null;
  const n = norm(nome);
  return cat.colunas.find((c) => c.nome === nome)?.nome
    || cat.colunas.find((c) => norm(c.nome) === n)?.nome
    || cat.colunas.find((c) => norm(c.nome).includes(n) || n.includes(norm(c.nome)))?.nome
    || (n === "aba" ? "_aba" : null);
}

// ------------------------------------------------------------
// Execução do plano (100% determinística)
// ------------------------------------------------------------
function casa(valorCelula, f) {
  const op = f.op || "contem";
  if (op === "vazio") return vazio(valorCelula);
  if (op === "preenchido") return !vazio(valorCelula);
  if (vazio(valorCelula)) return op === "diferente" || op === "nao_contem";
  const a = norm(valorCelula);
  const valores = (Array.isArray(f.valor) ? f.valor : [f.valor]).map((x) => norm(x));
  const numA = paraNumero(valorCelula), numB = paraNumero(f.valor);
  switch (op) {
    case "igual": return valores.some((b) => a === b);
    case "diferente": return valores.every((b) => a !== b);
    case "nao_contem": return valores.every((b) => !a.includes(b));
    case "maior": return numA !== null && numB !== null && numA > numB;
    case "menor": return numA !== null && numB !== null && numA < numB;
    case "maior_igual": return numA !== null && numB !== null && numA >= numB;
    case "menor_igual": return numA !== null && numB !== null && numA <= numB;
    default: return valores.some((b) => a.includes(b));
  }
}

function aplicarFiltros(linhas, filtros, cat) {
  let r = linhas;
  for (const f of filtros || []) {
    if (f.coluna === "*" || f.coluna === "qualquer") {
      const v = norm(f.valor);
      r = r.filter((l) => Object.entries(l).some(([c, x]) => !colunaInterna(c) && norm(x).includes(v)));
      continue;
    }
    const col = acharColuna(cat, f.coluna);
    if (!col) continue;
    r = r.filter((l) => casa(l[col], f));
  }
  return r;
}

function executarPlano(plano, linhas, cat) {
  const filtradas = aplicarFiltros(linhas, plano.filtros, cat);
  const op = plano.operacao || "listar";
  const colValor = acharColuna(cat, plano.coluna_valor);
  const colGrupo = acharColuna(cat, plano.agrupar_por);
  const valores = colValor ? filtradas.map((l) => paraNumero(l[colValor])).filter((n) => n !== null) : [];
  const res = { op, filtradas, colValor, colGrupo, total: filtradas.length };

  if (op === "somar") res.valor = valores.reduce((a, b) => a + b, 0);
  if (op === "media") res.valor = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
  if (op === "maior" || op === "menor") {
    let melhor = null;
    for (const l of filtradas) {
      const n = colValor ? paraNumero(l[colValor]) : null;
      if (n === null) continue;
      if (!melhor || (op === "maior" ? n > melhor.n : n < melhor.n)) melhor = { n, l };
    }
    res.melhor = melhor;
  }
  if (op === "agrupar" && colGrupo) {
    const g = new Map();
    for (const l of filtradas) {
      const k = vazio(l[colGrupo]) ? "Não informado" : String(l[colGrupo]).trim();
      const e = g.get(k) || { qtd: 0, soma: 0 };
      e.qtd++; const n = colValor ? paraNumero(l[colValor]) : null; if (n !== null) e.soma += n;
      g.set(k, e);
    }
    res.grupos = [...g.entries()].sort((a, b) => (colValor ? b[1].soma - a[1].soma : b[1].qtd - a[1].qtd));
  }
  if (op === "listar" && colValor && plano.ordem) {
    const s = plano.ordem === "asc" ? 1 : -1;
    res.filtradas = [...filtradas].sort((a, b) => s * ((paraNumero(a[colValor]) ?? -Infinity) - (paraNumero(b[colValor]) ?? -Infinity)));
  }
  res.valoresUsados = valores.length;
  return res;
}

// ------------------------------------------------------------
// Formatação da resposta (sem IA => números sempre corretos)
// ------------------------------------------------------------
function colunasPrincipais(cat) {
  const pref = ["objeto", "obra", "descricao", "nome", "bairro", "localidade", "status", "situacao", "empresa", "valor"];
  const out = [];
  for (const p of pref) {
    const c = cat.colunas.find((x) => norm(x.nome).includes(p) && !out.includes(x.nome));
    if (c) out.push(c.nome);
    if (out.length >= 4) break;
  }
  return out.length ? out : cat.colunas.slice(0, 4).map((c) => c.nome);
}

function descreverLinha(l, cols) {
  return cols.filter((c) => !vazio(l[c])).map((c) => {
    const n = paraNumero(l[c]);
    return `${c}: ${n !== null && ehMonetaria(c) ? brl(n) : String(l[c]).trim()}`;
  }).join(" | ");
}

function detalharLinha(l) {
  return Object.entries(l).filter(([c, v]) => !colunaInterna(c) && !vazio(v)).map(([c, v]) => {
    const n = paraNumero(v);
    return `• *${c}:* ${n !== null && ehMonetaria(c) ? brl(n) : String(v).trim()}`;
  }).join("\n");
}

function formatar(res, plano, cat) {
  const desc = plano.descricao ? ` (${plano.descricao})` : "";
  if (res.total === 0) return `Não encontrei nenhum registro na planilha${desc}. Quer tentar com outras palavras?`;
  const cols = [...new Set([...(plano.mostrar || []).map((c) => acharColuna(cat, c)).filter(Boolean), ...colunasPrincipais(cat)])].slice(0, 5);

  switch (res.op) {
    case "contar": return `Encontrei *${res.total}* registro(s)${desc}.`;
    case "somar":
      if (!res.colValor) break;
      return `A soma de *${res.colValor}*${desc} é *${fmtValor(res.colValor, res.valor)}* (${res.valoresUsados} de ${res.total} registro(s) com valor preenchido).`;
    case "media":
      if (!res.colValor || res.valor === null) break;
      return `A média de *${res.colValor}*${desc} é *${fmtValor(res.colValor, res.valor)}* (base: ${res.valoresUsados} registro(s)).`;
    case "maior": case "menor":
      if (!res.melhor) break;
      return `${res.op === "maior" ? "Maior" : "Menor"} *${res.colValor}*${desc}: *${fmtValor(res.colValor, res.melhor.n)}*\n${descreverLinha(res.melhor.l, cols)}`;
    case "agrupar":
      if (!res.grupos) break;
      return `*${res.colGrupo}*${desc} — ${res.total} registro(s):\n` + res.grupos.slice(0, 30).map(([k, e]) =>
        `• ${k}: ${e.qtd}${res.colValor ? ` — ${fmtValor(res.colValor, e.soma)}` : ""}`).join("\n");
    case "detalhar":
      if (res.total <= 3) return res.filtradas.map(detalharLinha).join("\n\n");
      break;
  }
  if (res.total === 1) return `Encontrei 1 registro${desc}:\n${detalharLinha(res.filtradas[0])}`;
  const lista = res.filtradas.slice(0, MAX_LISTA).map((l, i) => `${i + 1}. ${descreverLinha(l, cols)}`).join("\n");
  const resto = res.total > MAX_LISTA ? `\n…e mais ${res.total - MAX_LISTA}. Quer filtrar melhor (bairro, status, ano…)?` : "";
  return `Encontrei *${res.total}* registro(s)${desc}:\n${lista}${resto}`;
}

// ------------------------------------------------------------
// Planejamento: regras locais rápidas + IA (só JSON)
// ------------------------------------------------------------
function planoLocal(pergunta, cat) {
  const p = norm(pergunta);
  if (/^(quantas|quantos|total de) (obras|registros|linhas)( (tem|existem|ha|cadastradas))?\??$/.test(p))
    return { operacao: "contar", filtros: [], descricao: "no total" };
  // Valores categóricos citados literalmente na pergunta (ex.: "concluída", nome de bairro)
  const filtros = [];
  for (const c of cat.colunas.filter((x) => x.categorica)) {
    const achados = c.distintos.filter((v) => { const n = norm(v); return n.length >= 4 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`).test(p); });
    if (achados.length) filtros.push({ coluna: c.nome, op: "igual", valor: achados });
  }
  if (!filtros.length) return null;
  if (/^(quantas|quantos)\b/.test(p) && !/\bvalor|soma|total em\b/.test(p))
    return { operacao: "contar", filtros, descricao: filtros.map((f) => f.valor.join("/")).join(", ") };
  return null;
}

function resumoCatalogo(cat) {
  return cat.colunas.map((c) => `- "${c.nome}" [${c.numerica ? "número" : "texto"}]${c.exemplos.length ? ` valores: ${c.exemplos.slice(0, c.categorica ? MAX_VALORES_CATALOGO : 6).join("; ").slice(0, 600)}` : ""}`).join("\n")
    + `\n- "_aba" [texto] valores: ${cat.abas.join("; ")}`;
}

function extrairJSON(t) {
  const s = String(t || "").replace(/```json|```/gi, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

async function planoIA(pergunta, historico, cat) {
  const anterior = [...historico].reverse().find((m) => m?.role === "assistant" && m.estado?.plano)?.estado?.plano;
  const conversa = historico.slice(-4).map((m) => `${m.role === "user" ? "Usuário" : "Bot"}: ${String(m.content || "").slice(0, 300)}`).join("\n");
  const sistema = `Você converte perguntas em português sobre uma planilha em um PLANO JSON. Responda SÓ o JSON.
Colunas disponíveis (use o nome EXATO):
${resumoCatalogo(cat)}

Formato:
{"operacao":"listar|contar|somar|media|maior|menor|agrupar|detalhar|fora_do_escopo",
 "filtros":[{"coluna":"nome exato ou * para qualquer coluna","op":"igual|contem|diferente|nao_contem|maior|menor|maior_igual|menor_igual|vazio|preenchido","valor":"texto, número ou lista"}],
 "coluna_valor":"coluna numérica para somar/media/maior/menor/ordenar","agrupar_por":"coluna","ordem":"asc|desc",
 "mostrar":["colunas relevantes para exibir"],"descricao":"resumo curto do filtro em português"}
Regras:
- Use valores que existem na lista quando possível ("igual"); para nomes parciais use "contem".
- "quantas/quantos" => contar. "valor total/soma/quanto foi investido" => somar. "por bairro/status" => agrupar.
- Pergunta sobre uma obra específica => detalhar com filtro "contem" (coluna * se não souber a coluna).
- Pergunta de continuação ("e quais são?", "e em tal bairro?") => reaproveite o plano anterior e ajuste.
- Se não tiver relação com a planilha => {"operacao":"fora_do_escopo"}.
Plano anterior: ${anterior ? JSON.stringify(anterior) : "nenhum"}`;
  const texto = await chamarIAbruta([
    { role: "system", content: sistema },
    { role: "user", content: `${conversa ? `Conversa recente:\n${conversa}\n\n` : ""}Pergunta: ${pergunta}` },
  ], { max_tokens: 400, temperature: 0 });
  return extrairJSON(texto);
}

// Busca de segurança: ranking por palavras em todas as células.
function buscaLivre(pergunta, linhas) {
  const ts = tokens(pergunta);
  if (!ts.length) return [];
  return linhas.map((l) => {
    const txt = norm(Object.entries(l).filter(([c]) => !colunaInterna(c)).map(([, v]) => v).join(" "));
    return { l, s: ts.reduce((a, t) => a + (txt.includes(t) ? 1 : 0), 0) };
  }).filter((x) => x.s >= Math.max(1, Math.ceil(ts.length / 2))).sort((a, b) => b.s - a.s).map((x) => x.l);
}

// ------------------------------------------------------------
function respostaSocial(pergunta = "") {
  const p = norm(pergunta);
  if (/^(?:o+i+|oie+|ola+|opa+|e ai+|bom dia+|boa tarde+|boa noite+)[!.? ]*$/.test(p))
    return "Olá! Pode me perguntar qualquer coisa sobre as obras da planilha: status, bairros, valores, empresas, prazos…";
  if (/^(?:muito )?(?:obrigad[oa]|obg|valeu|vlw|show|blz|beleza)[!.? ]*$/.test(p)) return "Por nada! Se precisar, é só chamar.";
  if (/^(?:tchau|ate mais|falou)[!.? ]*$/.test(p)) return "Até mais!";
  return null;
}

export async function responderPergunta(pergunta, historico = [], _opcoes = {}) {
  const inicio = Date.now();
  const texto = String(pergunta || "").trim().slice(0, 800);
  if (!texto) return { resposta: "Digite sua pergunta sobre as obras." };
  const social = respostaSocial(texto);
  if (social) return { resposta: social, social: true, modoAgente: "social" };

  let linhas;
  try { linhas = await getObras(); } catch (e) {
    console.error("AGENTE: falha ao ler planilha:", e.message);
    return { resposta: "Não consegui acessar a planilha agora. Tente novamente em instantes.", erro: e.message };
  }
  const cat = montarCatalogo(linhas);

  let plano = planoLocal(texto, cat), modo = "regra_local";
  if (!plano) {
    try { plano = await planoIA(texto, Array.isArray(historico) ? historico : [], cat); modo = "plano_ia"; }
    catch (e) { console.error("AGENTE: IA indisponível:", e.message); plano = null; }
  }

  if (plano?.operacao === "fora_do_escopo")
    return { resposta: "Só consigo responder sobre as informações da planilha de obras. O que você quer saber sobre elas?", modoAgente: "fora_do_escopo" };

  let res = plano ? executarPlano(plano, linhas, cat) : null;

  // Se o plano não achou nada, tenta a busca livre antes de desistir.
  if (!res || (res.total === 0 && ["listar", "detalhar", "contar"].includes(plano?.operacao))) {
    const achadas = buscaLivre(texto, linhas);
    if (achadas.length) {
      plano = { operacao: achadas.length <= 3 ? "detalhar" : "listar", filtros: [], descricao: "busca por palavras" };
      res = { op: plano.operacao, filtradas: achadas, total: achadas.length };
      modo = "busca_livre";
    }
  }
  if (!res) return { resposta: "Não entendi bem. Pode reformular citando, por exemplo, o bairro, o status ou o nome da obra?", modoAgente: "sem_plano" };

  const resposta = formatar(res, plano, cat);
  return {
    resposta,
    linhas: res.total,
    modoAgente: modo,
    estado: { plano },
    diagnostico: { plano, total_planilha: linhas.length, ms: Date.now() - inicio },
  };
}

// Exportado para testes.
export const _interno = { montarCatalogo, executarPlano, planoLocal, paraNumero, formatar, buscaLivre };
