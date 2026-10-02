// ============================================================
// agente.js - SQL AGENT CONVERSACIONAL + SELF-HEALING + CONTEXTO FORTE + RESPOSTAS HUMANAS (Node.js) - V13.5
// ============================================================
// Arquitetura baseada em duas referencias usadas no projeto:
// 1) Conversational SQL Agent: schema/view + SQL dinamico + memoria de conversa.
// 2) SQL Query Engine: geracao -> execucao -> reparo com erro real do PostgreSQL,
//    early-accept e best-result tracking.
//
// IMPORTANTE:
// - Continua dentro do projeto Node atual.
// - Nao exige Python, FastAPI ou LangChain.
// - Mantem a mesma exportacao: responderPergunta(pergunta, historico).
// - Usa db.js (queryReadOnly) e groq.js (chamarIAbruta) existentes.
// - A IA pode gerar SQL, mas o Node valida e o PostgreSQL executa READ ONLY.
// - Arquero valida/inspeciona o conjunto retornado e Decimal.js recalcula valores monetarios com precisao.
// - Dependencias novas: npm install arquero decimal.js
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js";
import * as aq from "arquero";
import Decimal from "decimal.js";

const MAX_REPAROS = Math.max(0, Math.min(Number(process.env.AGENTE_MAX_REPAROS || 2), 4));
const MAX_RESULTADOS = Math.max(20, Math.min(Number(process.env.AGENTE_MAX_RESULTADOS || 200), 500));
const MAX_LINHAS_PARA_IA = Math.max(10, Math.min(Number(process.env.AGENTE_MAX_LINHAS_IA || 60), 100));
const CACHE_SCHEMA_MS = Math.max(60_000, Math.min(Number(process.env.AGENTE_CACHE_SCHEMA_MS || 300_000), 30 * 60_000));
const MAX_HISTORICO_PROMPT = 6;

let cacheSchema = { quando: 0, contexto: null };

// ------------------------------------------------------------
// Utilitarios
// ------------------------------------------------------------
function normalizar(s = "") {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function textoSeguro(s = "", max = 1200) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}


// ------------------------------------------------------------
// Camada local de analise/validacao (Arquero + Decimal.js)
// ------------------------------------------------------------
// O PostgreSQL continua sendo a fonte de verdade e fazendo os filtros pesados.
// Esta camada confere o resultado retornado ANTES de a IA redigir a resposta.
// Assim contagens nao sao confundidas com dinheiro e somas podem ser validadas
// com aritmetica decimal exata, sem depender de ponto flutuante do JavaScript.
function decimalSeguro(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (Decimal.isDecimal?.(valor)) return valor;

  let s = String(valor).trim();
  if (!s) return null;
  s = s.replace(/\s+/g, "").replace(/^R\$/i, "");

  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirgula && temPonto) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // 1.234.567,89
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // 1,234,567.89
      s = s.replace(/,/g, "");
    }
  } else if (temVirgula) {
    // 1234,56
    s = s.replace(",", ".");
  }

  s = s.replace(/[^0-9eE+\-.]/g, "");
  if (!s || !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null;

  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function formatarDecimalBR(valor, casas = 2, moeda = false) {
  const d = decimalSeguro(valor);
  if (!d) return null;
  const fixo = d.toFixed(casas);
  const negativo = fixo.startsWith("-");
  const base = negativo ? fixo.slice(1) : fixo;
  const [inteiro, frac = ""] = base.split(".");
  const agrupado = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const numero = `${negativo ? "-" : ""}${agrupado}${casas > 0 ? `,${frac}` : ""}`;
  return moeda ? `R$ ${numero}` : numero;
}

function campoPareceMonetario(campo = "") {
  const k = normalizar(campo).replace(/\s+/g, "_");
  return /(?:^|_)(valor|investimento|investido|gasto|gastos|custo|custos|saldo|preco|montante|reajuste|aditivo|contrapartida|pago|pagamento)(?:_|$)/.test(k) ||
    /valor|invest|gasto|custo|saldo|preco|montante|reajuste|aditivo|contrapartida|pago/.test(k);
}

function campoPareceContagem(campo = "") {
  const k = normalizar(campo).replace(/\s+/g, "_");
  if (campoPareceMonetario(k) || /percent|media|taxa|indice/.test(k)) return false;

  if (/^(?:count|contagem|quantidade|qtd|numero)(?:_|$)/.test(k)) return true;
  if (/(?:^|_)(?:count|contagem|quantidade|qtd)(?:_|$)/.test(k)) return true;
  return /^total_(?:obras?|projetos?|licitacoes?|registros?|encontrados?|itens?|contratos?|engenheiros?|responsaveis?|empresas?|bairros?)$/.test(k);
}

function limiteDaSQL(sql = "") {
  const m = String(sql || "").match(/\blimit\s+(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

function aliasesAgregadosDaSQL(sql = "") {
  const encontrados = [];
  const rx = /\b(sum|avg)\s*\(\s*(?:[a-zA-Z_][\w$]*\.)?"?([a-zA-Z_][\w$]*)"?\s*\)\s*(over\s*\([^)]*\))?\s+as\s+"?([a-zA-Z_][\w$]*)"?/gi;
  let m;
  while ((m = rx.exec(String(sql || "")))) {
    encontrados.push({ funcao: m[1].toLowerCase(), origem: m[2], janela: !!m[3], alias: m[4] });
  }
  return encontrados;
}

function analisarResultadoDados(pergunta = "", sql = "", rows = []) {
  const lista = Array.isArray(rows) ? rows : [];
  const tabela = aq.from(lista);
  const linhas = tabela.numRows();
  const colunas = tabela.columnNames();
  const objetos = tabela.objects();

  const analise = {
    motor: "Arquero + Decimal.js",
    linhas,
    colunas,
    conjunto_completo: null,
    contagens: {},
    agregados_validados: [],
    avisos: [],
  };

  if (!linhas) return analise;

  // Contagens retornadas pelo SQL (COUNT, total_encontrados etc.).
  for (const coluna of colunas.filter(campoPareceContagem)) {
    const vals = objetos.map((r) => decimalSeguro(r?.[coluna])).filter(Boolean);
    const unicos = [...new Set(vals.map((d) => d.toString()))];
    if (!unicos.length) continue;

    analise.contagens[coluna] = unicos.length === 1 ? unicos[0] : unicos;
    if (unicos.length > 1) {
      analise.avisos.push(`A contagem ${coluna} veio com valores diferentes entre as linhas.`);
      continue;
    }

    const total = new Decimal(unicos[0]);
    if (total.lt(linhas)) {
      analise.avisos.push(`A contagem ${coluna} (${total.toString()}) e menor que as ${linhas} linhas retornadas.`);
    }
    if (/total_encontrados|total_registros|total_obras|total_projetos|total_licitacoes/i.test(coluna)) {
      analise.conjunto_completo = total.eq(linhas);
    }
  }

  // Se nao houver total_encontrados, usamos o LIMIT para saber se o conjunto
  // certamente terminou antes do limite. Se bateu exatamente no LIMIT, tratamos
  // como potencialmente parcial e nao validamos soma pelo subconjunto.
  if (analise.conjunto_completo === null) {
    const limite = limiteDaSQL(sql);
    analise.conjunto_completo = limite === null ? true : linhas < limite;
  }

  // Recalcula SUM/AVG quando a propria consulta retornou a coluna componente.
  // Decimal.js evita erros do tipo 0.1 + 0.2 e preserva valores financeiros.
  for (const agg of aliasesAgregadosDaSQL(sql)) {
    if (!colunas.includes(agg.origem) || !colunas.includes(agg.alias)) continue;
    if (!analise.conjunto_completo) continue;

    const componentes = objetos.map((r) => decimalSeguro(r?.[agg.origem])).filter(Boolean);
    const reportados = objetos.map((r) => decimalSeguro(r?.[agg.alias])).filter(Boolean);
    if (!componentes.length || !reportados.length) continue;

    const unicosReportados = [...new Set(reportados.map((d) => d.toString()))];
    // Para window aggregate, todas as linhas devem carregar o mesmo total/media.
    if (agg.janela && unicosReportados.length !== 1) {
      analise.avisos.push(`O agregado ${agg.alias} nao veio consistente entre as linhas.`);
      continue;
    }

    let recalculado = componentes.reduce((acc, d) => acc.plus(d), new Decimal(0));
    if (agg.funcao === "avg") recalculado = recalculado.div(componentes.length);
    const reportado = reportados[0];
    const ok = recalculado.eq(reportado);

    analise.agregados_validados.push({
      alias: agg.alias,
      funcao: agg.funcao,
      origem: agg.origem,
      reportado: reportado.toString(),
      recalculado: recalculado.toString(),
      ok,
    });
    if (!ok) {
      analise.avisos.push(`Divergencia em ${agg.alias}: SQL=${reportado.toString()} e recalculo=${recalculado.toString()}.`);
    }
  }

  return analise;
}

function respostaNumericaDiretaSegura(pergunta = "", rows = [], analise = null) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0] || {};
  if (r.objeto) return null;

  const p = normalizar(pergunta);
  const pedeDinheiro = /\b(valor|valores|investid|investimento|gasto|gastos|custo|custos|saldo|quanto foi|quanto e|quanto é)\b/.test(p);
  if (!pedeDinheiro) return null;

  const candidatos = Object.entries(r)
    .filter(([k, v]) => campoPareceMonetario(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ({ campo: k, valor: decimalSeguro(v) }))
    .filter((x) => x.valor);

  if (!candidatos.length) return null;
  const preferidos = candidatos.filter((x) => /total|invest|soma|saldo|gasto|custo/.test(normalizar(x.campo)));
  const escolhido = preferidos.length === 1 ? preferidos[0] : candidatos.length === 1 ? candidatos[0] : null;
  if (!escolhido) return null;

  const fmt = formatarDecimalBR(escolhido.valor, 2, true);
  if (!fmt) return null;

  const temAviso = Array.isArray(analise?.avisos) && analise.avisos.length > 0;
  if (temAviso) return null; // deixa a IA/fallback explicar em vez de mascarar divergencia.
  return `O valor total correspondente a esses critérios é ${fmt}.`;
}

function respostaSocial(pergunta = "", historico = []) {
  const p = normalizar(pergunta);
  const temConversaAtiva = Array.isArray(historico) && historico.some((m) =>
    m && m.memoriaResumo !== true && textoSeguro(m.content || "", 120).length > 0
  );

  // Saudacoes curtas nunca devem virar SQL. Aceita variacoes naturais como
  // "oi", "oii", "oiii", "oie", "olaa", alem de bom dia/tarde/noite.
  if (/^(?:o+i+|oie+|ola+|opa+|e ai+|bom dia+|boa tarde+|boa noite+)[!.? ]*$/.test(p)) {
    return temConversaAtiva
      ? "Olá novamente! Como posso ajudar?"
      : "Olá! Como posso ajudar? Pode me perguntar sobre obras, projetos, licitações, valores, responsáveis, recursos e andamento.";
  }

  if (/^(?:muito )?(?:obrigad[oa]|obg|obgd|valeu|vlw|show|blz|beleza|agradecido)[!.? ]*$/.test(p)) {
    return "Por nada! Se precisar de mais alguma informação, é só chamar.";
  }

  if (/^(?:tchau|ate mais|até mais|falou|era so isso|era só isso|por hoje e so|por hoje é só)[!.? ]*$/.test(p)) {
    return "Até mais! Quando precisar, pode chamar.";
  }

  return null;
}

// Perguntas genericas sobre "licitacoes nao analisadas" sao ambiguas na base:
// existem campos separados para PROPOSTA ANALISADA e HABILITACAO ANALISADA.
// Nesses casos, o sistema pede a dimensao correta ANTES de deixar a IA gerar SQL.
function respostaAmbiguidadeAnaliseLicitacao(pergunta = "") {
  const p = normalizar(pergunta);
  const falaDeLicitacao = /\blicita(?:cao|coes)\b/.test(p);
  const falaDeNaoAnalisada = /\bnao\b[\s\S]{0,40}\banalisad/.test(p) || /\banalisad[\s\S]{0,40}\bnao\b/.test(p);
  const especificouProposta = /\bpropost/.test(p);
  const especificouHabilitacao = /\bhabilit/.test(p);

  if (falaDeLicitacao && falaDeNaoAnalisada && !especificouProposta && !especificouHabilitacao) {
    return "Você quer as propostas não analisadas ou as habilitações não analisadas?";
  }
  return null;
}


// Estes dois campos pertencem ao universo de LICITACOES, nao ao de obras.
// Para evitar que a IA escolha tipo_negocio='obra' por engano, o Node monta
// diretamente a consulta quando a pergunta cita explicitamente proposta ou
// habilitacao + analisada/nao analisada.
//
// Isso nao substitui o agente SQL geral. E apenas um mapeamento semantico de
// campos reais da planilha para garantir que a pergunta use a categoria certa.
function sqlAnaliseLicitacao(pergunta = "", ctx = null) {
  const p = normalizar(pergunta);
  const falaDeAnalise = /\banalisad/.test(p);
  if (!falaDeAnalise) return null;

  const proposta = /\bpropost/.test(p);
  const habilitacao = /\bhabilit/.test(p);
  if (!proposta && !habilitacao) return null;

  const querNao =
    /\bnao\b[\s\S]{0,40}\banalisad/.test(p) ||
    /\banalisad[\s\S]{0,40}\bnao\b/.test(p);

  const chave = proposta ? "PROPOSTA ANALISADA" : "HABILITAÇÃO ANALISADA";
  const alias = proposta ? "proposta_analisada" : "habilitacao_analisada";
  const relacao = ctx?.relacao || "obras_chatbot";

  // A planilha usa Sim/Nao. Aceitamos "Não" e "Nao" para tolerar eventual
  // normalizacao futura dos dados.
  const condicao = querNao
    ? `LOWER(BTRIM(COALESCE(dados_extras->>'${chave}', ''))) IN ('não','nao')`
    : `LOWER(BTRIM(COALESCE(dados_extras->>'${chave}', ''))) = 'sim'`;

  return `
    SELECT
      id,
      objeto,
      tipo_negocio,
      status,
      status_original,
      engenheiro,
      recurso,
      tipo_recurso,
      dados_extras->>'${chave}' AS ${alias},
      COUNT(*) OVER()::int AS total_registros
    FROM public.${relacao}
    WHERE tipo_negocio = 'licitacao'
      AND ${condicao}
    ORDER BY objeto
  `.trim();
}

function jsonSeguro(valor, max = 12_000) {
  try {
    const t = JSON.stringify(valor, (_k, v) => {
      if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
      return v;
    });
    return t.length > max ? t.slice(0, max) + "…" : t;
  } catch {
    return "[]";
  }
}

function resumoHistorico(historico = []) {
  if (!Array.isArray(historico) || !historico.length) return "(sem conversa anterior)";

  // A memoria persistente pode trazer um resumo compacto dos turnos antigos.
  // Ele sempre entra no prompt, mesmo quando existem muitas mensagens recentes.
  const resumoPersistente = historico.find((m) => m?.memoriaResumo === true) || null;
  const recentes = historico.filter((m) => m?.memoriaResumo !== true).slice(-MAX_HISTORICO_PROMPT);
  const itens = resumoPersistente ? [resumoPersistente, ...recentes] : recentes;

  return itens.map((m) => {
    const papel = m?.memoriaResumo ? "MEMORIA_RESUMIDA" : (m?.role === "assistant" ? "ASSISTENTE" : "USUARIO");
    const conteudo = textoSeguro(m?.content || "", m?.memoriaResumo ? 1200 : 420);
    const sql = !m?.memoriaResumo && m?.role === "assistant" && m?.sql ? `\nSQL_ANTERIOR: ${textoSeguro(m.sql, 800)}` : "";
    const estado = m?.estado ? `\nESTADO_ANTERIOR: ${jsonSeguro(m.estado, 800)}` : "";
    return `${papel}: ${conteudo}${sql}${estado}`;
  }).join("\n\n");
}

function ultimaConsultaConfirmada(historico = []) {
  if (!Array.isArray(historico) || !historico.length) return "";
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m?.role !== "assistant") continue;
    const sql = textoSeguro(m?.sql || m?.estado?.sql || "", 4000);
    if (sql) return limparSQL(sql);
  }
  return "";
}

