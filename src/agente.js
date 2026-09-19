// ============================================================
//  agente.js
//  Agente conversacional de analytics. Fluxo padrao de 2 chamadas:
//    1) IA recebe a PERGUNTA + o schema da tabela -> gera SQL
//    2) Validamos a SQL (so SELECT, bloqueia comandos perigosos)
//    3) Executamos no banco
//    4) IA recebe o RESULTADO -> escreve a resposta em portugues
//
//  Na primeira chamada a IA ve schema REAL + metadados + memoria e produz a consulta.
//  Na segunda, recebe pergunta + memoria + SQL + linhas retornadas e interpreta a resposta.
//  Os calculos continuam sendo feitos pelo PostgreSQL.
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js"; // reaproveita a chamada de IA que ja existe

// Descricao da tabela que a IA recebe (o "schema"). Se mudar a
// tabela, atualize aqui.
const SCHEMA = `
Tabela PostgreSQL: obras
Colunas: id, objeto, bairro, status, categoria, valor_total, valor_executado,
percentual_executado, engenheiro, empresa, aba_origem, dados_extras(JSONB).
Regras de dados:
- objeto = nome da obra; engenheiro = responsavel; empresa = executora.
- valor_total/valor_executado sao numeros e podem ser NULL.
- Para texto, prefira unaccent(campo) ILIKE unaccent('%termo%').
- Status pode variar em acentos; filtre por trecho com unaccent/ILIKE.
- aba_origem/categoria distinguem OBRAS, PROJETOS, PAVIMENTACAO e LICITACAO.
- "obra em andamento" NAO e a mesma coisa que "habilitacao em andamento".
- dados_extras pode conter "STATUS ORIGINAL", preservando a etapa exata escrita na planilha.
- RECURSO, CONTRATO, CONVENIO, ADITIVO, PRAZO, DATAS e campos nao listados ficam
  em dados_extras. Para esses casos selecione objeto, dados_extras; nao invente
  chaves JSON.
`;

// Complementa o schema de negocio acima com a estrutura REAL encontrada no
// Supabase. Isso evita que uma alteracao de tipo/coluna no banco fique invisivel
// para o agente. O cache reduz custo e conexoes durante conversas seguidas.
let cacheSchemaBanco = { texto: "", quando: 0 };
const CACHE_SCHEMA_MS = 5 * 60 * 1000;

async function contextoAtualDoBanco() {
  const agora = Date.now();
  if (cacheSchemaBanco.texto && agora - cacheSchemaBanco.quando < CACHE_SCHEMA_MS) {
    return cacheSchemaBanco.texto;
  }

  try {
    // Colunas de texto que valem como CATEGORIA filtravel. Listamos os valores
    // reais de cada uma para a IA nao precisar adivinhar (ex.: saber que existe
    // o bairro "Cristo Rei" evita WHERE bairro ILIKE '%cristo do rei%").
    const COLUNAS_CATEGORICAS = ["status", "categoria", "bairro", "engenheiro", "empresa", "aba_origem"];
    const consultaValores = COLUNAS_CATEGORICAS
      .map((c) =>
        `SELECT '${c}' AS coluna, ${c}::text AS valor, COUNT(*)::int AS quantidade ` +
        `FROM obras WHERE ${c} IS NOT NULL AND BTRIM(${c}::text) <> '' GROUP BY ${c}`
      )
      .join(" UNION ALL ");

    const [colunas, valores, extras, totais] = await Promise.all([
      queryReadOnly(
        "SELECT column_name, data_type, is_nullable " +
        "FROM information_schema.columns " +
        "WHERE table_schema = current_schema() AND table_name = 'obras' " +
        "ORDER BY ordinal_position"
      ),
      queryReadOnly(`SELECT * FROM (${consultaValores}) v ORDER BY coluna, quantidade DESC`),
      queryReadOnly(
        "SELECT chave FROM (" +
        "SELECT DISTINCT jsonb_object_keys(COALESCE(dados_extras, '{}'::jsonb)) AS chave " +
        "FROM obras) x ORDER BY chave LIMIT 80"
      ),
      queryReadOnly(
        "SELECT COUNT(*)::int AS total, " +
        "COUNT(valor_total)::int AS com_valor, " +
        "COALESCE(SUM(valor_total),0)::numeric AS soma_valor FROM obras"
      ),
    ]);

    // --- CLASSIFICADOR DE COLUNAS ---
    // Separa o que e NUMERO (agregavel com SUM/AVG) do que e CATEGORIA
    // (filtravel com ILIKE/=). Isso torna a geracao de SQL bem mais precisa.
    const TIPOS_NUMERICOS = ["integer", "bigint", "numeric", "double precision", "real", "smallint"];
    const porColuna = new Map();
    for (const linha of valores.rows) {
      if (!porColuna.has(linha.coluna)) porColuna.set(linha.coluna, []);
      porColuna.get(linha.coluna).push(linha);
    }

    const linhasColunas = colunas.rows.map((c) => {
      const nome = c.column_name;
      const ehNumero = TIPOS_NUMERICOS.includes((c.data_type || "").toLowerCase());
      if (ehNumero) {
        return `- ${nome} [NUMERO - use SUM/AVG/MIN/MAX, nunca ILIKE]`;
      }
      if (nome === "dados_extras") {
        return `- ${nome} [JSONB - campos livres; leia com dados_extras->>'CHAVE']`;
      }
      const lista = porColuna.get(nome);
      if (lista && lista.length) {
        const totalDistintos = lista.length;
        const amostra = lista
          .slice(0, 25)
          .map((v) => `${v.valor} (${v.quantidade})`)
          .join(", ");
        const reticencias = totalDistintos > 25 ? `, ... (+${totalDistintos - 25})` : "";
        return `- ${nome} [CATEGORIA - ${totalDistintos} valores distintos] valores reais: ${amostra}${reticencias}`;
      }
      return `- ${nome} [TEXTO LIVRE - use unaccent+ILIKE com termo curto]`;
    });

    const textoExtras = extras.rows.map((e) => e.chave).join(" | ");
    const t = totais.rows[0] || {};

    const texto = `
METADADOS REAIS DO BANCO (gerados automaticamente a cada leitura):
Total de obras cadastradas: ${t.total ?? "?"} (com valor preenchido: ${t.com_valor ?? "?"})

CLASSIFICACAO DAS COLUNAS:
${linhasColunas.join("\n") || "(nenhuma coluna encontrada)"}

Chaves disponiveis em dados_extras: ${textoExtras || "(nenhuma)"}

COMO USAR ESTES METADADOS:
- Para filtrar CATEGORIA, use EXATAMENTE um dos valores reais listados acima.
  Se o cidadao escrever diferente (ex.: "Cristo do Rei"), escolha o valor real
  mais parecido da lista (ex.: "Cristo Rei"). Nao invente valor que nao esta la.
- Para NUMERO use SUM/AVG/COUNT; nunca compare numero com ILIKE.
- Consulte SOMENTE a tabela obras.`;

    cacheSchemaBanco = { texto, quando: agora };
    return texto;
  } catch (e) {
    console.error("AGENTE: nao foi possivel carregar metadados do banco:", e.message);
    return "(metadados dinamicos indisponiveis; use o schema de negocio acima)";
  }
}

// --- SEGURANCA: valida a SQL antes de executar ---
const PALAVRAS_PROIBIDAS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "grant", "revoke", "replace", "merge", "call", "execute", "copy", "vacuum",
  "analyze", "refresh", "cluster", "reindex", "listen", "notify", "load",
  "begin", "commit", "rollback", "savepoint", "into", "lock",
];

// O agente precisa apenas destas funcoes para consultar a tabela de obras.
// Qualquer outra chamada e rejeitada, mesmo que seja tecnicamente um SELECT.
const FUNCOES_PERMITIDAS = new Set([
  "count", "sum", "avg", "min", "max", "round", "coalesce", "nullif",
  "unaccent", "lower", "upper", "trim", "btrim", "length", "abs", "greatest", "least",
]);

