// ============================================================
// agente.js - SQL AGENT CONVERSACIONAL + SELF-HEALING + REGRAS DE NEGOCIO UNIFICADAS + RESPOSTAS HUMANAS (Node.js) - V13.7
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
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js";

// ------------------------------------------------------------
// Analise local opcional: Arquero + Decimal.js
// ------------------------------------------------------------
// IMPORTANTE: usamos import() dinamico dentro de try/catch.
// Assim, se o Render ainda nao tiver as dependencias instaladas, o agente
// CONTINUA SUBINDO normalmente e usa fallback nativo. Quando as bibliotecas
// estiverem no package.json/node_modules, elas sao ativadas automaticamente.
let moduloArquero = null;
let ClasseDecimal = null;
let promessaBibliotecasAnalise = null;

async function carregarBibliotecasAnalise() {
  if (promessaBibliotecasAnalise) return promessaBibliotecasAnalise;

  promessaBibliotecasAnalise = (async () => {
    const status = { arquero: false, decimal: false };

    try {
      moduloArquero = await import("arquero");
      status.arquero = true;
    } catch (e) {
      console.warn("AGENTE SQL: Arquero nao instalado; usando analise nativa.", e?.code || e?.message || e);
    }

    try {
      const decimalModulo = await import("decimal.js");
      ClasseDecimal = decimalModulo?.default || decimalModulo?.Decimal || null;
      status.decimal = !!ClasseDecimal;
    } catch (e) {
      console.warn("AGENTE SQL: Decimal.js nao instalado; usando Number como fallback.", e?.code || e?.message || e);
    }

    return status;
  })();

  return promessaBibliotecasAnalise;
}

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

// ------------------------------------------------------------
// Regra-mestra de UNIVERSO DE NEGOCIO
// ------------------------------------------------------------
// Um universo explicito BLOQUEIA toda a consulta nesse mesmo tipo_negocio.
// Ex.: "engenheiros dos projetos e quais sao os projetos" continua 100% em
// tipo_negocio='projeto'; "engenheiros" e "nomes" sao CAMPOS do mesmo conjunto,
// nao universos diferentes. So liberamos mistura quando o usuario cita de forma
// explicita mais de um universo (ex.: "compare obras e projetos").
function universosExplicitosDaPergunta(pergunta = "") {
  const p = normalizar(pergunta);
  const itens = [];
  if (/\bobras?\b/.test(p)) itens.push("obra");
  if (/\bprojetos?\b/.test(p)) itens.push("projeto");
  if (/\blicita(?:cao|coes)\b/.test(p)) itens.push("licitacao");
  return [...new Set(itens)];
}

function universoNegocioDaPergunta(pergunta = "") {
  const p = normalizar(pergunta);
  if (!p) return null;

  const explicitos = universosExplicitosDaPergunta(pergunta);
  if (explicitos.length > 1) return null; // comparacao/mistura explicitamente pedida
  if (explicitos.length === 1) return explicitos[0];

  // Regra oficial do projeto: alvos fisicos, sem projeto/licitacao explicitos,
  // pertencem ao universo de obras.
  const alvoFisico = /\b(ubs|unidade basica de saude|posto de saude|psf|escola|creche|praca|mercado|campo|drenagem|quadra|pavimentacao|rua)\b/.test(p);
  return alvoFisico ? "obra" : null;
}

function universosEncontradosNaSQL(sql = "") {
  const s = String(sql || "");
  const out = new Set();
  const rxEq = /\btipo_negocio\s*=\s*'(obra|projeto|licitacao)'/gi;
  let m;
  while ((m = rxEq.exec(s))) out.add(normalizar(m[1]));

  const rxRotulo = /'(obra|projeto|licitacao)'\s+AS\s+(?:tipo|universo|tipo_negocio)\b/gi;
  while ((m = rxRotulo.exec(s))) out.add(normalizar(m[1]));
  return [...out];
}

function pedidoCompostoMesmoUniverso(pergunta = "", sql = "") {
  const universo = universoNegocioDaPergunta(pergunta);
  if (!universo) return false;
  const p = normalizar(pergunta);
  const pedeCampo = /\b(engenheir|arquit|responsavel|status|situacao|recurso|valor|bairro|empresa|contrato|convenio|data|percentual|executad)\w*\b/.test(p);
  const pedeRegistros = /\b(quais|liste|lista|nomes?|mostre|fale)\b/.test(p) && /\b(obras?|projetos?|licitacoes?)\b/.test(p);
  if (!(pedeCampo && pedeRegistros)) return false;

  // Para varios campos do MESMO conjunto, UNION/CTEs separados quase sempre
  // quebram a associacao registro -> campo. Exigimos uma linha por registro.
  return /\bunion(?:\s+all)?\b/i.test(String(sql || ""));
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

  // UNIVERSO BLOQUEADO: quando a pergunta tem um unico universo, TODAS as
  // subconsultas/CTEs/UNIONs devem usar esse mesmo tipo_negocio. Corrigimos
  // todas as igualdades, nao apenas a primeira ocorrencia.
  const rxIgualGlobal = /((?:\b[a-zA-Z_][\w$]*\.)?tipo_negocio\s*=\s*)'(obra|projeto|licitacao)'/gi;
  let encontrouFiltro = false;
  s = s.replace(rxIgualGlobal, (_todo, prefixo) => {
    encontrouFiltro = true;
    return `${prefixo}'${esperado}'`;
  });

  // Se a IA tentou usar IN para misturar universos numa pergunta de universo
  // unico, reduzimos ao universo correto.
  const rxIn = /((?:\b[a-zA-Z_][\w$]*\.)?tipo_negocio\s+IN\s*)\([^)]*\)/gi;
  s = s.replace(rxIn, (_todo, prefixo) => {
    encontrouFiltro = true;
    return `${prefixo}('${esperado}')`;
  });

  // Corrige rotulos artificiais usados em UNIONs, ex.: SELECT 'obra' AS tipo,
  // para a resposta nao chamar projetos de obras apos o guardrail.
  s = s.replace(/'(obra|projeto|licitacao)'(\s+AS\s+(?:tipo|universo|tipo_negocio)\b)/gi,
    (_todo, _valor, sufixo) => `'${esperado}'${sufixo}`);

  if (encontrouFiltro || /\btipo_negocio\b/i.test(s)) return limparSQL(s);
  return adicionarCondicaoWhere(s, `tipo_negocio = '${esperado}'`);
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

// Quando a pergunta pede qual ENTIDADE (engenheiro, empresa, bairro etc.) tem
// maior/menor VALOR TOTAL INVESTIDO no conjunto, o correto e somar as obras de
// cada entidade. MAX(valor_total) responderia apenas qual foi a maior obra
// individual daquela entidade, mudando a semantica da pergunta.
// ------------------------------------------------------------
// Guardrail universal de STATUS por aba/universo
// ------------------------------------------------------------
// Mapa oficial usado pelo chatbot:
// - EM_ANDAMENTO / PAVIMENTACAO -> tipo_negocio='obra'
//     * "em andamento" -> em_andamento_obra = true
//     * "concluida"    -> concluido = true
//     * qualquer outro status especifico -> status_original
// - EM_PROJETO -> tipo_negocio='projeto' -> status_original
// - EM_LICITACAO -> tipo_negocio='licitacao' -> status_original
// - proposta/habilitacao analisada -> dados_extras (tratado por sqlAnaliseLicitacao)
//
// A funcao corrige a SQL DEPOIS da IA gerar e tambem em cada reparo do
// self-healing. Assim uma tentativa de reparo nao consegue voltar para a coluna
// errada. Nao depende de nomes de obras nem de valores fixos da planilha.
function nomesColunasContexto(ctx = null) {
  return new Set((ctx?.colunas || []).map((c) => c?.column_name).filter(Boolean));
}

function universoPelaSQL(sql = "") {
  const s = String(sql || "");
  const tipo = s.match(/\btipo_negocio\s*=\s*'(obra|projeto|licitacao)'/i)?.[1];
  if (tipo) return normalizar(tipo);

  // Compatibilidade com a tabela legada quando a IA filtrar pela aba de origem.
  if (/\bEM_PROJETO\b/i.test(s)) return "projeto";
  if (/\bEM_LICITA(?:C|Ç)(?:AO|ÃO)\b/i.test(s)) return "licitacao";
  if (/\bEM_ANDAMENTO\b/i.test(s) || /\bPAVIMENTA(?:C|Ç)(?:AO|ÃO)\b/i.test(s)) return "obra";
  return null;
}