function ancoraContextoRecente(historico = []) {
  const sql = ultimaConsultaConfirmada(historico);
  if (!sql) return "(sem recorte anterior)";
  return `ULTIMA CONSULTA/RECORTE CONFIRMADO:\n${textoSeguro(sql, 1800)}\n` +
    `REGRA DE CONTINUIDADE: se a pergunta atual NAO nomear claramente um novo universo, alvo ou filtro incompatível, preserve o mesmo recorte/filtros desta consulta. Pedir outro campo, valor, recurso, status, quantidade ou perguntar "quais" NAO reinicia o assunto.`;
}

// Follow-ups extremamente curtos, como "quais são?", dependem integralmente do
// recorte anterior. Nesses casos nao deixamos a preservacao do WHERE apenas a
// cargo da IA: o Node reaplica deterministicamente o WHERE da ultima consulta.
function followUpSomenteReferencia(pergunta = "") {
  const p = normalizar(pergunta);
  return /^(?:e\s+)?(?:quais(?:\s+sao)?|quem(?:\s+sao)?|qual(?:\s+e)?)[?.! ]*$/.test(p);
}

function extrairWhereSimples(sql = "") {
  const s = limparSQL(sql);
  const m = s.match(/\bwhere\b\s+([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\blimit\b|\boffset\b|$)/i);
  return m?.[1]?.trim() || "";
}

function substituirWhereSimples(sql = "", novoWhere = "") {
  const s = limparSQL(sql);
  if (!s || !novoWhere) return s;

  const rxWhere = /\bwhere\b\s+[\s\S]*?(?=\bgroup\s+by\b|\border\s+by\b|\blimit\b|\boffset\b|$)/i;
  if (rxWhere.test(s)) return s.replace(rxWhere, `WHERE ${novoWhere} `).trim();

  const pos = s.search(/\b(group\s+by|order\s+by|limit|offset)\b/i);
  if (pos >= 0) return `${s.slice(0, pos).trim()} WHERE ${novoWhere} ${s.slice(pos).trim()}`.trim();
  return `${s} WHERE ${novoWhere}`.trim();
}

function preservarRecorteFollowUp(pergunta = "", historico = [], sqlAtual = "") {
  if (!followUpSomenteReferencia(pergunta)) return limparSQL(sqlAtual);

  const sqlAnterior = ultimaConsultaConfirmada(historico);
  if (!sqlAnterior) return limparSQL(sqlAtual);

  const whereAnterior = extrairWhereSimples(sqlAnterior);
  if (!whereAnterior) return limparSQL(sqlAtual);

  // Mantem o SELECT/projecao que a IA escolheu para responder ao novo pedido,
  // mas restaura o conjunto de registros confirmado no turno anterior.
  return substituirWhereSimples(sqlAtual, whereAnterior);
}

function ultimaPerguntaUsuario(historico = []) {
  if (!Array.isArray(historico)) return "";
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m?.role !== "user" || m?.memoriaResumo === true) continue;
    const conteudo = textoSeguro(m?.content || "", 1200);
    if (conteudo) return conteudo;
  }
  return "";
}

// Resolve apenas universos inequívocos pelas regras de negocio. Se o usuario
// citar mais de um universo na mesma pergunta, deixa a IA montar a combinacao.
function universoNegocioDaPergunta(pergunta = "") {
  const p = normalizar(pergunta);
  if (!p) return null;

  const falaObra = /\bobras?\b/.test(p);
  const falaProjeto = /\bprojetos?\b/.test(p);
  const falaLicitacao = /\blicita(?:cao|coes)\b/.test(p);
  const universosExplicitos = [falaObra, falaProjeto, falaLicitacao].filter(Boolean).length;

  if (universosExplicitos > 1) return null;
  if (falaLicitacao) return "licitacao";
  if (falaProjeto) return "projeto";
  if (falaObra) return "obra";

  // Regra oficial do projeto: alvos fisicos, sem projeto/licitacao explicitos,
  // pertencem ao universo de obras.
  const alvoFisico = /\b(ubs|unidade basica de saude|posto de saude|psf|escola|creche|praca|mercado|campo|drenagem|quadra|pavimentacao|rua)\b/.test(p);
  return alvoFisico ? "obra" : null;
}

function adicionarCondicaoWhere(sql = "", condicao = "") {
  const s = limparSQL(sql);
  if (!s || !condicao) return s;

  const whereAtual = extrairWhereSimples(s);
  if (whereAtual) return substituirWhereSimples(s, `(${condicao}) AND (${whereAtual})`);

  const pos = s.search(/\b(group\s+by|order\s+by|limit|offset)\b/i);
  if (pos >= 0) return `${s.slice(0, pos).trim()} WHERE ${condicao} ${s.slice(pos).trim()}`.trim();
  return `${s} WHERE ${condicao}`.trim();
}

function garantirUniversoNegocio(pergunta = "", historico = [], sqlAtual = "") {
  const perguntaBase = followUpSomenteReferencia(pergunta)
    ? ultimaPerguntaUsuario(historico)
    : pergunta;
  const esperado = universoNegocioDaPergunta(perguntaBase);
  let s = limparSQL(sqlAtual);
  if (!esperado || !s) return s;

  // Se ja existe um filtro simples tipo_negocio='...', corrige eventual universo
  // errado. Consultas que usam IN/OR deliberadamente ficam intocadas.
  const rxIgual = /((?:\b[a-zA-Z_][\w$]*\.)?tipo_negocio\s*=\s*)'([^']+)'/i;
  const m = s.match(rxIgual);
  if (m) {
    if (normalizar(m[2]) === esperado) return s;
    return s.replace(rxIgual, `$1'${esperado}'`);
  }

  if (/\btipo_negocio\b/i.test(s)) return s;
  return adicionarCondicaoWhere(s, `tipo_negocio = '${esperado}'`);
}