function semLiterais(sql) {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

// Checa se o SQL parece COMPLETO (nao foi cortado pela IA no meio).
// Pega tres tipos de corte: aspas abertas, parenteses desbalanceados, e o
// SQL terminando numa palavra que nao pode ser o fim (OR, AND, ILIKE...) -
// esse ultimo caso causava o "syntax error at or near LIMIT".
function sqlCompleta(s) {
  if (!s) return false;
  const aspasOk = ((s.match(/'/g) || []).length % 2) === 0;
  if (!aspasOk) return false;
  const parOk = (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;
  if (!parOk) return false;
  const fim = s.replace(/;$/, "").trim().toLowerCase();
  const terminaMal = /(\bor|\band|\bwhere|\bilike|\blike|\bunaccent|\bfrom|\bselect|\bon|\bin|=|,|\()$/.test(fim);
  if (terminaMal) return false;
  return true;
}

export function sqlSegura(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    return { ok: false, motivo: "SQL vazio" };
  }
  const s = sql.toLowerCase().trim();
  const estrutural = semLiterais(s);
  // Tem que comecar com SELECT
  if (!/^select\b/.test(s)) return { ok: false, motivo: "so SELECT e permitido" };
  // Comentarios podem esconder uma segunda intencao e nunca sao necessarios.
  if (/--|\/\*|\*\/|#/.test(estrutural)) {
    return { ok: false, motivo: "comentarios SQL nao sao permitidos" };
  }
  // Nao pode ter palavra proibida
  for (const p of PALAVRAS_PROIBIDAS) {
    if (new RegExp(`\\b${p}\\b`, "i").test(estrutural)) {
      return { ok: false, motivo: `comando proibido: ${p}` };
    }
  }
  // So uma instrucao (sem ; no meio)
  const semFinal = s.endsWith(";") ? s.slice(0, -1) : s;
  if (semFinal.includes(";")) return { ok: false, motivo: "multiplas instrucoes" };
  // O cidadao so pode consultar a tabela/view publica de obras. Isso impede
  // prompt injection tentando ler outras tabelas, usuarios ou catalogos.
  if (/\b(?:pg_catalog|information_schema|pg_[a-z0-9_]*)\b/i.test(estrutural)) {
    return { ok: false, motivo: "catalogos internos nao sao permitidos" };
  }
  if (/\b(?:current_user|session_user|current_role|current_catalog|current_schema)\b/i.test(estrutural)) {
    return { ok: false, motivo: "identidade/configuracao do banco nao e permitida" };
  }
  if (/\bjoin\b/i.test(estrutural)) {
    return { ok: false, motivo: "JOIN nao e necessario para consultar obras" };
  }
  const referencias = [...estrutural.matchAll(/\bfrom\s+([a-z_][a-z0-9_.]*)/gi)]
    .map((m) => m[1].replace(/^public\./i, ""));
  if (referencias.length === 0 || referencias.some((t) => t !== "obras")) {
    return { ok: false, motivo: "a consulta so pode usar a tabela obras" };
  }
  // Bloqueia funcoes fora da allowlist. Palavras estruturais podem aparecer
  // imediatamente antes de parenteses sem serem chamadas de funcao, por
  // exemplo: WHERE (...), AND (...), OR (...) e NOT (...). Elas precisam ser
  // ignoradas aqui; as demais barreiras continuam validando a consulta.
  const palavrasEstruturais = new Set([
    "in", "exists", "select", "case", "when", "then", "else",
    "where", "and", "or", "not", "having", "on",
    "group", "order", "limit", "offset", "distinct",
  ]);
  const funcoes = [...estrutural.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((f) => !palavrasEstruturais.has(f));
  const funcaoNegada = funcoes.find((f) => !FUNCOES_PERMITIDAS.has(f));
  if (funcaoNegada) {
    return { ok: false, motivo: `funcao nao permitida: ${funcaoNegada}` };
  }
  // Detecta SQL TRUNCADO (cortado no meio pela IA). Sem isso, um SELECT
  // cortado vira erro de sintaxe no banco (ex.: "syntax error at LIMIT").
  if (!sqlCompleta(sql)) return { ok: false, motivo: "SQL truncado (incompleto)" };
  return { ok: true };
}

// Garante um LIMIT para nao trazer dados demais.
export function comLimite(sql, max = 200) {
  const teto = Math.max(1, Math.min(Number(max) || 200, 200));
  const s = sql.trim().replace(/;$/, "").trim();

  // PRESERVA limites menores definidos pela consulta. Antes, LIMIT 1 era
  // removido e trocado por LIMIT 200; por isso uma pergunta de "maior percentual"
  // executava varias linhas mesmo exibindo SQL com LIMIT 1. Isso tambem quebrava
  // paginacao LIMIT 10 OFFSET N.
  const m = s.match(/\s+limit\s+(all|\d+)(?:\s+offset\s+(\d+))?\s*$/i);
  if (m) {
    const base = s.slice(0, m.index).trim();
    const solicitado = m[1].toLowerCase() === "all" ? teto : Math.max(1, Number(m[1]));
    const limite = Math.min(solicitado, teto);
    const offset = m[2] ? ` OFFSET ${Number(m[2])}` : "";
    return `${base} LIMIT ${limite}${offset}`;
  }

  return `${s} LIMIT ${teto}`;
}

// Monta o contexto conversacional para a IA, no estilo do chatbot do artigo.
// Envia as ultimas 6 mensagens e preserva a SQL usada nas respostas anteriores.
// Isso permite follow-ups como "quais sao?", "e dessas, qual o valor?" e
// "agora so as do Centro" sem depender de regex fixa para entender a conversa.
function resumoHistorico(historico = []) {
  if (!Array.isArray(historico) || historico.length === 0) return "(sem contexto anterior)";

  return historico.slice(-6).map((m) => {
    const quem = m.role === "user" ? "USUARIO" : "ASSISTENTE";
    const txt = (m.content || "").toString().replace(/\s+/g, " ").trim().slice(0, 260);
    const sqlAnterior = m.role === "assistant" && m.sql
      ? `\nSQL_USADA: ${(m.sql || "").toString().replace(/\s+/g, " ").trim().slice(0, 500)}`
      : "";
    return `${quem}: ${txt}${sqlAnterior}`;
  }).join("\n");
}

// ------------------------------------------------------------
//  CAMINHO RAPIDO SEM IA
//  Resolve as perguntas mais comuns diretamente em SQL.
//  Isso evita gastar tokens para coisas simples e preserva o contexto.
// ------------------------------------------------------------
function normalizarTexto(s = "") {
  return s.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
}

function ultimaSQLDoHistorico(historico = []) {
  if (!Array.isArray(historico)) return "";
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "assistant" && historico[i]?.sql) {
      return historico[i].sql.toString();
    }
  }
  return "";
}

function whereDaSQL(sql = "") {
  const limpa = sql.replace(/;$/, "").replace(/\s+limit\s+\d+(?:\s+offset\s+\d+)?\s*$/i, "");
  const m = limpa.match(/\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i);
  return m ? `WHERE ${m[1].trim()}` : "";
}

function filtroStatusDaPergunta(p) {
  if (/\b(concluid[ao]s?|pront[ao]s?|finalizad[ao]s?|terminad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%conclu%')";
  // A ingestao padroniza "Em execucao" como "Em andamento" para obras/pavimentacoes.
  if (/\b(em andamento|andamento|em execucao|execucao|executando|sendo feit[ao]s?|tocando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%andamento%')";
  if (/\b(em licitacao|licitacao|licitando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%licita%')";
  if (/\b(em projeto)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%projeto%')";
  if (/\b(paralisad[ao]s?|paradas?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%paralis%')";
  if (/\b(a iniciar|nao iniciad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%iniciar%')";
  if (/\b(homologad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%homolog%')";
  return "";
}

function filtroEscopoDaPergunta(p) {
  // O tipo pedido pelo cidadao precisa respeitar a origem da planilha.
  // Isso evita misturar projeto/licitacao com obra fisica so porque o texto do
  // status contem palavras parecidas.
  if (/\bprojetos?\b/.test(p)) return "aba_origem = 'EM_PROJETO'";
  if (/\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p)) return "aba_origem = 'EM_LICITAÇÃO'";
  if (/\bpaviment(?:acao|acoes|ar|ada|adas|ado|ados)?\b/.test(p)) return "aba_origem = 'PAVIMENTAÇÃO'";
  return "";
}

function ehPerguntaGenericaObrasEmAndamento(p) {
  return /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p) &&
    /\bobras?\b/.test(p) &&
    /\b(em andamento|andamento)\b/.test(p) &&
    !/\bprojetos?\b/.test(p) &&
    !/\b(licitacoes?|licitacao)\b/.test(p) &&
    !/\bpaviment/.test(p);
}

// Identifica quando a pessoa esta falando de UM item pelo nome (rua, creche,
// escola, mercado etc.). Nesses casos, nao devemos reduzir a pergunta ao bairro
// final do nome (ex.: "Rua do Cruzeiro - Centro" nao significa "todas do Centro").
function pareceItemEspecifico(p) {
  const temEntidade = /\b(rua|avenida|creche|escola|mercado|ubs|posto|ponte|praca|quadra|hospital|campo|drenagem|muro|iluminacao|terminal|calcadao|estadio|biblioteca|galpao|passarela|ciclovia|orla|estacao|cemiterio)\b/.test(p);
  // Aceita singular/plural e palavras completas. Antes "engenheiro" nao casava
  // com o trecho "engenheir", fazendo perguntas duplas como
  // "recurso e engenheiro da UBS X" cair no filtro errado de profissional.
  const pedeCampo = /\b(valores?|quanto|responsaveis?|engenheir[oa]s?|arquit(?:eto|eta|etos|etas)?|empresas?|contratos?|convenios?|recursos?|status|situacao|percentual|porcentagem|executad[oa]s?|prazo|datas?|detalh\w*|informac\w*)\b/.test(p);
  return temEntidade && pedeCampo;
}

// Extrai um nome de profissional quando a pergunta usa algo como
// "obras do engenheiro Ricardo Sousa". O filtro e dinamico: nenhum nome fica
// fixo no codigo.
function condicaoEngenheiroDaPergunta(p) {
  // Captura somente o NOME do profissional. Primeiro pega o texto depois do
  // titulo (Eng./Arq./responsavel) e depois corta assim que aparece uma palavra
  // que pertence a PERGUNTA, nao ao nome. Isso evita filtros errados como
  // "%paulo nunes estao%" ou "%paulo nunes tem o maior percentual%".
  const m = p.match(/\b(?:engenheir[oa]|eng|arquiteto|arquiteta|arq|responsavel(?: tecnico)?)\.?\s+([a-z][a-z .'-]{2,100})/i);
  if (!m) return "";

  let nome = (m[1] || "").trim();

  // "engenheiro" tambem pode ser o CAMPO que o cidadao quer saber, e nao o
  // inicio do nome de um profissional. Ex.: "recurso e o engenheiro da Reforma
  // da UBS do Cristo Rei". Nesses casos nao criamos filtro de engenheiro.
  if (/^(?:(?:da|do|de)\s+)?(?:reforma|ampliacao|construcao|pavimentacao|obra|projeto|rua|avenida|ubs|creche|escola|mercado|posto|praca|quadra|hospital|drenagem|muro|iluminacao|terminal|calcadao|ciclovia|orla)\b/i.test(nome)) {
    return "";
  }

  nome = nome.split(/\s+\b(?:tem|possui|acompanha|acompanham|esta|estao|estava|estavam|fica|ficam|sao|com|que|no|na|em|das?|dos?|pel[oa]|obras?|projetos?|pavimentacoes?|licitacoes?|status|situacao|valor|maior|menor|mais|qual|percentual|porcentagem|execucao|executad[oa]s?|concluid[oa]s?|andamento)\b/i)[0];
  nome = nome
    .replace(/\b(?:das?|dos?|de)\s*$/i, "")
    .replace(/[^a-z .'-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!nome || nome.length < 3) return "";
  const seguro = nome.replace(/'/g, "''");
  return `unaccent(COALESCE(engenheiro,'')) ILIKE unaccent('%${seguro}%')`;
}

// Contagem generica por TIPO. Serve para perguntas como "quantas obras no
// Centro?" ou "quantas obras concluidas?" sem chamar projeto/licitacao de obra.
function sqlContagemPorTipo(filtroLocal = "", filtroStatus = "") {
  const globais = [filtroLocal, filtroStatus].filter(Boolean);
  const where = globais.length ? `WHERE ${globais.join(" AND ")}` : "";
  return `SELECT ` +
    `SUM(CASE WHEN aba_origem = 'EM_ANDAMENTO' THEN 1 ELSE 0 END)::int AS obras, ` +
    `SUM(CASE WHEN aba_origem = 'PAVIMENTAÇÃO' THEN 1 ELSE 0 END)::int AS pavimentacoes, ` +
    `SUM(CASE WHEN aba_origem = 'EM_PROJETO' THEN 1 ELSE 0 END)::int AS projetos, ` +
    `SUM(CASE WHEN aba_origem = 'EM_LICITAÇÃO' THEN 1 ELSE 0 END)::int AS licitacoes, ` +
    `SUM(CASE WHEN aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO') THEN 1 ELSE 0 END)::int AS obras_e_pavimentacoes, ` +
    `COUNT(*)::int AS total_registros_relacionados FROM obras ${where}`;
}

function condicaoLocalDaPergunta(p) {
  // Captura locais escritos de forma natural:
  // "no Centro", "na Bela Vista", "em Barra de Mamanguape" e "bairro Centro".
  // A regra procura o ULTIMO local da frase e trata o status separadamente.
  // Assim funcionam tanto:
  //   "obras em andamento existem em Nova Mamanguape"
  // quanto:
  //   "obras em Nova Mamanguape em andamento".
  let local = "";
  let bairroExplicito = false;
  const statusFinal = /\b(concluidas?|concluidos?|prontas?|prontos?|finalizadas?|finalizados?|terminadas?|terminados?|em andamento|paralisadas?|paralisados?|em licitacao|homologadas?|homologados?)\b\s*$/i;

  const limparLocal = (valor = "") => valor
    .replace(statusFinal, "")
    .replace(/^(?:bairro|distrito)\s+(?:de\s+|do\s+|da\s+)?/i, "")
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Caso explicito: "bairro Centro", "bairro de Nova Mamanguape" etc.
  const mb = p.match(/\bbairro\s+(?:de\s+|do\s+|da\s+)?([a-z0-9][a-z0-9 -]{1,60})$/i);
  if (mb) {
    local = limparLocal(mb[1]);
    bairroExplicito = true;
  }

  const extrairUltimoNoNaEm = (texto) => {
    // .* e guloso de proposito: escolhe o ULTIMO no/na/em da frase.
    const m = texto.match(/.*\b(?:no|na|em)\s+([a-z0-9][a-z0-9 -]{1,60})$/i);
    return m ? limparLocal(m[1]) : "";
  };

  if (!local) local = extrairUltimoNoNaEm(p);

  // Se o ultimo "em" era o proprio status ("... em andamento"), removemos o
  // status do fim e tentamos de novo para recuperar o bairro imediatamente antes.
  if (!local || /^(andamento|execucao|licitacao|projeto|homologada?|paralisada?)$/i.test(local)) {
    const semStatusFinal = p.replace(/\s+\b(concluidas?|concluidos?|prontas?|prontos?|finalizadas?|finalizados?|terminadas?|terminados?|em andamento|paralisadas?|paralisados?|em licitacao|homologadas?|homologados?)\b\s*$/i, "").trim();
    local = extrairUltimoNoNaEm(semStatusFinal);
  }

  if (!local || local.length < 2 || local.length > 60) return "";

  // Palavras da propria pergunta NAO sao local. Sem esta barreira, frases como
  // "em andamento com obra, bairro, valor e percentual" podiam virar um bairro
  // falso, e follow-ups como "qual o bairro dela?" tentavam procurar "dela".
  const naoEhLocal = /\b(andamento|execucao|executad[oa]s?|licitacao|projeto|total|geral|tudo|cidade|obras?|obra|valor|valores|percentual|porcentagem|engenheir[oa]?|arquiteto|arquiteta|responsavel|responsaveis|empresa|empresas|status|situacao|com|dela|dele|delas|deles|nela|nele|essa|esse|essas|esses|ela|ele)\b/i;
  if (naoEhLocal.test(local)) return "";

  // Se o cidadao escreveu explicitamente "bairro X", respeitamos exatamente
  // o campo BAIRRO. Isso evita incluir uma obra de outro bairro apenas porque
  // o nome/objeto contem a palavra procurada (ex.: "Ligacao Centro - Aldeia").
  if (bairroExplicito) {
    return `unaccent(COALESCE(bairro,'')) ILIKE unaccent('%${local}%')`;
  }

  // Em perguntas mais naturais como "obras no Centro", o objeto continua como
  // apoio para abas antigas em que o local pode aparecer somente no nome da obra.
  return `(unaccent(COALESCE(bairro,'')) ILIKE unaccent('%${local}%') OR unaccent(objeto) ILIKE unaccent('%${local}%'))`;
}

function gerarSQLRapida(pergunta, historico = []) {
  const p = normalizarTexto(pergunta);
  if (!p) return null;

  const sqlAnterior = ultimaSQLDoHistorico(historico);
  const whereAnterior = whereDaSQL(sqlAnterior);
  const condAnterior = whereAnterior.replace(/^WHERE\s+/i, "").trim();

  // PAGINACAO: "mostrar mais", "mais 10", "proximas", "ver mais obras".
  // Reaproveita o filtro da consulta anterior e pula as que ja foram mostradas.
  // Conta quantas ja apareceram somando os blocos de 10 pedidos antes.
  const pedeMais = /\b(mais\s+\d*\s*obras?|mostrar? mais|ver mais|proxim|seguintes?|continua|continuar|mais 10|outras? 10)\b/.test(p);
  if (pedeMais && condAnterior) {
    // conta quantas vezes o cidadao ja pediu "mais" nesta sequencia
    let jaMostrou = 10; // o primeiro bloco (as 10 primeiras)
    for (let i = historico.length - 1; i >= 0; i--) {
      const h = historico[i];
      if (h?.role === "user") {
        const t = normalizarTexto(h.content || "");
        if (/\b(mais|mostrar? mais|ver mais|proxim|seguintes?|continua)\b/.test(t)) jaMostrou += 10;
        else if (!/\b(primeir|todas|todos)\b/.test(t)) break;
      }
    }
    return `SELECT objeto, valor_total FROM obras WHERE ${condAnterior} ORDER BY objeto LIMIT 10 OFFSET ${jaMostrou}`;
  }

  const referenciaAnterior = /\b(dessas?|destas?|nessas?|nestas?|delas?|essas?|elas?|anteriores?|acima|mesmas?|isso)\b/.test(p);
  const perguntaCurtaLista = /^(?:e\s+)?quais(?:\s+sao)?$|^(?:lista|liste|mostra|mostre)(?:\s+(?:elas|essas|as obras))?$/.test(p);
  const curtaDeAcompanhamento = p.split(" ").length <= 7 && (
    /\b(engenheiros?|engenheiras?|responsaveis?|empresas?|executoras?|valor|valores|custo|bairro|status|situacao|nomes?)\b/.test(p) ||
    perguntaCurtaLista
  );

  // Follow-up de UM item que acabou de ser escolhido por ranking (maior valor,
  // maior percentual etc.). Reaproveitamos a MESMA ordenacao + LIMIT 1 da SQL
  // anterior. Assim "qual o bairro dela?" continua apontando exatamente para a
  // obra vencedora, em vez de abrir novamente todas as obras do responsavel.
  const referenciaMesmoItem = /\b(dela|dele|nela|nele|essa|esse|esta obra|este projeto|esse item|essa obra)\b/.test(p);
  const pedeCampoMesmoItem = /\b(bairro|local|valor|percentual|porcentagem|status|situacao|empresa|engenheir|arquit|responsavel|contrato|convenio|recurso|executad)\b/.test(p);
  if (referenciaMesmoItem && pedeCampoMesmoItem && sqlAnterior &&
      /\border\s+by\b/i.test(sqlAnterior) && /\blimit\s+1\b/i.test(sqlAnterior)) {
    const cauda = sqlAnterior.match(/\bFROM\s+obras\b[\s\S]*$/i)?.[0] || "";
    if (cauda) {
      return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
        `valor_executado, percentual_executado, aba_origem, dados_extras ${cauda}`;
    }
  }

  // Se a pessoa nomeou um item concreto e pediu um campo dele, deixamos a IA
  // montar a busca exata pelo objeto. Isso evita o erro de interpretar apenas o
  // bairro no fim do nome (ex.: "valor da Creche ... no Centro").
  const itemEspecificoSemContexto = pareceItemEspecifico(p) && !referenciaAnterior;
  if (itemEspecificoSemContexto) return null;

  // Caso importante: "quantas obras estao em andamento?" precisa responder
  // o TOTAL PRINCIPAL da aba EM_ANDAMENTO e, ao mesmo tempo, explicar os grupos
  // parecidos sem mistura-los. A consulta devolve os tres numeros em uma linha,
  // para a redacao detalhar com transparencia.
  if (ehPerguntaGenericaObrasEmAndamento(p)) {
    return `SELECT ` +
      `SUM(CASE WHEN aba_origem = 'EM_ANDAMENTO' THEN 1 ELSE 0 END)::int AS obras_em_andamento, ` +
      `SUM(CASE WHEN aba_origem = 'PAVIMENTAÇÃO' AND unaccent(status) ILIKE unaccent('%andamento%') THEN 1 ELSE 0 END)::int AS pavimentacoes_em_execucao, ` +
      `SUM(CASE WHEN aba_origem = 'EM_LICITAÇÃO' AND (` +
        `unaccent(status) ILIKE unaccent('%andamento%') OR ` +
        `unaccent(COALESCE(dados_extras->>'STATUS ORIGINAL','')) ILIKE unaccent('%andamento%')` +
      `) THEN 1 ELSE 0 END)::int AS licitacoes_com_etapa_em_andamento ` +
      `FROM obras`;
  }

  const filtroStatus = filtroStatusDaPergunta(p);
  const filtroLocal = condicaoLocalDaPergunta(p);
  const filtroEngenheiro = condicaoEngenheiroDaPergunta(p);
  let filtroEscopo = filtroEscopoDaPergunta(p);

  // Mesmo quando nao e uma contagem (ex.: "quais obras estao em andamento?"),
  // a expressao generica "obras em andamento" aponta para a area EM_ANDAMENTO.
  // Pavimentacoes em execucao e etapas de licitacao ficam como grupos separados.
  if (!filtroEscopo && /\bobras?\b/.test(p) && /\b(em andamento|andamento)\b/.test(p)) {
    filtroEscopo = "aba_origem = 'EM_ANDAMENTO'";
  }

  const temFiltroNovo = !!(filtroStatus || filtroLocal || filtroEscopo || filtroEngenheiro);

  // Se a pessoa diz explicitamente "dessas" + um novo filtro, refinamos a
  // consulta anterior. Se apenas faz uma pergunta curta, herdamos o filtro.
  const condicoes = [];
  if (condAnterior && referenciaAnterior) condicoes.push(condAnterior);
  if (filtroEscopo) condicoes.push(filtroEscopo);
  if (filtroStatus) condicoes.push(filtroStatus);
  if (filtroLocal) condicoes.push(filtroLocal);
  if (filtroEngenheiro) condicoes.push(filtroEngenheiro);

  // Quando a pessoa fala genericamente em "obras concluidas", projetos e
  // processos licitatorios nao entram no total de obras fisicas.
  if (!filtroEscopo && filtroStatus && /\bobras?\b/.test(p) &&
      /\b(concluid|pront|finaliz|terminad)/.test(p)) {
    condicoes.push("aba_origem NOT IN ('EM_PROJETO','EM_LICITAÇÃO')");
  }
  if (!condicoes.length && condAnterior && curtaDeAcompanhamento) condicoes.push(condAnterior);

  const usarAnterior = !!condAnterior && (referenciaAnterior || curtaDeAcompanhamento) && !temFiltroNovo;
  const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

  const pedeEng = /\b(engenheiros?|engenheiras?|eng|arquitetos?|arquitetas?|arq|responsavel|responsaveis|responsavel tecnico|responsaveis tecnicos)\b/.test(p);
  const pedeEmpresa = /\b(empresas?|executoras?|construtoras?)\b/.test(p);
  const pedeBairro = /\bbairros?\b/.test(p);
  const pedeStatus = /\b(status|situacao)\b/.test(p);
  const pedePercentual = /\b(percentual|porcentagem|% executad)\b/.test(p);
  const pedeExecutado = /\b(valor executado|quanto executou|ja executado|executad[oa])\b/.test(p);
  const pedeValor = pedeExecutado || /\b(valor|valores|custos?|custou|investid|investimento|quanto foi|orcamento)\b/.test(p);
  const pedeContagem = /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p);
  const pedeSoma = pedeValor && (
    /\b(total|soma|somando|ao todo|quanto foi investido|quanto custou tudo|investid|investimento)\b/.test(p) ||
    (!!filtroLocal && /\bqual(?: e| o)? valor\b/.test(p))
  );
  const pedeDetalhes = /\b(detalh\w*|informacoes?|completo|completa|tudo sobre|me fale sobre|explique|como esta|como ta|situacao completa)\b/.test(p);
  const pedeExistencia = /\b(existe|existem|ha|tem|algum|alguma|alguns|algumas)\b/.test(p);
  const pedeMaiorValor = /\b(maior valor|maior custo|mais cara|mais caro|maior investimento)\b/.test(p);
  const pedeMenorValor = /\b(menor valor|menor custo|mais barata|mais barato|menor investimento)\b/.test(p);
  const pedeMaisAvancada = /\b(mais avancad[ao]|maior percentual|maior execucao|mais executad[ao])\b/.test(p);
  const pedeMenosAvancada = /\b(menos avancad[ao]|menor percentual|menor execucao|menos executad[ao])\b/.test(p);

  // Perguntas genericas de quantidade de "obras" recebem uma separacao por
  // tipo. Assim "10 registros no Centro" nao vira incorretamente "10 obras"
  // quando parte deles sao projetos ou processos de licitacao.
  if (pedeContagem && /\bobras?\b/.test(p) && !filtroEscopo && !ehPerguntaGenericaObrasEmAndamento(p)) {
    return sqlContagemPorTipo(filtroLocal, filtroStatus);
  }

  // Rankings/superlativos: devolve o item vencedor com contexto suficiente para
  // explicar POR QUE ele e o maior/menor/mais avancado.
  if (pedeMaiorValor || pedeMenorValor || pedeMaisAvancada || pedeMenosAvancada) {
    const campoOrdem = (pedeMaisAvancada || pedeMenosAvancada) ? "percentual_executado" : "valor_total";
    const direcao = (pedeMenorValor || pedeMenosAvancada) ? "ASC" : "DESC";
    let whereRanking = where;

    // Se a pessoa disse "obra", rankings nao podem incluir projeto ou processo
    // de licitacao so porque existe outro filtro (ex.: nome do engenheiro).
    if (/\bobras?\b/.test(p) && !filtroEscopo) {
      const escopoFisico = "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
      whereRanking = whereRanking ? `${whereRanking} AND ${escopoFisico}` : `WHERE ${escopoFisico}`;
    }

    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
      `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras ` +
      `${whereRanking} ${whereRanking ? "AND" : "WHERE"} ${campoOrdem} IS NOT NULL ` +
      `ORDER BY ${campoOrdem} ${direcao} NULLS LAST LIMIT 1`;
  }

  // Se o cidadao pediu detalhes de um recorte ja identificado, traz o conjunto
  // completo de campos uteis + dados_extras. A IA decide o que e relevante e
  // organiza a resposta; campos vazios nao precisam ser exibidos.
  if (pedeDetalhes && (where || usarAnterior)) {
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, ` +
      `valor_total, valor_executado, percentual_executado, aba_origem, dados_extras ` +
      `FROM obras ${where} ORDER BY objeto`;
  }

  // Campos livres de dados_extras (recurso, contrato, convenio, prazo...).
  // ATENCAO ao plural: "recursos"/"contratos" precisam casar tambem, senao a
  // pergunta escapa para o atalho generico e volta so a lista de nomes.
  const pedeExtras = /\b(recursos?|fontes?|contratos?|convenios?|aditivos?|prazos?|data da|datas? de|ordem de servico|licitac(?:ao|oes))\b/.test(p);
  if (pedeExtras) {
    // Se JA sabemos o filtro (herdado da conversa ou dito agora), montamos a
    // SQL aqui mesmo: traz a gaveta dados_extras inteira e o sistema extrai o
    // campo certo na redacao. Assim a CONSULTA nao depende da IA (que pode
    // estar lenta/instavel); so a redacao usa IA.
    if (where || usarAnterior) {
      return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
        `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras ${where} ORDER BY objeto`;
    }
    // Sem filtro nenhum (ex.: "qual o recurso da praca da bandeira") a IA
    // precisa entender de qual obra se trata - entao deixamos com ela.
    return null;
  }

  // Perguntas sobre engenheiros/responsaveis tecnicos precisam de contexto, nao
  // apenas de um COUNT. Trazemos os registros relacionados para o Node agrupar
  // por responsavel e explicar quais obras/projetos cada pessoa acompanha.
  // Isso vale tambem para "quantos engenheiros?" quando ha um recorte claro.
  if (pedeEng && (where || usarAnterior)) {
    return `SELECT objeto, engenheiro, status, categoria, bairro, valor_total, ` +
      `percentual_executado, aba_origem FROM obras ${where} ` +
      `${where ? "AND" : "WHERE"} engenheiro IS NOT NULL AND BTRIM(engenheiro) <> '' ` +
      `ORDER BY engenheiro, objeto`;
  }

  // Pergunta geral, sem obra/local especifico: permite explicar quem sao os
  // responsaveis e quantos registros cada um acompanha. Se a frase parecer
  // apontar para uma obra especifica ("engenheiro da creche..."), deixamos a
  // IA gerar a SQL para localizar o objeto corretamente.
  const pedeEngGeral = pedeEng && !where && !usarAnterior &&
    /\b(quais|liste|lista|todos|todas|quantos|quantas|engenheiros|responsaveis tecnicos)\b/.test(p) &&
    !/\b(da|do|de)\s+(obra|projeto|rua|creche|escola|praca|mercado|ubs|posto|pavimentacao|ponte|quadra)\b/.test(p);
  if (pedeEngGeral) {
    return `SELECT objeto, engenheiro, status, categoria, bairro, valor_total, ` +
      `percentual_executado, aba_origem FROM obras ` +
      `WHERE engenheiro IS NOT NULL AND BTRIM(engenheiro) <> '' ORDER BY engenheiro, objeto`;
  }

  if (pedeExistencia && (where || usarAnterior)) {
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
      `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras ${where} ORDER BY objeto`;
  }

  if (pedeContagem) {
    if (pedeEmpresa) return `SELECT COUNT(DISTINCT empresa)::int AS quantidade_empresas FROM obras ${where} ${where ? "AND" : "WHERE"} empresa IS NOT NULL AND BTRIM(empresa) <> ''`;
    if (pedeBairro) return `SELECT COUNT(DISTINCT bairro)::int AS quantidade_bairros FROM obras ${where} ${where ? "AND" : "WHERE"} bairro IS NOT NULL AND BTRIM(bairro) <> ''`;
    return `SELECT COUNT(*)::int AS quantidade_obras FROM obras ${where}`;
  }

  if (pedeSoma) {
    const campo = pedeExecutado ? "valor_executado" : "valor_total";
    // Para perguntas de soma/investimento, NAO devolvemos apenas o SUM.
    // Trazemos os registros que compoem o total para o Node calcular a soma
    // com precisao e explicar ao cidadao de onde veio cada parcela.
    // Registros sem valor tambem voltam, para o bot avisar que existem mas
    // nao entram na soma.
    return `SELECT objeto, ${campo}, status, categoria, bairro, aba_origem ` +
      `FROM obras ${where} ORDER BY ${campo} DESC NULLS LAST, objeto`;
  }

  if (pedeEng) {
    // Casos especificos sem filtro reconhecido acima (ex.: "engenheiro da Creche X")
    // ficam para a IA localizar o objeto pelo nome, em vez de listar todos.
    return null;
  }
  if (pedeEmpresa) {
    if (where || usarAnterior) return `SELECT objeto, empresa, status, categoria, bairro, engenheiro, valor_total, percentual_executado, aba_origem FROM obras ${where} ORDER BY objeto`;
    return "SELECT DISTINCT empresa FROM obras WHERE empresa IS NOT NULL AND BTRIM(empresa) <> '' ORDER BY empresa";
  }
  if (pedeBairro && !/\bobra/.test(p)) {
    return `SELECT DISTINCT bairro FROM obras ${where} ${where ? "AND" : "WHERE"} bairro IS NOT NULL AND BTRIM(bairro) <> '' ORDER BY bairro`;
  }
  if (pedePercentual) return `SELECT objeto, percentual_executado, valor_executado, valor_total, status, categoria, bairro, engenheiro, empresa, aba_origem FROM obras ${where} ORDER BY objeto`;
  if (pedeValor) {
    const campo = pedeExecutado ? "valor_executado" : "valor_total";
    return `SELECT objeto, ${campo}, valor_total, valor_executado, percentual_executado, status, categoria, bairro, engenheiro, empresa, aba_origem FROM obras ${where} ORDER BY objeto`;
  }
  if (pedeStatus && where) return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, valor_executado, percentual_executado, aba_origem FROM obras ${where} ORDER BY objeto`;

  // "Quais sao?" logo apos "quantas concluidas?" deve listar as mesmas obras,
  // sem depender da IA. Traz o valor junto para nao mostrar "nao informado"
  // quando na verdade o valor existe (so nao tinha sido consultado).
  if (condAnterior && perguntaCurtaLista) {
    return `SELECT objeto, valor_total FROM obras WHERE ${condAnterior} ORDER BY objeto`;
  }

  // Listagens simples com filtro explicito (status ou local). Inclui valor_total
  // para que a lista mostre o valor real de cada obra quando cadastrado.
  if (where && /\b(obras?|quais|liste|lista|nomes?|mostra|mostre)\b/.test(p)) {
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, percentual_executado, aba_origem FROM obras ${where} ORDER BY objeto`;
  }

  // Acompanhamento curto usando o filtro anterior.
  if (usarAnterior && /\b(quais|lista|liste|nomes?|obras?|elas|essas|mostra|mostre)\b/.test(p)) {
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, percentual_executado, aba_origem FROM obras ${where} ORDER BY objeto`;
  }

  return null;
}

// --- CHAMADA 1: pergunta -> SQL ---
// MODO "CONVERSATIONAL ANALYTICS": toda pergunta de dados passa pela IA.
// A IA recebe schema + metadados REAIS do banco + memoria recente, gera a SQL,
// e o Node apenas valida/executa. E o mesmo padrao de agente SQL do artigo.
async function gerarSQL(pergunta, historico = [], correcao = null) {
  // Perguntas comuns passam primeiro pelo caminho deterministico. Alem de gastar
  // menos tokens, ele aplica regras de negocio importantes (obra != projeto !=
  // licitacao) e evita que a IA misture categorias so por palavras parecidas.
  if (!correcao) {
    const rapida = gerarSQLRapida(pergunta, historico);
    if (rapida) {
      console.log("AGENTE: usando SQL rapida/deterministica.");
      return rapida;
    }
  }

  const contextoBanco = await contextoAtualDoBanco();

  const blocoCorrecao = correcao
    ? `\nA consulta anterior falhou/rejeitou. SQL=${JSON.stringify((correcao.sql || "").slice(0, 600))} ERRO=${JSON.stringify((correcao.erro || "").slice(0, 220))}. Corrija a consulta sem mudar a intencao da pergunta.`
    : "";

  const instrucao = `Voce e um ANALISTA DE DADOS especialista em obras publicas.
Sua funcao e transformar a pergunta do cidadao em UMA consulta PostgreSQL precisa.

SCHEMA DE NEGOCIO:
${SCHEMA}

METADADOS ATUAIS DO DATASET:
${contextoBanco}

MEMORIA RECENTE DA CONVERSA:
${resumoHistorico(historico)}

COMO TRABALHAR:
1. Entenda a pergunta em linguagem natural, inclusive erros de digitacao e follow-ups.
2. Use SOMENTE colunas/chaves que realmente existem no schema/metadados acima.
3. Gere UMA SQL SELECT que responda exatamente o que foi perguntado.
3.1. Se o cidadao fizer DUAS OU MAIS perguntas/campos na mesma mensagem (ex.: "qual o recurso e o engenheiro da UBS X?" ou "valor, empresa e percentual da obra Y?"), a MESMA SQL deve trazer TODOS os campos pedidos. Nunca responda apenas uma parte.
3.2. Palavras como recurso, engenheiro, empresa, bairro, contrato, valor, percentual e status podem ser CAMPOS solicitados. Nao trate essas palavras nem o nome da obra que vem depois delas como valor de filtro de outro campo. Ex.: em "recurso e engenheiro da Reforma da UBS do Cristo Rei", "engenheiro" e campo pedido; o filtro deve localizar a obra pelo objeto, nao procurar um engenheiro chamado "Reforma da UBS...".
4. Para pergunta de acompanhamento, use a conversa e a SQL anterior para manter/refinar o recorte.
5. Se houver ambiguidade pequena, faca a interpretacao mais razoavel com base nos valores reais do banco.
6. Se a pergunta nao puder ser respondida com este dataset, responda SEM_CONSULTA.

REGRAS SQL:
- Somente SELECT na tabela obras. Sem JOIN, comentarios, CTE, subconsultas desnecessarias ou outras tabelas.
- Nunca INSERT, UPDATE, DELETE, DROP, ALTER, CREATE ou qualquer escrita.
- Para texto, prefira unaccent(campo) ILIKE unaccent('%termo%').
- Para categorias, escolha valores REAIS listados nos metadados; nao invente categoria.
- "quantas obras" = COUNT(*), mas RESPEITE o tipo/origem pedido.
- REGRA DE NEGOCIO: "obras em andamento" = obras da origem/categoria EM_ANDAMENTO. Nao some processos de licitacao cuja etapa se chama "Habilitacao em andamento".
- PROJETOS: se a pergunta disser projeto/projetos, filtre aba_origem='EM_PROJETO'.
- LICITACOES: se disser licitacao/licitacoes/processo licitatorio, filtre aba_origem='EM_LICITAÇÃO'.
- PAVIMENTACAO: se disser pavimentacao/pavimentacoes, filtre aba_origem='PAVIMENTAÇÃO'.
- "obras concluidas" generico NAO inclui projetos concluidos nem processos licitatorios.
- Se a pergunta for sobre UM item identificavel pelo nome/rua/contrato, mesmo que o cidadao pergunte so valor, responsavel, empresa ou status, selecione contexto completo: objeto,status,categoria,bairro,engenheiro,empresa,valor_total,valor_executado,percentual_executado,aba_origem,dados_extras. A resposta destacara primeiro o campo pedido e depois os detalhes uteis.
- Se a pergunta pedir DETALHES/INFORMACOES/SITUACAO, use esse mesmo conjunto completo de campos.
- Para LISTAGENS ("quais", "liste") selecione pelo menos objeto,status,categoria,bairro,engenheiro,empresa,valor_total,percentual_executado,aba_origem; acrescente dados_extras quando a pergunta envolver recurso, contrato, convenio, prazo, data ou observacao.
- Para MAIOR/MENOR/MAIS AVANCADA, use ORDER BY no campo correto + LIMIT 1 e traga o contexto completo do item vencedor.
- Se houver uma palavra ambigua de etapa (ex.: "andamento" em habilitacao), use aba_origem/categoria e STATUS ORIGINAL para entender o contexto antes de contar.
- "quantos engenheiros" = COUNT(DISTINCT engenheiro).
- "quantas empresas" = COUNT(DISTINCT empresa).
- soma/investimento = SUM(valor_total), salvo se a pergunta pedir valor executado.
- Para recurso/contrato/convenio/aditivo/prazo/data, consulte dados_extras usando apenas chaves reais listadas nos metadados. Se nao tiver certeza da chave, selecione objeto,dados_extras.
- Bairro/local pode procurar em bairro e, quando fizer sentido, no objeto da obra.
- Saida: SOMENTE a SQL, sem markdown, explicacao ou ponto-e-virgula.
${blocoCorrecao}`;

  let ultimo = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const resposta = await chamarIAbruta([
      { role: "system", content: instrucao },
      { role: "user", content: (pergunta || "").toString().slice(0, 1200) },
    ], {
      max_tokens: tentativa === 1 ? 260 : 340,
      temperature: 0,
      reasoning_effort: "low",
    });

    let sql = resposta.replace(/```sql/gi, "").replace(/```/g, "").trim();
    const m = sql.match(/select[\s\S]+/i);
    if (m) sql = m[0].trim();
    sql = sql.replace(/;$/, "").trim();
    ultimo = sql;

    if (/sem_consulta/i.test(sql) || sqlCompleta(sql)) return sql;
    console.warn(`AGENTE: SQL incompleto na tentativa ${tentativa}/2.`);
  }
  return ultimo;
}

// Resume uma contagem generica separando obra/pavimentacao de projeto/licitacao.
// Evita frases enganosas como "10 obras" quando o total inclui outros tipos.
function montarResumoContagemPorTipo(pergunta, linhas) {
  if (!Array.isArray(linhas) || linhas.length !== 1) return null;
  const l = linhas[0] || {};
  const chaves = ["obras", "pavimentacoes", "projetos", "licitacoes", "obras_e_pavimentacoes", "total_registros_relacionados"];
  if (!chaves.every((k) => Object.prototype.hasOwnProperty.call(l, k))) return null;
  return {
    obras: Number(l.obras) || 0,
    pavimentacoes: Number(l.pavimentacoes) || 0,
    projetos: Number(l.projetos) || 0,
    licitacoes: Number(l.licitacoes) || 0,
    obras_e_pavimentacoes: Number(l.obras_e_pavimentacoes) || 0,
    total_registros_relacionados: Number(l.total_registros_relacionados) || 0,
  };
}

// Resume perguntas financeiras de SOMA usando os registros individuais.
// O Node faz a conta; a IA apenas explica o resultado ja calculado.
function montarResumoSomaDetalhada(pergunta, linhas) {
  if (!Array.isArray(linhas) || linhas.length === 0) return null;

  const p = normalizarTexto(pergunta);
  const pedeExecutado = /\b(valor executado|quanto executou|ja executado|executad[oa])\b/.test(p);
  const pedeValor = pedeExecutado || /\b(valor|valores|custos?|custou|investid|investimento|quanto foi|orcamento)\b/.test(p);
  const consultaTemContextoDeComposicao = linhas.some((l) => l &&
    Object.prototype.hasOwnProperty.call(l, "aba_origem") &&
    Object.prototype.hasOwnProperty.call(l, "categoria"));
  const pedeSoma = pedeValor && (
    /\b(total|soma|somando|ao todo|quanto foi investido|quanto custou tudo|investid|investimento)\b/.test(p) ||
    (consultaTemContextoDeComposicao && /\bqual(?: e| o)? valor\b/.test(p))
  );
  if (!pedeSoma) return null;

  const campo = pedeExecutado ? "valor_executado" : "valor_total";
  if (!linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, "objeto"))) return null;
  if (!linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, campo))) return null;

  const tipoRegistro = (l) => {
    const origem = `${l?.aba_origem || ""} ${l?.categoria || ""}`
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (origem.includes("projeto")) return "projeto";
    if (origem.includes("licit")) return "processo de licitação";
    if (origem.includes("paviment")) return "pavimentação";
    return "obra";
  };

  let total = 0;
  const comValor = [];
  const semValor = [];
  for (const l of linhas) {
    const bruto = l?.[campo];
    const n = bruto === null || bruto === undefined || bruto === "" ? NaN : Number(bruto);
    const item = {
      objeto: l?.objeto || "Registro sem nome",
      valor: Number.isFinite(n) ? n : null,
      tipo: tipoRegistro(l),
      status: l?.status || null,
      bairro: l?.bairro || null,
    };
    if (Number.isFinite(n)) {
      total += n;
      comValor.push(item);
    } else {
      semValor.push(item);
    }
  }

  const semValorPorTipo = {};
  for (const i of semValor) semValorPorTipo[i.tipo] = (semValorPorTipo[i.tipo] || 0) + 1;

  return {
    campo,
    total,
    encontrados: linhas.length,
    comValor,
    semValor,
    semValorPorTipo,
  };
}


// Agrupa respostas sobre engenheiros/responsaveis tecnicos. O agrupamento e feito
// no Node para a IA nao precisar adivinhar contagens nem associar uma obra ao
// profissional errado.
function montarResumoEngenheiros(pergunta, linhas) {
  const p = normalizarTexto(pergunta);
  if (!/\b(engenheiros?|engenheiras?|eng|arquitetos?|arquitetas?|arq|responsavel|responsaveis|responsavel tecnico|responsaveis tecnicos)\b/.test(p)) return null;
  if (!Array.isArray(linhas) || linhas.length === 0) return null;
  if (!linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, "engenheiro"))) return null;

  // Se o cidadao pediu, na MESMA mensagem, campos que este resumo
  // deterministico nao exibe (recurso, contrato, convenio, empresa etc.),
  // nao transforme a resposta em um relatorio apenas de responsaveis.
  // Nesse caso deixamos a redacao geral usar todos os campos retornados pela SQL.
  // Ex.: "qual o recurso e o engenheiro da UBS X?" precisa responder OS DOIS.
  const pedeCampoForaDoResumo = /\b(recursos?|fontes?|contratos?|convenios?|aditivos?|prazos?|datas?|empresa|empresas|executora|executoras|valor executado|quanto (?:ja )?(?:foi )?(?:executado|pago)|saldo(?: devedor)?)\b/.test(p);
  if (pedeCampoForaDoResumo) return null;

  const tipoRegistro = (l) => {
    const origem = `${l?.aba_origem || ""} ${l?.categoria || ""}`
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (origem.includes("projeto")) return "projeto";
    if (origem.includes("licit")) return "processo de licitação";
    if (origem.includes("paviment")) return "pavimentação";
    return "obra";
  };

  const grupos = new Map();
  let semResponsavel = 0;
  for (const l of linhas) {
    const nome = (l?.engenheiro || "").toString().trim();
    if (!nome) {
      semResponsavel += 1;
      continue;
    }
    if (!grupos.has(nome)) grupos.set(nome, []);
    grupos.get(nome).push({
      objeto: l?.objeto || "Registro sem nome",
      tipo: tipoRegistro(l),
      status: l?.status || null,
      bairro: l?.bairro || null,
      valor_total: l?.valor_total ?? null,
      percentual_executado: l?.percentual_executado ?? null,
    });
  }

  const limitePorResponsavel = linhas.length <= 20 ? 20 : 4;
  const responsaveis = [...grupos.entries()].map(([nome, itens]) => ({
    nome,
    quantidade_registros: itens.length,
    itens: itens.slice(0, limitePorResponsavel),
    itens_omitidos: Math.max(0, itens.length - limitePorResponsavel),
  }));

  return {
    total_responsaveis: responsaveis.length,
    total_registros: [...grupos.values()].reduce((acc, itens) => acc + itens.length, 0),
    sem_responsavel: semResponsavel,
    responsaveis,
  };
}

// Resposta DETERMINISTICA para perguntas de engenheiro/responsavel.
// A IA nao reorganiza esses dados: cada bairro, valor e percentual fica preso
// ao mesmo registro retornado pelo banco. Isso elimina trocas como atribuir
// "Centro" a uma obra cujo bairro real e "Nova Mamanguape".
function redigirResumoEngenheirosDeterministico(resumo) {
  if (!resumo || !Array.isArray(resumo.responsaveis) || resumo.responsaveis.length === 0) return null;

  const plural = (n, singular, pluralTxt) => `${n} ${n === 1 ? singular : pluralTxt}`;
  const total = resumo.total_registros || 0;
  const tiposTodos = resumo.responsaveis.flatMap((r) => r.itens || []).map((i) => i.tipo);
  const soObras = tiposTodos.length > 0 && tiposTodos.every((t) => t === "obra");
  const labelTotal = soObras ? plural(total, "obra", "obras") : plural(total, "registro", "registros");

  const linhas = [];
  if (resumo.total_responsaveis === 1) {
    const r = resumo.responsaveis[0];
    linhas.push(`*${r.nome}* acompanha *${labelTotal}* neste recorte.`);
  } else {
    linhas.push(`São *${plural(resumo.total_responsaveis, "responsável técnico", "responsáveis técnicos")}* acompanhando *${labelTotal}* neste recorte.`);
  }

  linhas.push("", "*Detalhes por responsável*");
  for (const r of resumo.responsaveis) {
    const tipos = (r.itens || []).map((i) => i.tipo);
    const somenteObras = tipos.length > 0 && tipos.every((t) => t === "obra");
    const qtdLabel = somenteObras
      ? plural(r.quantidade_registros, "obra", "obras")
      : plural(r.quantidade_registros, "registro", "registros");
    linhas.push("", `• *${r.nome}* — ${qtdLabel}`);

    for (const i of (r.itens || [])) {
      const partes = [i.objeto];
      if (i.bairro) partes.push(`bairro ${i.bairro}`);
      if (i.valor_total && i.valor_total !== "valor nao informado") partes.push(i.valor_total);
      if (i.percentual_executado) partes.push(`${i.percentual_executado} executada`);
      if (i.status) partes.push(i.status);
      linhas.push(`  • ${partes.join(" — ")}`);
    }
    if (r.itens_omitidos > 0) linhas.push(`  • +${r.itens_omitidos} item(ns) não exibido(s)`);
  }

  if (resumo.sem_responsavel > 0) {
    linhas.push("", `${plural(resumo.sem_responsavel, "registro", "registros")} sem responsável técnico informado.`);
  }
  return linhas.join("\n");
}

// --- CHAMADA 2: resultado -> resposta natural ---
async function redigir(pergunta, linhas, ehInicio = false, historico = [], sqlUsada = "") {
  // Achata dados_extras E pre-formata valores em reais NO CODIGO. Assim os
  // numeros ja chegam prontos ("R$ 1.408.500,00") e a IA so COPIA - nunca
  // recalcula nem redigita, o que elimina o erro de valor mudar entre respostas.
  const linhasLimpas = linhas.map((lin) => {
    if (!lin || typeof lin !== "object") return lin;
    const { dados_extras, ...resto } = lin;
    const junto = (dados_extras && typeof dados_extras === "object")
      ? { ...resto, ...dados_extras }
      : { ...resto };
    for (const chave of Object.keys(junto)) {
      const v = junto[chave];
      // So formata como R$ campos que sao REALMENTE valor monetario. Evita
      // pegar contagens (count, total de obras) - por isso exige "valor" ou
      // palavras de dinheiro, e ignora nomes com "obras"/"count"/"quantidade".
      // Percentual de execucao vai pronto no padrao brasileiro. Isso evita a IA
      // trocar 54,24% por 54.24% ou chamar progresso de "concluido".
      if (/^percentual_executado$/i.test(chave) &&
          v !== null && v !== undefined && v !== "" && !isNaN(Number(v))) {
        junto[chave] = Number(v).toLocaleString("pt-BR", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }) + "%";
        continue;
      }

      const ehContagem = /obras|count|quantidade|qtd|numero de/i.test(chave);
      const ehValor = !ehContagem &&
        /valor|custo|investi|aditivo|orcamento|montante|r\$/i.test(chave);
      if (ehValor && v !== null && v !== undefined && v !== "" && !isNaN(Number(v))) {
        junto[chave] = "R$ " + Number(v).toLocaleString("pt-BR", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
      }
      // Valor vazio/null vira texto amigavel (nao mostra "null" pro cidadao).
      if (ehValor && (v === null || v === undefined || v === "")) {
        junto[chave] = "valor nao informado";
      }
    }
    return junto;
  });
  // Para SOMAS, o Node calcula o total e entrega a composicao pronta para a IA.
  // Assim a resposta pode explicar de onde veio o valor sem pedir que o modelo
  // faca aritmetica ou invente itens.
  const resumoContagem = montarResumoContagemPorTipo(pergunta, linhas);
  const resumoSoma = montarResumoSomaDetalhada(pergunta, linhas);
  const resumoEngenheiros = montarResumoEngenheiros(pergunta, linhasLimpas);

  // Para responsaveis/engenheiros, a resposta sai direto do Node para preservar
  // associacao exata entre obra, bairro, valor, percentual e profissional.
  if (resumoEngenheiros) {
    const pronta = redigirResumoEngenheirosDeterministico(resumoEngenheiros);
    if (pronta) return pronta;
  }

  const moedaResumo = (v) => "R$ " + Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  // Protecao para listas GIGANTES (planilha grande, ex: 500+ obras).
  // Nao da pra despejar 500 obras num WhatsApp (o app corta, fica caro e lento).
  const totalLinhas = linhasLimpas.length;
  const LIMITE_LISTA = 12; // IA so redige extras; mantem payload pequeno
  const listaGigante = !resumoContagem && !resumoSoma && !resumoEngenheiros && totalLinhas > LIMITE_LISTA;
  const amostra = listaGigante ? linhasLimpas.slice(0, LIMITE_LISTA) : linhasLimpas;

  let dadosObjeto;
  if (resumoContagem) {
    dadosObjeto = {
      tipo_resposta: "contagem_por_tipo",
      ...resumoContagem,
    };
  } else if (resumoSoma) {
    const itensComValor = resumoSoma.comValor.slice(0, LIMITE_LISTA).map((i) => ({
      objeto: i.objeto,
      valor: moedaResumo(i.valor),
      tipo: i.tipo,
      status: i.status,
      bairro: i.bairro,
    }));
    const itensSemValor = resumoSoma.semValor.slice(0, LIMITE_LISTA).map((i) => ({
      objeto: i.objeto,
      tipo: i.tipo,
      status: i.status,
      bairro: i.bairro,
    }));
    dadosObjeto = {
      tipo_resposta: "soma_detalhada",
      campo_somado: resumoSoma.campo === "valor_executado" ? "valor executado" : "valor total cadastrado",
      total: moedaResumo(resumoSoma.total),
      registros_encontrados: resumoSoma.encontrados,
      registros_com_valor: resumoSoma.comValor.length,
      registros_sem_valor: resumoSoma.semValor.length,
      sem_valor_por_tipo: resumoSoma.semValorPorTipo,
      itens_com_valor: itensComValor,
      itens_sem_valor: itensSemValor,
      itens_com_valor_omitidos: Math.max(0, resumoSoma.comValor.length - itensComValor.length),
      itens_sem_valor_omitidos: Math.max(0, resumoSoma.semValor.length - itensSemValor.length),
    };
  } else if (resumoEngenheiros) {
    dadosObjeto = {
      tipo_resposta: "engenheiros_detalhados",
      total_responsaveis: resumoEngenheiros.total_responsaveis,
      total_registros: resumoEngenheiros.total_registros,
      sem_responsavel: resumoEngenheiros.sem_responsavel,
      responsaveis: resumoEngenheiros.responsaveis,
    };
  } else {
    dadosObjeto = amostra.slice(0, 15);
  }

  const dados = JSON.stringify(dadosObjeto);
  const muitasLinhas = !resumoContagem && !resumoSoma && !resumoEngenheiros && amostra.length > 8;
  const prompt = `Voce e o Assistente de Obras da Prefeitura de Mamanguape no WhatsApp.
O cidadao perguntou: "${pergunta}"
Consulta usada neste turno: ${sqlUsada || "(consulta nao informada)"}
Contexto recente da conversa:
${resumoHistorico(historico)}

O sistema consultou o banco e retornou EXATAMENTE estes dados (JSON): ${dados}

Interprete o resultado para responder exatamente a pergunta atual, levando em conta o contexto recente.
Escreva uma resposta clara e cordial em portugues, formato WhatsApp.

FORMATO DE RESPOSTA (IMPORTANTE):
- Comece pela resposta DIRETA em 1 frase (numero, valor, status ou conclusao pedida).
- Se a mensagem tiver DUAS OU MAIS perguntas/campos pedidos, responda TODOS explicitamente na mesma resposta, de preferencia um por linha ou marcador. Nunca escolha so um deles. Ex.: "recurso e engenheiro" -> informe Recurso e Responsavel tecnico; "valor, empresa e percentual" -> informe os tres.
- Depois, quando o resultado trouxer informacoes que ajudam a pessoa a entender o que esta acontecendo, acrescente uma secao curta de detalhes com marcadores.
- Em perguntas de contagem, se o JSON trouxer VARIOS contadores/categorias, explique cada um separadamente. NAO some categorias diferentes sem o usuario pedir.
- Se o JSON tiver tipo_resposta="contagem_por_tipo" e o usuario perguntou genericamente por "obras", a RESPOSTA PRINCIPAL e SEMPRE obras_e_pavimentacoes. Chame esse numero simplesmente de "obras" para o cidadao e, nos detalhes, explique a composicao entre obras fisicas e pavimentacoes. Projetos e processos de licitacao sao categorias SEPARADAS e NAO entram nessa contagem. Se existirem, voce pode menciona-los em uma frase separada como informacao adicional, deixando claro que nao entram no total de obras. NAO mostre total_registros_relacionados nem some obras + projetos + licitacoes, a menos que o usuario peça explicitamente "total de registros", "incluindo projetos e licitacoes", "tudo junto" ou equivalente. Em perguntas como "quantas obras concluidas?", responda pelo numero obras_e_pavimentacoes, mesmo que existam projetos concluidos separados. Nunca chame projeto ou processo de licitacao de obra executada.
- Se o JSON tiver tipo_resposta="soma_detalhada": comece pelo TOTAL ja calculado; depois diga quantos registros possuem valor e liste CADA item_com_valor com nome + valor. Se houver registros_sem_valor, explique quantos ficaram fora da soma; quando forem poucos, cite tambem os nomes e os tipos (projeto, licitacao etc.). Se itens_com_valor_omitidos ou itens_sem_valor_omitidos for maior que zero, avise quantos registros adicionais nao foram listados. NUNCA some novamente os valores: copie o campo total.
- Se o JSON tiver tipo_resposta="engenheiros_detalhados": explique quem sao os RESPONSAVEIS TECNICOS do recorte. Comece dizendo quantos responsaveis foram encontrados e quantos registros eles acompanham. Depois agrupe por pessoa: nome + quantidade de registros e, abaixo, liste os itens associados a ela com o substantivo correto (obra, projeto, pavimentacao ou processo de licitacao), status e bairro quando disponiveis. Se valor_total ou percentual_executado estiverem presentes, inclua-os quando ajudarem a entender a situacao. Se itens_omitidos > 0, diga quantos itens adicionais daquele responsavel nao foram mostrados e ofereca detalhar o nome dele. Se houver nomes com "Arq.", prefira chamar o conjunto de "responsaveis tecnicos" em vez de dizer que todos sao engenheiros. NUNCA atribua um item a outro profissional.
- Quando a pergunta usar "investido" mas o campo_somado for "valor total cadastrado", prefira dizer "valor total cadastrado" ou "valor total das obras/pavimentacoes" para nao confundir com dinheiro ja pago/executado. Se o usuario pedir quanto ja foi executado/pago, use somente o campo correspondente.
- Diferencie sempre: OBRA fisica, PROJETO, PAVIMENTACAO e PROCESSO DE LICITACAO. Use o substantivo correto na resposta.
- Exemplo de distincao: "Habilitacao em andamento" e uma etapa de licitacao; isso NAO significa que a obra esteja em execucao.
- REGRA GERAL PARA QUALQUER PERGUNTA: responda primeiro exatamente o que foi pedido e, em seguida, use os outros campos retornados para dar contexto util. Ex.: se pediram valor, acrescente status/percentual/responsavel quando existirem; se pediram responsavel, mostre tambem quais itens ele acompanha; se pediram uma lista, indique tipo, status e valor quando disponiveis. Nao transforme toda resposta em relatorio enorme: priorize os detalhes que ajudam a entender a situacao.
- Para uma obra/projeto especifico, se os campos existirem no JSON, informe os detalhes relevantes: situacao/status, responsavel, empresa, bairro/local, valor total, valor executado, percentual, recurso/convenio/contrato, datas, observacoes e etapa original. Nao esconda um detalhe util que esteja disponivel.
- Nao despeje campos tecnicos. Traduza aba_origem/categoria em linguagem humana quando isso ajudar a explicar a origem do registro.
- Omita campos vazios. Nao invente o que nao veio no JSON.
- Se houver uma diferenca que possa confundir o cidadao, EXPLIQUE o criterio usado em uma frase curta.

REGRAS ABSOLUTAS DE EXATIDAO (o mais importante - nunca quebre):
- COPIE os numeros e valores EXATAMENTE como aparecem no JSON, digito por digito.
  Se o JSON diz "R$ 1.408.500,00", escreva "R$ 1.408.500,00" - NAO troque nenhum
  algarismo, NAO arredonde, NAO recalcule. Copiar errado um valor e o pior erro.
- Todo numero, nome ou valor na resposta TEM que aparecer no JSON. Se nao esta
  no JSON, NAO existe - nao invente.
- BAIRRO/LOCAL, RESPONSAVEL, STATUS, VALOR e PERCENTUAL pertencem ao MESMO item
  do JSON. NUNCA copie o bairro de uma obra para outra. Exiba o bairro exatamente
  como veio no mesmo objeto/registro daquela obra.
- percentual_executado significa PROGRESSO/EXECUCAO. Diga "54,24% executada" ou
  "54,24% de execucao". So use "concluida" quando o status do proprio item for
  realmente Concluida.
- Para "quantas" (contagem): conte os itens do JSON ou use o COUNT que ele traz.
  O total que voce disser TEM que bater com a quantidade de itens listados. Se
  listou 6 obras, o total e 6 - nunca diga um numero diferente do que listou.
- NUNCA reutilize numeros de mensagens anteriores. Cada resposta usa SO este JSON.
- CUIDADO: "ao todo/geral" e DIFERENTE de "em andamento" (um status so). Use o
  numero exato que o JSON traz para a pergunta feita.
- NAO concorde com o cidadao sem conferir. A verdade e o JSON, nao a pergunta.
- Se o JSON vier vazio, diga que nao encontrou e peca para reformular. NUNCA
  invente numero para preencher.
- Se a pergunta puder ter mais de uma interpretacao e a consulta adotou uma interpretacao
  razoavel, deixe essa suposicao clara em UMA frase curta (ex.: "Considerei Centro como bairro").
- ${ehInicio
    ? "Esta e a PRIMEIRA mensagem: pode cumprimentar uma vez (Ola/Bom dia)."
    : "NAO cumprimente. A conversa JA comecou - va DIRETO a resposta."}

OUTRAS REGRAS:
- Os valores JA VEM formatados como "R$ ..." no JSON - use-os como estao.
- NUNCA exponha funcionamento interno. Nao mencione banco, SQL, consulta, query, filtro, tabela, coluna, ILIKE, unaccent, JSON, aba_origem, nem codigos internos como EM_PROJETO/EM_LICITAÇÃO. Nao diga frases como "o status contem conclu" ou "a consulta busca bairro/objeto". Explique apenas em linguagem de cidadao, por exemplo: "projetos e licitacoes sao contabilizados separadamente".
- Nao diga que voce e uma IA.
- No maximo um emoji sutil. Seja objetivo, claro e informativo, sem floreio.
${listaGigante ? `- ATENCAO: existem ${totalLinhas} obras no total, mas voce recebeu so as primeiras ${LIMITE_LISTA} como amostra. Liste essas ${LIMITE_LISTA} e diga claramente: "Estas sao as primeiras ${LIMITE_LISTA} de ${totalLinhas} obras. Para ver melhor, me diga um bairro ou status especifico." NAO diga que sao so ${LIMITE_LISTA} no total - o total real e ${totalLinhas}.` : ""}
${muitasLinhas ? "- A lista e LONGA: UMA linha por obra: '• Nome — R$ valor'. Se o valor for 'valor nao informado', escreva assim mesmo (nao invente). SEM introducao. Termine com 'Total: N obras' onde N e a quantidade EXATA de itens listados. Se algumas obras nao tem valor, acrescente uma linha curta explicando: 'Obs.: algumas obras ainda nao tem valor cadastrado.'" : "- Responda de forma completa mas objetiva. Se o valor for 'valor nao informado', diga isso - nao invente numero."}`;

  const limite = resumoEngenheiros ? 900 : (resumoSoma ? 900 : (muitasLinhas ? 760 : 600));
  return await chamarIAbruta([{ role: "user", content: prompt }], { max_tokens: limite, reasoning_effort: "low" });
}

// Resposta deterministica para quando os provedores de IA estiverem fora do
// ar depois que o banco ja retornou um resultado correto.
function redigirLocal(pergunta, linhas) {
  if (!Array.isArray(linhas) || linhas.length === 0) {
    return "Não encontrei obras com esse critério. Tente informar o bairro, a rua ou o nome da obra.";
  }

  const p = normalizarTexto(pergunta);
  const moeda = (v) => {
    if (v === null || v === undefined || v === "") return "valor não informado";
    if (isNaN(Number(v))) return v.toString();
    return "R$ " + Number(v).toLocaleString("pt-BR", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  };
  const texto = (v, vazio = "não informado") =>
    v === null || v === undefined || v === "" ? vazio : String(v);

  // Contagem por tipo: para o cidadao, "obras" = obras fisicas + pavimentacoes.
  // Projetos e licitacoes ficam separados e nao entram no numero principal,
  // salvo se a pessoa pedir explicitamente para juntar todas as categorias.
  const resumoContagem = montarResumoContagemPorTipo(pergunta, linhas);
  if (resumoContagem) {
    const fisicas = resumoContagem.obras_e_pavimentacoes;
    const pNorm = normalizarTexto(pergunta);
    const pediuTudoJunto = /\b(total de registros|todos os registros|tudo junto|incluindo projetos|incluindo licitacoes|incluindo projetos e licitacoes)\b/.test(pNorm);
    const concluidas = /\b(concluid|pront|finaliz|terminad)\w*/.test(pNorm);

    if (pediuTudoJunto) {
      let out = `Ha ${resumoContagem.total_registros_relacionados} registro${resumoContagem.total_registros_relacionados === 1 ? "" : "s"} relacionados.`;
      out += `\n\n• ${fisicas} obra${fisicas === 1 ? "" : "s"} (incluindo pavimentacoes)`;
      if (resumoContagem.projetos) out += `\n• ${resumoContagem.projetos} projeto${resumoContagem.projetos === 1 ? "" : "s"}`;
      if (resumoContagem.licitacoes) out += `\n• ${resumoContagem.licitacoes} processo${resumoContagem.licitacoes === 1 ? "" : "s"} de licitacao`;
      return out;
    }

    let out = concluidas
      ? `Existem ${fisicas} obra${fisicas === 1 ? "" : "s"} concluida${fisicas === 1 ? "" : "s"}.`
      : `Existem ${fisicas} obra${fisicas === 1 ? "" : "s"} nesse recorte.`;

    const detalhes = [];
    if (resumoContagem.obras > 0) detalhes.push(`${resumoContagem.obras} obra${resumoContagem.obras === 1 ? "" : "s"} fisica${resumoContagem.obras === 1 ? "" : "s"}`);
    if (resumoContagem.pavimentacoes > 0) detalhes.push(`${resumoContagem.pavimentacoes} pavimentacao${resumoContagem.pavimentacoes === 1 ? "" : "oes"}`);
    if (concluidas && resumoContagem.obras === 0 && resumoContagem.pavimentacoes > 0) {
      out += `\n\nAs ${resumoContagem.pavimentacoes} sao pavimentacoes concluidas.`;
    } else if (detalhes.length > 1) {
      out += `\n\nDetalhes: ${detalhes.join(" + ")}.`;
    }

    const extras = [];
    if (resumoContagem.projetos) extras.push(`${resumoContagem.projetos} projeto${resumoContagem.projetos === 1 ? "" : "s"}`);
    if (resumoContagem.licitacoes) extras.push(`${resumoContagem.licitacoes} processo${resumoContagem.licitacoes === 1 ? "" : "s"} de licitacao`);
    if (extras.length) {
      out += `\n\nHa tambem ${extras.join(" e ")} relacionado${extras.length > 1 || resumoContagem.projetos > 1 || resumoContagem.licitacoes > 1 ? "s" : ""}, tratado${extras.length > 1 || resumoContagem.projetos > 1 || resumoContagem.licitacoes > 1 ? "s" : ""} separadamente e fora dessa contagem de obras.`;
    }
    return out;
  }

  // Soma detalhada: mostra o total E a composicao, inclusive registros sem valor.
  const resumoSoma = montarResumoSomaDetalhada(pergunta, linhas);
  if (resumoSoma) {
    if (resumoSoma.comValor.length === 0) {
      return `Encontrei ${resumoSoma.encontrados} registro${resumoSoma.encontrados === 1 ? "" : "s"}, ` +
        `mas nenhum possui ${resumoSoma.campo === "valor_executado" ? "valor executado" : "valor total"} cadastrado.`;
    }

    const itens = resumoSoma.comValor.slice(0, 12).map((i) =>
      `• ${texto(i.objeto, "Registro sem nome")} — ${moeda(i.valor)}`
    );
    let resposta = `${resumoSoma.campo === "valor_executado" ? "Total executado" : "Valor total cadastrado"}: ${moeda(resumoSoma.total)}.\n\n` +
      `Esse total e composto por ${resumoSoma.comValor.length} registro${resumoSoma.comValor.length === 1 ? "" : "s"} com valor informado:\n` +
      itens.join("\n");

    if (resumoSoma.comValor.length > 12) {
      resposta += `\n• ... e mais ${resumoSoma.comValor.length - 12} registro${resumoSoma.comValor.length - 12 === 1 ? "" : "s"}.`;
    }

    if (resumoSoma.semValor.length > 0) {
      const tipos = Object.entries(resumoSoma.semValorPorTipo)
        .map(([tipo, n]) => {
          if (n === 1) return `1 ${tipo}`;
          if (tipo === "projeto") return `${n} projetos`;
          if (tipo === "pavimentação") return `${n} pavimentações`;
          if (tipo === "processo de licitação") return `${n} processos de licitação`;
          return `${n} obras`;
        })
        .join(", ");
      resposta += `\n\nHa ainda ${resumoSoma.semValor.length} registro${resumoSoma.semValor.length === 1 ? "" : "s"} sem valor cadastrado` +
        `${tipos ? ` (${tipos})` : ""}; por isso ${resumoSoma.semValor.length === 1 ? "ele nao entra" : "eles nao entram"} nessa soma.`;
    }
    return resposta;
  }

  // Agregacoes: COUNT/SUM etc.
  if (linhas.length === 1) {
    const l = linhas[0] || {};

    // Resposta explicativa para a pergunta "quantas obras estao em andamento?".
    // O primeiro numero e o total principal; os outros sao contextos relacionados
    // que NAO devem ser somados automaticamente.
    if ("obras_em_andamento" in l) {
      const obras = Number(l.obras_em_andamento) || 0;
      const pav = Number(l.pavimentacoes_em_execucao) || 0;
      const lic = Number(l.licitacoes_com_etapa_em_andamento) || 0;
      return `Existem ${obras} obras em andamento.\n\n` +
        `Para nao misturar etapas diferentes, a planilha tambem registra:\n` +
        `• ${pav} pavimentacao${pav === 1 ? "" : "oes"} em execucao;\n` +
        `• ${lic} processo${lic === 1 ? "" : "s"} de licitacao com alguma etapa em andamento.\n\n` +
        `Esses grupos ficam separados do total principal de obras em andamento.`;
    }

    if ("quantidade_obras" in l) {
      const n = Number(l.quantidade_obras) || 0;
      const ehProjeto = /\bprojetos?\b/.test(p);
      const ehLicitacao = /\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p);
      const ehPav = /\bpaviment/.test(p);
      const nome = ehProjeto ? (n === 1 ? "projeto" : "projetos")
        : ehLicitacao ? (n === 1 ? "processo de licitação" : "processos de licitação")
        : ehPav ? (n === 1 ? "pavimentação" : "pavimentações")
        : (n === 1 ? "obra" : "obras");
      return `Total: ${n} ${nome}.`;
    }
    if ("quantidade_engenheiros" in l) {
      const n = Number(l.quantidade_engenheiros) || 0;
      return n === 1 ? "Total: 1 engenheiro responsável." : `Total: ${n} engenheiros responsáveis.`;
    }
    if ("quantidade_empresas" in l) {
      const n = Number(l.quantidade_empresas) || 0;
      return `Total: ${n} empresa${n === 1 ? "" : "s"}.`;
    }
    if ("quantidade_bairros" in l) {
      const n = Number(l.quantidade_bairros) || 0;
      return `Total: ${n} bairro${n === 1 ? "" : "s"}.`;
    }
    if (Object.keys(l).length === 1 && ("valor_total" in l || "valor_executado" in l)) {
      const chave = "valor_executado" in l ? "valor_executado" : "valor_total";
      return `${chave === "valor_executado" ? "Total executado" : "Total"}: ${moeda(l[chave])}.`;
    }
  }

  const LIMITE = 10;

  // O cidadao pediu explicitamente pra ver a lista mesmo sendo grande?
  // ("as 10 primeiras", "liste todas", "mostrar tudo", "lista completa")
  const querListarMesmoAssim = /\bprimeir\w*|\btodas?\b|\btodos?\b|\btudo\b|\bcompleta\b|liste? todas|pode listar|mostrar? tudo/.test(p);

  // OPCAO A - listas grandes nao sao despejadas. Se passar de 10 obras, o bot
  // resume e pede um filtro (bairro/status), em vez de jogar dezenas de linhas
  // no WhatsApp. Vale para as listagens de OBRAS (que tem objeto).
  const ehListaDeObras = linhas.length > 0 &&
    linhas.every((l) => l && Object.prototype.hasOwnProperty.call(l, "objeto"));
  if (ehListaDeObras && linhas.length > LIMITE && !querListarMesmoAssim) {
    const bairros = [...new Set(
      linhas.map((l) => (l.bairro || "").toString().trim()).filter(Boolean)
    )].slice(0, 6);
    // Mostra as 10 primeiras JA, e oferece continuar (ver mais) ou filtrar.
    const itens = linhas.slice(0, LIMITE).map(
      (l) => `• ${texto(l.objeto, "Obra sem nome")} — ${moeda(l.valor_total)}`
    );
    const dicaBairro = bairros.length
      ? `filtrar por bairro (ex.: ${bairros.slice(0, 3).join(", ")})`
      : "filtrar por bairro ou status";
    return `${itens.join("\n")}\n\n` +
      `Estas são as ${LIMITE} primeiras de ${linhas.length} obras.\n` +
      `Para continuar, responda "ver mais" — ou peça para ${dicaBairro}. 🙂`;
  }

  const amostra = linhas.slice(0, LIMITE);

  // Perguntas sobre engenheiros: agrupa por responsavel e mostra quais registros
  // cada profissional acompanha, mesmo se a IA de redacao estiver indisponivel.
  const resumoEng = montarResumoEngenheiros(pergunta, linhas);
  if (resumoEng) {
    const blocos = resumoEng.responsaveis.map((r) => {
      const itens = r.itens.map((i) => {
        const detalhes = [i.tipo, i.status, i.bairro].filter(Boolean).join("; ");
        const valor = i.valor_total !== null && i.valor_total !== undefined && i.valor_total !== ""
          ? `; ${moeda(i.valor_total)}` : "";
        const percentual = i.percentual_executado !== null && i.percentual_executado !== undefined && i.percentual_executado !== ""
          ? `; ${texto(i.percentual_executado)}% executado` : "";
        return `  - ${texto(i.objeto, "Registro sem nome")}${detalhes ? ` — ${detalhes}` : ""}${valor}${percentual}`;
      });
      const omitidos = r.itens_omitidos > 0 ? `\n  - ... e mais ${r.itens_omitidos} registro${r.itens_omitidos === 1 ? "" : "s"}.` : "";
      return `• ${r.nome} — ${r.quantidade_registros} registro${r.quantidade_registros === 1 ? "" : "s"}\n${itens.join("\n")}${omitidos}`;
    });
    const rotuloResp = resumoEng.total_responsaveis === 1 ? "responsável técnico" : "responsáveis técnicos";
    return `Encontrei ${resumoEng.total_responsaveis} ${rotuloResp} ` +
      `em ${resumoEng.total_registros} registro${resumoEng.total_registros === 1 ? "" : "s"}:\n\n${blocos.join("\n\n")}`;
  }

  // Obra + engenheiro: caso exato do acompanhamento "dessas obras".
  if (amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "engenheiro")) &&
      amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "objeto"))) {
    const itens = amostra.map((l) =>
      `• ${texto(l.objeto, "Obra sem nome")} — engenheiro: ${texto(l.engenheiro, "não informado")}`
    );
    return `${itens.join("\n")}\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
  }

  if (amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "empresa")) &&
      amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "objeto"))) {
    const itens = amostra.map((l) =>
      `• ${texto(l.objeto, "Obra sem nome")} — empresa: ${texto(l.empresa, "não informada")}`
    );
    return `${itens.join("\n")}\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
  }

  if (amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "valor_total")) &&
      amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "objeto"))) {
    const itens = amostra.map((l) => `• ${texto(l.objeto, "Obra sem nome")} — ${moeda(l.valor_total)}`);
    return `${itens.join("\n")}\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
  }

  if (amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "valor_executado")) &&
      amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "objeto"))) {
    const itens = amostra.map((l) => `• ${texto(l.objeto, "Obra sem nome")} — executado: ${moeda(l.valor_executado)}`);
    return `${itens.join("\n")}\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
  }

  if (amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "percentual_executado")) &&
      amostra.some((l) => Object.prototype.hasOwnProperty.call(l || {}, "objeto"))) {
    const itens = amostra.map((l) =>
      `• ${texto(l.objeto, "Obra sem nome")} — ${texto(l.percentual_executado)}% executado`
    );
    return `${itens.join("\n")}\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
  }

  if (amostra.every((l) => l && Object.keys(l).length === 1 && "engenheiro" in l)) {
    const nomes = amostra.map((l) => texto(l.engenheiro)).filter((x) => x !== "não informado");
    return `${nomes.map((n) => `• ${n}`).join("\n")}\n\nTotal: ${nomes.length} engenheiro${nomes.length === 1 ? "" : "s"}.`;
  }
  if (amostra.every((l) => l && Object.keys(l).length === 1 && "empresa" in l)) {
    const nomes = amostra.map((l) => texto(l.empresa, "não informada")).filter((x) => x !== "não informada");
    return `${nomes.map((n) => `• ${n}`).join("\n")}\n\nTotal: ${nomes.length} empresa${nomes.length === 1 ? "" : "s"}.`;
  }
  if (amostra.every((l) => l && Object.keys(l).length === 1 && "bairro" in l)) {
    const nomes = amostra.map((l) => texto(l.bairro)).filter((x) => x !== "não informado");
    return `${nomes.map((n) => `• ${n}`).join("\n")}\n\nTotal: ${nomes.length} bairro${nomes.length === 1 ? "" : "s"}.`;
  }

  if (amostra.every((l) => l && Object.keys(l).length === 1 && "objeto" in l)) {
    const itens = amostra.map((l) => `• ${texto(l.objeto, "Obra sem nome")}`);
    const resto = linhas.length > LIMITE ? `\n\nMostrando ${LIMITE} de ${linhas.length} obras.` : `\n\nTotal: ${linhas.length} obra${linhas.length === 1 ? "" : "s"}.`;
    return itens.join("\n") + resto;
  }

  // Fallback local generico. Mantem o bot funcionando mesmo sem IA.
  if (linhas.length === 1) {
    const l = linhas[0] || {};
    const campos = Object.entries(l).flatMap(([k, v]) =>
      k === "dados_extras" && v && typeof v === "object" ? Object.entries(v) : [[k, v]]
    );
    return campos.slice(0, 18).map(([k, v]) => {
      const ehMoeda = /valor|custo|invest|aditivo|orcamento|montante/i.test(k) &&
        !/count|quantidade|qtd/i.test(k);
      return `• ${k.replace(/_/g, " ")}: ${ehMoeda ? moeda(v) : texto(v)}`;
    }).join("\n");
  }

  const itens = amostra.map((l, i) => {
    const nome = l?.objeto || `Obra ${i + 1}`;
    const compl = l?.status || l?.bairro || l?.engenheiro || l?.empresa || "";
    return `• ${nome}${compl ? ` — ${compl}` : ""}`;
  });
  return `${itens.join("\n")}\n\nTotal retornado: ${linhas.length}.`;
}

function precisaRedacaoIA(pergunta, linhas) {
  const p = normalizarTexto(pergunta);
  // Plural incluido: "recursos", "contratos" etc. tambem precisam de redacao IA.
  const pedeExtra = /\b(recursos?|fontes?|contratos?|convenios?|aditivos?|prazos?|data da|datas? de|ordem de servico)\b/.test(p);
  const temExtras = (linhas || []).some((l) => l?.dados_extras && typeof l.dados_extras === "object");
  return pedeExtra && temExtras;
}

// Detecta saudacoes, agradecimentos e despedidas simples - que nao precisam
// de banco de dados. Retorna uma resposta pronta, ou null se nao for saudacao.
function respostaSocial(pergunta) {
  const p = pergunta.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // remove pontuacao das bordas
  const limpo = p.replace(/[!?.,;]+/g, " ").replace(/\s+/g, " ").trim();

  // So trata como saudacao/social se a mensagem for CURTA (senao pode ter pergunta junto)
  const curta = limpo.split(" ").length <= 4;
  if (!curta) return null;

  // Saudacoes detectadas por PADRAO (aceita variacoes: oi/oii/oiii, ola/olaa,
  // eai/eaii, etc.) - mais robusto que uma lista fixa de palavras exatas.
  const ehSaudacao =
    /^o+i+$/.test(limpo) ||                                   // oi, oii, oiii, ooi...
    /^o+la+$/.test(limpo) ||                                  // ola, olaa, oola...
    /^(opa|opaa|salve|ei+|hey|hello|hi|oie|alo+)$/.test(limpo) ||
    /^e+ ?a+i+$/.test(limpo) ||                               // eai, e ai, eaii...
    /\b(bom dia|boa tarde|boa noite|boas)\b/.test(limpo);

  // Agradecimentos e despedidas
  const agradece = ["obrigado", "obrigada", "obg", "vlw", "valeu", "grato",
    "grata", "agradecido", "thanks"];
  const despede = ["tchau", "ate mais", "ate logo", "adeus", "falou", "flw", "ate"];
  const comeca = (lista) => lista.some((s) => limpo === s || limpo.startsWith(s + " ") || limpo.endsWith(" " + s));

  if (comeca(agradece)) {
    return "Por nada! Estou aqui para ajudar com informacoes sobre as obras de Mamanguape. 😊";
  }
  if (comeca(despede)) {
    return "Ate mais! Qualquer duvida sobre as obras da cidade, e so chamar. 👋";
  }
  if (ehSaudacao) {
    return "Ola! Sou o assistente de obras publicas da Prefeitura de Mamanguape. " +
      "Posso te dizer quais obras estao em andamento, concluidas, seus valores, " +
      "bairros e responsaveis. O que voce gostaria de saber? 🏗️";
  }
  return null;
}

// --- FLUXO COMPLETO ---
export async function responderPergunta(pergunta, historico = []) {
  // 0. Saudacao/agradecimento/despedida - responde sem tocar no banco.
  const social = respostaSocial(pergunta);
  if (social) {
    console.log("AGENTE: resposta social (sem SQL).");
    return { resposta: social, social: true };
  }

  // 1. Gera SQL
  let sql;
  try {
    sql = await gerarSQL(pergunta, historico);
  } catch (e) {
    return { resposta: "Desculpe, tive um problema ao entender sua pergunta. Pode reformular?", erro: "gerar_sql: " + e.message };
  }
  console.log("AGENTE: SQL gerada:", sql);

  // 1b. A IA sinalizou que a mensagem nao e uma pergunta clara sobre obras?
  // (ex.: saudacao solta que escapou, "ok", algo vago). Pede reformular em vez
  // de inventar um numero. Cobre casos que a deteccao de saudacao nao pegou.
  if (/sem_consulta/i.test(sql) || !/select/i.test(sql)) {
    console.log("AGENTE: mensagem sem consulta clara - pedindo reformular.");
    return {
      resposta: "Nao entendi bem sua pergunta. Posso te informar sobre obras em andamento, concluidas, valores, bairros e engenheiros responsaveis. O que voce gostaria de saber? 🏗️",
      semConsulta: true,
    };
  }

  // 2. Valida seguranca. Para erros comuns do modelo, permite UMA correcao;
  // a nova SQL passa exatamente pelas mesmas barreiras da primeira.
  let check = sqlSegura(sql);
  if (!check.ok) {
    console.warn("AGENTE: primeira SQL rejeitada -", check.motivo);
    try {
      const anterior = sql;
      const corrigida = await gerarSQL(pergunta, historico, {
        sql: anterior,
        erro: `validacao de seguranca: ${check.motivo}`,
      });
      const checkCorrigida = sqlSegura(corrigida);
      if (checkCorrigida.ok) {
        sql = corrigida;
        check = checkCorrigida;
        console.log("AGENTE: SQL corrigida e validada.");
      } else {
        console.warn("AGENTE: SQL corrigida tambem foi bloqueada -", checkCorrigida.motivo);
      }
    } catch (e) {
      console.error("AGENTE: falha ao corrigir SQL rejeitada:", e.message);
    }
  }
  if (!check.ok) {
    return {
      resposta: "Nao consegui responder essa pergunta com seguranca. Pode perguntar de outro jeito?",
      sqlBloqueada: sql,
    };
  }

  // 3. Executa
  let linhas;
  try {
    const r = await queryReadOnly(comLimite(sql));
    linhas = r.rows;
  } catch (e) {
    console.error("AGENTE: primeira execucao SQL falhou:", e.message);
    try {
      const corrigida = await gerarSQL(pergunta, historico, {
        sql,
        erro: e.message,
      });
      const checkCorrigida = sqlSegura(corrigida);
      if (!checkCorrigida.ok) {
        throw new Error(`SQL corrigida bloqueada: ${checkCorrigida.motivo}`);
      }
      const r = await queryReadOnly(comLimite(corrigida));
      sql = corrigida;
      linhas = r.rows;
      console.log("AGENTE: segunda SQL executada apos correcao.");
    } catch (e2) {
      console.error("AGENTE: correcao/segunda execucao falhou:", e2.message);
      return {
        resposta: "Tive um problema ao buscar essa informacao. Pode tentar de novo?",
        erro: "executar: " + e.message,
      };
    }
  }
  console.log(`AGENTE: ${linhas.length} linha(s) retornada(s).`);

  // 4. CHAMADA 2: resultado SQL -> resposta natural.
  // No modo do artigo, TODA consulta de dados passa por esta interpretacao da IA.
  // Se Groq/Gemini estiverem indisponiveis, existe fallback deterministico local.
  try {
    const ehInicio = !Array.isArray(historico) || historico.length === 0;
    const resposta = await redigir(pergunta, linhas, ehInicio, historico, sql);
    return { resposta, sql, linhas: linhas.length, modoAgente: "duas_chamadas" };
  } catch (e) {
    console.error("AGENTE: redacao por IA falhou; usando resposta local:", e.message);
    return {
      resposta: redigirLocal(pergunta, linhas),
      sql,
      linhas: linhas.length,
      fallbackLocal: true,
    };
  }
}