function dividirWherePorAndTopo(where = "") {
  const partes = [];
  let atual = "";
  let profundidade = 0;
  let aspasSimples = false;
  let aspasDuplas = false;

  for (let i = 0; i < where.length; i++) {
    const ch = where[i];
    const prox = where[i + 1];

    if (aspasSimples) {
      atual += ch;
      if (ch === "'" && prox === "'") {
        atual += prox;
        i++;
      } else if (ch === "'") {
        aspasSimples = false;
      }
      continue;
    }

    if (aspasDuplas) {
      atual += ch;
      if (ch === '"' && prox === '"') {
        atual += prox;
        i++;
      } else if (ch === '"') {
        aspasDuplas = false;
      }
      continue;
    }

    if (ch === "'") {
      aspasSimples = true;
      atual += ch;
      continue;
    }
    if (ch === '"') {
      aspasDuplas = true;
      atual += ch;
      continue;
    }
    if (ch === "(") profundidade++;
    if (ch === ")" && profundidade > 0) profundidade--;

    if (profundidade === 0) {
      const resto = where.slice(i);
      const m = resto.match(/^\s+AND\s+/i);
      if (m) {
        if (atual.trim()) partes.push(atual.trim());
        atual = "";
        i += m[0].length - 1;
        continue;
      }
    }

    atual += ch;
  }

  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

function substituirIdentificadorStatus(sql = "", novo = "status_original") {
  const s = String(sql || "");
  let out = "";
  let i = 0;
  let aspasSimples = false;
  let aspasDuplas = false;

  while (i < s.length) {
    const ch = s[i];
    const prox = s[i + 1];

    if (aspasSimples) {
      out += ch;
      if (ch === "'" && prox === "'") {
        out += prox;
        i += 2;
        continue;
      }
      if (ch === "'") aspasSimples = false;
      i++;
      continue;
    }

    if (aspasDuplas) {
      out += ch;
      if (ch === '"' && prox === '"') {
        out += prox;
        i += 2;
        continue;
      }
      if (ch === '"') aspasDuplas = false;
      i++;
      continue;
    }

    if (ch === "'") {
      aspasSimples = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      aspasDuplas = true;
      out += ch;
      i++;
      continue;
    }

    const trecho = s.slice(i);
    const m = trecho.match(/^status\b(?!_original)/i);
    const anterior = i > 0 ? s[i - 1] : "";
    if (m && !/[A-Za-z0-9_$]/.test(anterior)) {
      out += novo;
      i += m[0].length;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function segmentoUsaStatusCanonico(segmento = "") {
  return /\bstatus\b(?!_original)/i.test(String(segmento || ""));
}

function statusPadraoObraDoSegmento(segmento = "") {
  const bruto = String(segmento || "");
  if (!segmentoUsaStatusCanonico(bruto)) return null;

  // Condicoes compostas (IN/OR) sao tratadas como status especifico para nao
  // perder parte da logica ao tentar converter tudo para um unico booleano.
  if (/\bin\s*\(/i.test(bruto) || /\bor\b/i.test(bruto)) return null;

  const n = normalizar(bruto);
  const negado = /\bnot\b/i.test(bruto) || /<>|!=/.test(bruto) || /\bnao\b/.test(n);

  if (/\bem andamento\b/.test(n)) {
    return { campo: "em_andamento_obra", valor: negado ? false : true };
  }
  if (/\bconclu(?:id|i)/.test(n)) {
    return { campo: "concluido", valor: negado ? false : true };
  }
  return null;
}

function corrigirStatusPorUniverso(pergunta = "", historico = [], sql = "", ctx = null) {
  let s = limparSQL(sql);
  if (!s) return s;

  const colunas = nomesColunasContexto(ctx);
  const temStatusOriginal = colunas.size === 0 || colunas.has("status_original");
  const temEmAndamento = colunas.size === 0 || colunas.has("em_andamento_obra");
  const temConcluido = colunas.size === 0 || colunas.has("concluido");

  const perguntaBase = followUpSomenteReferencia(pergunta)
    ? ultimaPerguntaUsuario(historico)
    : pergunta;
  const universo = universoPelaSQL(s) || universoNegocioDaPergunta(perguntaBase);
  if (!universo) return s;

  // PROJETOS e LICITACOES: status_original e a fonte autoritativa da etapa/status
  // real da aba. Isso vale tanto para SELECT quanto para WHERE/GROUP/ORDER.
  if ((universo === "projeto" || universo === "licitacao") && temStatusOriginal) {
    return substituirIdentificadorStatus(s, "status_original");
  }

  if (universo !== "obra") return s;

  const whereAtual = extrairWhereSimples(s);
  let usavaStatusCanonico = segmentoUsaStatusCanonico(s);

  if (whereAtual) {
    const partes = dividirWherePorAndTopo(whereAtual);
    if (partes.length) {
      const novas = partes.map((segmento) => {
        if (!segmentoUsaStatusCanonico(segmento)) return segmento;

        const padrao = statusPadraoObraDoSegmento(segmento);
        if (padrao?.campo === "em_andamento_obra" && temEmAndamento) {
          return `em_andamento_obra = ${padrao.valor ? "true" : "false"}`;
        }
        if (padrao?.campo === "concluido" && temConcluido) {
          return `concluido = ${padrao.valor ? "true" : "false"}`;
        }

        // Paralisada, Retomada e qualquer outro status especifico da obra.
        return temStatusOriginal
          ? substituirIdentificadorStatus(segmento, "status_original")
          : segmento;
      });
      s = substituirWhereSimples(s, novas.join(" AND "));
    }
  }

  // Mesmo quando a IA nao colocou um filtro de status, a pergunta pode ter
  // pedido explicitamente "obras em andamento"/"obras concluidas". Reforcamos
  // os booleanos normalizados para abranger EM_ANDAMENTO e PAVIMENTACAO juntas.
  const p = normalizar(perguntaBase);
  if (/\bem andamento\b/.test(p) && temEmAndamento && !/\bem_andamento_obra\b/i.test(s)) {
    s = adicionarCondicaoWhere(s, "em_andamento_obra = true");
  }
  if (/\bconclu(?:id|i)/.test(p) && temConcluido && !/\bconcluido\b/i.test(s)) {
    s = adicionarCondicaoWhere(s, "concluido = true");
  }

  // Se restou alguma referencia generica a status (SELECT, GROUP BY, ORDER BY
  // ou um filtro especifico), mostre/use o status real da origem.
  if (temStatusOriginal && (usavaStatusCanonico || /\b(status|situacao|situação|etapa)\b/.test(p))) {
    s = substituirIdentificadorStatus(s, "status_original");
  }

  return limparSQL(s);
}

function corrigirRankingValorTotalPorEntidade(pergunta = "", sql = "") {
  const p = normalizar(pergunta);
  let s = limparSQL(sql);
  if (!s) return s;

  const pedeEntidade = /\b(engenheir|arquit|responsavel|empresa|bairro)\w*\b/.test(p);
  const pedeExtremo = /\b(maior|mais|menor|menos)\b/.test(p);
  const pedeTotalFinanceiro = /\b(valor\s+(?:total\s+)?investid|investimento|valor\s+total|total\s+investid)\w*\b/.test(p);
  const agrupada = /\bgroup\s+by\b/i.test(s);
  const usaMaxValorTotal = /\bmax\s*\(\s*valor_total\s*\)/i.test(s);

  if (!(pedeEntidade && pedeExtremo && pedeTotalFinanceiro && agrupada && usaMaxValorTotal)) return s;

  // Troca apenas o agregado do valor_total. Mantem alias, GROUP BY, filtros e ORDER BY.
  return s.replace(/\bmax\s*\(\s*valor_total\s*\)/ig, "SUM(valor_total)");
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
    return `REGRAS DE NEGOCIO OFICIAIS DA VIEW (OBRIGATORIAS):\n` +
      `1) UNIVERSOS / ABAS\n` +
      `- EM_ANDAMENTO e PAVIMENTACAO -> tipo_negocio='obra'.\n` +
      `- EM_PROJETO -> tipo_negocio='projeto'.\n` +
      `- EM_LICITACAO -> tipo_negocio='licitacao'.\n` +
      `- subtipo_negocio='pavimentacao' identifica as pavimentacoes dentro de obra.\n` +
      `- Se o usuario citar UM unico universo (obra, projeto ou licitacao), BLOQUEIE TODA a SQL nesse tipo_negocio: SELECT principal, CTEs, subqueries, UNIONs, filtros e agregacoes. NAO troque de universo so porque ele pediu outro campo.\n` +
      `- So misture universos se o usuario pedir explicitamente mais de um, por exemplo comparar obras e projetos.\n` +
      `- Pedido composto no mesmo universo e UMA consulta do mesmo conjunto: "engenheiros dos projetos e quais projetos" = objeto + engenheiro de tipo_negocio='projeto'. NAO crie um CTE de engenheiros e outro de obras, NAO use UNION e NAO perca a associacao entre registro e campo.\n\n` +
      `2) STATUS / SITUACAO\n` +
      `- Obra em andamento -> em_andamento_obra = true.\n` +
      `- Obra concluida -> concluido = true.\n` +
      `- Outro status especifico de obra (Paralisada, Retomada etc.) -> status_original.\n` +
      `- Projeto: TODO status especifico e status_original (Em elaboração, Em revisão, Aguardando aprovação, Concluído etc.).\n` +
      `- Licitacao: etapa/status real e status_original (Edital publicado, Habilitação em andamento, Homologada etc.).\n` +
      `- Se pedir "qual o status" de projeto/licitacao, retorne status_original. Em obra, use booleanos para filtrar ciclo e status_original para mostrar a descricao humana quando existir.\n\n` +
      `3) ANALISE DE LICITACAO\n` +
      `- Proposta analisada/nao analisada -> EXCLUSIVAMENTE dados_extras->>'PROPOSTA ANALISADA'.\n` +
      `- Habilitacao analisada/nao analisada -> EXCLUSIVAMENTE dados_extras->>'HABILITAÇÃO ANALISADA'.\n` +
      `- Nunca deduza proposta/habilitacao por status ou status_original.\n\n` +
      `4) CAMPOS E ASSOCIACAO\n` +
      `- objeto = nome da obra/projeto/licitacao no chatbot. engenheiro = responsavel. recurso e tipo_recurso sao conceitos diferentes.\n` +
      `- Quando o usuario pedir varios campos do mesmo conjunto (nome + engenheiro, nome + valor, nome + recurso, nome + status), retorne UMA LINHA POR REGISTRO com objeto + todos os campos pedidos. Preserve a associacao.\n` +
      `- DISTINCT de um campo sozinho so quando ele pedir explicitamente valores unicos/nomes unicos, sem precisar saber a qual registro pertencem.\n` +
      `- Campos nao canonicos podem existir em dados_extras; use a CHAVE REAL exibida pelo schema, sem substituir por um campo apenas parecido.\n\n` +
      `5) VALORES / CALCULOS / RANKINGS\n` +
      `- Valor total investido de um conjunto -> SUM(valor_total), salvo pedido explicito por valor executado/pago.\n` +
      `- Quanto falta -> valor_total - valor_executado quando disponiveis.\n` +
      `- Ranking de entidade por valor total (engenheiro/empresa/bairro) -> GROUP BY entidade + SUM(valor_total), nunca MAX(valor_total).\n` +
      `- Ranking por quantidade -> GROUP BY entidade + COUNT(*).\n` +
      `- ORDER BY numerico deve usar NULLS LAST; nao deixe NULL ganhar ranking.\n\n` +
      `6) SEMANTICA DE ASSUNTO\n` +
      `- UBS, unidade basica de saude, posto, PSF, escola, creche, praca, mercado, campo, drenagem, quadra, rua etc. sao alvos/assuntos. Sem projeto/licitacao explicitos, trate-os como obras.\n` +
      `- Saude: somente equipamentos/servicos claramente de saude. Creche e escola sao educacao, nao saude.\n` +
      `- Nao invente nomes, status, bairros, responsaveis, empresas, recursos ou valores. Sempre leia o banco atual.\n` +
      `- Use SOMENTE public.obras_chatbot.\n`;
  }
  return `REGRAS DE NEGOCIO DA TABELA LEGADA:\n` +
    `- Use SOMENTE public.obras.\n` +
    `- obras = aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO'). projetos = EM_PROJETO. licitacoes = EM_LICITAÇÃO.\n` +
    `- Se o usuario citar um unico universo, mantenha TODA a consulta nesse universo; so misture quando ele pedir comparacao explicita.\n` +
    `- Pedidos de varios campos do mesmo registro devem retornar uma linha por registro, preservando associacoes.\n` +
    `- recurso e tipo_recurso nao sao a mesma coisa.\n`;
}


// ------------------------------------------------------------
// PIPELINE SEMANTICO V14
// Inspirado em DIN-SQL (planejamento/schema linking), DAIL-SQL
// (exemplos dinamicos compactos) e CHASE-SQL (candidatos + selecao).
// Tudo permanece neste unico agente.js: nenhum arquivo/tabela extra e exigido.
// ------------------------------------------------------------
const EXEMPLOS_SEMANTICOS = [
  {
    intent: "count", universes: ["obra"], concepts: ["status", "quantidade"], shape: "scalar_count",
    pergunta: "Quantas obras concluidas existem?",
    sql: "SELECT COUNT(*) AS total_obras FROM public.obras_chatbot WHERE tipo_negocio = 'obra' AND concluido = true"
  },
  {
    intent: "list", universes: ["obra"], concepts: ["responsavel"], shape: "records",
    pergunta: "Quais os responsaveis dessas obras?",
    sql: "SELECT objeto, engenheiro FROM public.obras_chatbot WHERE tipo_negocio = 'obra'"
  },
  {
    intent: "sum", universes: ["obra"], concepts: ["valor_total"], shape: "records_with_aggregate",
    pergunta: "Qual o valor total das obras concluidas?",
    sql: "SELECT objeto, valor_total, SUM(valor_total) OVER () AS total_valor FROM public.obras_chatbot WHERE tipo_negocio = 'obra' AND concluido = true"
  },
  {
    intent: "rank", universes: ["obra"], concepts: ["engenheiro", "valor_total"], shape: "ranking",
    pergunta: "Qual engenheiro tem o maior valor total em obras?",
    sql: "SELECT engenheiro, SUM(valor_total) AS total_valor FROM public.obras_chatbot WHERE tipo_negocio = 'obra' AND engenheiro IS NOT NULL GROUP BY engenheiro ORDER BY total_valor DESC NULLS LAST LIMIT 1"
  },
  {
    intent: "rank", universes: ["obra"], concepts: ["engenheiro", "quantidade"], shape: "ranking",
    pergunta: "Qual engenheiro tem mais obras?",
    sql: "SELECT engenheiro, COUNT(*) AS total_obras FROM public.obras_chatbot WHERE tipo_negocio = 'obra' AND engenheiro IS NOT NULL GROUP BY engenheiro ORDER BY total_obras DESC, engenheiro"
  },
  {
    intent: "list", universes: ["projeto"], concepts: ["status"], shape: "records",
    pergunta: "Quais projetos estao concluidos?",
    sql: "SELECT objeto, status_original FROM public.obras_chatbot WHERE tipo_negocio = 'projeto' AND status_original ILIKE 'Conclu%'"
  },
  {
    intent: "list", universes: ["licitacao"], concepts: ["proposta_analisada"], shape: "records",
    pergunta: "Quais licitacoes estao com proposta nao analisada?",
    sql: "SELECT objeto, dados_extras->>'PROPOSTA ANALISADA' AS proposta_analisada FROM public.obras_chatbot WHERE tipo_negocio = 'licitacao' AND LOWER(COALESCE(dados_extras->>'PROPOSTA ANALISADA','')) = 'nao'"
  },
  {
    intent: "distinct", universes: ["obra"], concepts: ["bairro"], shape: "distinct_list",
    pergunta: "Quais bairros tem obras?",
    sql: "SELECT DISTINCT bairro AS bairro_bruto FROM public.obras_chatbot WHERE tipo_negocio = 'obra' AND bairro IS NOT NULL AND BTRIM(bairro) <> '' ORDER BY bairro_bruto"
  },
];

function listaTextoCurta(arr = [], max = 12) {
  return (arr || []).slice(0, max).map((x) => String(x)).join(" | ");
}

function schemaCompactoParaPlanejamento(ctx) {
  const colunas = (ctx.colunas || [])
    .map((c) => `${c.column_name}:${c.data_type}`)
    .join(" | ");

  const valores = Object.entries(ctx.categorias || {})
    .filter(([, arr]) => Array.isArray(arr) && arr.length)
    .map(([campo, arr]) => `${campo}=[${listaTextoCurta(arr, campo === "bairro" ? 20 : 10)}]`)
    .join("\n");

  const extras = listaTextoCurta(ctx.chavesDadosExtras || [], 120);
  const objetos = (ctx.objetosCatalogo || []).slice(0, 35).map((r) => {
    const p = [r.tipo_negocio, r.objeto, r.bairro ? `bairro=${r.bairro}` : null].filter(Boolean);
    return p.join(" | ");
  }).join("\n");

  return `RELACAO public.${ctx.relacao}\nCOLUNAS: ${colunas}\n` +
    `CHAVES JSONB: ${extras || "(nenhuma)"}\n` +
    `AMOSTRAS DE VALORES CATEGORICOS:\n${valores || "(nenhuma)"}\n` +
    `AMOSTRA DE OBJETOS REAIS:\n${objetos || "(nenhuma)"}`;
}

function planoPadrao() {
  return {
    intent: "other",
    universes: [],
    subject_terms: [],
    entities: [],
    measures: [],
    filters: [],
    requested_fields: [],
    expected_result: { shape: "records", primary_concept: null, numeric_kind: null },
    result_normalization: { needed: false, concept: null, reason: "" },
    needs_semantic_validation: true,
    needs_multiple_candidates: false,
    complexity: "medium",
    confidence: 0,
    clarification: { needed: false, question: "" },
    notes: [],
  };
}

function normalizarPlano(obj) {
  const base = planoPadrao();
  if (!obj || typeof obj !== "object") return base;
  const p = { ...base, ...obj };
  p.universes = Array.isArray(obj.universes) ? obj.universes.filter(Boolean) : [];
  p.subject_terms = Array.isArray(obj.subject_terms) ? obj.subject_terms.filter(Boolean).slice(0, 12) : [];
  p.entities = Array.isArray(obj.entities) ? obj.entities.filter(Boolean).slice(0, 12) : [];
  p.measures = Array.isArray(obj.measures) ? obj.measures.filter(Boolean).slice(0, 12) : [];
  p.filters = Array.isArray(obj.filters) ? obj.filters.filter(Boolean).slice(0, 20) : [];
  p.requested_fields = Array.isArray(obj.requested_fields) ? obj.requested_fields.filter(Boolean).slice(0, 20) : [];
  p.expected_result = { ...base.expected_result, ...(obj.expected_result || {}) };
  p.result_normalization = { ...base.result_normalization, ...(obj.result_normalization || {}) };
  p.clarification = { ...base.clarification, ...(obj.clarification || {}) };
  p.notes = Array.isArray(obj.notes) ? obj.notes.filter(Boolean).slice(0, 12) : [];
  p.confidence = Math.max(0, Math.min(1, Number(obj.confidence || 0)));
  p.needs_semantic_validation = obj.needs_semantic_validation !== false;
  p.needs_multiple_candidates = obj.needs_multiple_candidates === true;
  return p;
}

async function planejarConsultaSemantica(pergunta, historico, ctx) {
  const prompt = `Voce e o PLANEJADOR SEMANTICO de um agente Text-to-SQL. NAO gere SQL nesta etapa.\n` +
    `Converta a pergunta em um plano estruturado e faca schema linking: ligue cada conceito pedido a coluna/chave JSON real.\n` +
    `O objetivo e evitar correcoes por frase/regex. Pense em INTENCAO, UNIVERSO, ENTIDADE, MEDIDA, FILTROS, CAMPOS e FORMATO ESPERADO.\n\n` +
    `${regrasNegocio(ctx)}\n` +
    `REGRAS SEMANTICAS GERAIS:\n` +
    `- "valor executado" e conceito de execucao; nao o renomeie para "valor pago".\n` +
    `- "pago", "ja pago", "valor pago" deve usar campos EXPLICITOS de pagamento quando existirem em dados_extras (por exemplo VALOR PAGO por ano). Nao use valor_executado como substituto silencioso. Para total pago sem periodo, prefira somar os campos anuais de pagamento disponiveis e NAO some ao mesmo tempo campos de gestao que representam os mesmos pagamentos.\n` +
    `- COUNT/quantidade e diferente de SUM/valor.\n` +
    `- Se um campo categorico estiver semanticamente sujo nas AMOSTRAS (ex.: mistura nome de bairro com endereco completo/localidade), marque result_normalization.needed=true. A normalizacao posterior so podera extrair valores explicitamente presentes, nunca adivinhar.\n` +
    `- Para follow-up, herde somente o recorte semanticamente ativo do historico; novo alvo explicito substitui contexto incompatível.\n` +
    `- Se a pergunta for realmente ambigua e houver duas interpretacoes de negocio materialmente diferentes, use clarification.needed=true e formule UMA pergunta curta.\n` +
    `- needs_multiple_candidates=true apenas para consulta complexa/ambigua, ranking delicado, multiplas agregacoes ou quando ha mais de um caminho SQL plausivel.\n` +
    `- needs_semantic_validation=true quando execucao SQL bem-sucedida ainda puder nao responder a pergunta (campo sujo, conceito parecido, JSONB, ranking/medida ambigua).\n\n` +
    `SCHEMA COMPACTO E VALORES REAIS:\n${schemaCompactoParaPlanejamento(ctx)}\n\n` +
    `HISTORICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n\n` +
    `Retorne SOMENTE JSON neste formato:\n` +
    `{"intent":"list|distinct|count|sum|avg|rank|detail|existence|compare|other",` +
    `"universes":["obra|projeto|licitacao"],` +
    `"subject_terms":[],` +
    `"entities":[{"concept":"...","source":"coluna ou dados_extras","json_keys":[],"role":"dimension|subject|field","required":true}],` +
    `"measures":[{"concept":"...","source":"coluna ou dados_extras","json_keys":[],"aggregation":"sum|avg|count|max|min|none","required":true}],` +
    `"filters":[{"concept":"...","source":"...","operator":"=|ilike|in|boolean|range","value":"...","origin":"current|history"}],` +
    `"requested_fields":[],` +
    `"expected_result":{"shape":"scalar_count|scalar_money|scalar|distinct_list|records|records_with_aggregate|ranking|grouped","primary_concept":"...","numeric_kind":"count|money|percent|null"},` +
    `"result_normalization":{"needed":false,"concept":null,"reason":""},` +
    `"needs_semantic_validation":false,"needs_multiple_candidates":false,"complexity":"simple|medium|complex","confidence":0.0,` +
    `"clarification":{"needed":false,"question":""},"notes":[]}`;

  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 750,
      temperature: 0,
      reasoning_effort: "low",
    });
    return normalizarPlano(objetoJSONEmTexto(bruto));
  } catch (e) {
    console.warn("SQL AGENT - planejamento semantico falhou; usando plano neutro:", e?.message || e);
    const p = planoPadrao();
    p.notes = ["planejamento_semantico_indisponivel"];
    return p;
  }
}

function conceitosDoPlano(plano = {}) {
  const itens = [];
  for (const e of plano.entities || []) itens.push(e?.concept, e?.role);
  for (const m of plano.measures || []) itens.push(m?.concept, m?.aggregation);
  itens.push(plano.intent, plano.expected_result?.shape, plano.expected_result?.primary_concept);
  return new Set(itens.filter(Boolean).map((x) => normalizar(String(x))));
}

function selecionarExemplosSemanticos(plano, max = 4) {
  const alvos = conceitosDoPlano(plano);
  const universos = new Set((plano.universes || []).map((x) => normalizar(String(x))));
  return EXEMPLOS_SEMANTICOS
    .map((ex) => {
      let score = 0;
      if (normalizar(ex.intent) === normalizar(plano.intent || "")) score += 5;
      if (normalizar(ex.shape) === normalizar(plano.expected_result?.shape || "")) score += 4;
      for (const u of ex.universes || []) if (universos.has(normalizar(u))) score += 2;
      for (const c of ex.concepts || []) if (alvos.has(normalizar(c))) score += 2;
      return { ex, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.ex);
}

function exemplosParaPrompt(exemplos = []) {
  if (!exemplos.length) return "(nenhum exemplo necessario)";
  return exemplos.map((e, i) => `${i + 1}) ${e.pergunta}\nSQL: ${e.sql}`).join("\n\n");
}

async function gerarSQLPorPlano(pergunta, historico, ctx, plano, exemplos = [], variante = "direta", correcao = "") {
  const estrategia = variante === "decomposicao"
    ? "Antes de escrever a SQL, decomponha mentalmente em conjunto-base -> filtros -> dimensoes/medidas -> agregacao -> ordenacao. Nao exponha o raciocinio."
    : "Gere a SQL mais simples que satisfaz integralmente o plano, evitando CTE/subquery sem necessidade.";

  const prompt = `Voce e o GERADOR SQL de um pipeline Text-to-SQL. O PLANO SEMANTICO abaixo e a fonte principal de intencao; nao volte a adivinhar a pergunta do zero.\n` +
    `${estrategia}\n\n` +
    `${regrasNegocio(ctx)}\n` +
    `REGRAS DE GERACAO:\n` +
    `- Somente SELECT ou WITH ... SELECT em public.${ctx.relacao}.\n` +
    `- Responda EXATAMENTE ao plano: universo, entidades, medidas, filtros e shape esperado.\n` +
    `- Se o plano marcou result_normalization.needed=true, NAO tente limpar texto com regex SQL. Retorne o valor bruto da fonte com alias claro (ex.: bairro_bruto) para a camada semantica normalizar depois.\n` +
    `- Se medida for pagamento e houver json_keys explicitas, use essas chaves. Para "total pago" sem periodo, some uma familia nao sobreposta (preferencialmente VALOR PAGO por ano); nao some junto PAGO_GESTAO_* se eles duplicarem os mesmos pagamentos.\n` +
    `- Nao transforme valor monetario em contagem. Use aliases semanticamente claros: total_pago, total_executado, total_investido, total_obras etc.\n` +
    `- Em ranking por valor acumulado de entidade, use SUM da medida por entidade. MAX so para maior valor individual quando isso estiver no plano.\n` +
    `- Para dimensoes nulas como engenheiro/empresa/bairro em ranking/lista, exclua NULL e texto vazio quando isso representar "nao informado" e nao uma entidade real.\n` +
    `- Preserve associacao entre objeto e campos pedidos na mesma linha.\n` +
    `- Nao force resultado: 0 linhas pode ser correto.\n` +
    `- Retorne SOMENTE JSON {"description":"...","query":"SELECT ..."}.\n\n` +
    `PLANO SEMANTICO:\n${jsonSeguro(plano, 7000)}\n\n` +
    `EXEMPLOS DINAMICOS MAIS PARECIDOS (apenas como padrao estrutural; nunca copie valores inexistentes):\n${exemplosParaPrompt(exemplos)}\n\n` +
    `SCHEMA REAL:\n${schemaCompactoParaPlanejamento(ctx)}\n\n` +
    `HISTORICO/ANCORA:\n${ancoraContextoRecente(historico)}\n\n` +
    (correcao ? `FEEDBACK DA AVALIACAO ANTERIOR:\n${correcao}\n\n` : "") +
    `PERGUNTA ORIGINAL: ${JSON.stringify(pergunta)}`;

  const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
    max_tokens: 520,
    temperature: variante === "decomposicao" ? 0.05 : 0,
    reasoning_effort: "low",
  });
  return extrairSQLDaResposta(bruto);
}

function fragmentosObrigatoriosDoPlano(plano = {}) {
  const itens = [];
  for (const x of [...(plano.entities || []), ...(plano.measures || [])]) {
    if (x?.required === false) continue;
    if (x?.source && x.source !== "dados_extras") itens.push({ tipo: "coluna", valor: x.source, concept: x.concept });
    for (const k of x?.json_keys || []) itens.push({ tipo: "json", valor: k, concept: x.concept });
  }
  return itens;
}

function avaliarSQLContraPlanoLocal(plano, sql = "") {
  const s = normalizar(sql);
  const issues = [];
  let score = 100;
  for (const req of fragmentosObrigatoriosDoPlano(plano)) {
    const alvo = normalizar(req.valor);
    if (!alvo) continue;
    if (!s.includes(alvo)) {
      // Para JSON com varias chaves alternativas, nao penalize cada chave ausente.
      if (req.tipo === "json") continue;
      issues.push(`fonte esperada ausente na SQL: ${req.concept || req.valor} -> ${req.valor}`);
      score -= 18;
    }
  }

  for (const u of plano.universes || []) {
    if (["obra", "projeto", "licitacao"].includes(u) && !s.includes(normalizar(u))) {
      issues.push(`universo ${u} nao ficou explicito na SQL`);
      score -= 12;
    }
  }

  const shape = plano.expected_result?.shape;
  if (shape === "ranking" && !/order\s+by/i.test(sql)) {
    issues.push("ranking sem ORDER BY"); score -= 20;
  }
  if (["scalar_count"].includes(shape) && !/count\s*\(/i.test(sql)) {
    issues.push("contagem esperada sem COUNT"); score -= 25;
  }
  if (["scalar_money", "records_with_aggregate"].includes(shape) && (plano.measures || []).some((m) => m?.aggregation === "sum") && !/sum\s*\(/i.test(sql)) {
    issues.push("soma esperada sem SUM"); score -= 20;
  }
  return { score: Math.max(0, score), issues };
}

function avaliarResultadoLocalSemantico(plano, sql, rows = []) {
  const sqlCheck = avaliarSQLContraPlanoLocal(plano, sql);
  let score = sqlCheck.score;
  const issues = [...sqlCheck.issues];
  let needAI = false;

  if (!Array.isArray(rows)) return { score: 0, issues: ["resultado nao e lista"], needAI: true };
  if (rows.length === 0) return { score: Math.min(score, 90), issues, needAI: plano.needs_semantic_validation === true };

  const shape = plano.expected_result?.shape || "records";
  const campos = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const temNumero = rows.some((r) => Object.values(r || {}).some((v) => v !== null && v !== "" && Number.isFinite(Number(v))));

  if (shape.startsWith("scalar") && rows.length !== 1) {
    issues.push("shape escalar esperado, mas vieram varias linhas"); score -= 25; needAI = true;
  }
  if ((shape === "scalar_count" || shape === "scalar_money") && !temNumero) {
    issues.push("resultado numerico esperado sem numero"); score -= 35; needAI = true;
  }
  if (shape === "ranking") {
    if (campos.length < 2 || !temNumero) { issues.push("ranking sem dimensao + medida"); score -= 30; needAI = true; }
  }
  if (shape === "distinct_list" && campos.length === 0) {
    issues.push("lista distinta sem campo"); score -= 30; needAI = true;
  }
  if (plano.result_normalization?.needed) {
    needAI = true;
    score = Math.min(score, 88);
  }
  if (plano.needs_semantic_validation) needAI = true;
  return { score: Math.max(0, score), issues, needAI };
}

async function avaliarCandidatoComIA({ pergunta, plano, sql, rows, avaliacaoLocal }) {
  const prompt = `Voce e o JUIZ SEMANTICO de um Text-to-SQL. Avalie se a SQL e o RESULTADO realmente respondem ao PLANO; nao avalie apenas se a SQL executou.\n` +
    `Procure erros como: coluna semanticamente parecida mas errada, valor tratado como contagem, universo errado, ranking por MAX quando deveria somar, dimensao suja (enderecos misturados com bairros), perda de contexto ou campos pedidos ausentes.\n` +
    `Resultado vazio pode estar correto. Nao exija dados so para evitar vazio.\n` +
    `Se houver problema de qualidade dos dados que SQL nao consegue resolver com seguranca, sinalize normalization_needed=true em vez de inventar.\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n` +
    `PLANO: ${jsonSeguro(plano, 6000)}\n` +
    `SQL: ${sql}\n` +
    `AVALIACAO LOCAL: ${jsonSeguro(avaliacaoLocal, 1800)}\n` +
    `AMOSTRA RESULTADO: ${jsonSeguro((rows || []).slice(0, 10), 6500)}\n\n` +
    `Retorne SOMENTE JSON {"score":0,"verdict":"accept|revise|reject","reason":"...","revision_hint":"...","normalization_needed":false}.`;
  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 340,
      temperature: 0,
      reasoning_effort: "low",
    });
    const o = objetoJSONEmTexto(bruto) || {};
    return {
      score: Math.max(0, Math.min(100, Number(o.score ?? avaliacaoLocal.score ?? 0))),
      verdict: ["accept", "revise", "reject"].includes(o.verdict) ? o.verdict : (avaliacaoLocal.score >= 85 ? "accept" : "revise"),
      reason: textoSeguro(o.reason || avaliacaoLocal.issues?.join("; ") || "", 700),
      revision_hint: textoSeguro(o.revision_hint || "", 1000),
      normalization_needed: o.normalization_needed === true || plano.result_normalization?.needed === true,
    };
  } catch (e) {
    return {
      score: avaliacaoLocal.score,
      verdict: avaliacaoLocal.score >= 85 ? "accept" : "revise",
      reason: avaliacaoLocal.issues?.join("; ") || "avaliacao IA indisponivel",
      revision_hint: "",
      normalization_needed: plano.result_normalization?.needed === true,
    };
  }
}