function pedidoAreaTematicaAmpla(pergunta = "") {
  const p = normalizar(pergunta);
  if (!p) return false;

  const universoExplicito = /\b(obras?|projetos?|licita(?:cao|coes))\b/.test(p);
  if (universoExplicito) return false;

  const falaDeArea = /\barea\s+(?:da|do|de)?\s*[a-z0-9]/.test(p);
  const pedidoAmplo = /\b(registros?|dados|informacoes?|itens?|cadastros?|geral|em geral|tudo|todos|todas)\b/.test(p) ||
    /\b(fala|fale|mostra|mostre|liste|quais|o que tem|o que existe)\b/.test(p);

  return falaDeArea && pedidoAmplo;
}

function consultaRestringeTipoNegocio(sql = "") {
  const s = String(sql || "");
  return /\btipo_negocio\s*=\s*'[^']+'/i.test(s) ||
    /\btipo_negocio\s+in\s*\([^)]*\)/i.test(s);
}

// Detecta um erro semantico comum em perguntas por AREA/TEMA: a IA ve um valor
// real em "recurso" com o mesmo nome do tema e reduz todo o assunto a esse
// campo. Ex.: "obras da educacao" -> recurso='EDUCACAO', deixando de fora
// escolas/creches financiadas por outra fonte.
//
// A deteccao e GENERICA: nao possui lista de areas. Ela so dispara quando a
// pergunta pede um conjunto e a SQL usa recurso/tipo_recurso como igualdade,
// sem que o usuario tenha pedido explicitamente uma fonte de recurso. A IA e
// chamada novamente para decidir, com base no catalogo real, se a expressao e
// tema/area ou de fato uma fonte/programa de financiamento.
function consultaPossivelmenteConfundeTemaComRecurso(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  const s = String(sql || "");
  if (!p || !s) return false;

  const pedeConjunto = /\b(obras?|projetos?|licita(?:cao|coes)|registros?|dados|itens?|cadastros?)\b/.test(p);
  if (!pedeConjunto) return false;

  // Se o usuario falou explicitamente de recurso/fonte/financiamento, a
  // igualdade em recurso pode ser exatamente o que ele quer.
  const pediuFonte = /\b(recurso|recursos|fonte|fontes|financiamento|financiada|financiadas|financiado|financiados|convenio|convenios|emenda|emendas|repasse|repasses)\b/.test(p);
  if (pediuFonte) return false;

  return /\b(?:recurso|tipo_recurso)\s*=\s*'[^']+'/i.test(s);
}


function referenciaPessoaRecente(historico = [], pergunta = "") {
  const p = normalizar(pergunta);
  const dependeDePessoa = /\b(ele|ela|dele|dela|esse engenheiro|essa engenheira|esse arquiteto|essa arquiteta|esse responsavel|essa responsavel)\b/.test(p);
  if (!dependeDePessoa || !Array.isArray(historico)) return null;

  // Procura o ultimo responsavel citado naturalmente na conversa.
  // E generico: nao guarda nomes fixos e nao persiste nada no banco.
  const rx = /\b((?:Eng\.?|Arq\.?)\s+[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇ][A-Za-zÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇáàâãéèêíïóôõöúç]+(?:\s+[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇ][A-Za-zÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇáàâãéèêíïóôõöúç]+){1,4})\b/g;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (!m?.content) continue;
    const encontrados = [...String(m.content).matchAll(rx)];
    if (encontrados.length) return encontrados[encontrados.length - 1][1];
  }
  return null;
}

function contextoReferenciaPessoa(historico = [], pergunta = "") {
  const pessoa = referenciaPessoaRecente(historico, pergunta);
  if (!pessoa) return "(nenhuma referencia pessoal recente)";
  return `REFERENCIA PESSOAL RECENTE: ${pessoa}\nREGRA: pronomes como ele/ela/dele/dela apontam para essa pessoa ate que o usuario nomeie outra. Se pedir \"em geral\", remova filtros de status/andamento do assunto anterior, mas MANTENHA o filtro dessa pessoa.`;
}

function referenciaPessoaPerdida(pergunta = "", historico = [], sql = "") {
  const pessoa = referenciaPessoaRecente(historico, pergunta);
  if (!pessoa) return null;
  const p = normalizar(pergunta);
  const pedeConjuntoDaPessoa = /\b(obras?|projetos?|licitacoes?|registros?)\b/.test(p);
  if (!pedeConjuntoDaPessoa) return null;
  const s = normalizar(sql);
  const nomeSemTitulo = normalizar(pessoa.replace(/^(eng\.?|arq\.?)\s*/i, ""));
  const preservou = /\bengenheiro\b/.test(s) && (s.includes(normalizar(pessoa)) || s.includes(nomeSemTitulo));
  return preservou ? null : pessoa;
}

