// ============================================================
// agente.js - AGENTE DA PLANILHA (SEM BANCO) - V16
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
const ORCAMENTO_LISTA = 3200;   // máx. de caracteres da lista (WhatsApp aceita ~4000)
// Perguntas de "obras" com filtro de status também olham a aba de pavimentação
// (lá o status concluído vem como "EXECUTADA"). Desligue com AGENTE_OBRAS_COM_PAV=false.
const OBRAS_COM_PAV = process.env.AGENTE_OBRAS_COM_PAV !== "false";

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------
const norm = (s = "") => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();
const vazio = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const colunaInterna = (c) => c.startsWith("_");
const STOP = new Set("a o as os de da do das dos e em no na nos nas um uma uns umas para pra por com que qual quais quanto quantos quantas quanta me diga mostre mostrar liste listar tem ha existe existem sao foi foram esta estao obra obras sobre qual e ou ao aos se sua seu fala falar fale der de dar dá da dê mostra mostrar mostre lista listar liste quero queria gostaria saber sei informe informa informar todas todos toda todo so somente apenas os nome nomes status situacao estado oi ola favor por voce vc pode poderia traga traz trazer ver veja manda mande envia envie relacao relatorio ai".split(" "));
// Pedido só de nomes ("me dê só os nomes das obras concluídas").
const pedeSoNomes = (p) => /\b(so|somente|apenas)\b[\s\S]{0,15}\bnomes?\b|\bnomes? (das|dos|de)\b|\bso o nome\b/.test(norm(p));
const pedeTodas = (p) => /\b(todas|todos|quais|liste|listar|lista|relacao)\b/.test(norm(p));

function paraNumero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (vazio(v)) return null;
  let s = String(v).replace(/r\$|\s|%/gi, "");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");   // 1.500 / 1.500.000
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (n) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const ehPercentual = (c) => /%|percent/.test(norm(c));
const ehMonetaria = (c) => !ehPercentual(c) && /valor|custo|preco|montante|pago|medido|saldo|restante|aditivo|reajuste|contrapartida|emenda|r\$/.test(norm(c));
// Percentual vindo como fração (0,755 ou 1,02) vira 75,5% / 102%; já em pontos (75,5) fica como está.
const fmtValor = (c, n) => (ehPercentual(c) ? `${num(Math.abs(n) <= 5 ? n * 100 : n)}%` : ehMonetaria(c) ? brl(n) : num(n));
const fmtCelula = (c, v) => { if (typeof v === "string" && ehPercentual(c) && v.includes("%")) return v.trim(); const n = paraNumero(v); return n !== null && (ehMonetaria(c) || ehPercentual(c)) ? fmtValor(c, n) : String(v).trim(); };
const rotuloColuna = (c) => (c === COL_PADRAO ? "Status" : c);
const COL_PADRAO = "STATUS PADRÃO";
const RE_VTOTAL = /^valor total da obra|^valor total$/;
const ehColStatus = (c) => /^(status|situacao)( original)?$/.test(norm(c));
// Acha o valor de uma coluna da linha por regex no nome normalizado.
const colDe = (l, re) => Object.keys(l).find((c) => !colunaInterna(c) && re.test(norm(c)));
const valDe = (l, re) => { const c = colDe(l, re); return c ? l[c] : undefined; };

function tokens(s) {
  return norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t));
}


// ------------------------------------------------------------
// Status padronizado: "Concluída", "CONCLUÍDO", "EXECUTADA" => Concluída, etc.
// ------------------------------------------------------------
const STATUS_REGRAS = [
  [/\bnao conclu|\binconclu/, "Em andamento"],
  [/\bparalis/, "Paralisada"],
  [/\bstand/, "Stand-by"],
  [/\bnao iniciad|\ba iniciar|\ba executar|\bnao comecad|\bsem iniciar|\binicio da obra/, "Não iniciada"],
  [/\bconclu|\bexecutad|\bfinaliz|\bentregue|\bterminad/, "Concluída"],
  [/\bem andamento|\bem execucao|\bandamento|\bexecucao/, "Em andamento"],
];
function padronizarStatus(txt) {
  const t = norm(txt);
  for (const [re, nome] of STATUS_REGRAS) if (re.test(t)) return nome;
  return "Outro";
}
// Status citados na pergunta (ex.: "concluídas e paralisadas" => [Concluída, Paralisada]).
function statusDaPergunta(p) {
  const t = norm(p);
  const achados = new Set();
  for (const [re, nome] of STATUS_REGRAS) if (re.test(t)) achados.add(nome);
  if (/\bnao conclu|\binconclu/.test(t)) achados.delete("Concluída");
  return [...achados];
}
function statusPadrao(l) {
  const cands = [valDe(l, /^(status|situacao)$/), valDe(l, /^status original$/)].filter((x) => !vazio(x));
  for (const t of cands) { const p = padronizarStatus(t); if (p !== "Outro") return p; }
  return cands.length ? "Outro" : null;
}

// ------------------------------------------------------------
// Deduplicação: a mesma obra aparece em mais de uma aba (ex.: EM_ANDAMENTO e
// "SITUAÇÃO DAS OBRAS EM ANDAMENTO"). Junta por nome do objeto (+ contrato, se
// ambos tiverem), mantém a linha mais completa e completa os vazios com as outras.
// ------------------------------------------------------------
const preench = (l) => Object.entries(l).filter(([c, v]) => !colunaInterna(c) && !vazio(v)).length;
const nomeObjeto = (l) => norm(String(valDe(l, /^(objeto|obra|rua)( |$)/) ?? "")).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const contratoDe = (l) => norm(String(valDe(l, /^(n\S* do )?contrato( |$)/) ?? "")).replace(/\s/g, "");