async function executarPipelineSemantico({ pergunta, historico, ctx, plano }) {
  const exemplos = selecionarExemplosSemanticos(plano, 4);
  const maxCand = Math.max(1, Math.min(Number(process.env.AGENTE_MAX_CANDIDATOS || 2), 3));
  const qtd = Math.min(maxCand, (plano.needs_multiple_candidates || plano.complexity === "complex") ? 2 : 1);
  const candidatos = [];

  for (let i = 0; i < qtd; i++) {
    const variante = i === 0 ? "direta" : "decomposicao";
    let gerada;
    try {
      gerada = await gerarSQLPorPlano(pergunta, historico, ctx, plano, exemplos, variante);
    } catch (e) {
      candidatos.push({ variante, erro: e?.message || String(e), score: 0 });
      continue;
    }
    if (!gerada?.query) continue;

    try {
      const execucao = await executarComSelfHealing({ pergunta, historico, ctx, sqlInicial: gerada.query });
      const local = avaliarResultadoLocalSemantico(plano, execucao.sql, execucao.rows);
      const precisaJuiz = local.needAI || qtd > 1 || local.score < 90;
      const semantica = precisaJuiz
        ? await avaliarCandidatoComIA({ pergunta, plano, sql: execucao.sql, rows: execucao.rows, avaliacaoLocal: local })
        : { score: local.score, verdict: "accept", reason: "validacao local suficiente", revision_hint: "", normalization_needed: false };
      candidatos.push({ variante, gerada, execucao, local, semantica, score: semantica.score });

      if (qtd === 1 && semantica.verdict === "accept" && semantica.score >= 92) break;
    } catch (e) {
      candidatos.push({ variante, gerada, erro: e?.message || String(e), score: 0 });
    }
  }

  let validos = candidatos.filter((c) => c.execucao).sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!validos.length) {
    // Fallback: mantem compatibilidade com o gerador antigo se o novo pipeline falhar.
    const antiga = await gerarSQL(pergunta, historico, ctx);
    if (!antiga.query) throw new Error("Nao foi possivel gerar uma consulta SQL valida.");
    const execucao = await executarComSelfHealing({ pergunta, historico, ctx, sqlInicial: antiga.query });
    const local = avaliarResultadoLocalSemantico(plano, execucao.sql, execucao.rows);
    return { plano, exemplos, candidato: { variante: "fallback", gerada: antiga, execucao, local, semantica: { score: local.score, verdict: "accept", reason: "fallback" }, score: local.score }, candidatos };
  }

  let melhor = validos[0];

  // CHASE-lite: se o melhor candidato ainda pede revisao, faz UMA revisao guiada
  // pelo feedback semantico em vez de adicionar nova regex/frase fixa ao codigo.
  if (melhor.semantica?.verdict === "revise" && melhor.semantica?.revision_hint) {
    try {
      const revisada = await gerarSQLPorPlano(
        pergunta, historico, ctx, plano, exemplos, "decomposicao",
        melhor.semantica.revision_hint
      );
      if (revisada?.query && limparSQL(revisada.query) !== limparSQL(melhor.execucao.sql)) {
        const execucao = await executarComSelfHealing({ pergunta, historico, ctx, sqlInicial: revisada.query });
        const local = avaliarResultadoLocalSemantico(plano, execucao.sql, execucao.rows);
        const semantica = await avaliarCandidatoComIA({ pergunta, plano, sql: execucao.sql, rows: execucao.rows, avaliacaoLocal: local });
        const candidatoRevisado = { variante: "revisao_semantica", gerada: revisada, execucao, local, semantica, score: semantica.score };
        candidatos.push(candidatoRevisado);
        if (candidatoRevisado.score > melhor.score) melhor = candidatoRevisado;
      }
    } catch (e) {
      console.warn("SQL AGENT - revisao semantica falhou; mantendo melhor candidato:", e?.message || e);
    }
  }

  return { plano, exemplos, candidato: melhor, candidatos };
}