function consultaAgregadaSeca(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  const s = String(sql || "");
  const pedeMedida = /\b(valor|valores|investid|investimento|gasto|gastos|custo|custos|soma|somar|media|média|executado|executada|saldo)\b/.test(p);
  if (!pedeMedida) return false;
  const temAgregado = /\b(?:sum|avg)\s*\(/i.test(s);
  const jaDetalha = /\bover\s*\(/i.test(s) || /\bgroup\s+by\b/i.test(s) || /\bobjeto\b/i.test(s);
  return temAgregado && !jaDetalha;
}

function existencialComLimitUm(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  const perguntaExistencial = /\b(existe|existem|ha|tem algum|tem alguma|tem alguns|tem algumas)\b/.test(p);
  return perguntaExistencial && /\blimit\s+1\b/i.test(String(sql || ""));
}

function existencialComAgregadoSeco(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  const s = String(sql || "");
  const perguntaExistencial = /\b(existe|existem|ha|tem algum|tem alguma|tem alguns|tem algumas)\b/.test(p);
  const conta = /\bcount\s*\(/i.test(s);
  const trazNomes = /\bobjeto\b/i.test(s);
  return perguntaExistencial && conta && !trazNomes;
}


function contagemComAgregadoSeco(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  const s = String(sql || "");
  const pedeContagem = /\b(quantos?|quantas?|quantidade|numero de|n[uú]mero de)\b/.test(p);
  const conta = /\bcount\s*\(/i.test(s);
  const trazNomes = /\bobjeto\b/i.test(s);
  return pedeContagem && conta && !trazNomes;
}

function stripThink(texto = "") {
  return String(texto || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Corrige rankings para valores vazios (NULL) nunca ganharem o topo.
// No PostgreSQL, "ORDER BY campo DESC" coloca NULL PRIMEIRO por padrao - entao
// "a obra mais avancada" acabava pegando uma obra SEM percentual preenchido.
// Aqui garantimos NULLS LAST em todo ORDER BY que nao declare explicitamente,
// e, quando ha LIMIT pequeno (ranking do tipo "o maior/o mais avancado"),
// tambem descartamos linhas cujo campo ordenado esteja vazio.
function corrigirOrdenacaoNula(sql = "") {
  let s = sql;

  // 1) Todo "ORDER BY <expr> ASC|DESC" sem NULLS ... ganha "NULLS LAST".
  //    (cobre um ou varios campos separados por virgula)
  s = s.replace(/order\s+by\s+([\s\S]+?)(\blimit\b|\boffset\b|\)|\s*$)/i, (todo, campos, fim) => {
    const partes = campos.split(",").map((parte) => {
      const t = parte.trim();
      if (!t) return t;
      if (/nulls\s+(first|last)/i.test(t)) return t; // ja declarado, respeita
      return `${t} NULLS LAST`;
    });
    return `ORDER BY ${partes.join(", ")}${fim ? (/^\s/.test(fim) ? fim : " " + fim) : ""}`;
  });

  return s;
}

function limparSQL(sql = "") {
  const base = stripThink(sql)
    .replace(/```sql/gi, "")
    .replace(/```/g, "")
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  return corrigirOrdenacaoNula(base);
}

// ------------------------------------------------------------
// Parser multi-estrategia (equivalente ao parser do PDF)
// ------------------------------------------------------------
function objetoJSONEmTexto(texto = "") {
  const t = stripThink(texto).trim();
  try {
    const direto = JSON.parse(t);
    if (direto && typeof direto === "object") return direto;
  } catch {}

  const ini = t.indexOf("{");
  const fim = t.lastIndexOf("}");
  if (ini >= 0 && fim > ini) {
    try {
      const embutido = JSON.parse(t.slice(ini, fim + 1));
      if (embutido && typeof embutido === "object") return embutido;
    } catch {}
  }
  return null;
}

function extrairSQLDaResposta(texto = "") {
  const t = stripThink(texto).trim();
  if (!t) return { query: "", descricao: "" };

  // 1) JSON direto / 2) JSON embutido
  const obj = objetoJSONEmTexto(t);
  if (obj) {
    const q = obj.query ?? obj.sql ?? obj.fixedQuery ?? obj.fixed_query ?? obj.corrigida ?? obj.consulta;
    if (q) {
      return {
        query: limparSQL(q),
        descricao: textoSeguro(obj.description ?? obj.descricao ?? obj.observation ?? obj.observacao ?? "", 700),
        modifiedUserPrompt: textoSeguro(obj.modifiedUserPrompt ?? obj.modified_user_prompt ?? "", 700),
      };
    }
  }

  // 3) bloco ```sql
  const bloco = t.match(/```sql\s*([\s\S]*?)```/i) || t.match(/```\s*([\s\S]*?)```/i);
  if (bloco?.[1]) return { query: limparSQL(bloco[1]), descricao: "" };

  // 4) SELECT/WITH encontrado no texto
  const m = t.match(/\b(?:SELECT|WITH)\b[\s\S]*/i);
  if (m?.[0]) return { query: limparSQL(m[0]), descricao: "" };

  // 5) texto cru
  if (/^(select|with)\b/i.test(t)) return { query: limparSQL(t), descricao: "" };
  return { query: "", descricao: "" };
}

// ------------------------------------------------------------
// Introspeccao automatica do schema + view preferencial
// ------------------------------------------------------------
async function relacaoPreferida() {
  const r = await queryReadOnly(`
    SELECT
      to_regclass('public.obras_chatbot')::text AS view_chatbot,
      to_regclass('public.obras')::text AS tabela_obras
  `);
  const row = r.rows?.[0] || {};
  if (row.view_chatbot) return "obras_chatbot";
  if (row.tabela_obras) return "obras";
  throw new Error("Nao encontrei public.obras_chatbot nem public.obras no PostgreSQL.");
}

async function carregarSchemaContexto() {
  const agora = Date.now();
  if (cacheSchema.contexto && agora - cacheSchema.quando < CACHE_SCHEMA_MS) return cacheSchema.contexto;

  const relacao = await relacaoPreferida();
  const colunasR = await queryReadOnly(`
    SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position
  `, [relacao]);

  const colunas = colunasR.rows || [];
  if (!colunas.length) throw new Error(`A relacao public.${relacao} existe, mas nao consegui ler suas colunas.`);

  const nomes = new Set(colunas.map((c) => c.column_name));
  // Uma unica linha de amostra e suficiente para mostrar formatos sem gastar TPM.
  const amostraR = await queryReadOnly(`SELECT * FROM public.${relacao} LIMIT 1`);
  const amostras = amostraR.rows || [];

  // Catalogo de objetos reais: ajuda a IA a fazer schema/data linking sem
  // depender de uma lista fixa de sinonimos escrita no JavaScript.
  // Ex.: a propria base pode conter um registro com "UBS" e outro com
  // "Posto de Saude"; o modelo passa a enxergar ambos antes de montar a SQL.
  let objetosCatalogo = [];
  if (nomes.has("objeto")) {
    try {
      const extras = [
        nomes.has("tipo_negocio") ? "tipo_negocio" : null,
        nomes.has("bairro") ? "bairro" : null,
        nomes.has("categoria") ? "categoria" : null,
        nomes.has("recurso") ? "recurso" : null,
        nomes.has("tipo_recurso") ? "tipo_recurso" : null,
        nomes.has("aba_origem") ? "aba_origem" : null,
      ].filter(Boolean);
      const campos = ["objeto", ...extras].join(", ");
      const rr = await queryReadOnly(
        `SELECT DISTINCT ${campos} FROM public.${relacao} WHERE objeto IS NOT NULL AND BTRIM(objeto::text) <> '' ORDER BY objeto LIMIT 120`
      );
      objetosCatalogo = rr.rows || [];
    } catch {
      objetosCatalogo = [];
    }
  }

  // Catalogo das chaves JSON reais. Isso e essencial para campos que variam por aba
  // e nao merecem virar uma coluna fixa na view (ex.: "DATA DE ENVIO", etapas de
  // licitacao, numeros de proposta etc.). O agente passa a descobrir esses campos
  // pelo schema/dados, em vez de confundir um nome parecido com uma coluna canonica.
  let chavesDadosExtras = [];
  if (nomes.has("dados_extras")) {
    try {
      const rr = await queryReadOnly(
        `SELECT DISTINCT jsonb_object_keys(COALESCE(dados_extras, '{}'::jsonb)) AS chave ` +
        `FROM public.${relacao} ORDER BY chave LIMIT 180`
      );
      chavesDadosExtras = (rr.rows || []).map((x) => x.chave).filter(Boolean);
    } catch {
      chavesDadosExtras = [];
    }
  }

  const categorias = {};
  const camposDistintos = ["tipo_negocio", "subtipo_negocio", "status", "status_original", "bairro", "engenheiro", "empresa", "recurso", "tipo_recurso", "aba_origem"]
    .filter((c) => nomes.has(c));

  for (const campo of camposDistintos) {
    try {
      const rr = await queryReadOnly(
        `SELECT DISTINCT ${campo}::text AS valor FROM public.${relacao} WHERE ${campo} IS NOT NULL AND BTRIM(${campo}::text) <> '' ORDER BY valor LIMIT 40`
      );
      categorias[campo] = (rr.rows || []).map((x) => x.valor).filter(Boolean);
    } catch {
      categorias[campo] = [];
    }
  }

  const contexto = {
    relacao,
    colunas,
    amostras,
    categorias,
    objetosCatalogo,
    chavesDadosExtras,
    temViewSemantica: relacao === "obras_chatbot",
  };
  cacheSchema = { quando: agora, contexto };
  return contexto;
}

function schemaParaPrompt(ctx) {
  const colunas = ctx.colunas
    .map((c) => `- ${c.column_name}: ${c.data_type}${c.udt_name && c.udt_name !== c.data_type ? ` (${c.udt_name})` : ""}`)
    .join("\n");

  // Mantem somente os valores de negocio mais uteis e limita cada lista.
  // Isso reduz TPM sem esconder do agente os valores reais importantes.
  const valores = Object.entries(ctx.categorias || {})
    .filter(([, arr]) => arr?.length)
    .map(([k, arr]) => `- ${k}: ${arr.slice(0, 24).join(" | ")}`)
    .join("\n");

  const objetos = (ctx.objetosCatalogo || []).slice(0, 100).map((r) => {
    const partes = [];
    if (r.tipo_negocio) partes.push(r.tipo_negocio);
    partes.push(r.objeto);
    if (r.categoria) partes.push(`categoria=${r.categoria}`);
    if (r.recurso) partes.push(`recurso=${r.recurso}`);
    if (r.tipo_recurso) partes.push(`tipo_recurso=${r.tipo_recurso}`);
    if (r.aba_origem) partes.push(`aba=${r.aba_origem}`);
    if (r.bairro) partes.push(`bairro=${r.bairro}`);
    return `- ${partes.join(" | ")}`;
  }).join("\n");

  const chavesExtras = (ctx.chavesDadosExtras || []).slice(0, 180).join(" | ");

  return `RELACAO AUTORIZADA: public.${ctx.relacao}\n\nCOLUNAS REAIS:\n${colunas}` +
    `\n\nCHAVES REAIS DE dados_extras (JSONB):\n${chavesExtras || "(nenhuma coletada)"}` +
    `\n\nVALORES REAIS IMPORTANTES:\n${valores || "(nao coletados)"}` +
    `\n\nCATALOGO DE OBJETOS REAIS (use para ligacao semantica; nao invente nomes):\n${objetos || "(nao coletado)"}` +
    `\n\nUMA AMOSTRA DE FORMATO:\n${jsonSeguro(ctx.amostras, 2500)}`;
}

function regrasNegocio(ctx) {
  if (ctx.temViewSemantica) {
    return `REGRAS DE NEGOCIO DA VIEW:\n` +
      `- Use SOMENTE public.obras_chatbot.\n` +
      `- tipo_negocio='obra' representa as obras fisicas e pavimentacoes do chatbot.\n` +
      `- tipo_negocio='projeto' representa somente projetos.\n` +
      `- tipo_negocio='licitacao' representa somente licitacoes.\n` +
      `- subtipo_negocio='pavimentacao' identifica especificamente pavimentacoes.\n` +
      `- Para 'obras em andamento', use tipo_negocio='obra' AND em_andamento_obra = true.\n` +
      `- 'concluido' e um booleano normalizado quando existir.\n` +
      `- recurso e tipo_recurso SAO conceitos diferentes. Nunca substitua um pelo outro.\n` +
      `- UBS, escola, creche, praca, mercado, campo, drenagem, quadra, rua etc. sao assuntos/alvos no objeto. Se o usuario nao disser projeto ou licitacao, trate esses alvos como obras.\n` +
      `- Dados como status, valores, engenheiro e empresa sao mutaveis: sempre leia o banco atual.\n`;
  }
  return `REGRAS DE NEGOCIO DA TABELA LEGADA:\n` +
    `- Use SOMENTE public.obras.\n` +
    `- 'obras' = aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO').\n` +
    `- 'projetos' = aba_origem='EM_PROJETO'.\n` +
    `- 'licitacoes' = aba_origem='EM_LICITAÇÃO'.\n` +
    `- 'pavimentacoes' = aba_origem='PAVIMENTAÇÃO'.\n` +
    `- 'obras em andamento' inclui EM_ANDAMENTO com status de andamento E PAVIMENTAÇÃO com status de execucao/andamento.\n` +
    `- UBS, escola, creche, praca, mercado, campo, drenagem, quadra, rua etc. sao assuntos do objeto; sem projeto/licitacao explicitos, procure somente no universo de obras.\n` +
    `- recurso e tipo de recurso podem estar em dados_extras e nao devem ser confundidos.\n` +
    `- RANKING/EXTREMOS ("mais avancada", "maior", "menor", "mais caro", "menos executado"): ` +
    `ao ordenar por percentual_executado, valor_total, valor_executado etc., use sempre ` +
    `"ORDER BY campo DESC NULLS LAST" (ou ASC NULLS LAST) e adicione "AND campo IS NOT NULL" ` +
    `no WHERE, para que obras com o valor vazio NUNCA ganhem o topo do ranking.\n`;
}

// ------------------------------------------------------------
// Geracao SQL (estagio 1)
// ------------------------------------------------------------
async function gerarSQL(pergunta, historico, ctx, correcao = "") {
  const prompt = `Voce e um SQL AGENT especializado em PostgreSQL para um chatbot de obras publicas.\n` +
    `Transforme a pergunta do usuario em UMA consulta SQL que responda exatamente ao pedido.\n\n` +
    `${regrasNegocio(ctx)}\n` +
    `REGRAS DE CONVERSA:\n` +
    `- Use o historico para resolver 'essas', 'delas', 'dele', 'qual delas', 'e o valor?', 'e quem cuida?' etc.\n` +
    `- Follow-up deve preservar o RECORTE anterior, mesmo que a consulta imediatamente anterior tenha apenas projetado/agrupado um campo.\n` +
    `- Perguntar um NOVO CAMPO ou MEDIDA do conjunto atual (valor, recurso, status, responsavel, contrato, data, percentual, etc.) NAO e um novo assunto. Preserve os filtros WHERE do recorte anterior.\n` +
    `- Se o conjunto atual for, por exemplo, projetos concluidos e o usuario perguntar se eles tem valor, consulte ESSES projetos concluidos. Se nenhum tiver valor, retorne 0 linhas/resultado vazio correto; NAO amplie para todas as obras so para achar dados.\n` +
    `- Um novo alvo explicito no turno atual substitui contexto incompatível anterior.\n` +
    `- Se o usuario disser 'em geral/no total', remova filtros de status/andamento herdados quando eles apenas limitavam o conjunto anterior, mas preserve entidades explicitamente referenciadas, principalmente a pessoa apontada por ele/ela/dele/dela.\n` +
    `- PRONOME DE PESSOA: se a resposta anterior identificou um engenheiro/arquiteto e o usuario perguntar 'ela tem quantas obras em geral?', 'quais obras ela tem?', 'e os projetos dele?' etc., filtre pelo mesmo engenheiro/responsavel. Nunca transforme isso em contagem de toda a base.\n\n` +
    `REGRAS SQL:\n` +
    `- Apenas SELECT ou WITH ... SELECT. Nunca escreva dados.\n` +
    `- Consulte SOMENTE public.${ctx.relacao}.\n` +
    `- Nao consulte information_schema, pg_catalog, auth, storage ou outras tabelas.\n` +
    `- Prefira agregacoes SQL reais (COUNT, SUM, AVG, GROUP BY, ORDER BY) quando a pergunta pedir calculo/ranking.\n` +
    `- SOMA/MEDIA EXPLICAVEL: quando somar ou calcular media de um conjunto e houver nomes/valores por registro, prefira retornar a composicao junto do agregado, por exemplo objeto + valor_total + SUM(valor_total) OVER () AS total_investido. Assim a resposta consegue explicar de onde saiu o total.\n` +
    `- EXISTENCIA/ALGUM: perguntas do tipo "existe/tem algum" NAO devem ser respondidas escolhendo um registro arbitrario com LIMIT 1. Use COUNT, agrupamento por tipo_negocio ou liste o conjunto real. Se nao houver universo claro nem recorte anterior, resuma por tipo_negocio em vez de escolher um item ao acaso.\n` +
    `- Para 'quais engenheiros dessas obras?', se o usuario quer apenas a lista de nomes, SELECT DISTINCT engenheiro e valido; se ele pedir quem e responsavel por cada obra, retorne objeto + engenheiro.\n` +
    `- FOLLOW-UP DE CAMPO SOBRE UM CONJUNTO: quando o usuario perguntar 'quais os recursos?', 'quais os status?', 'quais os engenheiros?', 'quais os contratos?' etc. sobre varios registros ja em contexto, prefira UMA LINHA POR REGISTRO com objeto + campo pedido. So use DISTINCT campo sozinho quando ele pedir explicitamente valores unicos/diferentes ou apenas os nomes sem associar a cada registro.\n` +
    `- RECURSOS: quando a pergunta envolver recurso de obras/projetos/licitacoes e as colunas existirem, retorne objeto, recurso e tipo_recurso. Esses campos tem significados diferentes e a resposta deve manter a associacao de cada registro.\n` +
    `- ANALISE DE LICITACAO: "proposta analisada/nao analisada" refere-se EXCLUSIVAMENTE a chave dados_extras->>'PROPOSTA ANALISADA'. "habilitacao analisada/nao analisada" refere-se EXCLUSIVAMENTE a dados_extras->>'HABILITAÇÃO ANALISADA' (ou a chave real equivalente exibida no schema). Esses campos pertencem SEMPRE a tipo_negocio='licitacao'; NUNCA use tipo_negocio='obra' ou 'projeto' para perguntas de proposta/habilitacao analisada. NUNCA deduza esses conceitos por status ou status_original.\n` +
    `- Para valor Sim/Nao desses campos de analise, compare o valor da chave diretamente (aceitando variacao de acento/caixa quando necessario). Nao use status_original NOT ILIKE '%analis%' como substituto.\n` +
    `- CAMPO LIVRE/JSONB: se o usuario pedir um campo especifico que NAO exista como coluna canonica, procure o nome correspondente nas CHAVES REAIS DE dados_extras. Quando houver correspondencia clara, leia a chave exata com dados_extras->>'CHAVE' e use um alias legivel.\n` +
    `- NUNCA substitua um campo pedido por outro apenas porque o nome parece parecido. Uma data especifica, etapa, numero, observacao ou indicador pode viver em dados_extras e NAO significa automaticamente data_inicio, data_prev_termino ou outro campo canonico.\n` +
    `- Se houver coluna canonica E chave JSON com sentidos diferentes, preserve a semantica pedida pelo usuario e escolha a fonte que corresponde ao nome/conceito solicitado.\n` +
    `- Para 'valor total investido' de um conjunto, some valor_total, salvo quando o usuario pedir explicitamente valor executado/pago.\n` +
    `- Para 'quanto falta', use valor_total - valor_executado quando essas colunas existirem.\n` +
    `- 'status de X' pede o campo status do alvo X; nao transforme a palavra status em filtro.\n` +
    `- LICITACOES E ETAPA REAL: ao listar/detalhar licitacoes ou responder sobre seu status, se a coluna status_original existir selecione status_original junto de status. status_original representa a etapa especifica cadastrada (ex.: Habilitacao em andamento, Edital publicado) e deve ser preferida na resposta ao rotulo generico 'Em licitacao'.\n` +
    `- Nao invente valores de status, nomes, bairros, engenheiros ou empresas; use os valores reais do schema/contexto.\n` +
    `- LIGACAO SEMANTICA: quando o usuario pedir uma CLASSE ou CONCEITO amplo (sigla, tipo de equipamento, servico ou categoria), nao filtre apenas a palavra literal. Considere abreviacoes, forma por extenso e sinonimos realmente equivalentes em portugues e compare com o CATALOGO DE OBJETOS REAIS. Use OR com ILIKE apenas para equivalencias semanticamente justificadas.\n` +
    `- AREAS TEMATICAS (qualquer area/assunto): NAO use uma lista fixa de palavras. Descubra dinamicamente pelos registros REAIS do catalogo e pelos campos objeto, categoria, recurso, tipo_recurso, aba_origem e dados_extras quando houver evidencia semantica clara de que o registro pertence ao tema pedido. Uma nova planilha pode trazer tipos de equipamentos/servicos que nunca apareceram antes; eles devem ser considerados se os dados reais mostrarem claramente a relacao. Nao inclua registros apenas por associacao vaga e nunca invente nomes.\n` +
    `- TEMA NAO E RECURSO: quando o usuario disser algo como "obras da/de/do X" e X representar uma area/tema, NAO transforme isso automaticamente em recurso='X' ou tipo_recurso='X' so porque esse valor existe na base. O campo recurso descreve a fonte/origem do dinheiro e pode ser diferente do tema da obra. Para area/tema, examine primeiro o OBJETO e o CATALOGO DE OBJETOS REAIS, usando categoria/dados_extras e recurso apenas como evidencias complementares. So filtre por recurso/tipo_recurso como criterio principal quando o usuario pedir explicitamente recurso, fonte, financiamento, convenio, emenda ou quando X for claramente uma fonte/programa de financiamento.\n` +
    `- COBERTURA TEMATICA: em uma pergunta por tema, inclua TODOS os registros do universo pedido que o catalogo real mostre pertencer claramente ao tema, mesmo que tenham fontes de recurso diferentes. Monte OR apenas com equivalencias/objetos realmente presentes no catalogo; nao use uma lista fixa escrita no codigo e nao invente sinonimos sem apoio dos dados.\n` +
    `- REGISTROS DE UMA AREA: se o usuario pedir "registros", "dados", "informacoes" ou perguntar de forma ampla o que existe em uma area, e NAO disser explicitamente obras/projetos/licitacoes, pesquise TODOS os tipos de negocio e registros auxiliares relacionados ao tema. Nao aplique tipo_negocio='obra' por padrao. Se disser "obras da area X", ai sim restrinja a obras; o mesmo vale para projetos e licitacoes.\n` +
    `- Para alvo proprio/especifico (nome de bairro, rua, equipamento com nome proprio), seja conservador: nao expanda para conceitos diferentes.\n` +
    `- Em busca ampla por assunto, voce pode procurar em objeto, categoria e dados_extras::text quando essas colunas existirem; mantenha o tipo_negocio correto.\n` +
    `- Se um termo livre puder ser nome parcial, use ILIKE/LOWER de forma tolerante.\n` +
    `- Retorne colunas suficientes para responder, mas nao SELECT * sem necessidade.\n` +
    `- Retorne SOMENTE JSON {"description":"...","query":"SELECT ..."}. Se nao puder responder com o schema, use query="".\n\n` +
    `SCHEMA E DADOS REAIS:\n${schemaParaPrompt(ctx)}\n\n` +
    `HISTORICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `ANCORA DO CONTEXTO ATUAL:\n${ancoraContextoRecente(historico)}\n\n` +
    `REFERENCIA DE PESSOA NO CONTEXTO:\n${contextoReferenciaPessoa(historico, pergunta)}\n\n` +
    `REFERENCIA DE PESSOA NO CONTEXTO:\n${contextoReferenciaPessoa(historico, pergunta)}\n\n` +
    (correcao ? `CONTEXTO DE CORRECAO: ${correcao}\n\n` : "") +
    `PERGUNTA ATUAL: ${JSON.stringify(pergunta)}`;

  const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
    max_tokens: 420,
    temperature: 0,
    reasoning_effort: "low",
  });
  return extrairSQLDaResposta(bruto);
}

// ------------------------------------------------------------
// Guardrail SQL
// ------------------------------------------------------------
const PALAVRAS_PROIBIDAS = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|copy|call|execute|vacuum|analyze|refresh|reindex|cluster|comment|security|set\s+role|set\s+session)\b/i;
const FUNCOES_PROIBIDAS = /\b(pg_sleep|dblink|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|current_setting\s*\(|set_config\s*\()/i;
const SCHEMAS_PROIBIDOS = /\b(information_schema|pg_catalog|pg_toast|auth\.|storage\.|vault\.|extensions\.)/i;

function aliasesCTE(sql = "") {
  const set = new Set();
  const rx = /(?:\bwith\b|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
  let m;
  while ((m = rx.exec(sql))) set.add(m[1].toLowerCase());
  return set;
}

function relacoesReferenciadas(sql = "") {
  const refs = [];
  const rx = /\b(?:from|join)\s+(?!\()((?:"?[a-zA-Z_][\w$]*"?\.)?"?[a-zA-Z_][\w$]*"?)/gi;
  let m;
  while ((m = rx.exec(sql))) refs.push(m[1].replace(/"/g, ""));
  return refs;
}

function validarSQL(sql, ctx) {
  const s = limparSQL(sql);
  if (!s) return { ok: false, motivo: "consulta vazia" };
  if (!/^(select|with)\b/i.test(s)) return { ok: false, motivo: "somente SELECT/WITH SELECT e permitido" };
  if (PALAVRAS_PROIBIDAS.test(s)) return { ok: false, motivo: "comando de escrita/DDL bloqueado" };
  if (FUNCOES_PROIBIDAS.test(s)) return { ok: false, motivo: "funcao de sistema bloqueada" };
  if (SCHEMAS_PROIBIDOS.test(s)) return { ok: false, motivo: "schema de sistema/privado bloqueado" };

  // Um unico statement. Permite ; apenas se era terminador removido por limparSQL.
  if (s.includes(";")) return { ok: false, motivo: "multiplos statements nao sao permitidos" };

  const ctes = aliasesCTE(s);
  const permitido = ctx.relacao.toLowerCase();
  for (const refOriginal of relacoesReferenciadas(s)) {
    const ref = refOriginal.toLowerCase();
    const simples = ref.includes(".") ? ref.split(".").pop() : ref;
    if (simples === permitido || ctes.has(simples)) continue;
    return { ok: false, motivo: `relacao nao autorizada: ${refOriginal}` };
  }

  if (!relacoesReferenciadas(s).some((r) => r.toLowerCase().split(".").pop() === permitido)) {
    return { ok: false, motivo: `a consulta precisa usar public.${ctx.relacao}` };
  }

  return { ok: true, sql: s };
}

function aplicarLimite(sql) {
  const s = limparSQL(sql);
  if (/\blimit\s+\d+/i.test(s)) return s;
  return `${s}\nLIMIT ${MAX_RESULTADOS}`;
}

function diagnosticoErroPG(e) {
  return {
    tipo: e?.name || "Error",
    mensagem: textoSeguro(e?.message || String(e), 1000),
    sqlstate: e?.code || null,
    detail: textoSeguro(e?.detail || "", 800) || null,
    hint: textoSeguro(e?.hint || "", 800) || null,
    position: e?.position || null,
    where: textoSeguro(e?.where || "", 800) || null,
    schema: e?.schema || null,
    table: e?.table || null,
    column: e?.column || null,
    constraint: e?.constraint || null,
  };
}

// ------------------------------------------------------------
// Estagio 2: avaliacao e self-healing
// ------------------------------------------------------------
async function repararSQL({ pergunta, historico, ctx, sqlAtual, erro = null, linhas = [], motivoSemantico = "" }) {
  const erroTexto = erro
    ? `ERRO POSTGRESQL REAL:\n${jsonSeguro(erro, 4000)}`
    : motivoSemantico
      ? `ALERTA SEMANTICO APOS EXECUCAO:\n${motivoSemantico}\nA consulta trouxe linha(s), mas os campos que deveriam responder ao pedido vieram vazios/nulos. Verifique as CHAVES REAIS DE dados_extras e se a SQL usou um campo apenas parecido com o que o usuario pediu. Nao force um valor se o dado realmente nao existir.`
      : `A consulta executou sem erro, mas retornou 0 linhas. Isso PODE ser correto. So altere a SQL se houver um motivo concreto no schema/valores reais indicando filtro, coluna ou semantica errados. Nao force resultado nao-vazio.`;

  const prompt = `Voce e o AVALIADOR/REFINADOR de um SQL Agent PostgreSQL.\n` +
    `Sua tarefa e corrigir UMA consulta somente quando houver motivo tecnico ou semantico concreto.\n` +
    `Nunca transforme uma consulta correta em outra so para retornar dados.\n\n` +
    `${regrasNegocio(ctx)}\n` +
    `SEGURANCA: somente SELECT/WITH SELECT em public.${ctx.relacao}.\n\n` +
    `SCHEMA REAL:\n${schemaParaPrompt(ctx)}\n\n` +
    `HISTORICO:\n${resumoHistorico(historico)}\n\n` +
    `ANCORA DO CONTEXTO ATUAL:\n${ancoraContextoRecente(historico)}\n\n` +
    `IMPORTANTE: resultado vazio pode ser a resposta correta. Nunca remova filtros herdados do recorte anterior apenas para produzir linhas.\n` +
    `PERGUNTA ORIGINAL: ${JSON.stringify(pergunta)}\n` +
    `SQL ATUAL: ${sqlAtual}\n` +
    `${erroTexto}\n` +
    (linhas?.length ? `AMOSTRA DO RESULTADO: ${jsonSeguro(linhas.slice(0, 3), 3000)}\n` : "") +
    `Retorne SOMENTE JSON: {"observation":"motivo curto","fixedQuery":"SELECT ...","modifiedUserPrompt":""}.\n` +
    `Se a SQL atual deve ser mantida (por exemplo, 0 linhas e isso e plausivel), retorne fixedQuery exatamente igual a SQL atual.`;

  const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
    max_tokens: 420,
    temperature: 0,
    reasoning_effort: "low",
  });
  return extrairSQLDaResposta(bruto);
}

function resultadoSoComCamposVazios(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return false;

  // Campos que normalmente apenas identificam/localizam o registro e nao sao a
  // informacao pedida em uma consulta de campo. Se so eles tiverem valor e os
  // demais campos vierem vazios, vale uma tentativa de reparo semantico.
  const contexto = new Set([
    "id", "objeto", "bairro", "categoria", "tipo_negocio", "subtipo_negocio", "aba_origem"
  ]);

  const chavesAlvo = [...new Set(rows.flatMap((r) => Object.keys(r || {})))]
    .filter((k) => !contexto.has(k));

  // SELECT apenas de identificacao/listagem continua valido.
  if (!chavesAlvo.length) return false;

  const temAlgumValor = rows.some((r) => chavesAlvo.some((k) => {
    const v = r?.[k];
    return v !== null && v !== undefined && String(v).trim() !== "";
  }));

  return !temAlgumValor;
}

async function executarComSelfHealing({ pergunta, historico, ctx, sqlInicial }) {
  let sqlAtual = limparSQL(sqlInicial);
  let melhor = null; // melhor consulta executada (inclusive vazia)
  const tentativas = [];

  for (let tentativa = 0; tentativa <= MAX_REPAROS; tentativa++) {
    const validacao = validarSQL(sqlAtual, ctx);
    if (!validacao.ok) {
      tentativas.push({ tentativa, sql: sqlAtual, erro: `guardrail: ${validacao.motivo}` });
      if (tentativa >= MAX_REPAROS) break;
      const reparo = await repararSQL({
        pergunta,
        historico,
        ctx,
        sqlAtual,
        erro: { tipo: "GuardrailError", mensagem: validacao.motivo },
      });
      if (!reparo.query || limparSQL(reparo.query) === sqlAtual) break;
      sqlAtual = limparSQL(reparo.query);
      continue;
    }

    try {
      const sqlExecucao = aplicarLimite(validacao.sql);
      const r = await queryReadOnly(sqlExecucao);
      const rows = r.rows || [];
      const atual = { sql: validacao.sql, sqlExecucao, rows, tentativa, observacao: "executou" };
      tentativas.push({ tentativa, sql: validacao.sql, linhas: rows.length, ok: true });

      // Best-result tracking: uma execucao valida nunca e perdida.
      if (!melhor || rows.length > melhor.rows.length) melhor = atual;

      // EARLY ACCEPT com uma excecao importante: uma linha pode existir, mas o
      // campo projetado para responder ao usuario pode estar NULL. Nesse caso a
      // SQL executou tecnicamente, porem ainda pode ter escolhido o campo errado
      // (especialmente quando o dado real esta em dados_extras).
      if (rows.length > 0 && !resultadoSoComCamposVazios(rows)) {
        return { ...atual, tentativas, earlyAccept: true };
      }

      if (rows.length > 0 && resultadoSoComCamposVazios(rows)) {
        if (tentativa >= MAX_REPAROS) break;
        const reparo = await repararSQL({
          pergunta,
          historico,
          ctx,
          sqlAtual: validacao.sql,
          linhas: rows,
          motivoSemantico: "Os registros foram localizados, mas todos os campos de resposta alem dos identificadores/contexto vieram vazios. Confirme se o campo solicitado existe como chave em dados_extras e se a consulta selecionou a chave correta."
        });
        const candidata = limparSQL(reparo.query);
        if (!candidata || candidata === validacao.sql) break;
        sqlAtual = candidata;
        continue;
      }

      // Resultado vazio: pode ser correto. Faz no maximo os reparos configurados,
      // preservando esta consulta como melhor resultado caso as proximas piorem.
      if (tentativa >= MAX_REPAROS) break;
      const reparo = await repararSQL({ pergunta, historico, ctx, sqlAtual: validacao.sql, linhas: rows });
      const candidata = limparSQL(reparo.query);
      if (!candidata || candidata === validacao.sql) break;
      sqlAtual = candidata;
    } catch (e) {
      const diag = diagnosticoErroPG(e);
      tentativas.push({ tentativa, sql: validacao.sql, ok: false, erro: diag });
      if (tentativa >= MAX_REPAROS) break;
      const reparo = await repararSQL({ pergunta, historico, ctx, sqlAtual: validacao.sql, erro: diag });
      const candidata = limparSQL(reparo.query);
      if (!candidata || candidata === validacao.sql) break;
      sqlAtual = candidata;
    }
  }

  if (melhor) return { ...melhor, tentativas, earlyAccept: false, bestResult: true };
  const ultimo = tentativas[tentativas.length - 1];
  const msg = typeof ultimo?.erro === "string" ? ultimo.erro : ultimo?.erro?.mensagem;
  throw new Error(msg || "Nao foi possivel obter uma consulta valida apos as tentativas de reparo.");
}

// ------------------------------------------------------------
// Resposta natural a partir do resultado real
// ------------------------------------------------------------
function limparRespostaParaWhatsApp(texto = "") {
  let t = String(texto || "").replace(/\r/g, "").trim();
  if (!t) return t;

  // Remove separadores tipicos de tabela Markdown (|---|---| etc.).
  const linhas = t.split("\n");
  const saida = [];
  for (const linhaOriginal of linhas) {
    let linha = linhaOriginal.trim();
    if (!linha) {
      if (saida.length && saida[saida.length - 1] !== "") saida.push("");
      continue;
    }
    if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(linha)) continue;

    // Normaliza rotulos tecnicos quando vierem em negrito Markdown.
    linha = linha
      .replace(/\*\*(id|objeto)\s*:\*\*/gi, "$1:")
      .replace(/\*\*(id|objeto)\*\*\s*:/gi, "$1:");

    // Nao mostramos identificadores internos do banco.
    if (/^(?:[-•*]\s*)?id\s*:\s*[^—\-\n]+$/i.test(linha)) continue;

    // Ex.: "1. id: 3 — objeto: UBS X — recurso: FEDERAL"
    // vira "1. UBS X — Recurso: FEDERAL".
    linha = linha
      .replace(/^(\s*(?:[-•*]|\d+[.)])\s*)\**id\**\s*:\s*[^—\-\n]+(?:\s*[—-]\s*)?/i, "$1")
      .replace(/^(\s*(?:[-•*]|\d+[.)])\s*)\**objeto\**\s*:\s*/i, "$1")
      .replace(/\b\**objeto\**\s*:\s*/gi, "")
      .replace(/\b\**id\**\s*:\s*[^—\-\n]+(?:\s*[—-]\s*)?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!linha) continue;

    // Remove explicacoes tecnicas de implementacao que nao interessam ao usuario final.
    // Mantemos apenas dados de negocio: nomes, valores, status, recursos, responsaveis etc.
    if (/(?:\bSQL\b|\bSELECT\b|\bWHERE\b|\bview\s+[`'"]?obras_chatbot|\btipo_negocio\b|\bconcluido\s*=\s*true\b|\bfiltrando\s+(?:a\s+)?view\b)/i.test(linha)) continue;

    // Se a IA ainda devolver uma linha de tabela, converte para texto simples.
    if (/^\|.*\|$/.test(linha)) {
      const celulas = linha.slice(1, -1).split("|").map((x) => x.trim()).filter(Boolean);
      // Descarta coluna ID quando a primeira celula for so um numero/identificador.
      const uteis = celulas.filter((c, i) => !(i === 0 && /^\d+$/.test(c)));
      if (uteis.length) {
        saida.push(`• ${uteis.join(" — ")}`);
        continue;
      }
    }
    saida.push(linha);
  }

  t = saida.join("\n")
    // percentual_executado mede execucao, nao conclusao. Corrige uma
    // formulacao enganosa caso o redator use "X% concluido".
    .replace(/(\d+(?:[.,]\d+)?\s*%)\s*(?:conclu[ií]do|de conclus[aã]o)/gi, "$1 executado")
    // Evita a frase mecanica herdada do estilo antigo.
    .replace(/\n?\*?\s*(?:não há mais registros|nao ha mais registros|não foram encontrados outros registros|nao foram encontrados outros registros)[^\n.!?]*[.!?]?\s*\*?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return t;
}

function rotuloHumano(campo = "") {
  const mapa = {
    bairro: "Bairro",
    status: "Status",
    status_original: "Etapa/status atual",
    categoria: "Categoria",
    engenheiro: "Engenheiro",
    empresa: "Empresa",
    valor_total: "Valor total",
    valor_executado: "Valor executado",
    percentual_executado: "Percentual executado",
    recurso: "Recurso",
    tipo_recurso: "Tipo de recurso",
    contrato: "Contrato",
    convenio: "Convênio",
    aditivo: "Aditivo",
    data_envio: "Data de envio",
    data_inicio: "Data de início",
    data_prev_termino: "Previsão de término",
    quanto_falta: "Valor restante",
    saldo_devedor: "Saldo devedor",
    observacoes: "Observações",
    quantidade: "Quantidade",
  };
  return mapa[campo] || campo.replace(/_/g, " ");
}

function valorFallback(campo, valor) {
  if (valor === null || valor === undefined || valor === "") return null;

  // Decimal.js tambem e usado na formatacao final de qualquer campo monetario,
  // inclusive aliases como total_investido, soma_valores, saldo_total etc.
  if (campoPareceMonetario(campo)) {
    const fmt = formatarDecimalBR(valor, 2, true);
    if (fmt) return fmt;
  }

  if (campo === "percentual_executado") {
    const d = decimalSeguro(valor);
    if (d) return `${formatarDecimalBR(d, Math.min(2, d.decimalPlaces()), false)}%`;
  }
  return String(valor);
}

function fallbackResposta(pergunta, rows = []) {
  if (!rows.length) return "Não encontrei registros que correspondam a essa pergunta nos dados atuais.";

  const camposTecnicosOcultos = new Set(["id", "objeto"]);
  if (rows.length === 1) {
    const r = rows[0];
    const chavesVisiveis = Object.keys(r).filter((k) => k !== "id");

    // Agregacoes com uma unica coluna devem sair diretas, sem nome tecnico.
    if (chavesVisiveis.length === 1 && chavesVisiveis[0] !== "objeto") {
      return `${valorFallback(chavesVisiveis[0], r[chavesVisiveis[0]]) ?? "Não informado"}`;
    }

    const linhas = [];
    if (r.objeto) linhas.push(`• ${r.objeto}`);
    for (const [k, v] of Object.entries(r)) {
      if (camposTecnicosOcultos.has(k)) continue;
      const fmt = valorFallback(k, v);
      if (fmt === null) continue;
      linhas.push(`  ${rotuloHumano(k)}: ${fmt}`);
    }
    return linhas.join("\n") || "Encontrei o registro, mas não há detalhes adicionais informados.";
  }

  const exibidas = rows.slice(0, 20);
  const linhas = exibidas.map((r, i) => {
    const nome = r.objeto ? String(r.objeto) : null;
    const detalhes = Object.entries(r)
      .filter(([k, v]) => !camposTecnicosOcultos.has(k) && v !== null && v !== undefined && v !== "")
      .slice(0, 3)
      .map(([k, v]) => `${rotuloHumano(k)}: ${valorFallback(k, v)}`)
      .join(" — ");
    if (nome) return `${i + 1}. ${nome}${detalhes ? ` — ${detalhes}` : ""}`;
    return `${i + 1}. ${detalhes || "Registro encontrado"}`;
  });
  return `${linhas.join("\n")}${rows.length > exibidas.length ? `\n… e mais ${rows.length - exibidas.length}.` : ""}`;
}

function respostaContagemDiretaSegura(pergunta = "", rows = []) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0] || {};
  if (r.objeto) return null;
  const p = normalizar(pergunta);
  const perguntaPedeContagem = /\b(quantos?|quantas?|quantidade|numero de|n[uú]mero de)\b/.test(p);

  // IMPORTANTE: "total_investido", "valor_total" etc. NAO sao contagens.
  // Antes a regex aceitava qualquer campo iniciado por "total" e podia responder
  // "503000 registros" para uma soma em reais. O alias simples "total" so e
  // aceito quando a propria pergunta pede explicitamente uma contagem.
  const candidatos = Object.entries(r)
    .filter(([k, v]) =>
      (campoPareceContagem(k) || (perguntaPedeContagem && normalizar(k) === "total")) &&
      v !== null && v !== undefined && v !== ""
    )
    .map(([k, v]) => ({ campo: k, valor: decimalSeguro(v) }))
    .filter((x) => x.valor && x.valor.isInteger() && x.valor.gte(0));
  if (candidatos.length !== 1) return null;

  const nDecimal = candidatos[0].valor;
  if (nDecimal.gt(Number.MAX_SAFE_INTEGER)) return null;
  const n = nDecimal.toNumber();
  if (/\bobras?\b/.test(p)) return n === 1 ? "Há 1 obra que corresponde a esses critérios." : `Há ${n} obras que correspondem a esses critérios.`;
  if (/\bprojetos?\b/.test(p)) return n === 1 ? "Há 1 projeto que corresponde a esses critérios." : `Há ${n} projetos que correspondem a esses critérios.`;
  if (/\blicita(?:cao|coes)\b/.test(p)) return n === 1 ? "Há 1 licitação que corresponde a esses critérios." : `Há ${n} licitações que correspondem a esses critérios.`;
  return n === 1 ? "Encontrei 1 registro com esses critérios." : `Encontrei ${n} registros com esses critérios.`;
}

async function redigirResposta(pergunta, historico, sql, rows, ctx, analiseDados = null) {
  // Se por qualquer motivo uma consulta de contagem ainda chegar apenas com o
  // agregado, nao envia contexto insuficiente para a IA completar com nomes.
  // Isso impede alucinacao de obras/valores que nao vieram do PostgreSQL.
  const contagemSegura = respostaContagemDiretaSegura(pergunta, rows);
  if (contagemSegura) return contagemSegura;

  // Agregados monetarios de uma unica linha sao respondidos pelo proprio Node.
  // Evita que a IA transforme um valor (ex.: 503000) em quantidade de registros.
  const numericaSegura = respostaNumericaDiretaSegura(pergunta, rows, analiseDados);
  if (numericaSegura) return numericaSegura;

  const amostra = rows.slice(0, MAX_LINHAS_PARA_IA);
  const prompt = `Voce e o redator final de um chatbot de obras publicas no WhatsApp.\n` +
    `Responda APENAS com base nos dados retornados pela consulta. Nao invente, nao estime e nao corrija valores por memoria.\n` +
    `Se o resultado estiver vazio, diga claramente que nao encontrou registros com os criterios.\n` +
    `Se for contagem/soma/ranking, destaque o resultado de forma direta e depois mostre os dados que sustentam a resposta em linguagem comum. EXPLICAR significa mostrar nomes, valores, status, responsaveis ou outros detalhes uteis dos registros; NAO significa explicar como o banco foi consultado.\n` +
    `REGRA ANTI-ALUCINACAO: so cite nome, bairro, empresa, valor, contrato, status ou qualquer detalhe se esse valor estiver explicitamente em DADOS RETORNADOS. Se os dados trouxerem apenas uma contagem agregada e nenhum objeto, responda somente a contagem; NUNCA complete com exemplos, nomes ou detalhes vindos do historico/schema.\n` +
    `NUNCA mencione SQL, consulta, SELECT, WHERE, view, tabela, coluna, filtro tecnico, booleano, tipo_negocio, concluido=true ou qualquer mecanismo interno. O usuario quer o RESULTADO e os registros encontrados, nao a forma tecnica de obtencao.\n` +
    `RESPOSTAS DEVEM SER EXPLICATIVAS, nao secas: comece com uma frase curta respondendo diretamente e depois mostre os detalhes que ajudam a entender o resultado. Nao escreva apenas uma lista de valores quando os dados permitem dizer a qual obra/projeto/licitacao cada valor pertence.\n` +
    `Em perguntas existenciais como "tem algum?", "existe algum?" ou "ha algum?", se houver poucos resultados, informe a quantidade E liste os nomes encontrados. Se vierem ate 20 registros, mostre todos. Nao responda apenas com a contagem quando os nomes estiverem disponiveis.\n` +
    `Quando houver um total/soma/media acompanhado de linhas individuais, informe o agregado UMA VEZ e em seguida mostre a composicao: nome de cada registro + valor que entrou no calculo. Explique que o total resulta da soma/media desses valores, sem inventar causalidade.\n` +
    `Quando a pergunta for um follow-up e nenhum registro do RECORTE ATUAL atender ao novo criterio, diga isso explicitamente (ex.: "Nos 4 projetos concluidos, nenhum possui valor total cadastrado"). Nao troque silenciosamente para a base inteira.\n` +
    `Quando houver varios registros e a pergunta pedir um campo (recurso, status, engenheiro, empresa, contrato, valor etc.), associe o campo a CADA nome retornado. Ex.: "• Reforma da UBS do Cristo Rei — Recurso: FEDERAL — Tipo de recurso: Recurso Proprio".\n` +
    `Para recurso, se recurso e tipo_recurso vierem no resultado, explique os dois separadamente. Nunca transforme tipo_recurso em recurso nem o contrario.\n` +
    `Para licitacoes, NUNCA diga que proposta ou habilitacao foi/nao foi analisada apenas com base em status/status_original (como "Em analise de propostas"). So faca essa afirmacao quando o resultado trouxer explicitamente o campo de proposta/habilitacao analisada.\n` +
    `Quando a consulta retornar um campo vindo de dados_extras com alias legivel, responda usando o significado desse campo; nao renomeie para outro conceito parecido.\n` +
    `Se houver exatamente 2 ou mais itens, pode abrir com "Encontrei X registros nesse recorte" ou equivalente, desde que seja natural e util.\n` +
    `Se for lista grande, seja conciso e liste no maximo 20 itens, avisando se houver mais.\n` +
    `FORMATO WHATSAPP: NUNCA use tabela Markdown, pipes |, linhas --- ou cabecalho de tabela. Use lista simples com marcadores.\n` +
    `Nao finalize com frases mecanicas como "nao ha mais registros" ou "nao foram encontrados outros registros"; apenas responda o que foi pedido.\n` +
    `NUNCA mostre ID/identificador interno. NUNCA escreva o nome tecnico da coluna "objeto". Use diretamente o nome da obra/projeto/licitacao.\n` +
    `Exemplo correto: "1. Reforma e ampliacao da UBS do Cristo Rei — Recurso: FEDERAL". Exemplo proibido: "1. id: 3 — objeto: Reforma...".\n` +
    `Diferencie obra, projeto e licitacao conforme os campos da view/tabela. Se tipo_negocio='licitacao', chame os registros de licitacoes, nunca de obras.\n` +
    `Quando a pergunta pedir REGISTROS/DADOS de uma area tematica de forma ampla, nao resuma tudo como "obras e projetos". Descreva corretamente a mistura encontrada (obras, projetos, licitacoes e/ou registros auxiliares) conforme tipo_negocio e aba_origem retornados.\n` +
    `PERCENTUAL: percentual_executado e percentual de EXECUCAO. Escreva sempre 'X% executado' ou 'X% de execucao'. NUNCA escreva 'X% concluido' para uma obra que ainda esta em andamento.\n` +
    `LICITACAO: se status_original vier no resultado, use-o como etapa/status especifico da licitacao (ex.: 'Habilitacao em andamento', 'Edital publicado'). Nao esconda essa etapa atras do rotulo generico 'Em licitacao'.\n` +
    `Recurso e tipo_recurso sao campos diferentes; nao troque um pelo outro.\n` +
    `Nao mostre SQL ao usuario na resposta natural.\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n` +
    `HISTORICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `SQL EXECUTADA: ${sql}\n` +
    `TOTAL DE LINHAS RETORNADAS: ${rows.length}\n` +
    `VALIDACAO LOCAL (Arquero + Decimal.js):\n${jsonSeguro(analiseDados || {}, 4_500)}\n` +
    `REGRA: se a validacao local trouxer aviso de divergencia, nao esconda o problema nem invente um valor alternativo. Responda somente com o que estiver consistente nos dados retornados.\n` +
    `DADOS RETORNADOS (ate ${MAX_LINHAS_PARA_IA} linhas):\n${jsonSeguro(amostra, 16_000)}\n\n` +
    `Responda em portugues brasileiro, de forma natural e objetiva.`;

  try {
    const resposta = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 1000,
      temperature: 0,
      reasoning_effort: "low",
    });
    const limpa = limparRespostaParaWhatsApp(String(resposta || "").trim());
    return limpa || fallbackResposta(pergunta, rows);
  } catch (e) {
    console.warn("AGENTE SQL: falha na redacao por IA; usando fallback local:", e.message);
    return fallbackResposta(pergunta, rows);
  }
}

function estadoPublico(ctx, execucao) {
  const primeira = execucao.rows?.[0] || {};
  return {
    fonte: `public.${ctx.relacao}`,
    sql: execucao.sql,
    linhas: execucao.rows?.length || 0,
    colunas_resultado: Object.keys(primeira).slice(0, 30),
    early_accept: execucao.earlyAccept === true,
    reparos_usados: Math.max(0, Number(execucao.tentativa || 0)),
  };
}

// ------------------------------------------------------------
// Fluxo principal
// ------------------------------------------------------------
export async function responderPergunta(pergunta, historico = []) {
  const texto = textoSeguro(pergunta, 1600);
  if (!texto) return { resposta: "Pode enviar sua pergunta sobre as obras?", erro: "pergunta_vazia" };

  const social = respostaSocial(texto, historico);
  if (social) return { resposta: social, social: true, modoAgente: "social" };

  const ambiguidadeAnalise = respostaAmbiguidadeAnaliseLicitacao(texto);
  if (ambiguidadeAnalise) {
    return {
      resposta: ambiguidadeAnalise,
      social: false,
      modoAgente: "clarificacao_analise_licitacao",
    };
  }

  try {
    const ctx = await carregarSchemaContexto();

    // Estagio 1: para campos de ANALISE DE LICITACAO, o Node garante o
    // universo correto (tipo_negocio='licitacao'). Para todo o resto, o fluxo
    // continua exatamente igual e a IA gera a SQL.
    const sqlAnaliseDireta = sqlAnaliseLicitacao(texto, ctx);
    let gerada = sqlAnaliseDireta
      ? { query: sqlAnaliseDireta, descricao: "consulta segura de análise de licitação" }
      : await gerarSQL(texto, historico, ctx);

    if (!gerada.query) {
      // Uma segunda tentativa curta so para formato/interpretacao, sem criar regra de frase.
      gerada = await gerarSQL(texto, historico, ctx, "A tentativa anterior nao produziu SQL. Gere uma consulta SELECT valida usando apenas o schema fornecido.");
    }
    if (!gerada.query) {
      return {
        resposta: "Não consegui transformar essa pergunta em uma consulta segura aos dados. Pode reformular?",
        erro: "sql_nao_gerada",
        modoAgente: "sql_agent_self_healing_v13_ram30",
      };
    }

    // Garante continuidade quando o usuario usa pronome para uma pessoa citada
    // no turno anterior (ex.: "ela tem quantas obras em geral?").
    const pessoaPerdida = referenciaPessoaPerdida(texto, historico, gerada.query);
    if (pessoaPerdida) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        `A pergunta atual usa um pronome que se refere a ${pessoaPerdida}, citado(a) no contexto recente. ` +
        `A SQL perdeu essa entidade e consultou um universo mais amplo. Refaça preservando o filtro de engenheiro/responsavel dessa pessoa. ` +
        `Se o usuario disse "em geral", remova apenas filtros de status/andamento anteriores; NAO remova o filtro da pessoa.`
      );
      if (refinada.query) gerada = refinada;
    }

    // Pedido tematico amplo: "registros/dados da area X" nao significa apenas obras.
    // A classificacao do tema e dinamica e deve vir dos dados reais da planilha.
    if (pedidoAreaTematicaAmpla(texto) && consultaRestringeTipoNegocio(gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "O usuario pediu REGISTROS/DADOS de uma AREA TEMATICA sem limitar a obras, projetos ou licitacoes. A SQL restringiu tipo_negocio indevidamente. Refaça pesquisando todos os tipos de negocio e registros auxiliares que tenham evidencia semantica clara de pertencer ao tema, usando o CATALOGO DE OBJETOS e os campos reais (objeto, categoria, recurso, tipo_recurso, aba_origem e dados_extras). Nao use uma lista fixa de palavras e nao invente categorias. Retorne tipo_negocio/aba_origem junto dos registros para a resposta diferenciar obra, projeto, licitacao e auxiliar."
      );
      if (refinada.query) gerada = refinada;
    }

    // Protecao generica contra confundir AREA/TEMA com FONTE DE RECURSO.
    // Ex.: "obras da educacao" nao deve virar apenas recurso='EDUCACAO', pois
    // outras obras do mesmo tema podem ter recurso FEDERAL, ESTADUAL etc.
    if (consultaPossivelmenteConfundeTemaComRecurso(texto, gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "Revise a semantica da expressao pedida pelo usuario. A SQL atual reduziu o conjunto a uma igualdade em recurso/tipo_recurso, embora o usuario nao tenha pedido explicitamente uma fonte de recurso. Primeiro determine, pelo contexto e pelo CATALOGO DE OBJETOS REAIS, se a expressao representa uma AREA/TEMA ou uma fonte/programa de financiamento. Se for AREA/TEMA, NAO use recurso='tema' como criterio unico: encontre dinamicamente TODOS os objetos do universo pedido que pertencem claramente ao tema, mesmo que tenham recursos diferentes, usando objeto como evidencia principal e categoria/dados_extras/recurso como apoio. Se for claramente uma fonte/programa de financiamento, preserve o filtro de recurso. Nao use lista fixa de areas, nao invente sinonimos e mantenha o tipo_negocio pedido pelo usuario."
      );
      if (refinada.query) gerada = refinada;
    }

    // Refinamentos gerais de qualidade. Nao sao regras de uma frase especifica:
    // evitam respostas existenciais arbitrarias e agregados numericos sem composicao.
    if (existencialComLimitUm(texto, gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "A consulta usou LIMIT 1 para uma pergunta existencial. Nao escolha um registro arbitrario. Refaça listando o conjunto real encontrado, preservando o recorte da conversa. Prefira objeto + campos relevantes + COUNT(*) OVER() AS total_encontrados, com no maximo 20 itens para exibicao."
      );
      if (refinada.query) gerada = refinada;
    }

    if (existencialComAgregadoSeco(texto, gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "A pergunta e existencial e a consulta retornaria apenas uma contagem. Preserve EXATAMENTE o mesmo recorte, mas traga tambem os registros encontrados para o usuario ver quais sao. Prefira objeto + status/tipo relevante + COUNT(*) OVER() AS total_encontrados. Se houver ate 20, liste todos; nao explique SQL nem filtros na resposta."
      );
      if (refinada.query) gerada = refinada;
    }

    if (contagemComAgregadoSeco(texto, gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "A pergunta pede uma contagem, mas a SQL retornaria apenas COUNT sem os registros que sustentam o total. Preserve EXATAMENTE o mesmo recorte e os mesmos criterios sem inventar categorias. Refaça trazendo objeto + campos uteis disponiveis + COUNT(*) OVER() AS total_encontrados. Para qualquer area tematica, descubra os registros dinamicamente pelo catalogo e pelos campos reais; nao use uma lista fechada de tipos/equipamentos e nao restrinja tipo_negocio se o usuario pediu registros gerais da area."
      );
      if (refinada.query) gerada = refinada;
    }

    if (consultaAgregadaSeca(texto, gerada.query)) {
      const refinada = await gerarSQL(
        texto, historico, ctx,
        "A consulta retornaria apenas um agregado seco. Preserve EXATAMENTE o mesmo recorte e refaça de forma explicavel: traga objeto + valor componente e o agregado por window function (SUM/AVG ... OVER()), para a resposta mostrar de onde saiu o total. Nao remova filtros anteriores."
      );
      if (refinada.query) gerada = refinada;
    }

    // Protecao de continuidade: em perguntas puramente referenciais (ex.:
    // "quais sao?"), restaura o WHERE do ultimo recorte confirmado. Isso evita
    // misturar obra/projeto/licitacao quando a IA simplifica demais a SQL.
    const sqlComRecorte = preservarRecorteFollowUp(texto, historico, gerada.query);
    if (sqlComRecorte && sqlComRecorte !== limparSQL(gerada.query)) {
      console.log("SQL AGENT - RECORTE DE FOLLOW-UP PRESERVADO");
      gerada = { ...gerada, query: sqlComRecorte };
    }

    // Guardrail semantico do universo: garante obra/projeto/licitacao quando a
    // regra de negocio e inequívoca. Em "quais sao?", usa a pergunta anterior.
    const sqlComUniverso = garantirUniversoNegocio(texto, historico, gerada.query);
    if (sqlComUniverso && sqlComUniverso !== limparSQL(gerada.query)) {
      console.log("SQL AGENT - UNIVERSO DE NEGOCIO CORRIGIDO");
      gerada = { ...gerada, query: sqlComUniverso };
    }

    console.log("SQL AGENT - SQL INICIAL:", gerada.query);

    // Estagio 2: executa + self-healing com diagnostico real do PostgreSQL.
    const execucao = await executarComSelfHealing({
      pergunta: texto,
      historico,
      ctx,
      sqlInicial: gerada.query,
    });

    console.log("SQL AGENT - SQL FINAL:", execucao.sql);
    console.log("SQL AGENT - LINHAS:", execucao.rows.length, "| REPAROS:", execucao.tentativa || 0, "| EARLY_ACCEPT:", !!execucao.earlyAccept);

    // Estagio 3: confere localmente o resultado antes da redacao por IA.
    const analiseDados = analisarResultadoDados(texto, execucao.sqlExecucao || execucao.sql, execucao.rows);
    if (analiseDados.avisos.length) {
      console.warn("SQL AGENT - VALIDACAO DE DADOS:", analiseDados.avisos.join(" | "));
    } else {
      console.log("SQL AGENT - VALIDACAO DE DADOS: OK (Arquero + Decimal.js)");
    }

    const resposta = await redigirResposta(texto, historico, execucao.sql, execucao.rows, ctx, analiseDados);
    return {
      resposta,
      sql: execucao.sql,
      linhas: execucao.rows.length,
      analiseDados,
      estado: estadoPublico(ctx, execucao),
      reparos: execucao.tentativa || 0,
      earlyAccept: !!execucao.earlyAccept,
      tentativas: execucao.tentativas,
      modoAgente: "sql_agent_self_healing_v13_ram30",
    };
  } catch (e) {
    console.error("SQL AGENT: falha final:", e);
    return {
      resposta: "Tive um problema ao consultar os dados agora. Tente novamente em instantes.",
      erro: e.message,
      modoAgente: "sql_agent_self_healing_v13_ram30_erro",
    };
  }
}