function deduplicar(linhas) {
  const clusters = [], porNome = new Map();
  for (const l of linhas) {
    const nome = nomeObjeto(l), ctr = contratoDe(l);
    if (!nome) { clusters.push({ ctr, itens: [l] }); continue; }   // sem nome: não arrisca juntar
    const lista = porNome.get(nome) || [];
    let c = lista.find((x) => !x.ctr || !ctr || x.ctr === ctr);
    if (!c) { c = { ctr, itens: [] }; lista.push(c); porNome.set(nome, lista); clusters.push(c); }
    if (!c.ctr && ctr) c.ctr = ctr;
    c.itens.push(l);
  }
  return clusters.map(({ itens }) => {
    if (itens.length === 1) return itens[0];
    const ord = [...itens].sort((a, b) => preench(b) - preench(a));
    const m = { ...ord[0], _abas: [...new Set(itens.map((x) => x._aba))] };
    for (const o of ord.slice(1)) for (const [c, v] of Object.entries(o)) if (!colunaInterna(c) && vazio(m[c]) && !vazio(v)) m[c] = v;
    return m;
  });
}

// Universo da consulta (categorias + dedup + status padrão), com cache por lista de linhas.
const universoCache = new WeakMap();
function montarUniverso(linhas, categorias) {
  let m = universoCache.get(linhas);
  if (!m) { m = new Map(); universoCache.set(linhas, m); }
  const k = categorias.join("+");
  if (m.has(k)) return m.get(k);
  const sel = linhas.filter((l) => categorias.includes(categoriaDaLinha(l, linhas)));
  let u = deduplicar(sel);
  if (categorias.some((c) => c === "obra" || c === "pavimentacao"))
    u = u.map((l) => { const p = statusPadrao(l); return p ? { ...l, [COL_PADRAO]: p } : l; });
  const r = { universo: u, brutas: sel.length };
  m.set(k, r);
  return r;
}

// ------------------------------------------------------------
// Catálogo (colunas, tipos e valores frequentes) - recalculado só quando
// a lista de linhas muda (o sheets.js já mantém o cache).
// ------------------------------------------------------------
const catalogoCache = new WeakMap();

function montarCatalogo(linhas) {
  if (catalogoCache.has(linhas)) return catalogoCache.get(linhas);
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
  catalogoCache.set(linhas, cat);
  return cat;
}

function acharColuna(cat, nome) {
  if (!nome) return null;
  const n = norm(nome);
  const exata = cat.colunas.find((c) => c.nome === nome) || cat.colunas.find((c) => norm(c.nome) === n);
  if (exata) return exata.nome;
  // parcial: prefere a coluna mais específica/curta que CONTÉM o termo
  const contem = cat.colunas.filter((c) => norm(c.nome).includes(n)).sort((a, b) => a.nome.length - b.nome.length);
  if (contem.length) return contem[0].nome;
  const contido = cat.colunas.filter((c) => n.includes(norm(c.nome))).sort((a, b) => b.nome.length - a.nome.length);
  return contido[0]?.nome || (n === "aba" ? "_aba" : null);
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
  const temPadrao = cat.colunas.some((c) => c.nome === COL_PADRAO);
  for (let f of filtros || []) {
    if (f.coluna === "*" || f.coluna === "qualquer") {
      const v = norm(f.valor);
      r = r.filter((l) => Object.entries(l).some(([c, x]) => !colunaInterna(c) && norm(x).includes(v)));
      continue;
    }
    let col = acharColuna(cat, f.coluna);
    if (!col) continue;
    const info = cat.colunas.find((c) => c.nome === col);
    // Status: usa a coluna padronizada quando todos os valores pedidos são reconhecidos.
    if (temPadrao && ehColStatus(col) && !["vazio", "preenchido"].includes(f.op)) {
      const vs = (Array.isArray(f.valor) ? f.valor : [f.valor]).map(padronizarStatus);
      if (vs.length && vs.every((v) => v !== "Outro")) {
        col = COL_PADRAO;
        f = { ...f, op: ["diferente", "nao_contem"].includes(f.op) ? "diferente" : "igual", valor: [...new Set(vs)] };
      }
    }
    // Texto livre (bairro, objeto, endereço): "igual" quase nunca é o que se quer.
    if (f.op === "igual" && col !== COL_PADRAO && info && !info.numerica) {
      const pedidos = (Array.isArray(f.valor) ? f.valor : [f.valor]).map(norm);
      const exatoExiste = pedidos.every((v) => info.distintos.some((d) => norm(d) === v));
      if (/bairro|localidade|endereco|objeto|rua|local/.test(norm(col)) || !exatoExiste) f = { ...f, op: "contem" };
    }
    const ff = f;
    const colObj = /^bairro|^localidade/.test(norm(col)) && ["contem", "igual", undefined].includes(ff.op) ? cat.colunas.find((c) => /^(objeto|obra|rua)( |$)/.test(norm(c.nome)))?.nome : null;
    r = r.filter((l) => casa(l[col], ff) || (colObj && vazio(l[col]) && casa(l[colObj], { ...ff, op: "contem" })));
  }
  return r;
}