async function normalizarResultadoSemanticoSeNecessario({ pergunta, plano, rows, avaliacao }) {
  const precisa = plano.result_normalization?.needed === true || avaliacao?.normalization_needed === true;
  const shape = plano.expected_result?.shape || "";
  if (!precisa || !["distinct_list", "records", "grouped"].includes(shape) || !Array.isArray(rows) || !rows.length) {
    return { rows, changed: false, note: "" };
  }

  const conceito = plano.result_normalization?.concept || plano.expected_result?.primary_concept || "valor categorico";
  const prompt = `Voce e uma camada de NORMALIZACAO SEMANTICA de resultados, nao um pesquisador.\n` +
    `O usuario pediu o conceito ${JSON.stringify(conceito)}. Os valores brutos podem misturar esse conceito com endereco, descricao, caixa alta/baixa ou mais de um valor na mesma string.\n` +
    `Extraia APENAS valores do conceito que estejam EXPLICITAMENTE presentes no texto retornado. NUNCA infira um valor que nao esteja escrito.\n` +
    `Pode: remover duplicatas por caixa/acento, limpar rotulo/endereco ao redor, e separar dois valores quando ambos estiverem explicitamente nomeados (ex.: "Bairro: Centro e Gurguri").\n` +
    `Nao pode: adivinhar bairro por nome de rua, CEP, coordenada ou conhecimento externo. Valores sem evidencia explicita do conceito devem ser omitidos e contabilizados na nota.\n` +
    `Preserve outros campos quando existirem e forem necessarios para responder.\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\nPLANO: ${jsonSeguro(plano, 5000)}\n` +
    `DADOS BRUTOS: ${jsonSeguro(rows.slice(0, 100), 18000)}\n\n` +
    `Retorne SOMENTE JSON {"rows":[...],"note":"frase curta sobre valores omitidos/normalizados"}.`;
  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 1800,
      temperature: 0,
      reasoning_effort: "low",
    });
    const o = objetoJSONEmTexto(bruto) || {};
    if (!Array.isArray(o.rows)) return { rows, changed: false, note: "" };
    return {
      rows: o.rows.slice(0, MAX_RESULTADOS),
      changed: true,
      note: textoSeguro(o.note || plano.result_normalization?.reason || "resultado normalizado semanticamente", 900),
    };
  } catch (e) {
    console.warn("SQL AGENT - normalizacao semantica falhou; usando bruto:", e?.message || e);
    return { rows, changed: false, note: plano.result_normalization?.reason || "" };
  }
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
    `- UNIVERSO BLOQUEADO: se REGRAS DE NEGOCIO identificarem um unico universo, TODAS as partes da SQL devem usar somente esse universo. Campos diferentes pedidos pelo usuario NAO autorizam trocar projeto por obra, obra por licitacao etc.\n` +
    `- PEDIDO COMPOSTO: se o usuario pedir nome dos registros + responsavel/status/recurso/valor/etc., prefira um unico SELECT com objeto + campos pedidos. Nao separe em listas por UNION quando os dados pertencem aos mesmos registros.\n` +
    `- Apenas SELECT ou WITH ... SELECT. Nunca escreva dados.\n` +
    `- Consulte SOMENTE public.${ctx.relacao}.\n` +
    `- Nao consulte information_schema, pg_catalog, auth, storage ou outras tabelas.\n` +
    `- Prefira agregacoes SQL reais (COUNT, SUM, AVG, GROUP BY, ORDER BY) quando a pergunta pedir calculo/ranking.\n` +
    `- SOMA/MEDIA EXPLICAVEL: quando somar ou calcular media de um conjunto e houver nomes/valores por registro, prefira retornar a composicao junto do agregado, por exemplo objeto + valor_total + SUM(valor_total) OVER () AS total_investido. Assim a resposta consegue explicar de onde saiu o total.\n` +
    `- RANKING POR ENTIDADE + VALOR TOTAL: se a pergunta for qual engenheiro/responsavel/empresa/bairro tem MAIOR ou MENOR valor total/investido no conjunto, agrupe pela entidade e use SUM(valor_total). NUNCA use MAX(valor_total) para esse pedido, porque MAX representa somente a maior obra individual. Use MAX apenas quando o usuario pedir explicitamente a maior obra/maior valor individual.\n` +
    `- RANKING POR QUANTIDADE: se a pergunta for qual engenheiro/responsavel/empresa/bairro tem mais ou menos obras, use COUNT(*) por entidade, GROUP BY, ORDER BY COUNT ASC/DESC e retorne sempre a entidade junto da contagem.\n` +
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
    `- Nao invente valores de status, nomes, bairros, engenheiros ou empresas; use os valores reais do schema/contexto.\n` +
    `- LIGACAO SEMANTICA: quando o usuario pedir uma CLASSE ou CONCEITO amplo (sigla, tipo de equipamento, servico ou categoria), nao filtre apenas a palavra literal. Considere abreviacoes, forma por extenso e sinonimos realmente equivalentes em portugues e compare com o CATALOGO DE OBJETOS REAIS. Use OR com ILIKE apenas para equivalencias semanticamente justificadas.\n` +
    `- AREA DA SAUDE: considere apenas equipamentos/servicos claramente de saude, como UBS/unidade basica de saude, posto de saude, PSF, hospital, policlinica, unidade de saude e academia da saude quando existirem no catalogo real. CRECHE e ESCOLA pertencem a educacao e NAO devem entrar como saude apenas por inferencia. Nunca invente nomes de equipamentos para completar uma categoria.\n` +
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

