// ============================================================
//  agente.js
//  O CORACAO do sistema novo. Fluxo (padrao de 2 chamadas):
//    1) IA recebe a PERGUNTA + o schema da tabela -> gera SQL
//    2) Validamos a SQL (so SELECT, bloqueia comandos perigosos)
//    3) Executamos no banco
//    4) IA recebe o RESULTADO -> escreve a resposta em portugues
//
//  Na primeira chamada a IA ve apenas schema/pergunta e produz a consulta.
//  Na segunda, recebe somente as linhas retornadas para redigir a resposta.
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
  // Remove apenas LIMIT/OFFSET do nivel externo, caso a IA tenha definido um
  // valor alto. Em seguida aplica o teto controlado pelo servidor.
  const s = sql
    .trim()
    .replace(/;$/, "")
    .replace(/\s+limit\s+(?:all|\d+)(?:\s+offset\s+\d+)?\s*$/i, "")
    .trim();
  return `${s} LIMIT ${teto}`;
}

// Monta um resumo curto das ultimas trocas, para dar contexto ao gerar SQL.
// So as ultimas 2-3 trocas importam para perguntas de acompanhamento.
function resumoHistorico(historico = []) {
  if (!Array.isArray(historico) || historico.length === 0) return "(sem contexto)";
  return historico.slice(-2).map((m) => {
    const quem = m.role === "user" ? "U" : "A";
    const txt = (m.content || "").toString().replace(/\s+/g, " ").slice(0, 120);
    const sqlAnterior = m.role === "assistant" && m.sql
      ? ` | SQL=${(m.sql || "").toString().replace(/\s+/g, " ").slice(0, 260)}`
      : "";
    return `${quem}:${txt}${sqlAnterior}`;
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
  if (/\b(em andamento|andamento|sendo feit[ao]s?|tocando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%andamento%')";
  if (/\b(em licitacao|licitacao|licitando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%licita%')";
  if (/\b(em projeto)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%projeto%')";
  if (/\b(paralisad[ao]s?|paradas?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%paralis%')";
  if (/\b(a iniciar|nao iniciad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%iniciar%')";
  if (/\b(homologad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%homolog%')";
  return "";
}

function condicaoLocalDaPergunta(p) {
  // Captura locais escritos de forma natural no fim da pergunta:
  // "no Centro", "na Bela Vista", "em Barra de Mamanguape" e "bairro Centro".
  // Termos de status/quantidade sao rejeitados para nao confundir "em andamento"
  // ou "no total" com bairro.
  let local = "";
  const mb = p.match(/\bbairro\s+(?:de\s+|do\s+|da\s+)?([a-z0-9][a-z0-9 -]{1,48})(?:$|\b(?:concluid|andamento|paralis|licit|projeto|homolog|valor|engenheir|empresa)\b)/i);
  if (mb) local = mb[1].trim();

  if (!local) {
    // Primeiro remove um status no final para aceitar "no Centro concluidas".
    const base = p.replace(/\s+\b(concluidas?|concluidos?|prontas?|prontos?|finalizadas?|finalizados?|terminadas?|terminados?|em andamento|paralisadas?|paralisados?|em licitacao|homologadas?|homologados?)\b.*$/i, "").trim();
    const m = base.match(/\b(?:no|na|em)\s+([a-z0-9][a-z0-9 -]{1,48})$/i);
    if (m) local = m[1].trim();
  }

  local = local
    .replace(/^(?:bairro|distrito)\s+(?:de\s+|do\s+|da\s+)?/i, "")
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!local || local.length < 2 || local.length > 48) return "";
  if (/^(andamento|licitacao|projeto|total|geral|tudo|cidade|mamanguape|obras?)$/i.test(local)) return "";

  // O texto ja foi normalizado e a limpeza acima remove apostrofos/%/_;
  // por isso pode entrar com seguranca no literal LIKE.
  return `(unaccent(COALESCE(bairro,'')) ILIKE unaccent('%${local}%') OR unaccent(objeto) ILIKE unaccent('%${local}%'))`;
}

function gerarSQLRapida(pergunta, historico = []) {
  const p = normalizarTexto(pergunta);
  if (!p) return null;

  const sqlAnterior = ultimaSQLDoHistorico(historico);
  const whereAnterior = whereDaSQL(sqlAnterior);
  const condAnterior = whereAnterior.replace(/^WHERE\s+/i, "").trim();

  const referenciaAnterior = /\b(dessas?|destas?|nessas?|nestas?|delas?|essas?|elas?|anteriores?|acima|mesmas?|isso)\b/.test(p);
  const perguntaCurtaLista = /^(?:e\s+)?quais(?:\s+sao)?$|^(?:lista|liste|mostra|mostre)(?:\s+(?:elas|essas|as obras))?$/.test(p);
  const curtaDeAcompanhamento = p.split(" ").length <= 7 && (
    /\b(engenheiros?|engenheiras?|responsaveis?|empresas?|executoras?|valor|valores|custo|bairro|status|situacao|nomes?)\b/.test(p) ||
    perguntaCurtaLista
  );

  const filtroStatus = filtroStatusDaPergunta(p);
  const filtroLocal = condicaoLocalDaPergunta(p);
  const temFiltroNovo = !!(filtroStatus || filtroLocal);

  // Se a pessoa diz explicitamente "dessas" + um novo filtro, refinamos a
  // consulta anterior. Se apenas faz uma pergunta curta, herdamos o filtro.
  const condicoes = [];
  if (condAnterior && referenciaAnterior) condicoes.push(condAnterior);
  if (filtroStatus) condicoes.push(filtroStatus);
  if (filtroLocal) condicoes.push(filtroLocal);
  if (!condicoes.length && condAnterior && curtaDeAcompanhamento) condicoes.push(condAnterior);

  const usarAnterior = !!condAnterior && (referenciaAnterior || curtaDeAcompanhamento) && !temFiltroNovo;
  const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

  const pedeEng = /\b(engenheiros?|engenheiras?|responsavel tecnico|responsaveis tecnicos)\b/.test(p);
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
      return `SELECT objeto, dados_extras FROM obras ${where} ORDER BY objeto`;
    }
    // Sem filtro nenhum (ex.: "qual o recurso da praca da bandeira") a IA
    // precisa entender de qual obra se trata - entao deixamos com ela.
    return null;
  }

  if (pedeContagem) {
    if (pedeEng) return `SELECT COUNT(DISTINCT engenheiro)::int AS quantidade_engenheiros FROM obras ${where} ${where ? "AND" : "WHERE"} engenheiro IS NOT NULL AND BTRIM(engenheiro) <> ''`;
    if (pedeEmpresa) return `SELECT COUNT(DISTINCT empresa)::int AS quantidade_empresas FROM obras ${where} ${where ? "AND" : "WHERE"} empresa IS NOT NULL AND BTRIM(empresa) <> ''`;
    if (pedeBairro) return `SELECT COUNT(DISTINCT bairro)::int AS quantidade_bairros FROM obras ${where} ${where ? "AND" : "WHERE"} bairro IS NOT NULL AND BTRIM(bairro) <> ''`;
    return `SELECT COUNT(*)::int AS quantidade_obras FROM obras ${where}`;
  }

  if (pedeSoma) {
    const campo = pedeExecutado ? "valor_executado" : "valor_total";
    return `SELECT COALESCE(SUM(${campo}),0) AS valor_total FROM obras ${where}`;
  }

  if (pedeEng) {
    if (where || usarAnterior) return `SELECT objeto, engenheiro FROM obras ${where} ORDER BY objeto`;
    return "SELECT DISTINCT engenheiro FROM obras WHERE engenheiro IS NOT NULL AND BTRIM(engenheiro) <> '' ORDER BY engenheiro";
  }
  if (pedeEmpresa) {
    if (where || usarAnterior) return `SELECT objeto, empresa FROM obras ${where} ORDER BY objeto`;
    return "SELECT DISTINCT empresa FROM obras WHERE empresa IS NOT NULL AND BTRIM(empresa) <> '' ORDER BY empresa";
  }
  if (pedeBairro && !/\bobra/.test(p)) {
    return `SELECT DISTINCT bairro FROM obras ${where} ${where ? "AND" : "WHERE"} bairro IS NOT NULL AND BTRIM(bairro) <> '' ORDER BY bairro`;
  }
  if (pedePercentual) return `SELECT objeto, percentual_executado FROM obras ${where} ORDER BY objeto`;
  if (pedeValor) {
    const campo = pedeExecutado ? "valor_executado" : "valor_total";
    return `SELECT objeto, ${campo} FROM obras ${where} ORDER BY objeto`;
  }
  if (pedeStatus && where) return `SELECT objeto, status FROM obras ${where} ORDER BY objeto`;

  // "Quais sao?" logo apos "quantas concluidas?" deve listar as mesmas obras,
  // sem depender da IA.
  if (condAnterior && perguntaCurtaLista) {
    return `SELECT objeto FROM obras WHERE ${condAnterior} ORDER BY objeto`;
  }

  // Listagens simples com filtro explicito (status ou local).
  if (where && /\b(obras?|quais|liste|lista|nomes?|mostra|mostre)\b/.test(p)) {
    return `SELECT objeto FROM obras ${where} ORDER BY objeto`;
  }

  // Acompanhamento curto usando o filtro anterior.
  if (usarAnterior && /\b(quais|lista|liste|nomes?|obras?|elas|essas|mostra|mostre)\b/.test(p)) {
    return `SELECT objeto FROM obras ${where} ORDER BY objeto`;
  }

  return null;
}

// --- CHAMADA 1: pergunta -> SQL ---
async function gerarSQL(pergunta, historico = [], correcao = null) {
  if (!correcao) {
    const rapida = gerarSQLRapida(pergunta, historico);
    if (rapida) {
      console.log("AGENTE: SQL rapida (sem IA):", rapida);
      return rapida;
    }
  }

  const blocoCorrecao = correcao
    ? `\nA consulta anterior falhou/rejeitou. SQL=${JSON.stringify((correcao.sql || "").slice(0, 450))} ERRO=${JSON.stringify((correcao.erro || "").slice(0, 180))}. Corrija.`
    : "";

  const instrucao = `Converta pergunta sobre obras publicas em UMA SQL PostgreSQL.
${SCHEMA}
REGRAS:
- Somente SELECT na tabela obras. Sem JOIN, comentarios ou outras tabelas.
- Para status use unaccent(status) ILIKE unaccent('%trecho%') para tolerar acentos.
- "quantas obras"=COUNT(*); "quantos engenheiros"=COUNT(DISTINCT engenheiro);
  "quantas empresas"=COUNT(DISTINCT empresa); soma de valor=SUM(valor_total).
- Pergunta de acompanhamento herda o WHERE da consulta anterior.
- Bairro/local deve procurar em bairro OU objeto com unaccent/ILIKE.
- Para recurso/contrato/convenio/aditivo/prazo selecione objeto,dados_extras.
- Termos de busca devem ser curtos.
- Se for apenas oi/ok/obrigado sem pedido de informacao, responda SEM_CONSULTA.
- Saida: somente SQL, sem markdown e sem ponto-e-virgula.
Contexto curto:
${resumoHistorico(historico)}
${blocoCorrecao}`;

  let ultimo = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const resposta = await chamarIAbruta([
      { role: "system", content: instrucao },
      { role: "user", content: (pergunta || "").toString().slice(0, 800) },
    ], { max_tokens: tentativa === 1 ? 180 : 240, temperature: 0, reasoning_effort: "low" });

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

// --- CHAMADA 2: resultado -> resposta natural ---
async function redigir(pergunta, linhas, ehInicio = false) {
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
  // Protecao para listas GIGANTES (planilha grande, ex: 500+ obras).
  // Nao da pra despejar 500 obras num WhatsApp (o app corta, fica caro e lento).
  // Se vier muita coisa, mostramos uma AMOSTRA e avisamos o total real.
  const totalLinhas = linhasLimpas.length;
  const LIMITE_LISTA = 12; // IA so redige extras; mantem payload pequeno
  const listaGigante = totalLinhas > LIMITE_LISTA;
  const amostra = listaGigante ? linhasLimpas.slice(0, LIMITE_LISTA) : linhasLimpas;
  const dados = JSON.stringify(amostra.slice(0, 15));
  const muitasLinhas = amostra.length > 8;
  const prompt = `Voce e o Assistente de Obras da Prefeitura de Mamanguape no WhatsApp.
O cidadao perguntou: "${pergunta}"
O sistema consultou o banco e retornou EXATAMENTE estes dados (JSON): ${dados}

Escreva uma resposta clara e cordial em portugues, formato WhatsApp.

REGRAS ABSOLUTAS DE EXATIDAO (o mais importante - nunca quebre):
- COPIE os numeros e valores EXATAMENTE como aparecem no JSON, digito por digito.
  Se o JSON diz "R$ 1.408.500,00", escreva "R$ 1.408.500,00" - NAO troque nenhum
  algarismo, NAO arredonde, NAO recalcule. Copiar errado um valor e o pior erro.
- Todo numero, nome ou valor na resposta TEM que aparecer no JSON. Se nao esta
  no JSON, NAO existe - nao invente.
- Para "quantas" (contagem): conte os itens do JSON ou use o COUNT que ele traz.
  O total que voce disser TEM que bater com a quantidade de itens listados. Se
  listou 6 obras, o total e 6 - nunca diga um numero diferente do que listou.
- NUNCA reutilize numeros de mensagens anteriores. Cada resposta usa SO este JSON.
- CUIDADO: "ao todo/geral" e DIFERENTE de "em andamento" (um status so). Use o
  numero exato que o JSON traz para a pergunta feita.
- NAO concorde com o cidadao sem conferir. A verdade e o JSON, nao a pergunta.
- Se o JSON vier vazio, diga que nao encontrou e peca para reformular. NUNCA
  invente numero para preencher.
- ${ehInicio
    ? "Esta e a PRIMEIRA mensagem: pode cumprimentar uma vez (Ola/Bom dia)."
    : "NAO cumprimente. A conversa JA comecou - va DIRETO a resposta."}

OUTRAS REGRAS:
- Os valores JA VEM formatados como "R$ ..." no JSON - use-os como estao.
- Nao mencione "banco", "SQL", "dados" nem que voce e uma IA.
- No maximo um emoji sutil. Seja objetivo e direto, sem floreio.
${listaGigante ? `- ATENCAO: existem ${totalLinhas} obras no total, mas voce recebeu so as primeiras ${LIMITE_LISTA} como amostra. Liste essas ${LIMITE_LISTA} e diga claramente: "Estas sao as primeiras ${LIMITE_LISTA} de ${totalLinhas} obras. Para ver melhor, me diga um bairro ou status especifico." NAO diga que sao so ${LIMITE_LISTA} no total - o total real e ${totalLinhas}.` : ""}
${muitasLinhas ? "- A lista e LONGA: UMA linha por obra: '• Nome — R$ valor'. Se o valor for 'valor nao informado', escreva assim mesmo (nao invente). SEM introducao. Termine com 'Total: N obras' onde N e a quantidade EXATA de itens listados. Se algumas obras nao tem valor, acrescente uma linha curta explicando: 'Obs.: algumas obras ainda nao tem valor cadastrado.'" : "- Responda de forma completa mas objetiva. Se o valor for 'valor nao informado', diga isso - nao invente numero."}`;

  const limite = muitasLinhas ? 520 : 360;
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

  // Agregacoes: COUNT/SUM etc.
  if (linhas.length === 1) {
    const l = linhas[0] || {};
    if ("quantidade_obras" in l) {
      const n = Number(l.quantidade_obras) || 0;
      return `Total: ${n} obra${n === 1 ? "" : "s"}.`;
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

  const LIMITE = 30;
  const amostra = linhas.slice(0, LIMITE);

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

  // 4. Redige resposta.
  // Para consultas comuns nao chama IA de novo: economiza aproximadamente metade
  // das chamadas e evita estourar TPM em conversas seguidas.
  if (!precisaRedacaoIA(pergunta, linhas)) {
    return {
      resposta: redigirLocal(pergunta, linhas),
      sql,
      linhas: linhas.length,
      respostaLocal: true,
    };
  }

  try {
    const ehInicio = !Array.isArray(historico) || historico.length === 0;
    const resposta = await redigir(pergunta, linhas, ehInicio);
    return { resposta, sql, linhas: linhas.length };
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