// ------------------------------------------------------------
// Bairros: o campo vem como endereço livre ("Rua X, s/n - Centro", "AREAL", "Areal").
// Extrai o bairro de CADA célula (sem varrer o texto atrás de palavras soltas).
// ------------------------------------------------------------
const IGNORA_BAIRRO = /^(rua|ruas|avenida|av|travessa|diversas?|estradas?|sitio|zona|zonas|localidades?|s\/n|projetada|mamanguape|pb|paraiba|municipio)\b/;
const titulo = (t) => t.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b, off) => (/^(da|de|do|das|dos|e)\s/.test(t.toLowerCase().slice(off + a.length)) && off > 0 ? m : a + b.toUpperCase()));
const candidatoValido = (n) => n.length >= 3 && n.length <= 25 && !/\d/.test(n) && !IGNORA_BAIRRO.test(n);
const limpaSeg = (x) => x.replace(/[.]+$/, "").trim();
function bairrosDaCelula(v) {
  if (vazio(v)) return ["Não informado"];
  const txt = String(v).trim();
  const quebra = (t) => t.split(/[,;]|\s[-–]\s/).flatMap((x) => x.split(/\s+e\s+/i)).map(limpaSeg);
  let cands = [];
  if (/bairro:?/i.test(txt)) cands = quebra(txt.split(/bairro:?/i).pop());                       // "... Bairro: Centro e Gurguri"
  else if (!/[,;]|\s[-–]\s/.test(txt)) cands = [limpaSeg(txt)];                                    // célula só com o bairro
  else { const segs = txt.split(/[,;]|\s[-–]\s/).map(limpaSeg).reverse(); const ok = segs.find((x) => candidatoValido(norm(x))); cands = ok ? [ok] : []; }
  const ach = [...new Set(cands.filter((x) => candidatoValido(norm(x))).map((x) => titulo(x)))];
  if (ach.length) return ach;
  return /zona rural|sitio|localidades rurais|estrada/.test(norm(txt)) ? ["Zona rural / estradas"] : ["Endereço sem bairro identificado"];
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
  if (op === "agrupar" && colGrupo && /^bairro/.test(norm(colGrupo))) {
    const g = new Map(); let multi = false;
    for (const l of filtradas) {
      const bs = bairrosDaCelula(l[colGrupo]);
      if (bs.length > 1) multi = true;
      for (const k of bs) {
        const e = g.get(k) || { qtd: 0, soma: 0 };
        e.qtd++; const n = colValor ? paraNumero(l[colValor]) : null; if (n !== null) e.soma += n;
        g.set(k, e);
      }
    }
    res.grupos = [...g.entries()].sort((a, b) => (colValor ? b[1].soma - a[1].soma : b[1].qtd - a[1].qtd) || b[1].qtd - a[1].qtd || a[0].localeCompare(b[0]));
    res.multi = multi;
  } else if (op === "agrupar" && colGrupo) {
    const g = new Map();
    for (const l of filtradas) {
      const k = vazio(l[colGrupo]) ? "Não informado" : String(l[colGrupo]).trim();
      const e = g.get(k) || { qtd: 0, soma: 0 };
      e.qtd++; const n = colValor ? paraNumero(l[colValor]) : null; if (n !== null) e.soma += n;
      g.set(k, e);
    }
    res.grupos = [...g.entries()].sort((a, b) => (colValor ? b[1].soma - a[1].soma : b[1].qtd - a[1].qtd) || b[1].qtd - a[1].qtd || a[0].localeCompare(b[0]));
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
function gruposPrincipais(cat) {
  const regras = [
    [/^(objeto|obra|rua|descricao|nome)( |$)/],
    [/^(bairro|localidade|endereco)/],
    [/^status padrao$/, /^(status|situacao)$/],
    [/^empresa/],
    [RE_VTOTAL, /^valor \(r\$\)|^valor( |$)/],
    [/^valor executado/],
    [/^%|percent/],
  ];
  const grupos = regras.map((rs) => rs.flatMap((re) => cat.colunas.filter((x) => re.test(norm(x.nome))).map((x) => x.nome)));
  const g = grupos.filter((x) => x.length);
  return g.length ? g : cat.colunas.slice(0, 4).map((c) => [c.nome]);
}
// Uma coluna por grupo: a primeira que estiver preenchida NESTA linha.
const colunasDaLinha = (l, grupos) => grupos.map((g) => g.find((c) => !vazio(l[c])) || g[0]);

function descreverLinha(l, cols) {
  return cols.filter((c) => !vazio(l[c])).map((c) => `${rotuloColuna(c)}: ${fmtCelula(c, l[c])}`).join(" | ");
}

function detalharLinha(l) {
  return Object.entries(l).filter(([c, v]) => !colunaInterna(c) && !vazio(v))
    .map(([c, v]) => `• *${rotuloColuna(c)}:* ${fmtCelula(c, v)}`).join("\n");
}

// Somas sobre TODAS as linhas filtradas (já deduplicadas).
function totaisLista(linhas, cat) {
  const out = [];
  const somar = (re) => {
    const c = cat.colunas.find((x) => x.numerica && re.test(norm(x.nome)));
    if (!c) return;
    const vs = linhas.map((l) => paraNumero(l[c.nome])).filter((n) => n !== null);
    if (vs.length) out.push(`• ${c.nome}: ${brl(vs.reduce((a, b) => a + b, 0))}${vs.length < linhas.length ? ` (${vs.length} de ${linhas.length} com valor)` : ""}`);
  };
  somar(RE_VTOTAL); somar(/^valor executado/); somar(/^valor pago$/); somar(/^valor \(r\$\)/);
  // restante = total − executado, só onde os dois existem (mesma conta do banco)
  let rest = 0, n = 0;
  for (const l of linhas) {
    const t = paraNumero(valDe(l, RE_VTOTAL)), e = paraNumero(valDe(l, /^valor executado/));
    if (t !== null && e !== null) { rest += t - e; n++; }
  }
  if (n) out.push(`• Valor restante (total − executado): ${brl(rest)}`);
  return out.length ? `\n*Soma de todos os ${linhas.length} registro(s):*\n${out.join("\n")}` : "";
}

// Inconsistências da base: só avisa, nunca altera os números.
function avisosQualidade(linhas) {
  const hoje = new Date();
  let zero = 0, acima = 0, futuro = 0;
  for (const l of linhas) {
    const st = l[COL_PADRAO];
    const tot = paraNumero(valDe(l, RE_VTOTAL)), exe = paraNumero(valDe(l, /^valor executado/));
    if (st === "Concluída" && tot > 0 && (exe ?? 0) === 0) zero++;
    if (tot > 0 && exe !== null && exe > tot * 1.0001) acima++;
    const d = String(valDe(l, /termino/) ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (st === "Concluída" && d && new Date(+d[3], +d[2] - 1, +d[1]) > hoje) futuro++;
  }
  const a = [];
  if (zero) a.push(`${zero} "Concluída(s)" com valor executado zerado (possível falta de preenchimento)`);
  if (acima) a.push(`${acima} com valor executado acima do valor total`);
  if (futuro) a.push(`${futuro} "Concluída(s)" com previsão de término ainda no futuro`);
  return a.length ? `\n⚠️ _Dados a conferir na planilha:_ ${a.join("; ")}.` : "";
}

function formatar(res, plano, cat) {
  const desc = plano.descricao ? ` (${plano.descricao})` : "";
  if (res.total === 0) return `Não encontrei nenhum registro na planilha${desc}. Quer tentar com outras palavras?`;
  const grupos = gruposPrincipais(cat);
  const extras = (plano.mostrar || []).map((c) => acharColuna(cat, c)).filter(Boolean).map((c) => [c]);
  const gruposTudo = [...extras, ...grupos].slice(0, 8);
  const cols = [...new Set(gruposTudo.flatMap((g) => g))].slice(0, 8);   // usado nos casos de 1 linha (maior/menor)
  const colsDa = (l) => [...new Set(colunasDaLinha(l, gruposTudo))];

  switch (res.op) {
    case "contar": return `Encontrei *${res.total}* registro(s)${desc}.`;
    case "somar":
      if (!res.colValor) break;
      return `A soma de *${res.colValor}*${desc} é *${fmtValor(res.colValor, res.valor)}* (${res.valoresUsados} de ${res.total} registro(s) com valor preenchido).`
        + (ehMonetaria(res.colValor) ? totaisLista(res.filtradas, cat) : "");
    case "media":
      if (!res.colValor || res.valor === null) break;
      return `A média de *${res.colValor}*${desc} é *${fmtValor(res.colValor, res.valor)}* (base: ${res.valoresUsados} registro(s)).`;
    case "maior": case "menor":
      if (!res.melhor) break;
      return `${res.op === "maior" ? "Maior" : "Menor"} *${res.colValor}*${desc}: *${fmtValor(res.colValor, res.melhor.n)}*\n${descreverLinha(res.melhor.l, colsDa(res.melhor.l))}`;
    case "agrupar":
      if (!res.grupos) break;
      return `*${res.colGrupo}*${desc} — ${res.total} registro(s), ${res.grupos.length} grupo(s):\n` + res.grupos.slice(0, 30).map(([k, e], i) =>
        `${i + 1}. ${k}: ${e.qtd}${res.colValor ? ` — ${fmtValor(res.colValor, e.soma)}` : ""}`).join("\n")
        + (res.grupos.length > 30 ? `\n…mostrando 30 de ${res.grupos.length} grupos.` : "")
        + (res.multi ? "\n_Obras que citam mais de um bairro entram em cada um deles._" : "");
    case "detalhar":
      if (res.total <= 3 && !plano.soNomes) return res.filtradas.map(detalharLinha).join("\n\n");
      break;
  }
  if (plano.soNomes) {
    const cNome = (l) => colDe(l, /^(objeto|obra|rua|descricao|nome)( |$)/);
    const nomes = res.filtradas.map((l) => { const c = cNome(l); return c ? String(l[c]).trim() : descreverLinha(l, colsDa(l).slice(0, 2)); });
    const lim = nomes.slice(0, 80);
    let txt = "", n = 0;
    for (const [i, x] of lim.entries()) { const t = `${i + 1}. ${x}\n`; if (txt.length + t.length > 3600) break; txt += t; n++; }
    return `Encontrei *${res.total}* registro(s)${desc}:\n${txt.trimEnd()}${res.total > n ? `\n…mostrando ${n} de ${res.total}.` : ""}`;
  }
  if (res.total === 1) return `Encontrei 1 registro${desc}:\n${detalharLinha(res.filtradas[0])}`;
  const itens = []; let usado = 0;
  for (const [i, l] of res.filtradas.slice(0, MAX_LISTA).entries()) {
    const t = `${i + 1}. ${descreverLinha(l, colsDa(l))}`;
    if (itens.length && usado + t.length > ORCAMENTO_LISTA) break;
    itens.push(t); usado += t.length + 1;
  }
  const resto = res.total > itens.length ? `\n…mostrando ${itens.length} de ${res.total}. Quer filtrar melhor (bairro, status, empresa…)?` : "";
  return `Encontrei *${res.total}* registro(s)${desc}:\n${itens.join("\n")}${resto}${totaisLista(res.filtradas, cat)}${avisosQualidade(res.filtradas)}`;
}

// ------------------------------------------------------------
// Planejamento: regras locais rápidas + IA (só JSON)
// ------------------------------------------------------------
function planoLocal(pergunta, cat) {
  const p = norm(pergunta);
  if (/^(quantas|quantos|total de) (obras|registros|linhas)( (tem|existem|ha|cadastradas))?\??$/.test(p))
    return { operacao: "contar", filtros: [], descricao: "no total" };
  const temPadrao = cat.colunas.some((c) => c.nome === COL_PADRAO);
  const filtros = [];
  const sts = temPadrao ? statusDaPergunta(p) : [];
  if (sts.length) filtros.push({ coluna: COL_PADRAO, op: "igual", valor: sts });
  // Valores categóricos citados literalmente na pergunta (ex.: nome de bairro).
  // Com STATUS PADRÃO, as colunas de status "cru" ficam de fora (senão o AND zera o resultado).
  for (const c of cat.colunas.filter((x) => x.categorica && x.nome !== COL_PADRAO && !(temPadrao && ehColStatus(x.nome)))) {
    const achados = c.distintos.filter((v) => { const n = norm(v); return n.length >= 4 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`).test(p); });
    if (achados.length) filtros.push({ coluna: c.nome, op: "igual", valor: achados });
  }
  if (!filtros.length) return null;
  const descricao = filtros.map((f) => f.valor.join("/")).join(", ");
  if (/^(quantas|quantos)\b/.test(p) && !/\bvalor|soma|total em\b/.test(p))
    return { operacao: "contar", filtros, descricao };
  // Pergunta só de status ("quais as obras concluídas?"): lista direto, sem depender da IA.
  if (sts.length && filtros.length === 1) {
    const resto = tokens(p).filter((t) => !/^(conclu|executad|finaliz|entregue|terminad|paralis|stand|iniciad|iniciar|executar|andamento|execucao|inconclu|nao|comecad)/.test(t));
    if (!resto.length) return { operacao: "listar", filtros, descricao };
  }
  return null;
}

// Plano "de segurança" quando a IA falha: usa o que deu para reconhecer na pergunta.
function planoLocalFraco(pergunta, cat) {
  const p = norm(pergunta);
  const temPadrao = cat.colunas.some((c) => c.nome === COL_PADRAO);
  const sts = temPadrao ? statusDaPergunta(p) : [];
  if (!sts.length) return null;
  const filtros = [{ coluna: COL_PADRAO, op: "igual", valor: sts }];
  const descricao = sts.join("/");
  if (/\b(quantas|quantos|quantidade|numero de)\b/.test(p)) return { operacao: "contar", filtros, descricao };
  if (/\b(soma|valor total|quanto (foi|custou|custaram|investido))\b/.test(p)) return { operacao: "somar", filtros, coluna_valor: /investid|gast/.test(p) ? "VALOR EXECUTADO" : "VALOR TOTAL DA OBRA", descricao };
  return { operacao: "listar", filtros, descricao };
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

async function planoIA(pergunta, historico, cat, categoria, rotulo) {
  const anteriorEstado = [...historico].reverse().find((m) => m?.role === "assistant" && m.estado?.plano)?.estado;
  const anterior = anteriorEstado?.categoria === categoria ? anteriorEstado.plano : null;
  const conversa = historico.slice(-4).map((m) => `${m.role === "user" ? "Usuário" : "Bot"}: ${String(m.content || "").slice(0, 300)}`).join("\n");
  const sistema = `Você converte perguntas em português sobre a planilha de obras de Mamanguape em um PLANO JSON. Responda SÓ o JSON.\nUniverso desta pergunta: SOMENTE ${rotulo} (aba(s): ${cat.abas.join(", ")}). Não use dados de outras categorias.
Colunas disponíveis (use o nome EXATO):
${resumoCatalogo(cat)}

Formato:
{"operacao":"listar|contar|somar|media|maior|menor|agrupar|detalhar|fora_do_escopo",
 "filtros":[{"coluna":"nome exato ou * para qualquer coluna","op":"igual|contem|diferente|nao_contem|maior|menor|maior_igual|menor_igual|vazio|preenchido","valor":"texto, número ou lista"}],
 "coluna_valor":"coluna numérica para somar/media/maior/menor/ordenar","agrupar_por":"coluna","ordem":"asc|desc",
 "mostrar":["colunas relevantes para exibir"],"descricao":"resumo curto do filtro em português"}
Regras:
- Use valores que existem na lista quando possível ("igual"); para nomes parciais use "contem".
- Local, bairro, rua ou objeto (ex.: "do centro", "Planalto"): SEMPRE op "contem" (o campo costuma trazer o endereço completo).
- "valor investido / gasto / pago / já executado" => coluna "VALOR EXECUTADO" (ou "VALOR PAGO" se a pergunta disser "pago"); "valor da obra / contratado / custo total / quanto custa" => "VALOR TOTAL DA OBRA". Nunca use "VALOR TOTAL DOS ADITIVOS" ou "VALOR TOTAL DOS REAJUSTES" salvo pedido explícito.
- "descricao": no máximo 6 palavras, só o filtro (ex.: "bairro Centro"), sem repetir a pergunta.
- Ranking/"quais bairros": operacao "agrupar" com agrupar_por "BAIRRO".
- Situação da obra: use a coluna "STATUS PADRÃO" quando existir (Concluída, Em andamento, Paralisada, Stand-by, Não iniciada, Outro). "concluída/executada/finalizada" = Concluída.
- "quantas/quantos" => contar. "valor total/soma/quanto foi investido" => somar. "por bairro/status" => agrupar.
- Pergunta sobre uma obra específica => detalhar com filtro "contem" (coluna * se não souber a coluna).
- Pergunta de continuação ("e quais são?", "e em tal bairro?") => reaproveite o plano anterior e ajuste.
- Se não tiver relação com a planilha => {"operacao":"fora_do_escopo"}.
Plano anterior: ${anterior ? JSON.stringify(anterior) : "nenhum"}`;
  const texto = await chamarIAbruta([
    { role: "system", content: sistema },
    { role: "user", content: `${conversa ? `Conversa recente:\n${conversa}\n\n` : ""}Pergunta: ${pergunta}` },
  ], { max_tokens: 800, temperature: 0 });
  return extrairJSON(texto);
}

// Busca de segurança: ranking por palavras. Tenta primeiro só nas colunas-chave
// (objeto, bairro, empresa, status…) e só depois em todas as células.
const RE_CHAVE = /objeto|obra|rua|bairro|localidade|endereco|empresa|status|situacao|contrato/;
function buscaLivre(pergunta, linhas) {
  const ts = tokens(pergunta);
  if (!ts.length) return [];
  const minimo = Math.max(1, Math.ceil(ts.length / 2));
  const rank = (soChave) => linhas.map((l) => {
    const txt = norm(Object.entries(l).filter(([c]) => !colunaInterna(c) && (!soChave || RE_CHAVE.test(norm(c)))).map(([, v]) => v).join(" "));
    return { l, s: ts.reduce((a, t) => a + (txt.includes(t) ? 1 : 0), 0) };
  }).filter((x) => x.s >= minimo).sort((a, b) => b.s - a.s).map((x) => x.l);
  const a = rank(true);
  return a.length ? a : rank(false);
}

// ------------------------------------------------------------
// Categorias: cada aba é um universo separado. Obras, projetos,
// licitações, pavimentação e pendências NUNCA são misturados.
// ------------------------------------------------------------
const CATEGORIAS = {
  obra: { rotulo: "obras contratadas/em andamento", nome: "obra(s)" },
  licitacao: { rotulo: "licitações", nome: "licitação(ões)" },
  projeto: { rotulo: "projetos", nome: "projeto(s)" },
  pavimentacao: { rotulo: "pavimentação de ruas", nome: "rua(s)" },
  pendencia: { rotulo: "pendências", nome: "pendência(s)" },
  recurso_proprio: { rotulo: "recursos próprios a pagar", nome: "registro(s)" },
  outros: { rotulo: "outras abas", nome: "registro(s)" },
};

function categoriaDaAba(aba = "") {
  const a = norm(aba);
  if (/licit/.test(a)) return "licitacao";
  if (/projet/.test(a)) return "projeto";
  if (/paviment|calcament/.test(a)) return "pavimentacao";
  if (/pendenc/.test(a)) return "pendencia";
  if (/andamento|obra|contrat/.test(a)) return "obra";
  return "outros";
}

// Aba sem nome claro (ex.: Sheet6): a aba inteira é classificada pelo conteúdo.
const categoriaAbaCache = new WeakMap();
function mapaCategorias(linhas) {
  if (categoriaAbaCache.has(linhas)) return categoriaAbaCache.get(linhas);
  const mapa = new Map();
  for (const l of linhas) {
    if (mapa.get(l._aba) === "recurso_proprio") continue;
    let c = categoriaDaAba(l._aba);
    if (c === "outros") {
      const txt = norm(Object.keys(l).join(" ") + " " + Object.values(l).join(" "));
      if (/recursos? propri|a serem pagos|contrapartida/.test(txt)) c = "recurso_proprio";
    }
    if (!mapa.has(l._aba) || c !== "outros") mapa.set(l._aba, c);
  }
  categoriaAbaCache.set(linhas, mapa);
  return mapa;
}
function categoriaDaLinha(l, linhas) {
  return linhas ? mapaCategorias(linhas).get(l._aba) : categoriaDaAba(l._aba);
}

// Pergunta de "obras" com status: inclui a pavimentação (onde "EXECUTADA" = concluída).
function categoriasDaConsulta(p, categoria) {
  if (!OBRAS_COM_PAV || categoria !== "obra") return [categoria];
  const q = norm(p);
  return statusDaPergunta(q).length && !/\bpaviment|\bruas?\b/.test(q) ? ["obra", "pavimentacao"] : [categoria];
}

function categoriaDaPergunta(p, anterior) {
  const q = norm(p);
  if (/\bpendenc/.test(q)) return "pendencia";
  if (/\blicita|\bedital|\bhomolog|\bhabilita|\bproposta analisada|\bpregao|\bcertame/.test(q)) return "licitacao";
  if (/\bprojeto/.test(q)) return "projeto";
  if (/\bpaviment|\bcalcament|\basfalt|\bmeio[ -]fio|\bruas?\b.*\bpaviment|\bm2\b|\bm²/.test(q)) return "pavimentacao";
  if (/recursos? propri.*(pagar|pago)|a serem pagos|contrapartida/.test(q)) return "recurso_proprio";
  if (/\bobras?\b|\bcontrato|\baditivo|\breajuste|\bexecutad|\bsaldo devedor|\bempresa/.test(q)) return "obra";
  return anterior || "obra";
}

// ------------------------------------------------------------
// Redação final pela IA: explica a resposta em linguagem simples e
// organiza para WhatsApp. A IA NÃO pode mudar números: se algum número
// da resposta calculada sumir ou aparecer um novo, usamos a original.
// ------------------------------------------------------------
const REDIGIR = process.env.AGENTE_REDIGIR !== "false";
// Ignora a numeração de listas ("1.", "2.") — só compara dados reais.
const numerosDe = (t) => (String(t).replace(/^\s*\d+[.)]\s/gm, "").match(/\d[\d.,]*/g) || [])
  .map((n) => n.replace(/[.,]+$/, ""));

async function redigirParaWhatsApp(pergunta, respostaBase, categoria) {
  if (!REDIGIR) return respostaBase;
  const partes = respostaBase.split("\n");
  const cabecalho = partes[0], corpo = partes.slice(1).join("\n");
  // Lista/detalhe: a IA só reescreve a frase de abertura; a lista calculada é mantida INTACTA.
  const soCabecalho = corpo !== "" && /^Encontrei \*\d+\* registro\(s\).*:\s*$/.test(cabecalho);
  if (corpo !== "" && !soCabecalho) return respostaBase;
  const alvo = soCabecalho ? cabecalho : respostaBase;
  const sistema = `Você é o assistente de obras da Prefeitura de Mamanguape no WhatsApp.
Reescreva a FRASE CALCULADA para o cidadão, de forma clara e educada, em no máximo 2 frases curtas, sem listas.
Regras OBRIGATÓRIAS:
- Use SOMENTE os dados da frase calculada. Não invente, não arredonde, não some, não omita números, nomes ou valores.
- Copie números e valores em R$ exatamente como estão.
- Formatação de WhatsApp: *negrito*, _itálico_. NÃO use markdown (#, **, tabelas, links).
- No máximo 1 emoji discreto (📍 🏗️ 💰 📋 ✅ ⏳). Máximo de 400 caracteres.${soCabecalho ? "\n- A frase deve terminar com dois-pontos (:), pois a lista vem logo abaixo." : ""}`;
  try {
    const texto = await chamarIAbruta([
      { role: "system", content: sistema },
      { role: "user", content: `Pergunta: ${pergunta}\n\nFRASE CALCULADA (${CATEGORIAS[categoria]?.rotulo || "planilha"}):\n${alvo}` },
    ], { max_tokens: 300, temperature: 0.2 });
    let final = String(texto || "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "").trim();
    if (!final) return respostaBase;
    if (!/[.!?:)*_\p{Extended_Pictographic}]$/u.test(final)) { console.warn("AGENTE: redação cortada, descartada."); return respostaBase; }
    const antes = new Set(numerosDe(alvo)), depois = new Set(numerosDe(final));
    const perdeu = [...antes].some((n) => !depois.has(n));
    const inventou = [...depois].some((n) => !antes.has(n) && n.length > 1);
    if (perdeu || inventou) {
      console.warn("AGENTE: redação descartada (números divergentes).");
      return respostaBase;
    }
    if (soCabecalho) { final = final.replace(/[:.!\s]*$/, "") + ":"; return `${final.slice(0, 500)}\n${corpo}`.slice(0, 3900); }
    return final.slice(0, 3900);
  } catch (e) {
    console.error("AGENTE: falha na redação:", e.message);
    return respostaBase;
  }
}

// ------------------------------------------------------------
// Planejador local "geral": entende operação, coluna de valor, agrupamento
// e filtros (status, valores citados, palavras do nome/bairro/empresa)
// sem depender da IA. Usado quando a IA falha ou devolve plano inválido.
// ------------------------------------------------------------
function colunaValorDaPergunta(p, cat) {
  const nums = cat.colunas.filter((c) => c.numerica);
  const acha = (re) => nums.find((c) => re.test(norm(c.nome)))?.nome;
  if (/\bsaldo/.test(p)) return acha(/saldo/);
  if (/\bpag[oa]s?\b|\bpagamento/.test(p)) return acha(/^valor pago$/) || acha(/pago/);
  if (/\bexecutad[oa] (em )?(r\$|valor)|\bvalor executado/.test(p)) return acha(/valor executado/);
  if (/\binvestid|\bgast[oa]|\bexecutad[oa]\b/.test(p)) return acha(/^valor executado/);
  if (/\baditiv/.test(p)) return acha(/aditivo/);
  if (/\breajuste/.test(p)) return acha(/reajuste/);
  if (/%|percentual|porcentagem|execucao fisica/.test(p)) return acha(/% de execucao|% executada|%/);
  if (/\bm2\b|\bm²|\bmetr|\barea\b|\bextensao/.test(p)) return acha(/m2|m²|metr|area|extensao/);
  return acha(RE_VTOTAL) || acha(/^valor( |$)|valor \(r\$\)/) || acha(/valor/);
}
function colunaGrupoDaPergunta(p, cat) {
  const m = p.match(/\b(?:por|cada|separad[oa]s? por|agrupad[oa]s? por|ranking (?:d[oa]s?|por)|quais (?:os |as )?)\s*(bairro|empresa|status|situacao|recurso|fonte|engenheiro|tipo|aba|localidade|ano)/);
  if (!m) return null;
  const alvo = { situacao: "status", fonte: "recurso", localidade: "bairro" }[m[1]] || m[1];
  if (alvo === "status" && cat.colunas.some((c) => c.nome === COL_PADRAO)) return COL_PADRAO;
  if (alvo === "aba") return "_aba";
  return acharColuna(cat, alvo);
}
function planoGeral(pergunta, cat, linhas) {
  const p = norm(pergunta);
  const temPadrao = cat.colunas.some((c) => c.nome === COL_PADRAO);
  const filtros = [];
  const sts = temPadrao ? statusDaPergunta(p) : [];
  if (sts.length) filtros.push({ coluna: COL_PADRAO, op: "igual", valor: sts });
  for (const c of cat.colunas.filter((x) => x.categorica && x.nome !== COL_PADRAO && !ehColStatus(x.nome))) {
    const achados = c.distintos.filter((v) => { const n = norm(v); return n.length >= 4 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`).test(p); });
    if (achados.length) filtros.push({ coluna: c.nome, op: "igual", valor: achados });
  }
  // Palavras que sobram (ex.: "passagem molhada", "ubs areal") viram filtro de texto.
  const palavrasOp = /^(soma|somar|total|valor|valores|media|maior|menor|mais|menos|caro|cara|barato|barata|quantidade|numero|cada|separado|agrupado|investido|gasto|custou|pago|paga|saldo|devedor|aditivo|aditivos|reajuste|percentual|porcentagem|bairro|bairros|empresa|empresas|recurso|engenheiro|tipo|ano|prazo|data|inicio|termino|conclu|executad|paralis|andamento|iniciad|stand)/;
  const jaUsado = norm(filtros.flatMap((f) => f.valor).join(" "));
  const livres = tokens(p).filter((t) => t.length >= 3 && !palavrasOp.test(t) && !jaUsado.includes(t));
  if (livres.length) {
    const casaTodos = (l) => { const txt = norm(Object.entries(l).filter(([c]) => !colunaInterna(c) && RE_CHAVE.test(norm(c))).map(([, v]) => v).join(" ")); return livres.every((t) => txt.includes(t)); };
    if (linhas.some(casaTodos)) livres.forEach((t) => filtros.push({ coluna: "*", op: "contem", valor: t }));
  }
  let operacao = "listar", coluna_valor = null, agrupar_por = colunaGrupoDaPergunta(p, cat), ordem = null;
  if (agrupar_por) operacao = "agrupar";
  else if (/\b(quantas|quantos|quantidade|numero de|total de obras)\b/.test(p) && !/\b(valor|reais|r\$|custa|custou|investid)/.test(p)) operacao = "contar";
  else if (/\bmedia\b/.test(p)) operacao = "media";
  else if (/\b(maior|mais car[oa]|mais alt[oa]|mais valios|top)\b/.test(p)) operacao = "maior";
  else if (/\b(menor|mais barat[oa]|mais baix[oa])\b/.test(p)) operacao = "menor";
  else if (/\b(soma|somar|valor total|valor (investid|gast|pag|executad)\w*|total (investido|gasto|pago)|quanto (foi|se|ja|custou|custaram|investiu|pagou|gastou)|quanto (de|em) dinheiro|montante)\b/.test(p)) operacao = "somar";
  else if (livres.length && filtros.some((f) => f.coluna === "*") && !pedeTodas(p)) operacao = "detalhar";
  if (["somar", "media", "maior", "menor", "agrupar"].includes(operacao)) coluna_valor = colunaValorDaPergunta(p, cat);
  if (operacao === "agrupar" && !/\b(valor|soma|reais|r\$|investid)/.test(p)) coluna_valor = null;
  if (!filtros.length && operacao === "listar" && !pedeTodas(p)) return null;
  const descricao = [...filtros.filter((f) => f.coluna !== "*").map((f) => [].concat(f.valor).join("/")), livres.length && filtros.some((f) => f.coluna === "*") ? livres.join(" ") : ""].filter(Boolean).join(", ");
  return { operacao, filtros, coluna_valor, agrupar_por, ordem, descricao };
}

// Validação do plano da IA: descarta colunas inexistentes em vez de falhar.
function validarPlano(plano, cat) {
  const OPS = ["listar", "contar", "somar", "media", "maior", "menor", "agrupar", "detalhar", "fora_do_escopo"];
  if (!plano || typeof plano !== "object" || !OPS.includes(plano.operacao)) return null;
  plano.filtros = (Array.isArray(plano.filtros) ? plano.filtros : []).filter((f) => f && (f.coluna === "*" || acharColuna(cat, f.coluna) || f.coluna === COL_PADRAO) && (["vazio", "preenchido"].includes(f.op) || !vazio(f.valor)));
  if (["somar", "media", "maior", "menor"].includes(plano.operacao) && !acharColuna(cat, plano.coluna_valor)) return null;
  if (plano.operacao === "agrupar" && !acharColuna(cat, plano.agrupar_por)) return null;
  return plano;
}

// Última saída: a IA lê as linhas relevantes (resumidas) e responde direto.
async function respostaLivreIA(pergunta, historico, linhas, rotulo) {
  const base = (buscaLivre(pergunta, linhas).length ? buscaLivre(pergunta, linhas) : linhas).slice(0, 60);
  const cols = (l) => Object.entries(l).filter(([c, v]) => !colunaInterna(c) && !vazio(v) && !/latitude|longitude|link/.test(norm(c)))
    .map(([c, v]) => `${rotuloColuna(c)}=${fmtCelula(c, v)}`).join("; ");
  let dados = "";
  for (const l of base) { const t = `- ${cols(l)}\n`; if (dados.length + t.length > 14000) break; dados += t; }
  const conversa = historico.slice(-4).map((m) => `${m.role === "user" ? "Usuário" : "Bot"}: ${String(m.content || "").slice(0, 300)}`).join("\n");
  const texto = await chamarIAbruta([
    { role: "system", content: `Você é o assistente da planilha de obras de Mamanguape. Responda em português, curto e claro, formatado para WhatsApp (use *negrito*, listas com •). Use SOMENTE os dados abaixo (${rotulo}). Não invente números nem obras. Se a resposta não estiver nos dados, diga isso e sugira como perguntar.\n\nDADOS (${base.length} de ${linhas.length} registros):\n${dados}` },
    { role: "user", content: `${conversa ? `Conversa recente:\n${conversa}\n\n` : ""}Pergunta: ${pergunta}` },
  ], { max_tokens: 900, temperature: 0.1 });
  return String(texto || "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "").trim().slice(0, 3900);
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
  const hist = Array.isArray(historico) ? historico : [];
  const catAnterior = [...hist].reverse().find((m) => m?.role === "assistant" && m.estado?.categoria)?.estado?.categoria;
  const categoria = categoriaDaPergunta(texto, catAnterior);
  const categoriasBusca = categoriasDaConsulta(texto, categoria);
  const rotulo = categoriasBusca.length > 1 ? "obras e pavimentação" : CATEGORIAS[categoria].rotulo;
  const { universo, brutas } = montarUniverso(linhas, categoriasBusca);
  if (!universo.length) return { resposta: `Não encontrei dados de ${rotulo} na planilha.`, modoAgente: "categoria_vazia", estado: { categoria } };

  // Licitações têm dois campos de análise diferentes: pergunta qual antes.
  const pn = norm(texto);
  if (categoria === "licitacao" && /\bnao\b[\s\S]{0,40}\banalisad|\banalisad[\s\S]{0,40}\bnao\b/.test(pn) && !/propost|habilit/.test(pn))
    return { resposta: "Você quer as licitações com *proposta* não analisada ou com *habilitação* não analisada?", modoAgente: "clarificacao", estado: { categoria } };

  const cat = montarCatalogo(universo);

  let plano = planoLocal(texto, cat), modo = "regra_local";
  if (!plano) {
    try { plano = await planoIA(texto, hist, cat, categoria, rotulo); modo = "plano_ia"; }
    catch (e) { console.error("AGENTE: IA indisponível:", e.message); plano = null; }
    plano = validarPlano(plano, cat);
    if (!plano) { const g = planoGeral(texto, cat, universo); if (g) { plano = g; modo = "regra_geral"; } }
    // IA falhou ou ignorou o status pedido: usa o plano local por status.
    const fraco = planoLocalFraco(texto, cat);
    const iaUsaStatus = (plano?.filtros || []).some((f) => /status|situacao/.test(norm(f.coluna || "")));
    if (fraco && (!plano || plano.operacao === "fora_do_escopo" || !iaUsaStatus)) { plano = fraco; modo = "regra_local_status"; }
  }
  if (plano && plano.operacao !== "fora_do_escopo") {
    if (pedeSoNomes(texto)) { plano.soNomes = true; if (["detalhar", "listar"].includes(plano.operacao)) plano.operacao = "listar"; }
    // "todas as obras concluídas" é lista, não detalhe de 1 obra.
    if (plano.operacao === "detalhar" && pedeTodas(texto)) plano.operacao = "listar";
  }

  if (plano?.operacao === "fora_do_escopo")
    return { resposta: "Só consigo responder sobre as informações da planilha de obras, projetos, licitações, pavimentação e pendências. O que você quer saber?", modoAgente: "fora_do_escopo" };

  let res = plano ? executarPlano(plano, universo, cat) : null;

  // Nada encontrado: busca por palavras DENTRO da mesma categoria.
  const filtraStatus = (plano?.filtros || []).some((f) => /status|situacao/.test(norm(f.coluna || "")));
  if (!res || (res.total === 0 && ["listar", "detalhar", "contar"].includes(plano?.operacao) && !filtraStatus)) {
    const achadas = buscaLivre(texto, universo);
    if (achadas.length) {
      plano = { operacao: achadas.length <= 3 && !pedeTodas(texto) ? "detalhar" : "listar", filtros: [], descricao: "busca por palavras — resultado aproximado", soNomes: pedeSoNomes(texto) };
      res = { op: plano.operacao, filtradas: achadas, total: achadas.length };
      modo = "busca_livre";
    }
  }
  if (!res || res.total === 0) {
    // Nada deu certo pelos cálculos: a IA lê os dados e responde direto.
    try {
      const livre = await respostaLivreIA(texto, hist, universo, rotulo);
      if (livre) return { resposta: livre, modoAgente: "ia_com_dados", estado: { categoria } };
    } catch (e) { console.error("AGENTE: falha na resposta livre:", e.message); }
    if (!res) return { resposta: `Não achei isso na planilha de ${rotulo}. Tente citar o nome da obra, o bairro, a empresa ou o status.`, modoAgente: "sem_plano", estado: { categoria } };
  }
  plano.descricao = [rotulo, plano.descricao].filter(Boolean).join(" — ");

  const respostaBase = formatar(res, plano, cat);
  const resposta = await redigirParaWhatsApp(texto, respostaBase, categoria);
  return {
    resposta,
    linhas: res.total,
    modoAgente: modo,
    estado: { plano, categoria },
    resposta_calculada: respostaBase,
    diagnostico: { categoria, plano, registros_na_categoria: universo.length, linhas_brutas: brutas, duplicadas_removidas: brutas - universo.length, categorias: categoriasBusca, total_planilha: linhas.length, ms: Date.now() - inicio },
  };
}

// Exportado para testes.
export const _interno = { planoGeral, validarPlano, planoLocalFraco, pedeSoNomes, pedeTodas, deduplicar, statusPadrao, padronizarStatus, statusDaPergunta, montarUniverso, avisosQualidade, totaisLista, fmtValor, montarCatalogo, executarPlano, planoLocal, paraNumero, formatar, buscaLivre, numerosDe, redigirParaWhatsApp, categoriaDaPergunta, categoriaDaLinha };