function aplicarGuardrailsNegocio(pergunta = "", historico = [], sql = "", ctx = null) {
  let s = limparSQL(sql);
  s = garantirUniversoNegocio(pergunta, historico, s);
  s = corrigirStatusPorUniverso(pergunta, historico, s, ctx);
  s = garantirUniversoNegocio(pergunta, historico, s); // revalida apos ajuste de status
  return limparSQL(s);
}

async function executarComSelfHealing({ pergunta, historico, ctx, sqlInicial }) {
  let sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, sqlInicial, ctx);
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
      sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, reparo.query, ctx);
      continue;
    }

    try {
      // Regra de negocio: campos do mesmo conjunto devem permanecer associados
      // na mesma linha. Se ainda restou UNION numa pergunta composta de universo
      // unico, tenta reparar antes de executar.
      if (pedidoCompostoMesmoUniverso(pergunta, validacao.sql) && tentativa < MAX_REPAROS) {
        const reparoNegocio = await repararSQL({
          pergunta,
          historico,
          ctx,
          sqlAtual: validacao.sql,
          erro: {
            tipo: "BusinessRuleError",
            mensagem: "Pedido composto do mesmo universo nao deve separar nomes e atributos por UNION. Retorne uma linha por registro com objeto + todos os campos pedidos e preserve o mesmo tipo_negocio em toda a SQL."
          },
        });
        const candidataNegocio = limparSQL(reparoNegocio.query);
        if (candidataNegocio && candidataNegocio !== validacao.sql) {
          sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, candidataNegocio, ctx);
          continue;
        }
      }

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
        sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, candidata, ctx);
        continue;
      }

      // Resultado vazio: pode ser correto. Faz no maximo os reparos configurados,
      // preservando esta consulta como melhor resultado caso as proximas piorem.
      if (tentativa >= MAX_REPAROS) break;
      const reparo = await repararSQL({ pergunta, historico, ctx, sqlAtual: validacao.sql, linhas: rows });
      const candidata = limparSQL(reparo.query);
      if (!candidata || candidata === validacao.sql) break;
      sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, candidata, ctx);
    } catch (e) {
      const diag = diagnosticoErroPG(e);
      tentativas.push({ tentativa, sql: validacao.sql, ok: false, erro: diag });
      if (tentativa >= MAX_REPAROS) break;
      const reparo = await repararSQL({ pergunta, historico, ctx, sqlAtual: validacao.sql, erro: diag });
      const candidata = limparSQL(reparo.query);
      if (!candidata || candidata === validacao.sql) break;
      sqlAtual = aplicarGuardrailsNegocio(pergunta, historico, candidata, ctx);
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
    engenheiro: "Responsável",
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
    total_pago: "Total pago",
    total_executado: "Total executado",
    total_investido: "Valor total",
    total_valor: "Valor total",
    soma_valor: "Valor total",
    custo_total: "Custo total",
    saldo_total: "Saldo total",
    valor_restante: "Valor restante",
  };
  return mapa[campo] || campo.replace(/_/g, " ");
}

function valorFallback(campo, valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (["valor_total", "valor_executado", "quanto_falta", "saldo_devedor", "aditivo"].includes(campo)) {
    const n = Number(valor);
    if (Number.isFinite(n)) {
      return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
    }
  }
  if (campo === "percentual_executado") {
    const n = Number(valor);
    if (Number.isFinite(n)) return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(n)}%`;
  }
  return String(valor);
}

function numeroParaAnalise(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;

  const bruto = String(valor).trim();
  if (!bruto) return null;

  // PostgreSQL normalmente entrega numeric como "503000.00". Tambem aceitamos
  // formatos brasileiros simples caso algum valor chegue como texto.
  let normalizado = bruto.replace(/\s/g, "").replace(/^R\$/i, "");
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(normalizado)) {
    normalizado = normalizado.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d+(?:,\d+)?$/.test(normalizado)) {
    normalizado = normalizado.replace(",", ".");
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

function formatarMoedaSegura(valor) {
  const n = numeroParaAnalise(valor);
  if (n === null) return null;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function campoPareceContagem(campo = "") {
  return /(?:^count$|count_|_count$|quantidade|qtd|total_(?:registros|encontrados|obras|projetos|licitacoes)|numero|n[uú]mero)/i.test(campo);
}

function campoParecePercentual(campo = "") {
  return /percent|porcent|taxa/i.test(campo);
}

function campoPareceFinanceiro(campo = "") {
  if (campoPareceContagem(campo) || campoParecePercentual(campo)) return false;
  return /(valor|invest|custo|gasto|pago|pagamento|executad|saldo|aditivo|contrapartida|restante|falta|orcamento|or[cç]amento|desembols)/i.test(campo);
}

function perguntaPedeContagem(pergunta = "") {
  const p = normalizar(pergunta);
  return /\b(quantos|quantas|quantidade|qtd|numero de|n[uú]mero de|total de (?:obras|projetos|licitacoes|licitações|registros|itens))\b/.test(p);
}

function perguntaPedeValorFinanceiro(pergunta = "") {
  const p = normalizar(pergunta);
  return /\b(quanto|valor|investid|pago|pagamento|pagou|executad|gasto|custo|saldo|restante|falta|desembols)\b/.test(p);
}

function decimalSomar(valores = []) {
  if (ClasseDecimal) {
    let total = new ClasseDecimal(0);
    for (const valor of valores) {
      const n = numeroParaAnalise(valor);
      if (n !== null) total = total.plus(String(n));
    }
    return total.toString();
  }

  let total = 0;
  for (const valor of valores) {
    const n = numeroParaAnalise(valor);
    if (n !== null) total += n;
  }
  return String(total);
}

async function analisarResultadoLocal(rows = []) {
  const status = await carregarBibliotecasAnalise();
  const lista = Array.isArray(rows) ? rows : [];

  let totalLinhas = lista.length;
  if (status.arquero && moduloArquero?.from) {
    try {
      totalLinhas = moduloArquero.from(lista).numRows();
    } catch (e) {
      console.warn("AGENTE SQL: Arquero falhou ao contar linhas; usando Array.length:", e?.message || e);
    }
  }

  const campos = [...new Set(lista.flatMap((r) => Object.keys(r || {})))];
  const somas = {};

  // Calcula apenas campos financeiros de linha (ex.: valor_total), evitando
  // aliases de agregado como total_investido, que podem se repetir em cada row.
  for (const campo of campos) {
    if (!campoPareceFinanceiro(campo)) continue;
    if (/^(?:total_|soma_|media_|avg_|sum_)/i.test(campo) && campo !== "valor_total") continue;

    const valores = lista.map((r) => r?.[campo]).filter((v) => numeroParaAnalise(v) !== null);
    if (!valores.length) continue;
    somas[campo] = decimalSomar(valores);
  }

  const agregados = {};
  for (const campo of campos) {
    if (!/^(?:total_|soma_|media_|avg_|sum_)/i.test(campo)) continue;
    const distintos = [...new Set(lista.map((r) => r?.[campo]).filter((v) => numeroParaAnalise(v) !== null).map(String))];
    if (distintos.length === 1) agregados[campo] = distintos[0];
  }

  const validacoes = [];
  if (somas.valor_total !== undefined) {
    for (const [campo, valor] of Object.entries(agregados)) {
      if (!/(invest|valor_total|total_invest|soma_valor)/i.test(campo)) continue;
      const calculado = numeroParaAnalise(somas.valor_total);
      const retornado = numeroParaAnalise(valor);
      if (calculado !== null && retornado !== null) {
        validacoes.push({
          agregado: campo,
          campo_base: "valor_total",
          confere: Math.abs(calculado - retornado) < 0.005,
          calculado: somas.valor_total,
          retornado: String(valor),
        });
      }
    }
  }

  return {
    total_linhas: totalLinhas,
    bibliotecas: status,
    somas_financeiras: somas,
    agregados_detectados: agregados,
    validacoes,
  };
}

function respostaFinanceiraDiretaSegura(pergunta = "", rows = []) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0] || {};
  if (r.objeto) return null;

  const p = normalizar(pergunta);
  const perguntaFinanceira = perguntaPedeValorFinanceiro(pergunta);

  // Regra geral: aliases como total_pago, total_executado, total_investido,
  // soma_valor etc. sao MEDIDAS financeiras, nunca quantidade de registros.
  // O alias generico "total" so e tratado como dinheiro quando a pergunta
  // claramente pede valor/quanto/pago/investido/executado/custo/saldo.
  const candidatos = Object.entries(r).filter(([campo, valor]) => {
    const nome = normalizar(campo);
    const ehFinanceiro = campoPareceFinanceiro(campo) || (perguntaFinanceira && nome === "total");
    return ehFinanceiro && numeroParaAnalise(valor) !== null;
  });
  if (candidatos.length !== 1) return null;

  const [campo, valor] = candidatos[0];
  const moeda = formatarMoedaSegura(valor);
  if (!moeda) return null;

  if (/\b(pago|pagamento|pagou|desembols)\b/.test(p)) return `O total já pago é ${moeda}.`;
  if (/\bexecutad/.test(p)) return `O total executado é ${moeda}.`;
  if (/\binvest/.test(p)) return `O valor total investido é ${moeda}.`;
  if (/\b(saldo|restante|falta)\b/.test(p)) return `O valor restante é ${moeda}.`;
  if (/\b(custo|gasto)\b/.test(p)) return `O valor total é ${moeda}.`;
  if (/\b(quanto|valor)\b/.test(p)) return `O valor total é ${moeda}.`;

  return `${rotuloHumano(campo)}: ${moeda}.`;
}

function tituloListaWhatsApp(pergunta = "", rows = []) {
  const p = normalizar(pergunta);
  const tipos = [...new Set((rows || []).map((r) => normalizar(r?.tipo_negocio || "")).filter(Boolean))];
  const n = Array.isArray(rows) ? rows.length : 0;

  let singular = "registro";
  let plural = "registros";
  const tipoUnico = tipos.length === 1 ? tipos[0] : "";

  if (tipoUnico === "obra" || /\bobras?\b/.test(p)) {
    singular = "obra";
    plural = "obras";
  } else if (tipoUnico === "projeto" || /\bprojetos?\b/.test(p)) {
    singular = "projeto";
    plural = "projetos";
  } else if (tipoUnico === "licitacao" || /\blicita(?:cao|coes)\b/.test(p)) {
    singular = "licitação";
    plural = "licitações";
  }

  const termo = n === 1 ? singular : plural;
  return `📋 *${n} ${termo} encontrado${n === 1 ? "" : "s"}*`;
}

function fallbackResposta(pergunta, rows = []) {
  if (!rows.length) return "Não encontrei registros que correspondam a essa pergunta nos dados atuais.";

  // Campos internos/repetitivos não devem poluir a leitura no WhatsApp.
  const camposTecnicosOcultos = new Set([
    "id", "objeto", "tipo_negocio", "subtipo_negocio", "aba_origem",
    "total_registros", "total_obras", "total_projetos", "total_licitacoes"
  ]);

  if (rows.length === 1) {
    const r = rows[0];
    const chavesVisiveis = Object.keys(r).filter((k) => !camposTecnicosOcultos.has(k));

    // Agregacoes com uma unica coluna devem sair diretas, sem nome tecnico.
    if (!r.objeto && chavesVisiveis.length === 1) {
      return `${valorFallback(chavesVisiveis[0], r[chavesVisiveis[0]]) ?? "Não informado"}`;
    }

    const linhas = [];
    if (r.objeto) linhas.push(`*${r.objeto}*`);
    for (const [k, v] of Object.entries(r)) {
      if (camposTecnicosOcultos.has(k)) continue;
      const fmt = valorFallback(k, v);
      if (fmt === null) continue;
      linhas.push(`• *${rotuloHumano(k)}:* ${fmt}`);
    }
    return linhas.join("\n") || "Encontrei o registro, mas não há detalhes adicionais informados.";
  }

  const exibidas = rows.slice(0, 20);
  const blocos = exibidas.map((r, i) => {
    const nome = r.objeto ? String(r.objeto) : null;
    const detalhes = Object.entries(r)
      .filter(([k, v]) => !camposTecnicosOcultos.has(k) && v !== null && v !== undefined && v !== "")
      .slice(0, 5)
      .map(([k, v]) => `• *${rotuloHumano(k)}:* ${valorFallback(k, v)}`);

    const linhas = [];
    if (nome) linhas.push(`*${i + 1}. ${nome}*`);
    else linhas.push(`*${i + 1}. Registro encontrado*`);
    linhas.push(...detalhes);
    return linhas.join("\n");
  });

  const titulo = tituloListaWhatsApp(pergunta, rows);
  const resto = rows.length > exibidas.length
    ? `\n\n… e mais ${rows.length - exibidas.length} registro${rows.length - exibidas.length === 1 ? "" : "s"}.`
    : "";

  return `${titulo}\n\n${blocos.join("\n\n")}${resto}`;
}

function respostaAgregadoComDimensaoSegura(pergunta = "", rows = []) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0] || {};
  if (r.objeto) return null;

  const ignorar = new Set(["id"]);
  const entradas = Object.entries(r).filter(([k, v]) =>
    !ignorar.has(k) && v !== null && v !== undefined && String(v).trim() !== ""
  );
  if (entradas.length < 2) return null;

  const medidas = entradas.filter(([k, v]) =>
    Number.isFinite(Number(v)) &&
    (/(?:^count$|count_|_count$|^total|total_|quantidade|qtd|valor|invest|executad|saldo|soma|media|avg|sum)/i.test(k))
  );
  const dimensoes = entradas.filter(([k]) => !medidas.some(([mk]) => mk === k));
  if (dimensoes.length !== 1 || medidas.length !== 1) return null;

  const [campoDim, valorDim] = dimensoes[0];
  const [campoMed, valorMed] = medidas[0];
  const p = normalizar(pergunta);
  const rotuloDim = rotuloHumano(campoDim);

  const ehContagem = /(?:count|quantidade|qtd|total_obras|numero_obras)/i.test(campoMed);
  if (ehContagem) {
    const n = Number(valorMed);
    if (!Number.isFinite(n)) return null;
    const plural = n === 1 ? "obra" : "obras";
    if (/\b(menos|menor)\b/.test(p)) return `${rotuloDim === "Engenheiro" ? "O engenheiro" : `O ${rotuloDim.toLowerCase()}`} com menos obras neste recorte é ${valorDim}, com ${n} ${plural}.`;
    if (/\b(mais|maior)\b/.test(p)) return `${rotuloDim === "Engenheiro" ? "O engenheiro" : `O ${rotuloDim.toLowerCase()}`} com mais obras neste recorte é ${valorDim}, com ${n} ${plural}.`;
    return `${rotuloDim}: ${valorDim} — ${n} ${plural}.`;
  }

  if (campoPareceFinanceiro(campoMed)) {
    const moeda = formatarMoedaSegura(valorMed);
    if (!moeda) return null;
    if (/\b(menos|menor)\b/.test(p)) return `${rotuloDim}: ${valorDim} — menor valor total neste recorte: ${moeda}.`;
    if (/\b(mais|maior)\b/.test(p)) return `${rotuloDim}: ${valorDim} — maior valor total neste recorte: ${moeda}.`;
    return `${rotuloDim}: ${valorDim} — ${rotuloHumano(campoMed)}: ${moeda}.`;
  }

  return null;
}

function respostaContagemDiretaSegura(pergunta = "", rows = []) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0] || {};
  if (r.objeto) return null;

  const p = normalizar(pergunta);
  const pedeContagem = perguntaPedeContagem(pergunta);

  // IMPORTANTE: nao aceite qualquer campo iniciado por "total" como contagem.
  // total_pago, total_executado, total_investido, total_valor etc. sao valores.
  // O alias generico "total" so vale como contagem se a pergunta pedir
  // explicitamente quantos/quantas/quantidade/numero de.
  const candidatos = Object.entries(r).filter(([k, v]) => {
    const nome = normalizar(k);
    const ehContagem = campoPareceContagem(k) || (pedeContagem && nome === "total");
    if (!ehContagem || campoPareceFinanceiro(k) || campoParecePercentual(k)) return false;
    return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  });
  if (candidatos.length !== 1) return null;

  // Se a linha tambem possui uma dimensao (engenheiro, empresa, bairro etc.),
  // NAO reduza a resposta a "Ha N obras". O nome da dimensao e parte da resposta.
  const campoMedida = candidatos[0][0];
  const temDimensao = Object.entries(r).some(([k, v]) =>
    k !== "id" && k !== campoMedida &&
    v !== null && v !== undefined && String(v).trim() !== ""
  );
  if (temDimensao) return null;

  const n = Number(candidatos[0][1]);
  if (/\bobras?\b/.test(p)) return n === 1 ? "Há 1 obra que corresponde a esses critérios." : `Há ${n} obras que correspondem a esses critérios.`;
  if (/\bprojetos?\b/.test(p)) return n === 1 ? "Há 1 projeto que corresponde a esses critérios." : `Há ${n} projetos que correspondem a esses critérios.`;
  if (/\blicita(?:cao|coes)\b/.test(p)) return n === 1 ? "Há 1 licitação que corresponde a esses critérios." : `Há ${n} licitações que correspondem a esses critérios.`;
  return n === 1 ? "Encontrei 1 registro com esses critérios." : `Encontrei ${n} registros com esses critérios.`;
}

async function redigirResposta(pergunta, historico, sql, rows, ctx, analiseDados = null, planoSemantico = null) {
  // Respostas triviais continuam locais para economizar tokens, EXCETO quando
  // a camada semantica sinalizou normalizacao/risco e a redacao precisa explicar.
  const forcarSemantica = analiseDados?.forcar_redacao_semantica === true;
  if (!forcarSemantica) {
    const agregadoComDimensao = respostaAgregadoComDimensaoSegura(pergunta, rows);
    if (agregadoComDimensao) return agregadoComDimensao;

    // Financeiro antes de contagem: total_pago nunca vira "registros".
    const financeiroSeguro = respostaFinanceiraDiretaSegura(pergunta, rows);
    if (financeiroSeguro) return financeiroSeguro;

    const contagemSegura = respostaContagemDiretaSegura(pergunta, rows);
    if (contagemSegura) return contagemSegura;
  }

  const amostra = rows.slice(0, MAX_LINHAS_PARA_IA);
  const prompt = `Voce e o redator final de um chatbot de obras publicas no WhatsApp.\n` +
    `Responda APENAS com base nos dados retornados pela consulta. Nao invente, nao estime e nao corrija valores por memoria.\n` +
    `Se o resultado estiver vazio, diga claramente que nao encontrou registros com os criterios.\n` +
    `Se for contagem/soma/ranking, destaque o resultado de forma direta e depois mostre os dados que sustentam a resposta em linguagem comum. EXPLICAR significa mostrar nomes, valores, status, responsaveis ou outros detalhes uteis dos registros; NAO significa explicar como o banco foi consultado.\n` +
    `AGREGADO COM DIMENSAO: se DADOS RETORNADOS trouxerem uma entidade junto de uma medida (ex.: engenheiro + total_obras, empresa + valor_total_obras, bairro + quantidade), cite SEMPRE os dois. Nunca responda somente o numero/valor e esconda a entidade.\n` +
    `DUAS MEDIDAS PEDIDAS: se o usuario pedir, por exemplo, valor investido E total executado, responda as duas separadamente. Se uma delas nao puder ser calculada porque todos os valores correspondentes vieram nulos/vazios, diga claramente que esse total nao pode ser calculado com os dados preenchidos; nao invente zero e nao assuma que obra concluida implica valor_executado = valor_total.\n` +
    `TIPO DA MEDIDA: aliases como total_pago, total_executado, total_investido, total_valor, soma_valor, custo_total e saldo_total sao VALORES FINANCEIROS e devem ser formatados em reais; nunca os chame de quantidade ou registros. COUNT/quantidade/qtd/total_registros/total_obras/total_projetos/total_licitacoes sao CONTAGENS.\n` +
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
    `FORMATO WHATSAPP: organize a resposta para leitura rapida no celular. NUNCA use tabela Markdown, pipes |, linhas --- ou cabecalho de tabela.\n` +
    `- Para listas com varios registros, comece com um titulo curto em negrito usando apenas um asterisco do WhatsApp, por exemplo: "📋 *15 projetos encontrados*".\n` +
    `- Separe cada registro com UMA linha em branco.\n` +
    `- Destaque o nome de cada obra/projeto/licitacao em negrito, por exemplo: "*1. Projeto X*".\n` +
    `- Mostre os detalhes em linhas separadas com marcadores: "• *Status:* ...", "• *Responsável:* ...", "• *Recurso:* ...".\n` +
    `- Nao amontoe nome, status, responsavel e recurso na mesma linha usando varios travessoes.\n` +
    `- Para respostas curtas (contagem, valor unico, sim/nao), seja direto e nao crie blocos desnecessarios.\n` +
    `- Use no maximo um emoji discreto no titulo; nao use emojis em cada linha.\n` +
    `Nao finalize com frases mecanicas como "nao ha mais registros" ou "nao foram encontrados outros registros"; apenas responda o que foi pedido.\n` +
    `NUNCA mostre ID/identificador interno. NUNCA escreva o nome tecnico da coluna "objeto". Use diretamente o nome da obra/projeto/licitacao.\n` +
    `Exemplo correto: "1. Reforma e ampliacao da UBS do Cristo Rei — Recurso: FEDERAL". Exemplo proibido: "1. id: 3 — objeto: Reforma...".\n` +
    `Diferencie obra, projeto e licitacao conforme os campos da view/tabela. Se tipo_negocio='licitacao', chame os registros de licitacoes, nunca de obras.\n` +
    `PERCENTUAL: percentual_executado e percentual de EXECUCAO. Escreva sempre 'X% executado' ou 'X% de execucao'. NUNCA escreva 'X% concluido' para uma obra que ainda esta em andamento.\n` +
    `STATUS REAL: se status_original vier no resultado, ele e a descricao real da origem e deve ser preferido ao rotulo generico status. Isso vale especialmente para projetos e licitacoes e para status especificos de obras.\n` +
    `OBRAS: em_andamento_obra/concluido servem para FILTRAR o ciclo da obra; na resposta ao usuario, mostre o texto humano de status_original quando ele estiver disponivel.\n` +
    `Recurso e tipo_recurso sao campos diferentes; nao troque um pelo outro.\n` +
    `Nao mostre SQL ao usuario na resposta natural.\n\n` +
    `PLANO SEMANTICO (use para manter o significado exato da pergunta):\n${jsonSeguro(planoSemantico || {}, 5000)}\n\n` +
    `NOTA DE NORMALIZACAO/QUALIDADE: ${textoSeguro(analiseDados?.nota_normalizacao || "", 1000)}\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n` +
    `HISTORICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `SQL EXECUTADA: ${sql}\n` +
    `TOTAL DE LINHAS RETORNADAS: ${rows.length}\n` +
    `ANALISE LOCAL NODE/ARQUERO/DECIMAL (auxiliar; nao invente dados):\n${jsonSeguro(analiseDados || {}, 4000)}\n` +
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

function estadoPublico(ctx, execucao, analiseDados = null) {
  const primeira = execucao.rows?.[0] || {};
  return {
    fonte: `public.${ctx.relacao}`,
    sql: execucao.sql,
    linhas: execucao.rows?.length || 0,
    colunas_resultado: Object.keys(primeira).slice(0, 30),
    early_accept: execucao.earlyAccept === true,
    reparos_usados: Math.max(0, Number(execucao.tentativa || 0)),
    analise_dados: analiseDados ? {
      arquero_ativo: !!analiseDados?.bibliotecas?.arquero,
      decimal_ativo: !!analiseDados?.bibliotecas?.decimal,
      total_linhas_conferido: analiseDados?.total_linhas ?? (execucao.rows?.length || 0),
      validacoes: analiseDados?.validacoes || [],
    } : null,
  };
}

// ------------------------------------------------------------
// Fluxo principal V14 semantico
// ------------------------------------------------------------
export async function responderPergunta(pergunta, historico = []) {
  const texto = textoSeguro(pergunta, 1600);
  if (!texto) return { resposta: "Pode enviar sua pergunta sobre as obras?", erro: "pergunta_vazia" };

  const social = respostaSocial(texto, historico);
  if (social) return { resposta: social, social: true, modoAgente: "social" };

  try {
    const ctx = await carregarSchemaContexto();

    // DIN-SQL: primeiro entende a pergunta e faz schema linking; so depois gera SQL.
    const plano = await planejarConsultaSemantica(texto, historico, ctx);
    console.log("SQL AGENT - PLANO SEMANTICO:", jsonSeguro(plano, 5000));

    if (plano.clarification?.needed && plano.clarification?.question) {
      return {
        resposta: plano.clarification.question,
        erro: null,
        modoAgente: "sql_agent_semantic_v14_clarification",
        plano: {
          intent: plano.intent,
          universes: plano.universes,
          confidence: plano.confidence,
        },
      };
    }

    // DAIL-SQL + CHASE-SQL lite: exemplos relevantes, um ou dois caminhos e
    // selecao pelo quanto a consulta/resultado realmente responde ao plano.
    const pipeline = await executarPipelineSemantico({ pergunta: texto, historico, ctx, plano });
    const escolhido = pipeline.candidato;
    const execucao = escolhido.execucao;

    console.log("SQL AGENT - SQL FINAL:", execucao.sql);
    console.log(
      "SQL AGENT - LINHAS:", execucao.rows.length,
      "| REPAROS:", execucao.tentativa || 0,
      "| SCORE SEMANTICO:", escolhido.score,
      "| VEREDITO:", escolhido.semantica?.verdict || "local"
    );

    // Quando a propria base mistura tipos de dado em um campo (ex.: bairro +
    // endereco), normaliza apenas o que estiver explicitamente escrito. Isso
    // evita chamar endereco de bairro sem criar regex por pergunta.
    const normalizado = await normalizarResultadoSemanticoSeNecessario({
      pergunta: texto,
      plano,
      rows: execucao.rows,
      avaliacao: escolhido.semantica,
    });

    const rowsResposta = normalizado.rows;
    const analiseDados = await analisarResultadoLocal(rowsResposta);
    analiseDados.plano_semantico = {
      intent: plano.intent,
      universes: plano.universes,
      expected_result: plano.expected_result,
      confidence: plano.confidence,
    };
    analiseDados.avaliacao_semantica = {
      score: escolhido.score,
      verdict: escolhido.semantica?.verdict || "local",
      reason: escolhido.semantica?.reason || "",
    };
    analiseDados.nota_normalizacao = normalizado.note || "";
    analiseDados.forcar_redacao_semantica = normalizado.changed === true || escolhido.semantica?.normalization_needed === true;

    const resposta = await redigirResposta(
      texto,
      historico,
      execucao.sql,
      rowsResposta,
      ctx,
      analiseDados,
      plano
    );

    return {
      resposta,
      sql: execucao.sql,
      linhas: execucao.rows.length,
      linhas_resposta: rowsResposta.length,
      estado: {
        ...estadoPublico(ctx, execucao, analiseDados),
        semantic_score: escolhido.score,
        semantic_verdict: escolhido.semantica?.verdict || "local",
        normalizacao_aplicada: normalizado.changed === true,
      },
      reparos: execucao.tentativa || 0,
      earlyAccept: !!execucao.earlyAccept,
      tentativas: execucao.tentativas,
      candidatos: (pipeline.candidatos || []).map((c) => ({
        variante: c.variante,
        score: c.score || 0,
        sql: c.execucao?.sql || c.gerada?.query || null,
        erro: c.erro || null,
        verdict: c.semantica?.verdict || null,
      })),
      plano: {
        intent: plano.intent,
        universes: plano.universes,
        expected_result: plano.expected_result,
        confidence: plano.confidence,
      },
      modoAgente: "sql_agent_semantic_v14_din_dail_chase",
    };
  } catch (e) {
    console.error("SQL AGENT: falha final:", e);
    return {
      resposta: "Tive um problema ao consultar os dados agora. Tente novamente em instantes.",
      erro: e.message,
      modoAgente: "sql_agent_semantic_v14_erro",
    };
  }
}
