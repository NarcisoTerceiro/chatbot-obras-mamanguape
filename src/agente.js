// ============================================================
//  agente.js - AGENTE 1 REFORCADO (resolucao semantica + candidatos reais)
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

// MODO PADRAO: IA interpreta a linguagem natural; o Node atua como guardrail.
// O planejador usa schema dinamico, regras gerais e memoria de conversa.
// Nao existe aprendizado persistente nem gravacao de perguntas/padroes.
// As regras rapidas antigas ficam disponiveis apenas como fallback de contingencia
// (ou se AGENTE_SQL_RAPIDA=true). Assim o chatbot nao depende de frases fixas.
const USAR_SQL_RAPIDA_PRIMEIRO = process.env.AGENTE_SQL_RAPIDA === "true";

// Camada deterministica de alta confianca vem ANTES do agente por ferramentas.
// Ela nao usa perguntas fixas: identifica operacao, escopo, filtros, campos e
// termos livres. Se nao reconhecer com seguranca, entrega para a IA.
// Pode ser desligada apenas para diagnostico com AGENTE_DIRETO=false.
const USAR_CAMADA_DIRETA = process.env.AGENTE_DIRETO !== "false";

// MODO PRINCIPAL: agente com ferramentas. A IA planeja o que precisa consultar,
// o Node valida/executa cada SELECT e a IA so redige depois de receber dados reais.
// Pode ser desativado apenas para contingencia com AGENTE_FERRAMENTAS=false.
const USAR_AGENTE_FERRAMENTAS = process.env.AGENTE_FERRAMENTAS !== "false";
const MAX_PASSOS_FERRAMENTAS = Math.max(1, Math.min(Number(process.env.AGENTE_MAX_PASSOS || 3), 4));

// Resolucao semantica de entidades/assuntos antes do Text-to-SQL.
// Em vez de transformar cada palavra da pergunta em ILIKE, o agente extrai o
// assunto, gera poucas pistas linguisticas temporarias, busca candidatos REAIS
// no PostgreSQL e so entao executa a consulta definitiva pelos IDs encontrados.
// Nao existe dicionario persistente de sinonimos nem agent_knowledge.
const USAR_BUSCA_SEMANTICA = process.env.AGENTE_BUSCA_SEMANTICA !== "false";
const MAX_CANDIDATOS_SEMANTICOS = Math.max(8, Math.min(Number(process.env.AGENTE_MAX_CANDIDATOS_SEMANTICOS || 24), 40));

// MODO ASSISTENTE: antes das regras de SQL, uma leitura curta da pergunta separa
// INTENCAO, CAMPOS PEDIDOS, ALVO NOVO e REFERENCIA AO CONTEXTO. A IA nao recebe
// permissao para executar SQL nessa etapa; ela apenas devolve um pequeno plano JSON.
// Se essa camada estiver indisponivel, todo o Agente 1 antigo continua funcionando.
const USAR_MODO_ASSISTENTE = process.env.AGENTE_MODO_ASSISTENTE !== "false";
const CONFIANCA_MIN_PLANO = Math.max(0.45, Math.min(Number(process.env.AGENTE_CONFIANCA_PLANO || 0.68), 0.95));


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


// ============================================================
// CONTEXTO RELEVANTE (estilo RAG / Vanna)
// ============================================================
// O schema completo continua sendo obtido do banco, mas nao precisamos enviar
// todos os valores distintos para a IA em toda pergunta. Este filtro conserva
// a estrutura e so mantem exemplos de valores que tenham relacao com a frase.
// Isso reduz tokens, latencia e a chance de bater limite do provedor.
function tokensRelevantes(s = "") {
  return [...new Set(normalizarTexto(s).split(/\s+/).filter((x) => x.length >= 3))];
}

function valorPareceRelevante(valor = "", pergunta = "") {
  const q = new Set(tokensRelevantes(pergunta));
  if (!q.size) return false;
  const vt = tokensRelevantes(valor);
  return vt.some((t) => q.has(t) || [...q].some((x) => x.length >= 5 && (t.startsWith(x) || x.startsWith(t))));
}

function contextoBancoCompacto(texto = "", pergunta = "") {
  const linhas = String(texto || "").split("\n");
  const saida = [];
  for (const linha of linhas) {
    if (!linha.includes("valores reais:")) {
      // Chaves JSON podem ser numerosas. Mantemos a linha, mas com teto.
      if (linha.startsWith("Chaves disponiveis em dados_extras:")) {
        saida.push(linha.slice(0, 1800));
      } else {
        saida.push(linha);
      }
      continue;
    }

    const [cab, valoresBrutos = ""] = linha.split("valores reais:");
    const nomeColuna = (cab.match(/^-\s*([^\s]+)/)?.[1] || "").toLowerCase();
    const valores = valoresBrutos.split(/,\s+/).filter(Boolean);

    // Status/origem sao pequenos e importantes para regra de negocio.
    if (["status", "aba_origem", "categoria"].includes(nomeColuna)) {
      saida.push(`${cab}valores reais: ${valores.slice(0, 15).join(", ")}`);
      continue;
    }

    const relevantes = valores.filter((v) => valorPareceRelevante(v, pergunta)).slice(0, 8);
    saida.push(relevantes.length
      ? `${cab}valores relevantes para esta pergunta: ${relevantes.join(", ")}`
      : `${cab}(valores omitidos por economia de tokens; descubra-os via SELECT se necessario)`);
  }
  return saida.join("\n").slice(0, 9000);
}


// Data-linking por amostra: em vez de mandar a tabela inteira ao LLM, fazemos
// uma busca pequena com os termos significativos e mostramos somente linhas
// candidatas. Esse padrao ajuda a ligar linguagem do usuario aos valores reais
// (siglas, grafias, etapas de licitacao) sem estourar tokens.
async function amostrasRelevantesDoBanco(pergunta = "") {
  try {
    const termos = termosLivresCandidatos(pergunta);
    if (!termos.length) return "(nenhuma amostra textual necessaria)";
    const cond = condicaoObjetoLivreDaPergunta(pergunta);
    if (!cond) return "(nenhuma amostra textual necessaria)";
    const r = await queryReadOnly(
      `SELECT objeto, bairro, status, categoria, engenheiro, empresa, aba_origem, ` +
      `dados_extras->>'STATUS ORIGINAL' AS status_original ` +
      `FROM obras WHERE ${cond} ORDER BY objeto LIMIT 8`
    );
    if (!r.rows?.length) return "(nenhuma linha candidata encontrada na amostra)";
    return r.rows.map((x, i) => `${i + 1}. ${JSON.stringify(x)}`).join("\n").slice(0, 5000);
  } catch (e) {
    console.warn("AGENTE: amostra relevante indisponivel:", e.message);
    return "(amostra relevante indisponivel)";
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

// --- GUARDRAIL SEMANTICO -------------------------------------------------
// A IA pode interpretar frases livres, mas a consulta precisa obedecer regras de
// negocio e coerencia minima. Este validador NAO tenta entender a frase inteira
// por regex; ele apenas barra erros perigosos/obvios antes de tocar no banco.
function validarSemanticaSQL(pergunta, sql) {
  const p = normalizarTexto(pergunta);
  const s = (sql || "").toString();
  const sn = normalizarTexto(s);
  const select = (s.match(/^\s*select\s+([\s\S]*?)\s+from\s+obras\b/i)?.[1] || "").toLowerCase();

  const falha = (motivo) => ({ ok: false, motivo: `coerencia: ${motivo}` });

  // Evita o erro classico: "qual engenheiro TEM mais obras" virar filtro por
  // um profissional chamado "tem/mais/possui".
  const filtrosEng = [...s.matchAll(/engenheiro[^\n]*?ilike\s+unaccent\('\%([^%']+)\%'/gi)]
    .map((m) => normalizarTexto(m[1] || ""));
  const termosInvalidos = new Set(["tem", "possui", "mais", "menos", "maior", "menor", "qual", "quais", "esta", "estao", "com"]);
  if (filtrosEng.some((x) => termosInvalidos.has(x))) {
    return falha("palavra da pergunta foi confundida com nome de responsavel");
  }

  // Quando o cidadao escreve explicitamente "bairro X", o filtro deve usar a
  // coluna bairro. Nao vale incluir o registro apenas porque o OBJETO contem X.
  if (/\bbairro\b/.test(p) && /\b(obras?|projetos?|pavimentacoes?|licitacoes?|ruas?)\b/.test(p)) {
    if (!/\bbairro\b/i.test(s)) return falha("a pergunta especifica um bairro, mas a SQL nao usa a coluna bairro");
    if (/\bor\s+[^)]*\bobjeto\b[^)]*(?:ilike|like)/i.test(s)) {
      return falha("bairro explicito nao pode ser ampliado por OR no nome do objeto");
    }
  }

  // Escopos de negocio: projeto, licitacao e pavimentacao sao categorias
  // separadas. A IA escolhe a frase livre, mas o Node exige o recorte correto.
  if (/\bprojetos?\b/.test(p) && !/EM_PROJETO/i.test(s)) {
    return falha("projeto/projetos exige origem EM_PROJETO");
  }
  if (/\b(licitacao|licitacoes|processo licitatorio|processos licitatorios)\b/.test(p) && !/EM_LICITAÇÃO|EM_LICITACAO/i.test(s)) {
    return falha("licitacao exige origem EM_LICITACAO");
  }
  if (/\bpaviment/.test(p) && !/PAVIMENTAÇÃO|PAVIMENTACAO/i.test(s)) {
    return falha("pavimentacao exige origem PAVIMENTACAO");
  }

  // "Obras" generico = obras fisicas + pavimentacoes. Para perguntas de
  // contagem/lista/ranking/soma, projetos e licitacoes nao podem entrar sem o
  // usuario pedir explicitamente para inclui-los.
  const falaObras = /\bobras?\b/.test(p);
  const falaOutrosTipos = /\b(projetos?|licitacao|licitacoes|processos? licitatorios?|pavimentacoes?)\b/.test(p);
  const pedeTudo = /\b(tudo junto|todos os registros|total de registros|incluindo projetos|incluindo licitacoes|todas as categorias)\b/.test(p);
  const ehConsultaDeConjunto = /\b(quant|quais|liste|lista|mostre|mostrar|total|soma|somando|mais|menos|maior|menor|ranking|em geral|ao todo)\b/.test(p);
  if (falaObras && !falaOutrosTipos && !pedeTudo && ehConsultaDeConjunto) {
    const escopoFisico = /EM_ANDAMENTO/i.test(s) && /PAVIMENTAÇÃO|PAVIMENTACAO/i.test(s);
    const somenteAndamento = /\b(em andamento|andamento|em execucao|execucao|executando)\b/.test(p) && /EM_ANDAMENTO/i.test(s) && !/EM_LICITAÇÃO|EM_LICITACAO/i.test(s);
    const excluiNaoObras = /NOT\s+IN\s*\(\s*'EM_PROJETO'\s*,\s*'EM_LICITAÇÃO'\s*\)/i.test(s);
    if (!escopoFisico && !somenteAndamento && !excluiNaoObras) {
      return falha("obras genericas devem excluir projetos e licitacoes");
    }
  }

  // Campo financeiro: se perguntou explicitamente pelo executado, nao pode
  // responder usando apenas valor_total.
  if (/\b(valor executado|ja executado|quanto executou|executado ate agora|montante executado)\b/.test(p)) {
    if (!/\bvalor_executado\b/i.test(s)) return falha("valor executado exige valor_executado");
  }

  // Se pediu campos objetivos na mesma mensagem, a SQL precisa trazer todos.
  // Para campos livres (recurso/contrato/convenio/prazo/data), dados_extras e
  // suficiente; a IA pode selecionar a chave exata quando souber.
  const campos = [
    [/\bengenheir|\bresponsavel|\barquit/, /\bengenheiro\b/i, "responsavel"],
    [/\bempresas?|\bexecutoras?|\bconstrutoras?/, /\bempresa\b/i, "empresa"],
    [/\bbairros?|\blocalizacao/, /\bbairro\b/i, "bairro"],
    [/\bpercentual|\bporcentagem/, /\bpercentual_executado\b/i, "percentual"],
    [/\bstatus|\bsituacao/, /\bstatus\b/i, "status"],
  ];
  for (const [rxPergunta, rxSQL, nome] of campos) {
    if (rxPergunta.test(p) && !rxSQL.test(select) && !/count\s*\(/i.test(select)) {
      return falha(`campo pedido (${nome}) nao foi selecionado`);
    }
  }
  if (/\b(recursos?|fontes? do recurso|fonte de recurso)\b/.test(p)) {
    // O nome da chave de recurso varia por aba. Exigimos o JSON inteiro e o
    // Node cria o campo canonico "recurso" depois da consulta.
    const extrasInteiro = /(?:^|,)\s*(?:obras\.)?dados_extras(?:\s+as\s+[a-z_][a-z0-9_]*)?\s*(?=,|$)/i.test(select);
    if (!extrasInteiro) return falha("recurso/fonte exige selecionar dados_extras inteiro para normalizacao entre abas");
  }
  if (/\b(contratos?|convenios?|aditivos?|prazos?|datas?|observacoes?)\b/.test(p)) {
    if (!/\bdados_extras\b|->>/i.test(select)) return falha("campo livre pedido exige dados_extras ou chave JSON real");
  }

  // Ranking por responsavel tem que ser uma agregacao real, nao um filtro por
  // uma palavra da frase.
  if (/\b(engenheir|responsavel|arquit)/.test(p) && /\b(mais|menos|maior|menor|ranking)\b/.test(p) && /\b(obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b/.test(p)) {
    if (!/\bgroup\s+by\s+engenheiro\b/i.test(s) || !/\bcount\s*\(/i.test(s)) {
      return falha("ranking de responsavel exige GROUP BY engenheiro + COUNT");
    }
    if (!/\bquantidade_registros\b/i.test(select)) {
      return falha("ranking de responsavel deve usar o alias quantidade_registros para auditoria");
    }
    const rankingObrasGenerico = /\bobras?\b/.test(p) && !/\b(projetos?|licitacoes?|pavimentacoes?|todos os registros|total de registros|tudo junto)\b/.test(p);
    if (rankingObrasGenerico && (!/\bobras_fisicas\b/i.test(select) || !/\bpavimentacoes\b/i.test(select))) {
      return falha("ranking de obras deve separar obras_fisicas e pavimentacoes");
    }
  }

  return { ok: true };
}

function validarConsulta(pergunta, sql) {
  const seguranca = sqlSegura(sql);
  if (!seguranca.ok) return seguranca;
  return validarSemanticaSQL(pergunta, sql);
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
    const estadoAnterior = m.role === "assistant" && m.estado
      ? `\nESTADO_SEMANTICO: ${JSON.stringify(m.estado).slice(0, 700)}`
      : "";
    return `${quem}: ${txt}${sqlAnterior}${estadoAnterior}`;
  }).join("\n");
}

// ------------------------------------------------------------
//  CAMINHO RAPIDO SEM IA
//  Resolve as perguntas mais comuns diretamente em SQL.
//  Isso evita gastar tokens para coisas simples e preserva o contexto.
// ------------------------------------------------------------
function normalizarTexto(s = "") {
  let t = s.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();

  // Corrige erros de digitacao muito comuns apenas em palavras de comando/campo.
  // Nomes de obras, bairros, empresas e pessoas nao sao alterados.
  const trocas = [
    [/\bexite\b/g, "existe"],
    [/\brecuso\b/g, "recurso"],
    [/\brecusos\b/g, "recursos"],
    [/\brecusso\b/g, "recurso"],
    [/\brecussos\b/g, "recursos"],
    [/\bultilizado\b/g, "utilizado"],
    [/\bultilizados\b/g, "utilizados"],
    [/\bultilizada\b/g, "utilizada"],
    [/\bultilizadas\b/g, "utilizadas"],
    [/\butilisado\b/g, "utilizado"],
    [/\butilisados\b/g, "utilizados"],
    [/\butilisada\b/g, "utilizada"],
    [/\butilisadas\b/g, "utilizadas"],
    [/\bengenhero\b/g, "engenheiro"],
    [/\bengenheros\b/g, "engenheiros"],
    [/\bestatus\b/g, "status"],
    [/\bestatu\b/g, "status"],
  ];
  for (const [rx, valor] of trocas) t = t.replace(rx, valor);
  return t;
}

// Campos livres mudam de nome conforme a aba da planilha. Ex.: recurso pode
// aparecer como RECURSO, CONVENIO/RECURSO ou FONTE DO RECURSO. Normalizamos
// esses nomes depois da consulta para que a IA receba um campo canonico.
function normalizarChaveExtra(s = "") {
  return s.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function valorExtraPorPrioridade(extras, prioridades = []) {
  if (!extras || typeof extras !== "object") return null;
  const entradas = Object.entries(extras).map(([k, v]) => [normalizarChaveExtra(k), v]);
  for (const alvo of prioridades) {
    const a = normalizarChaveExtra(alvo);
    const achou = entradas.find(([k, v]) => k === a && v !== null && v !== undefined && String(v).trim() !== "");
    if (achou) return achou[1];
  }
  return null;
}

function enriquecerLinhaParaIA(linha = {}) {
  if (!linha || typeof linha !== "object") return linha;
  const out = { ...linha };
  const ex = linha.dados_extras && typeof linha.dados_extras === "object" ? linha.dados_extras : null;
  if (!ex) return out;

  if (out.recurso === null || out.recurso === undefined || String(out.recurso).trim() === "") {
    out.recurso = valorExtraPorPrioridade(ex, [
      "RECURSO",
      "CONVENIO/RECURSO",
      "FONTE DO RECURSO",
      "FONTE RECURSO",
      "TIPO_RECURSO",
      "TIPO RECURSO",
    ]);
  }
  if (out.convenio === null || out.convenio === undefined || String(out.convenio).trim() === "") {
    out.convenio = valorExtraPorPrioridade(ex, [
      "N DO CONVENIO/ PROPOSTA",
      "Nº DO CONVENIO/ PROPOSTA",
      "NUMERO DO CONVENIO",
      "CONVENIO",
      "PROPOSTA",
    ]);
  }
  if (out.contrato === null || out.contrato === undefined || String(out.contrato).trim() === "") {
    out.contrato = valorExtraPorPrioridade(ex, [
      "N DO CONTRATO",
      "Nº DO CONTRATO",
      "NUMERO DO CONTRATO",
      "CONTRATO",
    ]);
  }
  if (out.observacoes === null || out.observacoes === undefined || String(out.observacoes).trim() === "") {
    out.observacoes = valorExtraPorPrioridade(ex, ["OBSERVACOES", "OBSERVACAO"]);
  }
  if (out.tipo_recurso === null || out.tipo_recurso === undefined || String(out.tipo_recurso).trim() === "") {
    out.tipo_recurso = valorExtraPorPrioridade(ex, ["TIPO_RECURSO", "TIPO RECURSO"]);
  }
  if (out.data_inicio === null || out.data_inicio === undefined || String(out.data_inicio).trim() === "") {
    out.data_inicio = valorExtraPorPrioridade(ex, ["DATA_INICIO", "DATA INICIO", "DATA DE INICIO"]);
  }
  if (out.data_prev_termino === null || out.data_prev_termino === undefined || String(out.data_prev_termino).trim() === "") {
    out.data_prev_termino = valorExtraPorPrioridade(ex, ["DATA_PREV_TERMINO", "DATA PREV TERMINO", "PREVISAO DE TERMINO", "DATA PREVISTA DE TERMINO"]);
  }
  if (out.saldo_devedor === null || out.saldo_devedor === undefined || String(out.saldo_devedor).trim() === "") {
    out.saldo_devedor = valorExtraPorPrioridade(ex, ["SALDO DEVEDOR", "SALDO"]);
  }
  return out;
}

function termosLivresCandidatos(pergunta = "") {
  const p = normalizarTexto(pergunta);
  // Remove palavras funcionais, pronomes de contexto e palavras que descrevem
  // OPERACOES (somar, comparar, listar, valor etc.). O que sobra sao termos
  // realmente uteis para localizar entidades nos dados: UBS, drenagem, escola,
  // nome de rua, nome de equipamento, siglas etc.
  const stop = new Set([
    "a","o","as","os","um","uma","uns","umas","de","do","da","dos","das",
    "no","na","nos","nas","em","e","ou","que","qual","quais","quem","como",
    "me","fala","fale","diga","dar","informe","informar","explique","explica","detalhe","detalhes","dados","informacao","informacoes","mostre","liste","listar","existe","existem","tem",
    "tenho","temos","sao","ser","esta","estao","foi","foram","com","sem","por",
    "para","pra","seu","sua","seus","suas","isso","isto","aquilo","mais","menos",
    "maior","menor","quantas","quantos","quanto","total","geral","todos","todas","cada","entre",
    "obra","obras","projeto","projetos","pavimentacao","pavimentacoes","licitacao",
    "licitacoes","processo","processos","registro","registros","bairro","bairros",
    "engenheiro","engenheiros","arquiteto","arquitetos","responsavel","responsaveis",
    "empresa","empresas","executora","executoras","recurso","recursos","fonte","fontes",
    "valor","valores","investimento","custo","custos","status","situacao","percentual","porcentagem",
    "contrato","contratos","convenio","convenios","data","datas","prazo","prazos","observacao","observacoes",
    "concluida","concluidas","concluido","concluidos","andamento","execucao","atual","cadastrado",
    "cadastrada","cadastradas","cadastrados","cadastro","algum","alguma","alguns","algumas",
    "relacionado","relacionada","relacionados","relacionadas","referente","referentes",
    "ligado","ligada","ligados","ligadas","sobre","municipio","prefeitura",
    "soma","somam","somar","somando","somado","somados","ja","dinheiro","base","planilha","banco","sistema",
    "servico","servicos","aparece","aparecem","acima","abaixo","superior","inferior",
    "utilizado","utilizados","utilizada","utilizadas","usado","usados","usada","usadas",
    "empregado","empregados","empregada","empregadas","aplicado","aplicados","aplicada","aplicadas",
    "ela","elas","ele","eles","dela","delas","dele","deles","nela","nelas","nele","neles",
    "essa","essas","esse","esses","dessa","dessas","desse","desses","esta","estas","este","estes",
    "desta","destas","deste","destes","nessa","nessas","nesse","nesses","nesta","nestas","neste","nestes"
  ]);

  const ehOperacional = (t) => /^(?:investid\w*|cust(?:a|am|ou|ando)?|executad\w*|avancad\w*|finalizad\w*|terminad\w*|pront\w*|milhao|milhoes|milhar|milhares|mil|real|reais|cuida|cuidam|acompanha|acompanham)$/.test(t);

  const tokens = p.split(/\s+/).filter((t) =>
    t.length >= 2 && !stop.has(t) && !ehOperacional(t) && !/^\d+(?:[.,]\d+)?$/.test(t)
  );
  return [...new Set(tokens)].slice(0, 12);
}


// Diferencia uma referencia pura ("ela", "dessas obras") de uma pergunta que
// contem um ALVO nomeado no proprio turno ("dessa Reforma da Escola...").
// Quando o usuario escreveu o nome/descricao do item, esse alvo novo vence a
// memoria anterior. Isso evita herdar filtros antigos como "concluidas".
function temAlvoExplicitoNaPergunta(pergunta = "") {
  const termos = termosLivresCandidatos(pergunta);
  // Dois termos significativos normalmente indicam um nome/descricao real.
  // Um unico termo continua podendo ser um refinamento do conjunto anterior
  // (ex.: "dessas obras do Centro").
  return termos.length >= 2;
}

function ehPedidoDescricaoRegistro(pergunta = "") {
  const p = normalizarTexto(pergunta);
  return /\b(fale|fala|conte|explica|explique)\s+(?:mais\s+)?sobre\b/.test(p) ||
    /\b(detalhes?|informacoes?|dados)\s+(?:d[oa]s?|sobre|desta|deste|dessa|desse|dela|dele)\b/.test(p) ||
    /\bo que (?:voce )?sabe sobre\b/.test(p) ||
    /\bme diga tudo sobre\b/.test(p);
}

function tipoRegistroHumano(aba = "") {
  if (aba === "EM_PROJETO") return "projeto";
  if (aba === "EM_LICITAÇÃO") return "licitação";
  if (aba === "PAVIMENTAÇÃO") return "pavimentação";
  if (aba === "EM_ANDAMENTO") return "obra";
  return "registro";
}

function formatarPercentualSeguro(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

function formatarFichaRegistro(linha = {}) {
  const l = enriquecerLinhaParaIA(linha);
  const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
  const itens = [];
  itens.push(`Tipo: ${tipoRegistroHumano(l.aba_origem)}`);
  if (!vazio(l.status)) itens.push(`Status: ${l.status}`);
  if (!vazio(l.bairro)) itens.push(`Local: ${l.bairro}`);
  if (!vazio(l.engenheiro)) itens.push(`Responsável técnico: ${l.engenheiro}`);
  if (!vazio(l.empresa)) itens.push(`Empresa: ${l.empresa}`);
  if (!vazio(l.recurso)) itens.push(`Recurso: ${l.recurso}`);
  if (!vazio(l.tipo_recurso) && normalizarTexto(l.tipo_recurso) !== normalizarTexto(l.recurso || "")) itens.push(`Tipo de recurso: ${l.tipo_recurso}`);
  if (!vazio(l.contrato)) itens.push(`Contrato: ${l.contrato}`);
  if (!vazio(l.convenio)) itens.push(`Convênio/proposta: ${l.convenio}`);
  if (!vazio(l.valor_total)) itens.push(`Valor total: ${formatarMoedaSemantica(l.valor_total)}`);
  if (!vazio(l.valor_executado)) itens.push(`Valor executado: ${formatarMoedaSemantica(l.valor_executado)}`);
  if (!vazio(l.saldo_devedor)) itens.push(`Saldo devedor: ${formatarMoedaSemantica(l.saldo_devedor)}`);
  const pct = formatarPercentualSeguro(l.percentual_executado);
  if (pct) itens.push(`Execução: ${pct}`);
  if (!vazio(l.data_inicio)) itens.push(`Início: ${l.data_inicio}`);
  if (!vazio(l.data_prev_termino)) itens.push(`Previsão de término: ${l.data_prev_termino}`);
  if (!vazio(l.observacoes)) itens.push(`Observações: ${l.observacoes}`);
  return `**${l.objeto || "Registro sem nome"}**\n` + itens.map((x) => `• ${x}`).join("\n");
}

function pistasInterpretacaoPergunta(pergunta = "") {
  const p = normalizarTexto(pergunta);
  const campos = [];
  if (/\b(recursos?|fontes? do recurso|fonte de recurso)\b/.test(p)) campos.push("recurso/fonte do recurso");
  if (/\b(engenheiros?|responsaveis?|arquitetos?)\b/.test(p)) campos.push("responsavel tecnico");
  if (/\b(empresas?|executoras?|construtoras?)\b/.test(p)) campos.push("empresa executora");
  if (/\b(valores?|investido|investimento|custo|custos)\b/.test(p)) campos.push("valor");
  if (/\b(percentual|porcentagem)\b/.test(p)) campos.push("percentual executado");
  if (/\b(bairros?|localizacao|local)\b/.test(p)) campos.push("bairro/local");
  if (/\b(status|situacao)\b/.test(p)) campos.push("status/situacao");

  return {
    pergunta_normalizada: p,
    campos_detectados: campos,
    // Estes termos NAO sao categorias pre-cadastradas. Sao simplesmente as
    // palavras significativas que sobraram da pergunta e que o planejador pode
    // procurar em objeto ou confrontar com os metadados reais.
    termos_livres_candidatos: termosLivresCandidatos(pergunta),
  };
}


// ============================================================
// EXEMPLOS SEMANTICOS DE NEGOCIO (estilo Vanna)
// ============================================================
// Estes exemplos NAO sao perguntas fixas e NAO geram respostas prontas.
// Eles ensinam ao planejador como interpretar o nosso modelo de dados. Em cada
// turno selecionamos somente os exemplos semanticamente mais proximos.
const EXEMPLOS_SEMANTICOS = [
  {
    id: "obras_concluidas",
    pergunta: "quantas obras concluidas existem e quais sao",
    tags: "obra concluida contar listar status pavimentacao",
    regra: "Obras genericas usam EM_ANDAMENTO + PAVIMENTAÇÃO; projeto e licitacao ficam fora. Filtrar status concluido e listar os objetos se isso foi pedido.",
  },
  {
    id: "ranking_responsavel_obras",
    pergunta: "qual responsavel tem mais obras",
    tags: "engenheiro responsavel ranking mais quantidade obras",
    regra: "Para ranking de obras, considerar apenas EM_ANDAMENTO + PAVIMENTAÇÃO, agrupar por engenheiro e contar no PostgreSQL. Nao somar projetos/licitações escondidos.",
  },
  {
    id: "bairro_campos",
    pergunta: "liste as obras do centro e seus recursos responsaveis valores",
    tags: "bairro centro listar recurso engenheiro valor",
    regra: "Se o usuario disser bairro X, filtrar pela coluna bairro. Para recurso selecionar dados_extras inteiro e normalizar depois. Trazer todos os campos explicitamente pedidos.",
  },
  {
    id: "entidade_livre",
    pergunta: "quantas UBS existem e quais seus recursos",
    tags: "entidade sigla objeto contar recurso todas categorias",
    regra: "Termo livre como sigla/equipamento deve ser procurado no objeto. Se o usuario nao disser obra/projeto/licitação, pesquisar todas as categorias e identificar cada tipo na resposta. Nao existe lista fixa de entidades.",
  },
  {
    id: "followup_conjunto",
    pergunta: "quais sao essas obras e quem sao os responsaveis delas",
    tags: "followup essas delas contexto memoria conjunto anterior",
    regra: "Referencia pronominal usa primeiro o conjunto do turno imediatamente anterior. Preserve os filtros sem ressuscitar assunto mais antigo.",
  },
  {
    id: "valor_total_vs_executado",
    pergunta: "qual o valor total e quanto ja foi executado",
    tags: "valor total executado financeiro",
    regra: "valor_total e valor_executado sao campos diferentes. Se ambos forem pedidos, selecionar ambos; nunca substituir um pelo outro.",
  },
  {
    id: "projetos",
    pergunta: "quais projetos concluidos existem",
    tags: "projeto concluido listar",
    regra: "Projeto exige aba_origem EM_PROJETO. Nao chamar projeto de obra fisica.",
  },
  {
    id: "licitacoes",
    pergunta: "quais licitacoes estao em habilitacao",
    tags: "licitacao habilitacao status",
    regra: "Licitacao exige aba_origem EM_LICITAÇÃO. 'Habilitacao em andamento' nao significa obra fisica em andamento.",
  },
  {
    id: "descricao_item",
    pergunta: "fale sobre esta obra",
    tags: "descricao detalhes ficha item status recurso engenheiro valor",
    regra: "Quando o usuario pede para falar sobre um item, trate como descricao do registro. Localize o item e apresente os principais dados disponiveis; nao transforme o pedido em contagem, soma ou apenas responsavel.",
  },
  {
    id: "multiplos_campos",
    pergunta: "qual o recurso e o engenheiro desta obra",
    tags: "recurso engenheiro dois campos mesma pergunta",
    regra: "Uma mensagem pode pedir varios campos. A consulta precisa trazer todos; recurso vem de dados_extras e engenheiro da coluna engenheiro.",
  },
  {
    id: "termo_desconhecido",
    pergunta: "tem algum registro relacionado a uma entidade que nunca vimos",
    tags: "termo desconhecido descoberta sinonimo grafia objeto",
    regra: "Antes de dizer que nao existe, fazer descoberta dos nomes reais de objeto e tentar abreviacao, sinonimo ou grafia aproximada.",
  },
];

function scoreExemploSemantico(exemplo, pergunta = "") {
  const q = new Set(tokensRelevantes(pergunta));
  const base = tokensRelevantes(`${exemplo.pergunta || ""} ${exemplo.tags || ""} ${exemplo.regra || ""}`);
  let score = 0;
  for (const t of base) {
    if (q.has(t)) score += 3;
    else if ([...q].some((x) => x.length >= 5 && (t.startsWith(x) || x.startsWith(t)))) score += 1;
  }
  const p = normalizarTexto(pergunta);
  if (/\b(ela|ele|delas?|deles?|essas?|esses?|dessas?|desses?)\b/.test(p) && exemplo.id === "followup_conjunto") score += 6;
  if (/\b(mais|menos|ranking)\b/.test(p) && exemplo.id === "ranking_responsavel_obras") score += 5;
  if (/\b(recursos?|fonte)\b/.test(p) && exemplo.id === "bairro_campos") score += 2;
  return score;
}

// Seleciona somente exemplos gerais embutidos no codigo.
// Eles servem como orientacao de negocio, nao sao frases exigidas e nao sao
// alterados pelo uso do chatbot. Nenhuma pergunta do usuario e gravada aqui.
function exemplosRelevantes(pergunta = "", limite = 4) {
  const todos = EXEMPLOS_SEMANTICOS
    .map((e) => ({ ...e, score: scoreExemploSemantico(e, pergunta) }))
    .sort((a, b) => b.score - a.score)
    .filter((e, i) => e.score > 0 || i === 0)
    .slice(0, Math.max(1, limite));

  const texto = todos.map((e) =>
    `Exemplo de interpretacao: "${e.pergunta}" -> ${e.regra}`
  ).join("\n");

  return { texto };
}

// O historico comum serve apenas para CONTEXTO da conversa.
// Ele nao vira treinamento nem conhecimento permanente.

function camposSolicitados(pergunta = "") {
  const p = normalizarTexto(pergunta);
  const campos = [];
  if (/\b(recursos?|fontes? do recurso|fonte de recurso)\b/.test(p)) campos.push("recurso");
  if (/\b(status|situacao)\b/.test(p)) campos.push("status");
  if (/\b(engenheiros?|responsaveis?|arquitetos?|cuida|cuidam|acompanha|acompanham)\b/.test(p)) campos.push("engenheiro");
  if (/\b(empresas?|executoras?|construtoras?)\b/.test(p)) campos.push("empresa");
  if (/\b(bairros?|localizacao|local)\b/.test(p)) campos.push("bairro");
  if (/\b(valor total|valores totais|valor cadastrado|valores cadastrados|investid\w*|investimentos?|custo|custos|custa|custam|precos?|dinheiro)\b/.test(p)) campos.push("valor_total");
  if (/\b(valor executado|ja executado|quanto executou|executado ate agora)\b/.test(p)) campos.push("valor_executado");
  if (/\b(percentual|porcentagem|mais adiantad|mais avancad)\b/.test(p)) campos.push("percentual_executado");
  return [...new Set(campos)];
}

function sqlDescobertaUniversal(pergunta = "") {
  const p = normalizarTexto(pergunta);
  const precisaExtras = /\b(recursos?|fontes? do recurso|fonte de recurso|contratos?|convenios?|aditivos?|prazos?|datas?|observacoes?)\b/.test(p);
  return "SELECT objeto, status, categoria, bairro, engenheiro, empresa, aba_origem" +
    (precisaExtras ? ", dados_extras" : "") +
    " FROM obras WHERE objeto IS NOT NULL ORDER BY objeto LIMIT 80";
}

async function executarDescobertaUniversal(pergunta = "") {
  const sql = sqlDescobertaUniversal(pergunta);
  const r = await queryReadOnly(sql);
  return {
    objetivo: "descoberta de nomes e tipos existentes na base para interpretar termo livre",
    sql,
    linhas: r.rows || [],
    descoberta: true,
  };
}


// Fallback universal SEM IA para quando Groq/Gemini estiverem indisponiveis.
// Nao existe lista de entidades (UBS, escola, praca etc.). Pegamos os termos
// significativos da pergunta e procuramos dinamicamente no campo objeto.
function escaparLiteralSQL(valor = "") {
  return String(valor).replace(/'/g, "''");
}

// Identifica quando RECURSO/FONTE e um FILTRO, e nao apenas um campo pedido.
// Exemplos naturais: "quais usam recurso proprio?", "obras com recurso federal".
// Nao depende de valores cadastrados: extrai dinamicamente o texto informado
// pelo usuario e aplica sobre o recurso canonico das diferentes abas.
function termoFiltroRecursoDaPergunta(pergunta = "") {
  const p = normalizarTexto(pergunta);
  if (!p) return "";

  let termo = "";

  // Quando o verbo vem ANTES de "recurso", existe um valor de recurso sendo
  // usado como FILTRO: "quais usam recurso proprio?", "obras com recurso FNDE".
  // Esse formato tem prioridade porque e semanticamente inequívoco.
  let m = p.match(/\b(?:usam?|utilizam?|possuem?|tem|com)\s+(?:o\s+|os\s+)?(?:recursos?|fontes?(?: do recurso)?)\s+(.+)$/i);
  if (m) termo = m[1] || "";

  if (termo) {
    termo = termo
      .replace(/\s+\b(?:nas?|nos?|em)\s+(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b.*$/i, "")
      .replace(/\s+\b(?:que|e)\s+(?:estao|sao|tem|possuem|ficam|foram)\b.*$/i, "")
      .trim();
    if (!termo || /^(?:qual|quais|quanto|quantos|quantas|status|engenheiro|responsavel|empresa|bairro|valor)$/i.test(termo)) return "";
    return termo.slice(0, 80);
  }

  // "quais os recursos utilizados nas UBS?" significa PEDIR o campo recurso
  // das UBS; "utilizados" nao e o nome de um recurso. O mesmo vale para
  // "recursos usados", "fontes aplicadas" etc. Essa barreira impede SQL como
  // recurso ILIKE '%utilizados nas ubs%'.
  const pedeRecursoComoCampo =
    /\b(?:qual|quais|informe|informar|mostre|mostrar|liste|listar|diga|saber)\b[\s\S]*?\b(?:recursos?|fontes?(?: do recurso)?)\b/i.test(p) ||
    /\b(?:recursos?|fontes?(?: do recurso)?)\s+(?:utilizad[oa]s?|usad[oa]s?|empregad[oa]s?|aplicad[oa]s?)\b/i.test(p);
  if (pedeRecursoComoCampo) return "";

  // Forma curta de filtro: "recurso proprio", "fonte caixa", "recurso federal".
  // Se vier "recurso da UBS"/"recursos das obras", e campo pedido e nao filtro.
  m = p.match(/\b(?:recursos?|fontes?(?: do recurso)?)\s+(.+)$/i);
  let candidato = (m?.[1] || "").trim();
  if (!candidato) return "";
  if (/^(?:da|das|do|dos|de|dela|delas|dele|deles|na|nas|no|nos|em)\b/i.test(candidato)) return "";
  if (/^(?:utilizad[oa]s?|usad[oa]s?|empregad[oa]s?|aplicad[oa]s?)(?:\s|$)/i.test(candidato)) return "";

  candidato = candidato
    .replace(/\s+\b(?:nas?|nos?|em)\s+(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b.*$/i, "")
    .replace(/\s+\b(?:que|e)\s+(?:estao|sao|tem|possuem|ficam|foram)\b.*$/i, "")
    .trim();

  if (!candidato || /^(?:qual|quais|quanto|quantos|quantas|status|engenheiro|responsavel|empresa|bairro|valor)$/i.test(candidato)) return "";
  return candidato.slice(0, 80);
}

function expressaoRecursoCanonicoSQL() {
  return `COALESCE(` +
    `dados_extras->>'RECURSO', ` +
    `dados_extras->>'CONVÊNIO/RECURSO', ` +
    `dados_extras->>'CONVENIO/RECURSO', ` +
    `dados_extras->>'FONTE DO RECURSO', ` +
    `dados_extras->>'FONTE RECURSO', ` +
    `dados_extras->>'TIPO_RECURSO', ` +
    `dados_extras->>'TIPO RECURSO', '')`;
}

function condicaoRecursoDaPergunta(pergunta = "") {
  const termo = termoFiltroRecursoDaPergunta(pergunta);
  if (!termo) return "";
  return `unaccent(${expressaoRecursoCanonicoSQL()}) ILIKE unaccent('%${escaparLiteralSQL(termo)}%')`;
}

function variantesBuscaLivre(termo = "") {
  const t = normalizarTexto(termo).replace(/[^a-z0-9]/g, "").trim();
  if (!t) return [];
  const v = new Set([t]);

  // Flexao simples PT-BR. Nao tenta "corrigir" nomes proprios: apenas cria
  // alternativas de busca, mantendo sempre o termo original.
  if (t.length >= 4) {
    if (t.endsWith("coes") && t.length > 5) v.add(t.slice(0, -4) + "cao");
    if (t.endsWith("oes") && t.length > 4) v.add(t.slice(0, -3) + "ao");
    if (t.endsWith("ais") && t.length > 4) v.add(t.slice(0, -3) + "al");
    if (t.endsWith("eis") && t.length > 4) v.add(t.slice(0, -3) + "el");
    if (t.endsWith("ois") && t.length > 4) v.add(t.slice(0, -3) + "ol");
    if (t.endsWith("uis") && t.length > 4) v.add(t.slice(0, -3) + "ul");
    if (t.endsWith("ns") && t.length > 3) v.add(t.slice(0, -2) + "m");
    if (t.endsWith("res") && t.length > 4) v.add(t.slice(0, -2));
    if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) v.add(t.slice(0, -1));
  }
  return [...v].filter((x) => x.length >= 2).slice(0, 4);
}

function expressaoBuscaLivrePorVariante(termo = "") {
  const lit = escaparLiteralSQL(termo);
  // Data-linking: quando o usuario nao nomeia uma coluna, pesquisamos nas
  // colunas textuais e no JSON livre. Isso permite encontrar siglas, nomes,
  // escolas, pracas, contratos, recursos etc. sem uma lista fixa de entidades.
  return `(` + [
    `unaccent(COALESCE(objeto,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(bairro,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(engenheiro,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(empresa,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(status,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(categoria,'')) ILIKE unaccent('%${lit}%')`,
    `unaccent(COALESCE(dados_extras::text,'')) ILIKE unaccent('%${lit}%')`,
  ].join(" OR ") + `)`;
}

function condicaoObjetoLivreDaPergunta(pergunta = "") {
  const termos = termosLivresCandidatos(pergunta)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!termos.length) return "";

  // Cada conceito precisa aparecer em algum campo da MESMA linha. Dentro de
  // cada conceito aceitamos singular/plural. Ex.: "escolas" encontra "escola";
  // "pracas" encontra "praca". Palavras funcionais como "alguma",
  // "relacionada" e "cadastrada" ja foram removidas no extrator.
  return termos.map((t) => {
    const variantes = variantesBuscaLivre(t);
    if (!variantes.length) return "";
    return `(${variantes.map(expressaoBuscaLivrePorVariante).join(" OR ")})`;
  }).filter(Boolean).join(" AND ");
}


// ============================================================
// RESOLUCAO SEMANTICA DE ASSUNTOS / ENTIDADES
// ============================================================
// O objetivo desta camada e resolver casos como:
//   "qual o recurso das UBS?"
// sem depender de um cadastro manual UBS -> posto de saude -> PSF etc.
// A IA gera apenas PISTAS DE BUSCA temporarias. O banco continua sendo a fonte
// da verdade e a consulta final usa somente IDs que realmente existem.

let cachePgTrgm = { valor: null, quando: 0 };
const CACHE_TRGM_MS = 10 * 60 * 1000;

async function pgTrgmDisponivel() {
  const agora = Date.now();
  if (cachePgTrgm.valor !== null && agora - cachePgTrgm.quando < CACHE_TRGM_MS) {
    return cachePgTrgm.valor;
  }
  try {
    const r = await queryReadOnly("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok");
    cachePgTrgm = { valor: !!r.rows?.[0]?.ok, quando: agora };
  } catch {
    cachePgTrgm = { valor: false, quando: agora };
  }
  return cachePgTrgm.valor;
}

function extrairLiteraisILIKE(condicao = "") {
  const out = [];
  const rx = /ILIKE\s+unaccent\('\%([^%']+)\%'\)/gi;
  let m;
  while ((m = rx.exec(condicao))) out.push(normalizarTexto(m[1]));
  return out.filter(Boolean);
}

function termosAssuntoSemantico(pergunta = "") {
  const p = normalizarTexto(pergunta);
  let termos = termosLivresCandidatos(pergunta);
  if (!termos.length) return [];

  // Valores ja reconhecidos como filtros estruturados nao sao o ASSUNTO livre.
  // Ex.: "UBS do Centro" -> Centro e filtro de local; UBS e o assunto.
  const estruturados = [
    filtroStatusDaPergunta(p),
    condicaoLocalDaPergunta(p),
    condicaoEngenheiroDaPergunta(p),
    condicaoEngenheiroImplicitoDaPergunta(p),
    condicaoRecursoDaPergunta(p),
  ].flatMap(extrairLiteraisILIKE);

  if (estruturados.length) {
    termos = termos.filter((t) => !estruturados.some((e) => {
      const nt = normalizarTexto(t);
      return nt === e || nt.startsWith(e) || e.startsWith(nt) || e.split(/\s+/).includes(nt);
    }));
  }
  return [...new Set(termos)].slice(0, 6);
}

function sanitizarPistaSemantica(v = "") {
  const t = normalizarTexto(v)
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2 || t.length > 80) return "";
  return t;
}

async function interpretarAssuntoSemantico(pergunta = "", historico = []) {
  const termos = termosAssuntoSemantico(pergunta);
  if (!termos.length) return null;

  const alvoLiteral = sanitizarPistaSemantica(termos.join(" "));
  const prompt = `Voce atua SOMENTE como resolvedor linguistico de busca para um banco de obras publicas.\n\n` +
    `Pergunta: ${JSON.stringify(pergunta)}\n` +
    `Termos livres extraidos pelo Node: ${JSON.stringify(termos)}\n\n` +
    `Retorne APENAS JSON valido neste formato:\n` +
    `{\"usar\":true,\"alvo\":\"...\",\"tipo\":\"conceito_grupo|nome_especifico|nenhum\",` +
    `\"equivalentes_fortes\":[\"...\"],\"relacionados\":[\"...\"]}\n\n` +
    `REGRAS:\n` +
    `- alvo = somente o assunto/entidade que deve ser localizado nos registros.\n` +
    `- palavras que sao CAMPOS pedidos (recurso, engenheiro, valor, status, empresa etc.) nao sao alvo.\n` +
    `- equivalentes_fortes: no maximo 4 formas que realmente significam o MESMO conceito ou correcao ortografica segura.\n` +
    `- relacionados: no maximo 4 expressoes semanticamente proximas que podem ajudar a descobrir candidatos, mas NAO sao necessariamente equivalentes.\n` +
    `- Nao use termos excessivamente amplos de uma palavra quando isso trouxer muitos falsos positivos.\n` +
    `- Se for nome especifico (rua, equipamento, obra com nome proprio), nao expanda para categorias amplas.\n` +
    `- Nao invente registros, bairros, pessoas, empresas ou valores. Isto serve apenas para procurar dados REAIS no banco.\n` +
    `- Nao explique nada fora do JSON.`;

  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 220,
      temperature: 0,
      reasoning_effort: "low",
    });
    const j = extrairJSONSeguro(bruto) || {};
    if (j.usar === false || j.tipo === "nenhum") return null;

    const alvo = sanitizarPistaSemantica(j.alvo || alvoLiteral) || alvoLiteral;
    const tipo = ["conceito_grupo", "nome_especifico"].includes(j.tipo) ? j.tipo : "conceito_grupo";
    const fortes = [...new Set([
      alvoLiteral,
      alvo,
      ...(Array.isArray(j.equivalentes_fortes) ? j.equivalentes_fortes : []),
    ].map(sanitizarPistaSemantica).filter(Boolean))].slice(0, tipo === "nome_especifico" ? 3 : 5);
    const relacionados = tipo === "nome_especifico" ? [] : [...new Set(
      (Array.isArray(j.relacionados) ? j.relacionados : [])
        .map(sanitizarPistaSemantica)
        .filter((x) => x && !fortes.includes(x))
    )].slice(0, 4);

    return { alvo, tipo, fortes, relacionados, termos_originais: termos };
  } catch (e) {
    console.warn("AGENTE/SEMANTICA: expansao linguistica indisponivel; usando busca literal:", e.message);
    return { alvo: alvoLiteral, tipo: "conceito_grupo", fortes: [alvoLiteral], relacionados: [], termos_originais: termos };
  }
}

function filtrosEstruturadosParaSemantica(pergunta = "") {
  const p = normalizarTexto(pergunta);
  const condicoes = [];
  let escopo = filtroEscopoDaPergunta(p);
  if (!escopo && /\bobras?\b/.test(p) && !/\bprojetos?\b/.test(p) && !/\b(licitacoes?|licitacao)\b/.test(p)) {
    escopo = "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
  }
  const outros = [
    filtroStatusDaPergunta(p),
    condicaoLocalDaPergunta(p),
    condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p),
    condicaoRecursoDaPergunta(p),
    filtroComparacaoNumericaDaPergunta(p),
  ];
  if (escopo) condicoes.push(escopo);
  for (const c of outros) if (c && !condicoes.includes(c)) condicoes.push(c);
  return condicoes;
}

function montarCondicaoTermoSemantico(termo, parametros, usarTrgm = false) {
  const limpo = sanitizarPistaSemantica(termo);
  if (!limpo) return "";

  const textoBusca = `(COALESCE(objeto,'') || ' ' || COALESCE(categoria,''))`;
  const alternativas = [];

  parametros.push(`%${limpo}%`);
  alternativas.push(`unaccent(${textoBusca}) ILIKE unaccent($${parametros.length}::text)`);

  const toks = tokensRelevantes(limpo).filter((t) => t.length >= 3).slice(0, 5);
  if (toks.length >= 2) {
    const partes = [];
    for (const tok of toks) {
      parametros.push(`%${tok}%`);
      partes.push(`unaccent(${textoBusca}) ILIKE unaccent($${parametros.length}::text)`);
    }
    alternativas.push(`(${partes.join(" AND ")})`);
  }

  // Se pg_trgm ja estiver habilitado no Supabase/PostgreSQL, aproveitamos a
  // similaridade para erros de digitacao. Se nao estiver, nada quebra e a
  // busca segue com ILIKE + expansao linguistica.
  if (usarTrgm && limpo.length >= 4) {
    parametros.push(limpo);
    alternativas.push(`word_similarity(unaccent($${parametros.length}::text), unaccent(COALESCE(objeto,''))) >= 0.58`);
  }
  return `(${alternativas.join(" OR ")})`;
}

async function buscarCandidatosSemanticos(termos = [], filtros = [], limite = MAX_CANDIDATOS_SEMANTICOS) {
  const limpos = [...new Set((termos || []).map(sanitizarPistaSemantica).filter(Boolean))].slice(0, 6);
  if (!limpos.length) return { rows: [], sql: "", params: [] };

  const usarTrgm = await pgTrgmDisponivel();
  const params = [];
  const buscas = limpos.map((t) => montarCondicaoTermoSemantico(t, params, usarTrgm)).filter(Boolean);
  if (!buscas.length) return { rows: [], sql: "", params: [] };

  const where = [...(filtros || []).filter(Boolean), `(${buscas.join(" OR ")})`].join(" AND ");
  const sql = `SELECT id, objeto, bairro, status, categoria, engenheiro, empresa, ` +
    `valor_total, valor_executado, percentual_executado, aba_origem, dados_extras ` +
    `FROM obras WHERE ${where} ORDER BY objeto LIMIT ${Math.max(1, Math.min(Number(limite) || 24, 40))}`;
  const r = await queryReadOnly(sql, params);
  return { rows: r.rows || [], sql, params };
}

function sqlDefinitivaPorIds(ids = []) {
  const nums = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  if (!nums.length) return "";
  return `SELECT id, objeto, bairro, status, categoria, engenheiro, empresa, valor_total, ` +
    `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras ` +
    `WHERE id IN (${nums.join(",")}) ORDER BY objeto`;
}

function formatarMoedaSemantica(v) {
  if (v === null || v === undefined || v === "") return "não informado";
  if (!Number.isFinite(Number(v))) return String(v);
  return "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatarLinhaSemantica(linha = {}, campos = []) {
  const l = enriquecerLinhaParaIA(linha);
  const partes = [];
  const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
  for (const c of campos) {
    if (c === "recurso") partes.push(`recurso: ${vazio(l.recurso) ? "não informado" : l.recurso}`);
    else if (c === "engenheiro") partes.push(`responsável: ${vazio(l.engenheiro) ? "não informado" : l.engenheiro}`);
    else if (c === "empresa") partes.push(`empresa: ${vazio(l.empresa) ? "não informada" : l.empresa}`);
    else if (c === "status") partes.push(`status: ${vazio(l.status) ? "não informado" : l.status}`);
    else if (c === "bairro") partes.push(`bairro: ${vazio(l.bairro) ? "não informado" : l.bairro}`);
    else if (c === "valor_total") partes.push(`valor: ${formatarMoedaSemantica(l.valor_total)}`);
    else if (c === "valor_executado") partes.push(`executado: ${formatarMoedaSemantica(l.valor_executado)}`);
    else if (c === "percentual_executado") {
      const v = vazio(l.percentual_executado) ? "não informado" : `${Number(l.percentual_executado).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
      partes.push(`percentual: ${v}`);
    }
  }
  if (!partes.length) {
    if (!vazio(l.status)) partes.push(l.status);
    else if (!vazio(l.bairro)) partes.push(l.bairro);
  }
  return `• ${l.objeto || "Registro sem nome"}${partes.length ? ` — ${partes.join("; ")}` : ""}`;
}

function redigirResultadoSemantico(pergunta = "", interpretacao = {}, diretas = [], relacionadas = []) {
  const p = normalizarTexto(pergunta);
  const campos = camposSolicitados(pergunta);
  const pedeContagem = /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p);
  const pedeExistencia = /\b(existe|existem|ha|tem|algum|alguma|alguns|algumas)\b/.test(p);
  const alvo = interpretacao.alvo || interpretacao.termos_originais?.join(" ") || "esse assunto";
  const maxDiretas = 15;
  const maxRelacionadas = 8;

  if (!diretas.length && !relacionadas.length) return null;

  // "Fale sobre X" e uma intencao descritiva, nao uma conta nem uma lista de
  // responsaveis. Para um item unico, devolvemos uma ficha util do registro.
  if (ehPedidoDescricaoRegistro(pergunta) && diretas.length === 1) {
    let ficha = formatarFichaRegistro(diretas[0]);
    if (relacionadas.length) {
      ficha += `\n\nEncontrei também ${relacionadas.length} registro${relacionadas.length === 1 ? "" : "s"} relacionado${relacionadas.length === 1 ? "" : "s"}, mas não ${relacionadas.length === 1 ? "o tratei" : "os tratei"} como o mesmo item.`;
    }
    return ficha;
  }

  let out = "";
  if (diretas.length) {
    if (pedeContagem) {
      out += `Encontrei ${diretas.length} registro${diretas.length === 1 ? "" : "s"} que correspondem diretamente a “${alvo}”.`;
    } else if (pedeExistencia) {
      out += `Sim. Encontrei ${diretas.length} registro${diretas.length === 1 ? "" : "s"} diretamente relacionado${diretas.length === 1 ? "" : "s"} a “${alvo}”.`;
    }
    const deveListar = !pedeContagem || /\b(quais|liste|mostre|nomes?|recursos?|engenheiros?|responsaveis?|status|valores?|empresas?)\b/.test(p) || campos.length;
    if (deveListar) {
      if (out) out += "\n\n";
      out += diretas.slice(0, maxDiretas).map((l) => formatarLinhaSemantica(l, campos)).join("\n");
      if (diretas.length > maxDiretas) out += `\n• ... e mais ${diretas.length - maxDiretas}.`;
    }
  } else {
    out = `Não encontrei registro que corresponda diretamente a “${alvo}”.`;
  }

  if (relacionadas.length) {
    out += `${out ? "\n\n" : ""}Também encontrei ${relacionadas.length} registro${relacionadas.length === 1 ? "" : "s"} semanticamente relacionado${relacionadas.length === 1 ? "" : "s"}. ` +
      `Não ${relacionadas.length === 1 ? "o conto" : "os conto"} automaticamente como equivalente${relacionadas.length === 1 ? "" : "s"}:\n` +
      relacionadas.slice(0, maxRelacionadas).map((l) => formatarLinhaSemantica(l, campos)).join("\n");
    if (relacionadas.length > maxRelacionadas) out += `\n• ... e mais ${relacionadas.length - maxRelacionadas}.`;
  }
  return out;
}

async function tentarResolucaoSemantica(pergunta = "", historico = []) {
  if (!USAR_BUSCA_SEMANTICA) return null;

  // Follow-ups devem usar primeiro os IDs/WHERE guardados no estado anterior.
  // Nao reinterpreta "elas", "dela", "dele" como um novo assunto.
  if (ehFollowupReferencialForte(pergunta) && !temAlvoExplicitoNaPergunta(pergunta) && ultimoEstadoDoHistorico(historico)) return null;

  const termos = termosAssuntoSemantico(pergunta);
  if (!termos.length) return null;

  const interpretacao = await interpretarAssuntoSemantico(pergunta, historico);
  if (!interpretacao?.fortes?.length) return null;

  const filtros = filtrosEstruturadosParaSemantica(pergunta);
  try {
    const buscaDireta = await buscarCandidatosSemanticos(interpretacao.fortes, filtros);
    const diretasPorId = new Map((buscaDireta.rows || []).map((r) => [Number(r.id), r]));

    let buscaRelacionada = { rows: [], sql: "", params: [] };
    if (interpretacao.relacionados?.length) {
      buscaRelacionada = await buscarCandidatosSemanticos(interpretacao.relacionados, filtros);
    }
    const relacionadas = (buscaRelacionada.rows || []).filter((r) => !diretasPorId.has(Number(r.id)));
    const diretasCandidatas = [...diretasPorId.values()];

    // Se nao encontramos nada nem por equivalente forte nem por relacao, o
    // agente tradicional ainda ganha a chance de descobrir via schema/amostras.
    if (!diretasCandidatas.length && !relacionadas.length) return null;

    // A consulta FINAL nao usa palavras inventadas pela IA. Usa apenas IDs que
    // vieram do PostgreSQL na etapa de candidatos.
    const idsFoco = (diretasCandidatas.length ? diretasCandidatas : relacionadas).map((x) => x.id);
    const sqlFinal = sqlDefinitivaPorIds(idsFoco);
    if (!sqlFinal) return null;
    const check = sqlSegura(sqlFinal);
    if (!check.ok) return null;

    const final = await queryReadOnly(sqlFinal);
    const linhasFinais = (final.rows || []).map(enriquecerLinhaParaIA);

    // Relacionados sao exibidos como apoio, mas nao entram no foco quando ha
    // correspondencias diretas. Assim "quantas UBS?" -> follow-up "quais?"
    // continua apontando somente para o conjunto direto, sem inflar a contagem.
    const linhasRelacionadas = relacionadas.map(enriquecerLinhaParaIA);
    const resposta = redigirResultadoSemantico(
      pergunta,
      interpretacao,
      diretasCandidatas.length ? linhasFinais : [],
      diretasCandidatas.length ? linhasRelacionadas : linhasFinais
    );
    if (!resposta) return null;

    const estado = construirEstadoSemantico(pergunta, sqlFinal, linhasFinais, historico);
    return {
      resposta,
      sql: sqlFinal,
      linhas: linhasFinais.length,
      estado,
      modoAgente: "agente1_resolucao_semantica",
      consultas: [buscaDireta.sql, buscaRelacionada.sql, sqlFinal].filter(Boolean),
      semantica: {
        alvo: interpretacao.alvo,
        equivalentes_fortes: interpretacao.fortes,
        relacionados: interpretacao.relacionados,
        ids_diretos: diretasCandidatas.map((x) => Number(x.id)),
        ids_relacionados: relacionadas.map((x) => Number(x.id)),
      },
    };
  } catch (e) {
    console.warn("AGENTE/SEMANTICA: falhou; seguindo para o agente normal:", e.message);
    return null;
  }
}

function gerarSQLFallbackUniversal(pergunta = "", historico = []) {
  const p = normalizarTexto(pergunta);
  if (!p) return null;

  // Primeiro respeita o contexto imediato quando a frase e referencial.
  const sqlAnterior = ultimaSQLDoHistorico(historico);
  const condAnterior = whereDaSQL(sqlAnterior).replace(/^WHERE\s+/i, "").trim();
  const referenciaAnterior = /\b(dessas?|destas?|nessas?|nestas?|delas?|deles?|dele|dela|essas?|esses?|elas?|eles?|nela|nele|anteriores?|anterior|acima|mesmas?|mesmos?|isso|essa|esse)\b/.test(p) &&
    !temAlvoExplicitoNaPergunta(pergunta);
  const filtroRecurso = condicaoRecursoDaPergunta(p);
  const followupRecursoSemSujeito = !!filtroRecurso &&
    /^(?:e\s+)?(?:quais?|qual)\s+(?:usam?|utilizam?|possuem?|tem|com)\b/.test(p) &&
    !/\b(obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b/.test(p);

  const condicoes = [];
  if (condAnterior && (referenciaAnterior || followupRecursoSemSujeito)) condicoes.push(condAnterior);

  const filtroStatus = filtroStatusDaPergunta(p);
  const filtroLocal = condicaoLocalDaPergunta(p);
  const filtroEngenheiro = condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p);
  const filtroEscopo = filtroEscopoDaPergunta(p);
  if (filtroEscopo) condicoes.push(filtroEscopo);
  else if (/\bobras?\b/.test(p)) condicoes.push("aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')");
  if (filtroStatus) condicoes.push(filtroStatus);
  if (filtroLocal) condicoes.push(filtroLocal);
  if (filtroEngenheiro) condicoes.push(filtroEngenheiro);
  if (filtroRecurso) condicoes.push(filtroRecurso);

  // Se nenhum filtro estrutural identificou o alvo, usa os termos livres como
  // busca no nome/objeto. Isso resolve QUALQUER entidade literal sem cadastra-la.
  if (!filtroLocal && !filtroEngenheiro) {
    const porObjeto = condicaoObjetoLivreDaPergunta(pergunta);
    if (porObjeto) condicoes.push(porObjeto);
  }

  if (!condicoes.length) return null;

  const where = `WHERE ${condicoes.join(" AND ")}`;
  // Traz um conjunto completo e pequeno de campos. Assim a mesma consulta pode
  // responder quantidade + recurso + status + responsavel + valor, inclusive
  // quando a frase pede varios campos ao mesmo tempo.
  return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
    `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras ${where} ORDER BY objeto`;
}

// Resolve apenas o ESCOPO DE NEGOCIO antes de validar/executar a SQL.
// A IA continua livre para entender a frase, nomes, filtros e campos, mas o Node
// garante deterministicamente que "obra" nao vire projeto/licitacao por engano.
function ultimaPerguntaUsuario(historico = []) {
  if (!Array.isArray(historico)) return "";
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "user" && historico[i]?.content) {
      return historico[i].content.toString();
    }
  }
  return "";
}

function perguntaParaEscopo(pergunta, historico = []) {
  const atual = normalizarTexto(pergunta);
  const temTipo = /\b(obras?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?|registros?)\b/.test(atual);
  if (temTipo) return atual;

  // Em follow-ups curtos ("e as concluidas dele?", "e as em andamento?"),
  // herda SOMENTE o tipo do ultimo pedido do usuario. Nao herda campos como
  // valor/empresa/status, evitando contaminar a nova pergunta.
  const pareceFollowup = /\b(ele|ela|dele|dela|deles|delas|essas?|esses?|dessas?|desses?|as concluidas|os concluidos|em andamento|e as|e os|agora)\b/.test(atual);
  if (!pareceFollowup) return atual;

  const anterior = normalizarTexto(ultimaPerguntaUsuario(historico));
  const tipoAnterior = anterior.match(/\b(obras?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?|registros?)\b/)?.[0] || "";
  return tipoAnterior ? `${atual} ${tipoAnterior}` : atual;
}

function escopoNegocioObrigatorio(pergunta, historico = []) {
  const atual = normalizarTexto(pergunta);
  const p = perguntaParaEscopo(pergunta, historico);
  const pedeTudo = /\b(tudo junto|tudo que|todos os registros|total de registros|incluindo projetos|incluindo licitacoes|todas as categorias|qualquer categoria)\b/.test(p);
  if (pedeTudo) return "";

  // Follow-up sem tipo explicito: herda o ESCOPO da ultima SQL, nao uma frase
  // antiga. Assim cadeias longas como "essas obras -> responsaveis delas -> qual
  // delas e mais cara" continuam no mesmo conjunto mesmo quando a ultima frase
  // nao repete a palavra "obras".
  const temTipoAtual = /\b(obras?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?|registros?)\b/.test(atual);
  if (!temTipoAtual && ehFollowupReferencialForte(pergunta)) {
    const estado = ultimoEstadoDoHistorico(historico);
    const escopoEstado = normalizarTexto(estado?.escopo || "");
    if (escopoEstado === "obras") return "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
    if (escopoEstado === "obras_em_andamento") return "aba_origem = 'EM_ANDAMENTO'";
    if (escopoEstado === "pavimentacoes") return "aba_origem = 'PAVIMENTAÇÃO'";
    if (escopoEstado === "projetos") return "aba_origem = 'EM_PROJETO'";
    if (escopoEstado === "licitacoes") return "aba_origem = 'EM_LICITAÇÃO'";

    const anterior = ultimaSQLDoHistorico(historico);
    if (/aba_origem\s+IN\s*\(\s*'EM_ANDAMENTO'\s*,\s*'PAVIMENTAÇÃO'\s*\)/i.test(anterior)) {
      return "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
    }
    if (/aba_origem\s*=\s*'EM_ANDAMENTO'/i.test(anterior)) return "aba_origem = 'EM_ANDAMENTO'";
    if (/aba_origem\s*=\s*'PAVIMENTAÇÃO'/i.test(anterior)) return "aba_origem = 'PAVIMENTAÇÃO'";
    if (/aba_origem\s*=\s*'EM_PROJETO'/i.test(anterior)) return "aba_origem = 'EM_PROJETO'";
    if (/aba_origem\s*=\s*'EM_LICITAÇÃO'/i.test(anterior)) return "aba_origem = 'EM_LICITAÇÃO'";
  }

  // Tipos explicitamente pedidos sempre vencem.
  if (/\bprojetos?\b/.test(p)) return "aba_origem = 'EM_PROJETO'";
  if (/\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p)) return "aba_origem = 'EM_LICITAÇÃO'";
  if (/\bpaviment/.test(p)) return "aba_origem = 'PAVIMENTAÇÃO'";

  if (/\bobras?\b/.test(p)) {
    // Regra especifica ja definida no projeto: "obras em andamento" refere-se
    // a aba EM_ANDAMENTO. Pavimentacoes em execucao sao uma categoria separada.
    if (/\b(em andamento|andamento|em execucao|em execucao|executando|sendo feit[ao]s?)\b/.test(p)) {
      return "aba_origem = 'EM_ANDAMENTO'";
    }
    if (/\bobras? fisic/.test(p)) return "aba_origem = 'EM_ANDAMENTO'";

    // "obras" generico (inclusive concluidas, ranking e totais) =
    // EM_ANDAMENTO + PAVIMENTACAO. Projeto e licitacao nunca entram escondidos.
    return "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
  }

  return "";
}

function adicionarCondicaoNaSQL(sql, condicao) {
  const s = (sql || "").toString().trim().replace(/;$/, "").trim();
  if (!s || !condicao) return s;

  // Nao tentamos reescrever SQL complexa/subconsulta. Nesses casos o guardrail
  // semantico rejeita e pede uma nova SQL para a IA.
  if ((s.match(/\bfrom\s+obras\b/gi) || []).length !== 1) return s;

  const estrutural = s.match(/\b(group\s+by|having|order\s+by|limit|offset)\b/i);
  const pos = estrutural ? estrutural.index : s.length;
  const antes = s.slice(0, pos).trimEnd();
  const depois = s.slice(pos).trimStart();
  const temWhere = /\bwhere\b/i.test(antes);
  const meio = temWhere ? ` AND (${condicao})` : ` WHERE (${condicao})`;
  return `${antes}${meio}${depois ? ` ${depois}` : ""}`.trim();
}

function aplicarEscopoNegocioNaSQL(pergunta, sql, historico = []) {
  const esperado = escopoNegocioObrigatorio(pergunta, historico);
  if (!esperado) return sql;

  const s = (sql || "").toString();
  // Se a IA ja escolheu alguma origem, nao sobrescrevemos silenciosamente:
  // deixamos o validador confirmar se ela e coerente e, se nao for, pedir
  // correcao. Isso evita mascarar uma interpretacao realmente contraditoria.
  if (/\baba_origem\b/i.test(s)) return s;

  return adicionarCondicaoNaSQL(s, esperado);
}

function ultimoEstadoDoHistorico(historico = []) {
  if (!Array.isArray(historico)) return null;
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "assistant" && historico[i]?.estado && typeof historico[i].estado === "object") {
      return historico[i].estado;
    }
  }
  return null;
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

function expressaoStatusAmploSQL() {
  return `COALESCE(NULLIF(BTRIM(dados_extras->>'STATUS ORIGINAL'), ''), status, '')`;
}

function filtroStatusDaPergunta(p) {
  // Etapas de LICITACAO podem estar em STATUS ORIGINAL em vez da coluna status.
  // A etapa especifica tem prioridade sobre a palavra generica "andamento".
  if (/\b(habilitacao|habilitando|habilitad[ao]s?)\b/.test(p)) {
    return `unaccent(${expressaoStatusAmploSQL()}) ILIKE unaccent('%habilit%')`;
  }
  if (/\b(homologacao|homologad[ao]s?|homologando)\b/.test(p)) {
    return `unaccent(${expressaoStatusAmploSQL()}) ILIKE unaccent('%homolog%')`;
  }
  if (/\b(adjudicacao|adjudicad[ao]s?|julgamento|propostas?)\b/.test(p)) {
    const termo = /adjudic/.test(p) ? 'adjudic' : (/julgamento/.test(p) ? 'julg' : 'propost');
    return `unaccent(${expressaoStatusAmploSQL()}) ILIKE unaccent('%${termo}%')`;
  }
  if (/\b(concluid[ao]s?|pront[ao]s?|finalizad[ao]s?|terminad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%conclu%')";
  // A ingestao padroniza "Em execucao" como "Em andamento" para obras/pavimentacoes.
  if (/\b(em andamento|andamento|em execucao|execucao|executando|sendo feit[ao]s?|tocando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%andamento%')";
  if (/\b(em licitacao|licitacao|licitando)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%licita%')";
  if (/\b(em projeto)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%projeto%')";
  if (/\b(paralisad[ao]s?|paradas?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%paralis%')";
  if (/\b(a iniciar|nao iniciad[ao]s?)\b/.test(p)) return "unaccent(status) ILIKE unaccent('%iniciar%')";
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

// Diferencia "campo de UM item" de "campo de um GRUPO". Exemplos:
// - "recurso da UBS do Cristo Rei" -> item especifico (IA pode localizar nome completo)
// - "recursos utilizados nas UBS" -> grupo livre (Node procura UBS e projeta recurso)
// O plural introduzido por nas/nos/das/dos e a pista estrutural; nao mantemos
// uma lista fixa de entidades para decidir isso.
function pedeCampoSobreGrupoLivre(pergunta = "") {
  const p = normalizarTexto(pergunta);
  const pedeCampo = /\b(recursos?|fontes?|contratos?|convenios?|engenheiros?|responsaveis?|empresas?|status|situacao|valores?|percentual|porcentagem)\b/.test(p);
  if (!pedeCampo) return false;
  if (!/\b(?:nas|nos|das|dos)\s+[a-z0-9]/.test(p)) return false;
  const termos = termosLivresCandidatos(pergunta);
  return termos.length >= 1 && termos.length <= 3;
}

// Extrai um nome de profissional quando a pergunta usa algo como
// "obras do engenheiro Ricardo Sousa". O filtro e dinamico: nenhum nome fica
// fixo no codigo.
function condicaoEngenheiroDaPergunta(p) {
  // Captura um NOME somente quando "engenheiro/arquiteto/responsavel" esta sendo
  // usado como titulo de uma pessoa. Em perguntas como "qual engenheiro tem mais
  // obras?", a palavra seguinte e um VERBO da pergunta ("tem"), nao um nome.
  const m = p.match(/\b(?:engenheir[oa]|eng|arquiteto|arquiteta|arq|responsavel(?: tecnico)?)\.?\s+([a-z][a-z .'-]{1,100})/i);
  if (!m) return "";

  let nome = (m[1] || "").trim();

  // Se o trecho comeca com verbo/interrogativo, nao existe nome de profissional
  // apos o titulo. Esta barreira evita filtros falsos como engenheiro='%tem%'.
  if (/^(?:tem|possui|acompanha|acompanham|esta|estao|fica|ficam|sao|com|que|qual|quais|mais|menos|maior|menor|responsavel|responsaveis|por|pel[oa])\b/i.test(nome)) {
    return "";
  }

  // "engenheiro" tambem pode ser o CAMPO que o cidadao quer saber, e nao o
  // inicio do nome de um profissional. Ex.: "recurso e o engenheiro da Reforma
  // da UBS do Cristo Rei". Nesses casos nao criamos filtro de engenheiro.
  if (/^(?:(?:da|do|de)\s+)?(?:reforma|ampliacao|construcao|pavimentacao|obra|projeto|rua|avenida|ubs|creche|escola|mercado|posto|praca|quadra|hospital|drenagem|muro|iluminacao|terminal|calcadao|ciclovia|orla)\b/i.test(nome)) {
    return "";
  }

  // Corta a captura na primeira palavra que pertence a estrutura da pergunta.
  nome = nome.split(/\s+\b(?:tem|possui|acompanha|acompanham|esta|estao|estava|estavam|fica|ficam|sao|com|que|no|na|em|obras?|projetos?|pavimentacoes?|licitacoes?|status|situacao|valor|maior|menor|mais|menos|qual|quais|percentual|porcentagem|execucao|executad[oa]s?|concluid[oa]s?|andamento|responsavel|responsaveis)\b/i)[0];
  nome = nome
    .replace(/\b(?:das?|dos?|de)\s*$/i, "")
    .replace(/[^a-z .'-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!nome || nome.length < 2) return "";

  // Nomes podem chegar com conectores que nao existem no cadastro, por exemplo
  // "Ricardo de Sousa" quando a planilha registra "Ricardo Sousa". Em vez de
  // exigir a frase inteira, procuramos pelos tokens significativos do nome.
  const tokens = nome
    .split(/\s+/)
    .filter((t) => t && !/^(?:de|da|do|das|dos|e)$/i.test(t))
    .map((t) => t.replace(/'/g, "''"));
  if (!tokens.length) return "";
  return tokens.map((t) => `unaccent(COALESCE(engenheiro,'')) ILIKE unaccent('%${t}%')`).join(" AND ");
}

// Tambem entende frases naturais sem o titulo profissional, por exemplo:
// "quantas obras Ricardo Sousa tem?" e "quais obras Ricardo Sousa acompanha?".
// So ativa quando ha um verbo de relacao com obras para nao confundir bairro,
// empresa ou nome da propria obra com uma pessoa.
function condicaoEngenheiroImplicitoDaPergunta(p) {
  const m = p.match(/\b(?:quantas?|quais|liste|mostre)\s+obras?\s+(?:o\s+|a\s+)?([a-z][a-z .'-]{1,80}?)\s+(?:tem|possui|acompanha|acompanham)\b/i);
  if (!m) return "";
  let nome = (m[1] || "").trim().replace(/[^a-z .'-]/gi, "").replace(/\s+/g, " ");
  if (!nome || /^(?:em|no|na|do|da|de|bairro|centro)\b/i.test(nome)) return "";
  const tokens = nome.split(/\s+/)
    .filter((t) => t && !/^(?:de|da|do|das|dos|e)$/i.test(t))
    .map((t) => t.replace(/'/g, "''"));
  if (!tokens.length) return "";
  return tokens.map((t) => `unaccent(COALESCE(engenheiro,'')) ILIKE unaccent('%${t}%')`).join(" AND ");
}

// Contagem generica por TIPO. Todos os filtros reconhecidos precisam entrar
// aqui. Antes o filtro do engenheiro era perdido, fazendo uma pergunta sobre
// Ricardo Sousa devolver o total geral das abas (15 + 15) em vez do total dele.
function sqlContagemPorTipo(...filtros) {
  const globais = filtros.filter(Boolean);
  const where = globais.length ? `WHERE ${globais.join(" AND ")}` : "";
  return `SELECT ` +
    `SUM(CASE WHEN aba_origem = 'EM_ANDAMENTO' THEN 1 ELSE 0 END)::int AS obras, ` +
    `SUM(CASE WHEN aba_origem = 'PAVIMENTAÇÃO' THEN 1 ELSE 0 END)::int AS pavimentacoes, ` +
    `SUM(CASE WHEN aba_origem = 'EM_PROJETO' THEN 1 ELSE 0 END)::int AS projetos, ` +
    `SUM(CASE WHEN aba_origem = 'EM_LICITAÇÃO' THEN 1 ELSE 0 END)::int AS licitacoes, ` +
    `SUM(CASE WHEN aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO') THEN 1 ELSE 0 END)::int AS obras_e_pavimentacoes, ` +
    `COUNT(*)::int AS total_registros_relacionados FROM obras ${where}`;
}

// Detecta comparacoes entre responsaveis, como:
// "qual engenheiro tem mais obras?", "quem tem menos projetos?" ou
// "ranking de responsaveis por quantidade de pavimentacoes".
function ehRankingResponsavel(p) {
  const falaResponsavel = /\b(engenheiros?|engenheiras?|arquitetos?|arquitetas?|responsaveis?|responsavel tecnico|responsaveis tecnicos)\b/.test(p);
  const falaQuantidade = /\b(mais|menos|maior quantidade|menor quantidade|maior numero|menor numero|ranking|lidera|lider|primeiro)\b/.test(p);
  const falaRegistro = /\b(obras?|registros?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?)\b/.test(p);
  return falaResponsavel && falaQuantidade && falaRegistro;
}

function sqlRankingResponsavel(p, filtroStatus = "", filtroLocal = "", filtroEscopo = "") {
  const querMenor = /\b(menos|menor quantidade|menor numero)\b/.test(p);
  const direcao = querMenor ? "ASC" : "DESC";
  const filtros = [filtroStatus, filtroLocal].filter(Boolean);

  // Se o usuario nomeou uma categoria, respeitamos a categoria. Para "obras"
  // generico, a regra do sistema continua sendo obra fisica + pavimentacao;
  // projeto e licitacao so entram quando forem pedidos explicitamente.
  if (filtroEscopo) {
    filtros.push(filtroEscopo);
  } else if (/\bobras?\b/.test(p) && !/\b(?:todos os registros|total de registros|incluindo projetos|incluindo licitacoes|tudo junto)\b/.test(p)) {
    filtros.push("aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')");
  }

  filtros.push("engenheiro IS NOT NULL", "BTRIM(engenheiro) <> ''");
  const where = `WHERE ${filtros.join(" AND ")}`;

  // Se tambem pediu "quais sao", devolvemos as obras do profissional que lidera,
  // permitindo responder nome + quantidade + lista numa unica consulta.
  // So lista as obras do lider quando a pessoa pedir explicitamente a LISTA
  // dos registros. Antes, "quais os engenheiros tem mais obras?" era lido
  // como se "quais" pedisse as obras, gerando uma SQL de itens em vez do
  // ranking agregado por responsavel.
  const pedeLista = (
    /\b(?:quais(?:\s+sao)?|liste|lista|mostre|mostrar|nomes?)\s+(?:as\s+|os\s+)?(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b/.test(p) ||
    /\be\s+quais\s+(?:sao\s+)?(?:elas|eles)\b/.test(p)
  );
  if (pedeLista) {
    const escopoSub = filtros.filter((f) => !/^engenheiro IS NOT NULL$|^BTRIM\(engenheiro\)/i.test(f));
    const whereSub = escopoSub.length ? `WHERE ${escopoSub.join(" AND ")} AND engenheiro IS NOT NULL AND BTRIM(engenheiro) <> ''` : "WHERE engenheiro IS NOT NULL AND BTRIM(engenheiro) <> ''";
    const escopoOuter = escopoSub.length ? `AND ${escopoSub.join(" AND ")}` : "";
    return `SELECT objeto, engenheiro, status, categoria, bairro, empresa, valor_total, valor_executado, percentual_executado, aba_origem ` +
      `FROM obras WHERE engenheiro = (` +
      `SELECT engenheiro FROM obras ${whereSub} GROUP BY engenheiro ORDER BY COUNT(*) ${direcao}, engenheiro LIMIT 1` +
      `) ${escopoOuter} ORDER BY objeto`;
  }

  return `SELECT engenheiro, ` +
    `SUM(CASE WHEN aba_origem = 'EM_ANDAMENTO' THEN 1 ELSE 0 END)::int AS obras_fisicas, ` +
    `SUM(CASE WHEN aba_origem = 'PAVIMENTAÇÃO' THEN 1 ELSE 0 END)::int AS pavimentacoes, ` +
    `SUM(CASE WHEN aba_origem = 'EM_PROJETO' THEN 1 ELSE 0 END)::int AS projetos, ` +
    `SUM(CASE WHEN aba_origem = 'EM_LICITAÇÃO' THEN 1 ELSE 0 END)::int AS licitacoes, ` +
    `COUNT(*)::int AS quantidade_registros ` +
    `FROM obras ${where} GROUP BY engenheiro ORDER BY COUNT(*) ${direcao}, engenheiro`;
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
  const statusFinal = /\b(concluidas?|concluidos?|prontas?|prontos?|finalizadas?|finalizados?|terminadas?|terminados?|em andamento|paralisadas?|paralisados?|em licitacao|habilitacao|homologacao|homologadas?|homologados?|adjudicacao|julgamento|propostas?)\b\s*$/i;

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

  // Tambem entende "obras do Centro", "projetos da Aldeia" etc. Esse
  // formato aparece muito em perguntas financeiras: "quanto foi executado
  // nas obras do Centro?". Termos como "engenheiro" sao rejeitados logo
  // abaixo e nao viram bairro por engano.
  if (!local) {
    const mt = p.match(/\b(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\s+(?:do|da|de)\s+([a-z0-9][a-z0-9 -]{1,60})$/i);
    if (mt) local = limparLocal(mt[1]);
  }

  // Se o ultimo "em" era o proprio status ("... em andamento"), removemos o
  // status do fim e tentamos de novo para recuperar o bairro imediatamente antes.
  if (!local || /^(andamento|execucao|licitacao|projeto|habilitacao|homologacao|homologada?|adjudicacao|julgamento|propostas?|paralisada?)$/i.test(local)) {
    const semStatusFinal = p.replace(/\s+\b(concluidas?|concluidos?|prontas?|prontos?|finalizadas?|finalizados?|terminadas?|terminados?|em andamento|paralisadas?|paralisados?|em licitacao|habilitacao|homologacao|homologadas?|homologados?|adjudicacao|julgamento|propostas?)\b\s*$/i, "").trim();
    local = extrairUltimoNoNaEm(semStatusFinal);
  }

  if (!local || local.length < 2 || local.length > 60) return "";

  // Palavras da propria pergunta NAO sao local. Sem esta barreira, frases como
  // "em andamento com obra, bairro, valor e percentual" podiam virar um bairro
  // falso, e follow-ups como "qual o bairro dela?" tentavam procurar "dela".
  const naoEhLocal = /\b(andamento|execucao|executad[oa]s?|licitacao|projeto|total|geral|tudo|cidade|base|planilha|banco|sistema|obras?|obra|valor|valores|percentual|porcentagem|engenheir[oa]?|arquiteto|arquiteta|responsavel|responsaveis|empresa|empresas|status|situacao|com|dela|dele|delas|deles|nela|nele|essa|esse|essas|esses|ela|ele)\b/i;
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


// ============================================================
// MEMORIA SEMANTICA DE CONVERSA (somente em RAM / historico)
// ============================================================
// O SQL anterior sozinho nao e memoria suficiente. Uma consulta de contagem
// pode olhar varias categorias para explicar o resultado e uma consulta com
// ORDER BY ... LIMIT 1 escolhe um unico item. Guardamos separadamente:
// - where_conjunto: o conjunto que o usuario esta discutindo;
// - foco_objeto: item singular escolhido ("ela", "dela");
// - foco_engenheiro: profissional escolhido em ranking ("dele").
// Nada disso e aprendizado persistente e nada vai para agent_knowledge.
function rotuloEscopoDaPergunta(p = "") {
  if (/\bprojetos?\b/.test(p)) return "projetos";
  if (/\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p)) return "licitacoes";
  if (/\bpaviment/.test(p)) return "pavimentacoes";
  if (/\bobras?\b/.test(p)) {
    if (/\b(em andamento|andamento|em execucao|execucao|executando)\b/.test(p)) return "obras_em_andamento";
    return "obras";
  }
  return "";
}

function condicaoPorRotuloEscopo(rotulo = "") {
  if (rotulo === "obras") return "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
  if (rotulo === "obras_em_andamento") return "aba_origem = 'EM_ANDAMENTO'";
  if (rotulo === "pavimentacoes") return "aba_origem = 'PAVIMENTAÇÃO'";
  if (rotulo === "projetos") return "aba_origem = 'EM_PROJETO'";
  if (rotulo === "licitacoes") return "aba_origem = 'EM_LICITAÇÃO'";
  return "";
}

function condicaoObjetoExato(objeto = "") {
  if (!objeto) return "";
  return `unaccent(COALESCE(objeto,'')) ILIKE unaccent('${escaparLiteralSQL(String(objeto).trim())}')`;
}

function condicaoEngenheiroExato(engenheiro = "") {
  if (!engenheiro) return "";
  return `unaccent(COALESCE(engenheiro,'')) ILIKE unaccent('${escaparLiteralSQL(String(engenheiro).trim())}')`;
}

function contextoReferencialDoEstado(pergunta = "", historico = []) {
  const p = normalizarTexto(pergunta);
  // "dessa Reforma da Escola Municipal..." contem um demonstrativo, mas o
  // proprio usuario nomeou um novo alvo. Nao reutilize o conjunto anterior.
  if (temAlvoExplicitoNaPergunta(pergunta)) return "";
  const estado = ultimoEstadoDoHistorico(historico);
  if (!estado || typeof estado !== "object") return "";

  // Pronome singular: sempre prioriza o ultimo ITEM efetivamente selecionado.
  if (/\b(ela|ele|dela|nela|essa|esse|esta obra|este projeto|esse item|essa obra)\b/.test(p) && estado.foco_objeto) {
    return condicaoObjetoExato(estado.foco_objeto);
  }

  // "obras dele" depois de um ranking de engenheiros deve voltar ao profissional,
  // sem herdar um status intermediario como "concluidas" de um turno posterior.
  if (/\b(dele|desse responsavel|desse engenheiro|deste responsavel|deste engenheiro)\b/.test(p) && estado.foco_engenheiro) {
    const partes = [];
    const escopoAtual = rotuloEscopoDaPergunta(p) || estado.escopo || "";
    const ce = condicaoPorRotuloEscopo(escopoAtual);
    if (ce) partes.push(ce);
    partes.push(condicaoEngenheiroExato(estado.foco_engenheiro));
    return partes.filter(Boolean).join(" AND ");
  }

  // Referencia plural mantem exatamente o conjunto atual.
  if (/\b(dessas?|destas?|nessas?|nestas?|delas|deles|essas?|esses?|elas|eles|mesmas?|mesmos?|anteriores?|acima)\b/.test(p)) {
    return estado.where_conjunto || "";
  }

  return "";
}

function construirWhereSemanticoDaPergunta(pergunta = "", historico = []) {
  const p = normalizarTexto(pergunta);
  const anterior = ultimoEstadoDoHistorico(historico);
  const referencial = ehFollowupReferencialForte(pergunta);
  const condReferencial = contextoReferencialDoEstado(pergunta, historico);
  const condicoes = [];

  if (condReferencial) condicoes.push(condReferencial);
  else if (referencial && anterior?.where_conjunto) condicoes.push(anterior.where_conjunto);

  let escopo = rotuloEscopoDaPergunta(p);
  if (!escopo && referencial) escopo = anterior?.escopo || "";
  const condEscopo = condicaoPorRotuloEscopo(escopo);
  if (condEscopo && !condicoes.some((c) => c.includes("aba_origem"))) condicoes.push(condEscopo);

  const status = filtroStatusDaPergunta(p);
  const local = condicaoLocalDaPergunta(p);
  const engenheiro = condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p);
  const recurso = condicaoRecursoDaPergunta(p);
  const numerico = filtroComparacaoNumericaDaPergunta(p);
  if (status && !condicoes.some((c) => c === status)) condicoes.push(status);
  if (local && !condicoes.some((c) => c === local)) condicoes.push(local);
  if (engenheiro && !condicoes.some((c) => c === engenheiro)) condicoes.push(engenheiro);
  if (recurso && !condicoes.some((c) => c === recurso)) condicoes.push(recurso);
  if (numerico && !condicoes.some((c) => c === numerico)) condicoes.push(numerico);

  // Busca livre entra apenas quando nenhum filtro de entidade/local identificou
  // o alvo. Isto evita transformar palavras de campo em filtros acidentais.
  if (!status && !local && !engenheiro && !recurso && !numerico && !condReferencial) {
    const livre = condicaoObjetoLivreDaPergunta(pergunta);
    if (livre) condicoes.push(livre);
  }

  return {
    escopo,
    where: condicoes.filter(Boolean).join(" AND "),
  };
}

function construirEstadoSemantico(pergunta = "", sql = "", linhas = [], historico = []) {
  const p = normalizarTexto(pergunta);
  const anterior = ultimoEstadoDoHistorico(historico) || {};
  const base = construirWhereSemanticoDaPergunta(pergunta, historico);
  const registros = Array.isArray(linhas) ? linhas : [];

  let escopo = base.escopo || anterior.escopo || estadoDaUltimaConsulta([{ role: "assistant", sql }]).escopo;
  const whereSQLAtual = whereDaSQL(sql).replace(/^WHERE\s+/i, "").trim();
  // Consultas da resolucao semantica terminam em IDs reais do banco. Esse
  // recorte definitivo deve vencer a busca textual original na memoria; senao
  // um follow-up voltaria a procurar apenas a sigla literal e perderia os itens
  // resolvidos semanticamente.
  const wherePorIds = /\bid\s+IN\s*\(/i.test(whereSQLAtual) ? whereSQLAtual : "";
  let whereConjunto = wherePorIds || base.where || whereSQLAtual || anterior.where_conjunto || "";
  let focoObjeto = null;
  let focoEngenheiro = anterior.foco_engenheiro || null;
  let focoEngenheiros = Array.isArray(anterior.foco_engenheiros) ? anterior.foco_engenheiros : [];

  // Ranking de responsavel: nao escolhemos arbitrariamente o primeiro quando
  // existe EMPATE. Se houver um unico lider, ele vira foco singular. Se houver
  // empate, o conjunto focado passa a ser todos os lideres empatados.
  if (ehRankingResponsavel(p) && registros[0]?.engenheiro) {
    const melhorQtd = Number(registros[0]?.quantidade_registros);
    const lideres = Number.isFinite(melhorQtd)
      ? registros.filter((r) => Number(r?.quantidade_registros) === melhorQtd && r?.engenheiro)
      : [registros[0]];
    focoEngenheiros = [...new Set(lideres.map((r) => String(r.engenheiro).trim()).filter(Boolean))];

    const partesBase = [];
    // base.where preserva filtros relevantes da pergunta atual (ex.: concluidas).
    // Se estiver vazio, pelo menos preservamos o escopo de negocio.
    if (base.where) partesBase.push(base.where);
    else {
      const ce = condicaoPorRotuloEscopo(escopo || rotuloEscopoDaPergunta(p));
      if (ce) partesBase.push(ce);
    }

    if (focoEngenheiros.length === 1) {
      focoEngenheiro = focoEngenheiros[0];
      partesBase.push(condicaoEngenheiroExato(focoEngenheiro));
      whereConjunto = partesBase.filter(Boolean).join(" AND ");
    } else if (focoEngenheiros.length > 1) {
      focoEngenheiro = null;
      const condEmpate = focoEngenheiros.map(condicaoEngenheiroExato).filter(Boolean);
      if (condEmpate.length) partesBase.push(`(${condEmpate.join(" OR ")})`);
      whereConjunto = partesBase.filter(Boolean).join(" AND ");
    }
  }

  const escolheUmItem = /\b(maior|menor|mais avancad|menos avancad|maior percentual|menor percentual|mais cara|mais caro|mais barata|mais barato)\b/.test(p);
  if (registros.length === 1 && registros[0]?.objeto && (escolheUmItem || /\b(ela|ele|dela|dele|nela|nele|essa|esse)\b/.test(p))) {
    focoObjeto = String(registros[0].objeto).trim();
    whereConjunto = condicaoObjetoExato(focoObjeto);
  } else if (registros.length === 1 && registros[0]?.objeto) {
    // Item unico encontrado por nome: tambem e seguro torna-lo foco.
    focoObjeto = String(registros[0].objeto).trim();
  }

  // Consulta sem resultado nao deve transformar um conjunto antigo em resposta
  // futura por acidente. Mantemos o profissional de ranking, mas limpamos item.
  if (registros.length === 0) focoObjeto = null;

  return {
    escopo: escopo || "nao_identificado",
    where_conjunto: whereConjunto || null,
    foco_objeto: focoObjeto,
    foco_engenheiro: focoEngenheiro,
    foco_engenheiros: focoEngenheiros,
    ultima_sql: sql || null,
    quantidade_resultados: registros.length,
  };
}

// Comparacoes numericas simples ficam no Node porque sao deterministicas e
// frequentes em analytics ("mais de 1 milhao", "abaixo de 50%", etc.).
// Frases sem numero continuam indo para o planejador de IA.
function filtroComparacaoNumericaDaPergunta(p = "") {
  const texto = normalizarTexto(p);
  const m = texto.match(/\b(mais de|acima de|superior a|maior que|menos de|abaixo de|inferior a|menor que)\s+(?:r\$\s*)?(\d+(?:[.,]\d+)?)\s*(milhoes?|milhao|milhares?|mil|k|%)?/);
  if (!m) return "";

  let numero = Number(String(m[2]).replace(",", "."));
  if (!Number.isFinite(numero)) return "";
  const unidade = m[3] || "";
  if (/^milh/.test(unidade)) numero *= 1_000_000;
  else if (/^(?:mil|milhar|milhares|k)$/.test(unidade)) numero *= 1_000;

  const operador = /^(?:mais de|acima de|superior a|maior que)$/.test(m[1]) ? ">" : "<";
  let campo = "valor_total";
  if (unidade === "%" || /\b(percentual|porcentagem)\b/.test(texto)) campo = "percentual_executado";
  else if (/\b(valor executado|ja executado|executado|executada)\b/.test(texto)) campo = "valor_executado";

  return `${campo} ${operador} ${numero}`;
}

function gerarSQLRapida(pergunta, historico = []) {
  const p = normalizarTexto(pergunta);
  if (!p) return null;

  const sqlAnterior = ultimaSQLDoHistorico(historico);
  const whereAnterior = whereDaSQL(sqlAnterior);
  const estadoAnterior = ultimoEstadoDoHistorico(historico);
  // A memoria semantica vence a simples copia do WHERE da consulta anterior.
  // Isso corrige contagens que consultam categorias auxiliares, rankings e
  // selecoes LIMIT 1. Se o servidor ainda nao tiver estado, cai no SQL legado.
  const condAnterior = contextoReferencialDoEstado(pergunta, historico) ||
    estadoAnterior?.where_conjunto ||
    whereAnterior.replace(/^WHERE\s+/i, "").trim();

  // PAGINACAO: "mostrar mais", "mais 10", "proximas", "ver mais obras".
  // Reaproveita o filtro da consulta anterior e pula as que ja foram mostradas.
  // Conta quantas ja apareceram somando os blocos de 10 pedidos antes.
  // PAGINACAO precisa ser um pedido EXPLICITO de continuacao.
  // Antes, a expressao "mais obras" tambem casava com perguntas analiticas
  // como "qual engenheiro tem mais obras concluidas?", reaproveitando o
  // conjunto anterior e gerando OFFSET indevido. Rankings nunca sao paginacao.
  const pedeMais = !ehRankingResponsavel(p) && (
    /\b(?:mostrar|mostre|ver)\s+mais\b/.test(p) ||
    /\b(?:proximas?|proximos?|seguintes?)\b/.test(p) ||
    /\b(?:continua|continuar|continue)\b/.test(p) ||
    /\bmais\s+\d+\s*(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)?\b/.test(p) ||
    /\boutras?\s+\d+\s*(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)?\b/.test(p) ||
    /^(?:mais|outras?)\s+(?:obras?|projetos?|pavimentacoes?|licitacoes?|registros?)$/.test(p)
  );
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

  const referenciaAnterior = /\b(dessas?|destas?|nessas?|nestas?|delas?|deles?|dele|dela|essas?|esses?|elas?|eles?|nela|nele|anteriores?|anterior|acima|mesmas?|mesmos?|isso|essa|esse)\b/.test(p) &&
    !temAlvoExplicitoNaPergunta(pergunta);
  const perguntaCurtaLista = /^(?:e\s+)?quais(?:\s+sao)?$|^(?:lista|liste|mostra|mostre)(?:\s+(?:elas|essas|as obras))?$/.test(p);
  const curtaDeAcompanhamento = p.split(" ").length <= 7 && (
    /\b(engenheiros?|engenheiras?|responsaveis?|empresas?|executoras?|valor|valores|custo|bairro|status|situacao|nomes?|quantos|quantas|total|percentual|porcentagem|recursos?|contratos?|convenios?)\b/.test(p) ||
    perguntaCurtaLista
  );

  // Follow-up de UM item que acabou de ser escolhido por ranking (maior valor,
  // maior percentual etc.). Reaproveitamos a MESMA ordenacao + LIMIT 1 da SQL
  // anterior. Assim "qual o bairro dela?" continua apontando exatamente para a
  // obra vencedora, em vez de abrir novamente todas as obras do responsavel.
  const referenciaMesmoItem = /\b(dela|dele|nela|nele|essa|esse|esta obra|este projeto|esse item|essa obra)\b/.test(p);
  const pedeCampoMesmoItem = /\b(bairro|local|valor|percentual|porcentagem|status|situacao|empresa|engenheir|arquit|responsavel|contrato|convenio|recurso|executad)\b/.test(p);
  if (referenciaMesmoItem && pedeCampoMesmoItem && estadoAnterior?.foco_objeto) {
    const foco = condicaoObjetoExato(estadoAnterior.foco_objeto);
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, ` +
      `valor_executado, percentual_executado, aba_origem, dados_extras FROM obras WHERE ${foco} ORDER BY objeto`;
  }
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
  // "recursos utilizados nas UBS" e uma consulta de GRUPO, nao de uma UBS
  // individual. Deixamos o caminho deterministico montar a busca livre.
  if (itemEspecificoSemContexto && !pedeCampoSobreGrupoLivre(pergunta)) return null;

  // Caso importante: "quantas obras estao em andamento?" precisa responder
  // o TOTAL PRINCIPAL da aba EM_ANDAMENTO e, ao mesmo tempo, explicar os grupos
  // parecidos sem mistura-los. A consulta devolve os tres numeros em uma linha,
  // para a redacao detalhar com transparencia.
  if (ehPerguntaGenericaObrasEmAndamento(p) && !/\b(quais|liste|lista|mostrar?|nomes?)\b/.test(p)) {
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
  const filtroEngenheiro = condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p);
  const filtroRecurso = condicaoRecursoDaPergunta(p);
  const filtroNumerico = filtroComparacaoNumericaDaPergunta(p);
  let filtroEscopo = filtroEscopoDaPergunta(p);
  // Termos livres sao data-linked dinamicamente. Nao existe lista fixa de UBS,
  // escola, praca, drenagem etc. So usamos essa busca quando a frase nao ja
  // definiu um status/local/profissional/recurso estruturado.
  const filtroLivre = (!filtroStatus && !filtroLocal && !filtroEngenheiro && !filtroRecurso && !filtroNumerico)
    ? condicaoObjetoLivreDaPergunta(pergunta)
    : "";

  // Mesmo quando nao e uma contagem (ex.: "quais obras estao em andamento?"),
  // a expressao generica "obras em andamento" aponta para a area EM_ANDAMENTO.
  // Pavimentacoes em execucao e etapas de licitacao ficam como grupos separados.
  if (!filtroEscopo && /\bobras?\b/.test(p) && /\b(em andamento|andamento)\b/.test(p)) {
    filtroEscopo = "aba_origem = 'EM_ANDAMENTO'";
  }
  // Em consultas nao agregadas, "obra/obras" generico significa exatamente
  // EM_ANDAMENTO + PAVIMENTAÇÃO. As contagens genericas continuam usando a
  // consulta especial por tipo para poder explicar projetos/licitacoes a parte.
  const pareceContagemAgora = /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p);
  if (!filtroEscopo && /\bobras?\b/.test(p) && !pareceContagemAgora) {
    filtroEscopo = "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
  }

  const temFiltroNovo = !!(filtroStatus || filtroLocal || filtroEscopo || filtroEngenheiro || filtroRecurso || filtroNumerico || filtroLivre);

  // Follow-up curto pode adicionar um NOVO filtro ao conjunto anterior mesmo
  // sem pronome explicito. Ex.: depois de listar concluidas, "quais usam
  // recurso proprio?" deve refinar AS MESMAS concluidas, e nao abrir a base toda.
  const condicoes = [];
  const followupRecursoSemSujeito = !!filtroRecurso &&
    /^(?:e\s+)?(?:quais?|qual)\s+(?:usam?|utilizam?|possuem?|tem|com)\b/.test(p) &&
    !/\b(obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b/.test(p);
  if (condAnterior && (referenciaAnterior || (!temFiltroNovo && curtaDeAcompanhamento) || followupRecursoSemSujeito)) {
    condicoes.push(condAnterior);
  }
  if (filtroEscopo) condicoes.push(filtroEscopo);
  if (filtroStatus) condicoes.push(filtroStatus);
  if (filtroLocal) condicoes.push(filtroLocal);
  if (filtroEngenheiro) condicoes.push(filtroEngenheiro);
  if (filtroRecurso) condicoes.push(filtroRecurso);
  if (filtroNumerico) condicoes.push(filtroNumerico);
  if (filtroLivre) condicoes.push(filtroLivre);

  // Quando a pessoa fala genericamente em "obras concluidas", projetos e
  // processos licitatorios nao entram no total de obras fisicas.
  if (!filtroEscopo && filtroStatus && /\bobras?\b/.test(p) &&
      /\b(concluid|pront|finaliz|terminad)/.test(p)) {
    condicoes.push("aba_origem NOT IN ('EM_PROJETO','EM_LICITAÇÃO')");
  }
  if (!condicoes.length && condAnterior && curtaDeAcompanhamento) condicoes.push(condAnterior);

  const usarAnterior = !!condAnterior && (referenciaAnterior || curtaDeAcompanhamento) && !temFiltroNovo;
  const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

  const pedeEng = /\b(engenheiros?|engenheiras?|eng|arquitetos?|arquitetas?|arq|responsavel|responsaveis|responsavel tecnico|responsaveis tecnicos|cuida|cuidam|acompanha|acompanham)\b/.test(p);
  const pedeEmpresa = /\b(empresas?|executoras?|construtoras?)\b/.test(p);
  const pedeBairro = /\bbairros?\b/.test(p);
  const pedeStatus = /\b(status|situacao)\b/.test(p);
  const pedePercentual = /\b(percentual|porcentagem|% executad)\b/.test(p);
  const pedeExecutado = /\b(valor executado|quanto executou|ja executado|executad[oa])\b/.test(p);
  const pedeValor = pedeExecutado || /\b(valor|valores|custos?|custa|custam|custou|custando|precos?|dinheiro|investid\w*|investimentos?|quanto foi|orcamentos?)\b/.test(p);
  const pedeContagem = /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p);
  const pedeSoma = pedeValor && (
    /\b(total|soma|somam|somar|somando|somado|somados|ao todo|quanto foi investid\w*|quanto custou tudo|investid\w*|investimentos?|quanto ja foi executad\w*)\b/.test(p) ||
    (!!filtroLocal && /\bqual(?: e| o)? valor\b/.test(p))
  );
  const pedeDetalhes = ehPedidoDescricaoRegistro(pergunta) || /\b(detalh\w*|informacoes?|completo|completa|tudo sobre|explique|como esta|como ta|situacao completa)\b/.test(p);
  const pedeExistencia = /\b(existe|existem|ha|tem|algum|alguma|alguns|algumas)\b/.test(p);
  const pedeMaiorValor = /\b(maior valor|maior custo|mais cara|mais caro|maior investimento)\b/.test(p);
  const pedeMenorValor = /\b(menor valor|menor custo|mais barata|mais barato|menor investimento)\b/.test(p);
  const pedeMaisAvancada = /\b(mais avancad[ao]|maior percentual|maior execucao|mais executad[ao])\b/.test(p);
  const pedeMenosAvancada = /\b(menos avancad[ao]|menor percentual|menor execucao|menos executad[ao])\b/.test(p);

  // Comparacoes entre responsaveis precisam contar POR profissional, nao tentar
  // interpretar "tem/possui/mais" como se fosse parte do nome do engenheiro.
  if (ehRankingResponsavel(p)) {
    return sqlRankingResponsavel(p, filtroStatus, filtroLocal, filtroEscopo);
  }

  // Se a frase parece contar obras de uma PESSOA, mas nao conseguimos extrair
  // com seguranca o nome (ex.: "quantas obras Ricardo Sousa tem?" sem escrever
  // "engenheiro"), nao fazemos uma contagem geral por engano. Deixamos a IA,
  // que recebe os nomes reais do banco, interpretar o nome e gerar a consulta.
  const pareceContagemPessoaSemFiltro = pedeContagem && /\bobras?\b/.test(p) && !filtroEngenheiro && !filtroLocal &&
    /\bquant(?:os|as)\s+obras?\s+.+\b(?:tem|possui|acompanha)\b/.test(p);
  if (pareceContagemPessoaSemFiltro) return null;

  // Duas intencoes na mesma frase: "quantas sao e quais?". Em vez de responder
  // apenas o COUNT, buscamos os registros detalhados da MESMA populacao; assim
  // a redacao consegue informar a quantidade e listar os nomes sem divergencia.
  const pedeListaJunto = pedeContagem && /\b(quais|liste|lista|mostrar?|nomes?)\b/.test(p) &&
    (/\b(obras?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?|registros?)\b/.test(p) || !!filtroLivre);
  if (pedeListaJunto) {
    let whereLista = where;
    if (/\bobras?\b/.test(p) && !filtroEscopo) {
      const fisicas = "aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO')";
      whereLista = whereLista ? `${whereLista} AND ${fisicas}` : `WHERE ${fisicas}`;
    }
    return `SELECT objeto, status, categoria, bairro, engenheiro, empresa, valor_total, valor_executado, percentual_executado, aba_origem, ` +
      `(COUNT(*) OVER())::int AS total_encontrados FROM obras ${whereLista} ORDER BY objeto`;
  }

  // Perguntas genericas de quantidade de "obras" recebem uma separacao por
  // tipo. TODOS os filtros reconhecidos entram na consulta, inclusive o nome
  // do responsavel. Isso evita devolver 15+15 quando a pergunta era sobre uma pessoa.
  if (pedeContagem && /\bobras?\b/.test(p) && !filtroEscopo && !ehPerguntaGenericaObrasEmAndamento(p)) {
    return sqlContagemPorTipo(filtroLocal, filtroStatus, filtroEngenheiro);
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
  const pedeExtras = /\b(recursos?|fontes?|contratos?|convenios?|aditivos?|prazos?|data da|datas? de|ordem de servico)\b/.test(p);
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

function ehFollowupReferencialForte(pergunta = "") {
  const p = normalizarTexto(pergunta);
  if (!p) return false;

  // Um demonstrativo acompanhado de um nome/descricao novo nao e follow-up
  // puro. Ex.: "status dessa Reforma da Escola Municipal do Distrito...".
  if (temAlvoExplicitoNaPergunta(pergunta)) return false;

  // Referencias como "essas obras", "delas", "ele", "aquelas" devem
  // continuar o RECORTE IMEDIATAMENTE anterior. Isso nao e uma frase fixa: e
  // uma regra geral de resolucao de pronome/contexto para qualquer assunto.
  const temReferencia = /\b(essas?|esses?|estas?|estes?|dessas?|desses?|destas?|destes?|delas?|deles?|dela|dele|elas|eles|essa|esse|esta|este|isso|aquilo|aquelas?|aqueles?|mesmas?|mesmos?|anteriores?|acima)\b/.test(p);
  if (!temReferencia) return false;

  // So forcamos o caminho deterministico quando a frase realmente parece uma
  // continuacao. Filtros novos (status, bairro, valor, responsavel etc.) ainda
  // sao combinados normalmente pelo gerarSQLRapida com o WHERE anterior.
  return p.split(" " ).length <= 16 || /\b(quais|quantas|quantos|valor|valores|bairro|status|engenheir|responsavel|empresa|percentual|recursos?|contratos?|convenios?|concluid|andamento|maior|menor)\b/.test(p);
}

// --- CHAMADA 1: pergunta -> SQL ---
// MODO "CONVERSATIONAL ANALYTICS": toda pergunta de dados passa pela IA.
// A IA recebe schema + metadados REAIS do banco + memoria recente, gera a SQL,
// e o Node apenas valida/executa. E o mesmo padrao de agente SQL do artigo.
async function gerarSQL(pergunta, historico = [], correcao = null) {
  // FOLLOW-UP REFERENCIAL: quando o cidadao diz "essas obras", "delas",
  // "ele" etc., o recorte do ULTIMO turno tem prioridade sobre entidades
  // mais antigas da conversa. Isso impede ressuscitar um engenheiro/obra de
  // varios turnos atras depois que o assunto ja mudou (ex.: Paulo Nunes -> Centro).
  if (!correcao && ehFollowupReferencialForte(pergunta)) {
    const continuidade = gerarSQLRapida(pergunta, historico);
    if (continuidade) {
      console.log("AGENTE: follow-up referencial usando o recorte do turno imediatamente anterior.");
      return continuidade;
    }
  }

  // PADRAO NOVO: IA PRIMEIRO. O cidadao pode escrever livremente; nao precisa
  // acertar uma frase/padrao cadastrado no codigo. As regras rapidas antigas
  // ficam opcionais e servem principalmente como contingencia.
  if (!correcao && USAR_SQL_RAPIDA_PRIMEIRO) {
    const rapida = gerarSQLRapida(pergunta, historico);
    if (rapida) {
      console.log("AGENTE: modo opcional SQL rapida ativado.");
      return rapida;
    }
  }

  const contextoBanco = await contextoAtualDoBanco();
  const amostrasBanco = await amostrasRelevantesDoBanco(pergunta);

  const blocoCorrecao = correcao
    ? `\nA consulta anterior falhou/rejeitou. SQL=${JSON.stringify((correcao.sql || "").slice(0, 600))} ERRO=${JSON.stringify((correcao.erro || "").slice(0, 220))}. Corrija a consulta sem mudar a intencao da pergunta.`
    : "";

  const instrucao = `Voce e um ANALISTA DE DADOS especialista em obras publicas.
Sua funcao e transformar a pergunta do cidadao em UMA consulta PostgreSQL precisa.

SCHEMA DE NEGOCIO:
${SCHEMA}

METADADOS ATUAIS DO DATASET:
${contextoBanco}

AMOSTRAS RELEVANTES ENCONTRADAS NO BANCO (no maximo 8; nao e a resposta final):
${amostrasBanco}

MEMORIA RECENTE DA CONVERSA:
${resumoHistorico(historico)}

COMO TRABALHAR:
1. Entenda a INTENCAO da pergunta em linguagem natural, inclusive sinonimos, erros de digitacao, frases nunca vistas e follow-ups. NAO dependa de frases exatas.
1.1. Antes de escrever a SQL, resolva mentalmente: (a) o que o cidadao quer saber, (b) qual conjunto de registros ele quer, (c) quais filtros citou, (d) quais campos/metricas pediu. Nao exponha esse raciocinio.
2. Use SOMENTE colunas/chaves que realmente existem no schema/metadados acima. Os metadados sao referencia; a resposta final deve vir da CONSULTA, nunca de memoria ou suposicao.
3. Gere UMA SQL SELECT que responda exatamente o que foi perguntado. Nao invente dado ausente e nao substitua um campo por outro parecido.
3.1. Se o cidadao fizer DUAS OU MAIS perguntas/campos na mesma mensagem, a MESMA SQL deve trazer TODOS os campos pedidos. Nunca responda apenas uma parte.
3.2. Palavras como recurso, engenheiro, empresa, bairro, contrato, valor, percentual e status podem ser CAMPOS solicitados. Nao trate essas palavras nem o nome/termo que vem depois delas como valor de filtro de outro campo.
3.3. Qualquer sigla, apelido, tipo de equipamento, nome parcial ou termo livre pode estar no campo objeto. Nao use uma lista fixa de entidades: procure o termo no objeto e, se a busca direta falhar, descubra os nomes reais antes de desistir.
4. Para pergunta de acompanhamento, use a conversa e a SQL anterior para manter/refinar o recorte.
4.1. PRIORIDADE DE CONTEXTO: pronomes/referencias como "essas obras", "elas", "delas", "ele", "essa" e "desses" apontam para o ASSUNTO DO TURNO IMEDIATAMENTE ANTERIOR, salvo se o cidadao mudar explicitamente o alvo. Nunca ressuscite engenheiro, obra, status ou filtro de varios turnos atras quando a pergunta anterior ja mudou o assunto.
4.2. Se o turno imediatamente anterior usou uma SQL com WHERE e a pergunta atual apenas pede "quais sao", "quanto vale", "quem e o responsavel" ou outro detalhe dessas mesmas linhas, reutilize/refine aquele WHERE antes de considerar qualquer contexto mais antigo.
5. Se houver ambiguidade pequena, faca a interpretacao mais razoavel com base nos valores reais do banco.
6. Se a pergunta nao puder ser respondida com este dataset, responda SEM_CONSULTA.

REGRAS SQL:
- Somente SELECT na tabela obras. Sem JOIN, comentarios, CTE, subconsultas desnecessarias ou outras tabelas.
- Nunca INSERT, UPDATE, DELETE, DROP, ALTER, CREATE ou qualquer escrita.
- Para texto, prefira unaccent(campo) ILIKE unaccent('%termo%').
- Para categorias, escolha valores REAIS listados nos metadados; nao invente categoria.
- "quantas obras" = COUNT(*), mas RESPEITE o tipo/origem pedido e TODOS os filtros mencionados (bairro, status, responsavel etc.). Nunca descarte o filtro de pessoa ao contar.
- REGRA DE NEGOCIO: quando o cidadao diz apenas "obra/obras" de forma generica, considere obras fisicas + pavimentacoes; PROJETOS e LICITACOES ficam separados, salvo quando forem pedidos explicitamente.
- REGRA DE NEGOCIO: "obras em andamento" = obras da origem/categoria EM_ANDAMENTO. Nao some processos de licitacao cuja etapa se chama "Habilitacao em andamento".
- Em "qual engenheiro/responsavel tem MAIS/MENOS obras/projetos/pavimentacoes/licitacoes?", NAO filtre engenheiro por palavras como "tem", "possui", "mais" ou "menos". Agrupe por engenheiro com GROUP BY, conte os registros e ordene pela contagem.
- Para ranking de responsavel, use aliases padrao para o Node auditar sem recalcular: engenheiro, COUNT(*)::int AS quantidade_registros e, quando o pedido for "obras" generico, tambem SUM(CASE WHEN aba_origem='EM_ANDAMENTO' THEN 1 ELSE 0 END)::int AS obras_fisicas, SUM(CASE WHEN aba_origem='PAVIMENTAÇÃO' THEN 1 ELSE 0 END)::int AS pavimentacoes, SUM(CASE WHEN aba_origem='EM_PROJETO' THEN 1 ELSE 0 END)::int AS projetos, SUM(CASE WHEN aba_origem='EM_LICITAÇÃO' THEN 1 ELSE 0 END)::int AS licitacoes. Para "obras" generico, filtre aba_origem IN ('EM_ANDAMENTO','PAVIMENTAÇÃO') antes de agrupar.
- "engenheiro", "responsavel" ou "arquiteto" pode ser CAMPO/perfil pedido, nao necessariamente o inicio de um nome. Verbos/interrogativos depois dessas palavras (tem, possui, esta, qual, mais, menos, com) NUNCA sao nomes de pessoa.
- Se o usuario escrever um nome com conectores que nao aparecem no cadastro (ex.: "Ricardo de Sousa" vs "Ricardo Sousa"), use o valor real mais proximo mostrado nos metadados; nao filtre pela frase errada literalmente.
- Se a mesma mensagem pedir CONTAGEM + LISTA (ex.: "quantas sao e quais?"), prefira selecionar os registros detalhados para que a resposta possa contar e listar a MESMA populacao, em vez de retornar apenas um COUNT.
- PROJETOS: se a pergunta disser projeto/projetos, filtre aba_origem='EM_PROJETO'.
- LICITACOES: se disser licitacao/licitacoes/processo licitatorio, filtre aba_origem='EM_LICITAÇÃO'.
- PAVIMENTACAO: se disser pavimentacao/pavimentacoes, filtre aba_origem='PAVIMENTAÇÃO'.
- "obras concluidas" generico NAO inclui projetos concluidos nem processos licitatorios.
- Exemplo obrigatorio de semantica: "quais sao as obras concluidas que ele tem?" deve manter o responsavel do contexto, filtrar somente EM_ANDAMENTO/PAVIMENTAÇÃO e status concluido. Projetos concluidos desse mesmo responsavel NAO entram.
- Exemplo obrigatorio de ranking: "qual engenheiro tem mais obras em geral?" conta somente EM_ANDAMENTO + PAVIMENTAÇÃO. Nunca use projetos ou licitacoes nessa contagem, a menos que o cidadao peça explicitamente todas as categorias/registros.
- Se o usuario quiser projeto, licitacao ou pavimentacao, respeite exatamente essa categoria. Nunca use uma categoria apenas porque o texto do status ou do objeto parece relacionado.
- Se a pergunta for sobre UM item identificavel pelo nome/rua/contrato, mesmo que o cidadao pergunte so valor, responsavel, empresa ou status, selecione contexto completo: objeto,status,categoria,bairro,engenheiro,empresa,valor_total,valor_executado,percentual_executado,aba_origem,dados_extras. A resposta destacara primeiro o campo pedido e depois os detalhes uteis.
- Se a pergunta pedir DETALHES/INFORMACOES/SITUACAO, use esse mesmo conjunto completo de campos.
- Para LISTAGENS ("quais", "liste") selecione pelo menos objeto,status,categoria,bairro,engenheiro,empresa,valor_total,percentual_executado,aba_origem; acrescente dados_extras quando a pergunta envolver recurso, contrato, convenio, prazo, data ou observacao.
- Para MAIOR/MENOR/MAIS AVANCADA, use ORDER BY no campo correto + LIMIT 1 e traga o contexto completo do item vencedor.
- Se houver uma palavra ambigua de etapa (ex.: "andamento" em habilitacao), use aba_origem/categoria e STATUS ORIGINAL para entender o contexto antes de contar.
- "quantos engenheiros" = COUNT(DISTINCT engenheiro).
- "quantas empresas" = COUNT(DISTINCT empresa).
- soma/investimento = SUM(valor_total), salvo se a pergunta pedir valor executado.
- Para recurso/fonte do recurso, selecione dados_extras INTEIRO, porque o nome da chave varia entre abas e sera normalizado pelo Node. Para contrato/convenio/aditivo/prazo/data, use dados_extras/chaves reais dos metadados.
- Bairro/local pode procurar em bairro e, quando fizer sentido, no objeto da obra.
- A SQL sera validada por um guardrail independente. Se ela misturar categorias, omitir um campo pedido, usar palavra comum como nome de engenheiro ou contrariar o escopo do cidadao, sera rejeitada e voce tera que corrigi-la.
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
  const pedeExecutado = /\b(valor executado|quanto executou|ja executado|executad\w*)\b/.test(p);
  const pedeValor = pedeExecutado || /\b(valor|valores|custos?|custa|custam|custou|custando|precos?|dinheiro|investid\w*|investimentos?|quanto foi|orcamentos?)\b/.test(p);
  const consultaTemContextoDeComposicao = linhas.some((l) => l &&
    Object.prototype.hasOwnProperty.call(l, "aba_origem") &&
    Object.prototype.hasOwnProperty.call(l, "categoria"));
  const pedidoPluralDeValores = /\bvalores\b/.test(p) && /\b(obras?|projetos?|pavimentacoes?|licitacoes?|registros?)\b/.test(p);
  // Quando a pessoa pede campos diferentes ("valor total e valor executado"),
  // ela quer comparar os dois valores, nao soma-los.
  const pedeTotalEExecutado = /\bvalor total\b/.test(p) && /\bvalor executado\b/.test(p);
  if (pedeTotalEExecutado) return null;
  const pedeSoma = pedeValor && (
    /\b(total|soma|somam|somar|somando|somado|somados|ao todo|quanto foi investid\w*|quanto custou tudo|investid\w*|investimentos?|quanto ja foi executad\w*)\b/.test(p) ||
    pedidoPluralDeValores ||
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


// Resume rankings por responsavel sem deixar a IA recalcular contagens.
// A SQL ja devolve uma linha por profissional, ordenada pela quantidade.
function montarResumoRankingResponsavel(pergunta, linhas) {
  const p = normalizarTexto(pergunta);
  if (!ehRankingResponsavel(p)) return null;
  if (!Array.isArray(linhas) || linhas.length === 0) return null;
  if (!linhas.every((l) => l && Object.prototype.hasOwnProperty.call(l, "engenheiro") && Object.prototype.hasOwnProperty.call(l, "quantidade_registros"))) return null;

  const itens = linhas.map((l) => ({
    nome: (l.engenheiro || "").toString().trim(),
    quantidade: Number(l.quantidade_registros) || 0,
    obras_fisicas: Number(l.obras_fisicas) || 0,
    pavimentacoes: Number(l.pavimentacoes) || 0,
    projetos: Number(l.projetos) || 0,
    licitacoes: Number(l.licitacoes) || 0,
  })).filter((i) => i.nome);
  if (!itens.length) return null;

  const menor = /\b(menos|menor quantidade|menor numero)\b/.test(p);
  const melhorQtd = itens[0].quantidade;
  const empatados = itens.filter((i) => i.quantidade === melhorQtd);
  const querRankingCompleto = /\b(ranking|ordem|lista|liste|todos|todas)\b/.test(p);

  let tipo = "registros";
  if (/\bprojetos?\b/.test(p)) tipo = "projetos";
  else if (/\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p)) tipo = "processos de licitação";
  else if (/\bpaviment/.test(p)) tipo = "pavimentações";
  else if (/\bobras?\b/.test(p)) tipo = "obras";

  return { itens, empatados, quantidade: melhorQtd, menor, tipo, querRankingCompleto };
}

function redigirRankingResponsavelDeterministico(resumo) {
  if (!resumo || !resumo.empatados?.length) return null;
  const singularTipo = resumo.tipo === "obras" ? "obra"
    : resumo.tipo === "projetos" ? "projeto"
    : resumo.tipo === "pavimentações" ? "pavimentação"
    : resumo.tipo === "processos de licitação" ? "processo de licitação"
    : "registro";
  const rotuloQtd = resumo.quantidade === 1 ? singularTipo : resumo.tipo;
  const criterio = resumo.menor ? "menos" : "mais";

  let out;
  if (resumo.empatados.length === 1) {
    const r = resumo.empatados[0];
    out = `*${r.nome}* tem a ${resumo.menor ? "menor" : "maior"} quantidade de ${resumo.tipo}: *${r.quantidade} ${rotuloQtd}*.`;
    if (resumo.tipo === "obras") {
      const pavTxt = r.pavimentacoes === 1 ? "1 pavimentação" : `${r.pavimentacoes} pavimentações`;
      out += `\n\nDetalhes: ${r.obras_fisicas} obra${r.obras_fisicas === 1 ? "" : "s"} física${r.obras_fisicas === 1 ? "" : "s"} + ${pavTxt}.`;
    }
  } else {
    out = `Há empate entre ${resumo.empatados.length} responsáveis técnicos, com *${resumo.quantidade} ${rotuloQtd}* cada:`;
    out += `\n${resumo.empatados.map((r) => `• ${r.nome}`).join("\n")}`;
  }

  if (resumo.querRankingCompleto) {
    out += `\n\n*Ranking completo*`;
    out += `\n${resumo.itens.map((r, i) => `${i + 1}. ${r.nome} — ${r.quantidade}`).join("\n")}`;
  }
  return out;
}

// Agrupa respostas sobre engenheiros/responsaveis tecnicos. O agrupamento e feito
// no Node para a IA nao precisar adivinhar contagens nem associar uma obra ao
// profissional errado.
function montarResumoEngenheiros(pergunta, linhas) {
  const p = normalizarTexto(pergunta);
  if (!/\b(engenheiros?|engenheiras?|eng|arquitetos?|arquitetas?|arq|responsavel|responsaveis|responsavel tecnico|responsaveis tecnicos)\b/.test(p)) return null;
  if (!Array.isArray(linhas) || linhas.length === 0) return null;
  if (!linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, "engenheiro"))) return null;
  // Rankings agregados (engenheiro + quantidade) nao possuem objeto individual;
  // eles sao tratados por um formatador proprio acima.
  if (!linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, "objeto"))) return null;

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
  const resumoRankingResponsavel = montarResumoRankingResponsavel(pergunta, linhasLimpas);
  const resumoEngenheiros = montarResumoEngenheiros(pergunta, linhasLimpas);

  // Rankings de responsaveis tambem saem direto do Node: a SQL ja fez a contagem
  // por pessoa e aqui apenas exibimos o resultado, sem risco de a IA recalcular.
  if (resumoRankingResponsavel) {
    const pronta = redigirRankingResponsavelDeterministico(resumoRankingResponsavel);
    if (pronta) return pronta;
  }

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
A CONSULTA E O JSON DESTE TURNO sao a fonte de verdade. Se o assunto mudou no turno anterior, nunca puxe de volta nomes/obras/responsaveis de turnos mais antigos. Em follow-ups como "essas obras" ou "delas", responda somente sobre o recorte retornado pela consulta atual.
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
- Em especial, NUNCA mencione um engenheiro, obra, projeto ou licitacao de um turno anterior se esse nome nao aparece no JSON atual. O JSON atual vence a memoria antiga.
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
  const p = normalizarTexto(pergunta);
  if (!Array.isArray(linhas) || linhas.length === 0) {
    if (/\b(licitacoes?|licitacao|processos? licitatorios?)\b/.test(p)) {
      return "Não encontrei licitações com esse critério nos dados cadastrados.";
    }
    if (/\bprojetos?\b/.test(p)) return "Não encontrei projetos com esse critério nos dados cadastrados.";
    if (/\bpaviment/.test(p)) return "Não encontrei pavimentações com esse critério nos dados cadastrados.";
    if (/\bobras?\b/.test(p)) return "Não encontrei obras com esse critério nos dados cadastrados.";
    return "Não encontrei registros relacionados a esse termo nos dados cadastrados.";
  }

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
    if (resumoContagem.pavimentacoes > 0) detalhes.push(resumoContagem.pavimentacoes === 1 ? "1 pavimentação" : `${resumoContagem.pavimentacoes} pavimentações`);
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

  // Ranking por responsavel: usa a contagem ja calculada no PostgreSQL.
  const resumoRankingResponsavel = montarResumoRankingResponsavel(pergunta, linhas);
  if (resumoRankingResponsavel) {
    const pronta = redigirRankingResponsavelDeterministico(resumoRankingResponsavel);
    if (pronta) return pronta;
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
        `• ${pav === 1 ? "1 pavimentação" : `${pav} pavimentações`} em execução;\n` +
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


  // Quando a mesma pergunta pede QUANTIDADE + LISTA ("quantas UBS e quais"),
  // a resposta precisa entregar as duas coisas. O total_encontrados vem de
  // COUNT(*) OVER() quando a camada direta gerou a consulta.
  const pedeContagemListaLocal = /\b(quantos|quantas|numero de|qtd|quantidade de)\b/.test(p) &&
    /\b(quais|liste|lista|mostrar?|nomes?)\b/.test(p) &&
    linhas.some((l) => l && Object.prototype.hasOwnProperty.call(l, "objeto"));
  if (pedeContagemListaLocal) {
    const totalJanela = Number(linhas[0]?.total_encontrados);
    const total = Number.isFinite(totalJanela) && totalJanela >= 0 ? totalJanela : linhas.length;
    const itens = linhas.slice(0, LIMITE).map((l) => {
      const tipo = l?.aba_origem === "EM_PROJETO" ? " — projeto" :
        l?.aba_origem === "EM_LICITAÇÃO" ? " — licitação" :
        l?.aba_origem === "PAVIMENTAÇÃO" ? " — pavimentação" : "";
      return `• ${texto(l?.objeto, "Registro sem nome")}${tipo}`;
    });
    const resto = total > LIMITE ? `\n• ... e mais ${total - LIMITE} registro${total - LIMITE === 1 ? "" : "s"}.` : "";
    return `Encontrei ${total} registro${total === 1 ? "" : "s"} relacionado${total === 1 ? "" : "s"}:\n\n${itens.join("\n")}${resto}`;
  }

  // Superlativos precisam mostrar o CAMPO que decidiu o vencedor, e nao apenas
  // um campo incidental que veio na mesma linha (antes "maior valor" podia
  // responder somente o engenheiro).
  const pedeMaiorMenorValorLocal = /\b(maior valor|menor valor|maior custo|menor custo|mais cara|mais caro|mais barata|mais barato|maior investimento|menor investimento)\b/.test(p);
  const pedeAvancoLocal = /\b(mais avancad[ao]|menos avancad[ao]|maior percentual|menor percentual|maior execucao|menor execucao|mais executad[ao]|menos executad[ao])\b/.test(p);
  if ((pedeMaiorMenorValorLocal || pedeAvancoLocal) && linhas[0]?.objeto) {
    const l = linhas[0];
    const partes = [];
    if (pedeMaiorMenorValorLocal) partes.push(`valor: ${moeda(l.valor_total)}`);
    if (pedeAvancoLocal) partes.push(`execução: ${texto(l.percentual_executado)}%`);
    if (l.status) partes.push(`status: ${texto(l.status)}`);
    if (l.engenheiro) partes.push(`responsável: ${texto(l.engenheiro)}`);
    return `• ${texto(l.objeto, "Registro sem nome")} — ${partes.join(" — ")}`;
  }


  // Pedido descritivo de UM registro: "fale sobre ela", "me dê detalhes desta
  // obra" etc. Nao reduza a resposta a um campo incidental como engenheiro.
  if (ehPedidoDescricaoRegistro(pergunta) && linhas.length === 1 && linhas[0]?.objeto) {
    return formatarFichaRegistro(linhas[0]);
  }

  // Campos explicitamente pedidos tem prioridade sobre colunas incidentais que
  // vieram junto na SELECT. Isso evita, por exemplo, responder so o engenheiro
  // quando a pergunta era "quais obras custam mais de 1 milhao?" e garante
  // que "valor total e valor executado dela" devolva OS DOIS campos.
  const camposDiretos = camposSolicitados(pergunta);
  const somaExplicitaLocal = /\b(soma|somam|somar|somando|ao todo|quanto foi investid\w*|quanto custou tudo|investimentos?)\b/.test(p) && linhas.length > 1;
  const devePriorizarCampos = camposDiretos.length > 0 && !somaExplicitaLocal &&
    (linhas.length === 1 || camposDiretos.some((c) => c !== "engenheiro"));
  if (devePriorizarCampos && linhas.some((l) => l && l.objeto)) {
    const rotulos = {
      recurso: "recurso", status: "status", engenheiro: "responsável", empresa: "empresa",
      bairro: "bairro", valor_total: "valor total", valor_executado: "valor executado",
      percentual_executado: "percentual executado",
    };
    const enriquecidas = linhas.map(enriquecerLinhaParaIA);
    const itens = enriquecidas.slice(0, LIMITE).map((l) => {
      const partes = camposDiretos.map((campo) => {
        let v = l?.[campo];
        if (campo === "valor_total" || campo === "valor_executado") v = moeda(v);
        else if (campo === "percentual_executado") {
          const n = Number(v);
          v = Number.isFinite(n) ? `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : texto(v);
        } else v = texto(v);
        return `${rotulos[campo] || campo}: ${v}`;
      });
      return `• ${texto(l?.objeto, "Registro sem nome")} — ${partes.join(" — ")}`;
    });
    const resto = enriquecidas.length > LIMITE ? `\n• ... e mais ${enriquecidas.length - LIMITE} registro${enriquecidas.length - LIMITE === 1 ? "" : "s"}.` : "";
    return `${itens.join("\n")}${resto}${enriquecidas.length > 1 ? `\n\nTotal: ${enriquecidas.length} registros.` : ""}`;
  }

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

  // Campos pedidos diretamente precisam ter prioridade sobre os resumos
  // genericos. Sem isso, uma pergunta como "recursos das UBS" podia cair no
  // bloco de engenheiro apenas porque a consulta tambem trouxe esse campo.
  const enriquecidasLocal = linhas.map(enriquecerLinhaParaIA);
  const pedeRecursoLocal = /\b(recursos?|fontes? do recurso|fonte de recurso)\b/.test(p);
  const pedeStatusLocal = /\b(status|situacao)\b/.test(p);
  if (pedeRecursoLocal || pedeStatusLocal) {
    const itens = enriquecidasLocal.slice(0, LIMITE).map((l) => {
      const partes = [];
      if (pedeRecursoLocal) partes.push(`recurso: ${texto(l.recurso, "não informado")}`);
      if (pedeStatusLocal) partes.push(`status: ${texto(l.status, "não informado")}`);
      return `• ${texto(l.objeto, "Registro sem nome")} — ${partes.join(" — ")}`;
    });
    const total = enriquecidasLocal.length;
    const resto = total > LIMITE ? `\n• ... e mais ${total - LIMITE} registro${total - LIMITE === 1 ? "" : "s"}.` : "";
    return `Encontrei ${total} registro${total === 1 ? "" : "s"} relacionado${total === 1 ? "" : "s"}:\n\n${itens.join("\n")}${resto}`;
  }

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
      "Posso consultar obras, pavimentações, projetos e licitações, incluindo valores, " +
      "bairros, responsáveis, recursos e situação. O que você gostaria de saber? 🏗️";
  }

  // Mensagens sociais/confirmacoes muito curtas nao podem escapar para um
  // SELECT sem filtro. Esta barreira e deterministica: zero SQL para "ok",
  // "sim", "teste", "entendi" etc.
  if (/^(ok|okay|certo|beleza|blz|sim|entendi|teste|show|massa|legal|perfeito|joia)$/.test(limpo)) {
    return "Certo! Pode me perguntar sobre obras, pavimentações, projetos ou licitações de Mamanguape.";
  }
  if (/^(ajuda|help|o que voce faz|o que vc faz|como funciona)$/.test(limpo)) {
    return "Você pode perguntar livremente sobre os dados cadastrados, por exemplo por bairro, status, responsável, empresa, recurso, valor, percentual, projeto ou licitação.";
  }
  return null;
}

// Perguntas muito curtas sem alvo e sem contexto nao devem virar SELECT geral.
// Em analytics real, desambiguar e mais seguro do que assumir um conjunto e
// despejar a base inteira. Quando existe contexto anterior, o follow-up segue
// normalmente pela memoria semantica.
function respostaDesambiguacao(pergunta = "", historico = []) {
  const p = normalizarTexto(pergunta);
  if (!p) return null;

  const temContexto = !!(ultimoEstadoDoHistorico(historico) || ultimaSQLDoHistorico(historico));
  if (temContexto) return null;

  const termosLivres = termosLivresCandidatos(pergunta);
  const temEscopo = /\b(obras?|projetos?|pavimentacoes?|licitacoes?|processos? licitatorios?|registros?)\b/.test(p);
  const temFiltro = !!(
    filtroStatusDaPergunta(p) || condicaoLocalDaPergunta(p) ||
    condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p) ||
    condicaoRecursoDaPergunta(p) || filtroComparacaoNumericaDaPergunta(p)
  );
  if (temEscopo || temFiltro || termosLivres.length) return null;

  if (ehFollowupReferencialForte(pergunta) || /^(?:e\s+)?quais(?:\s+sao)?(?:\s+(?:elas|eles|essas|esses))?$/.test(p)) {
    return "Preciso saber a qual conjunto você está se referindo. Pode informar se são obras, projetos, pavimentações ou licitações, ou dizer um bairro/nome?";
  }

  if (/^(?:e\s+)?qual(?:\s+e|\s+o|\s+a)?\s+(?:valor|status|situacao|bairro|recurso|fonte|responsavel|engenheiro|empresa|percentual|porcentagem)(?:\s+(?:total|executado))?$/.test(p)) {
    return "De qual obra, projeto, pavimentação ou licitação você quer essa informação? Pode informar o nome ou o bairro.";
  }

  if (/^quant(?:os|as)(?:\s+(?:existem|tem|ha))?$/.test(p)) {
    return "Você quer a quantidade de obras, projetos, pavimentações ou licitações?";
  }

  return null;
}

// Audita os numeros mais sensiveis da resposta final. A IA pode escrever livre,
// mas moeda e percentual precisam existir nos dados retornados. Se aparecer um
// numero financeiro novo, a resposta e refeita; se persistir, usamos fallback.
function auditarRespostaNumerica(resposta, linhas) {
  const txt = (resposta || "").toString();
  if (!txt) return { ok: false, motivo: "resposta vazia" };

  const moedasPermitidas = new Set();
  const percentuaisPermitidos = new Set();

  const visitar = (obj, chavePai = "") => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) { obj.forEach((v) => visitar(v, chavePai)); return; }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) visitar(v, k);
      return;
    }
    const n = Number(obj);
    if (!Number.isFinite(n)) return;
    const k = normalizarTexto(chavePai);
    if (/valor|custo|invest|aditivo|orcamento|montante|saldo|pago/.test(k)) {
      moedasPermitidas.add("R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
    if (/percentual|porcentagem/.test(k)) {
      percentuaisPermitidos.add(n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%");
    }
  };
  visitar(linhas);

  // Totais de soma calculados pelo Node podem nao existir como uma celula unica.
  for (const campo of ["valor_total", "valor_executado"]) {
    let soma = 0, tem = false;
    for (const l of (linhas || [])) {
      const n = Number(l?.[campo]);
      if (Number.isFinite(n)) { soma += n; tem = true; }
    }
    if (tem) moedasPermitidas.add("R$ " + soma.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }

  const moedasResposta = txt.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?/g) || [];
  for (const m of moedasResposta) {
    const padrao = m.replace(/\s+/g, " ").trim();
    if (!moedasPermitidas.has(padrao)) return { ok: false, motivo: `valor nao suportado pelos dados: ${padrao}` };
  }

  const percentuaisResposta = txt.match(/\b\d{1,3}(?:[.,]\d{1,2})?%/g) || [];
  for (const x of percentuaisResposta) {
    const n = Number(x.replace("%", "").replace(".", "").replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const padrao = n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
    if (!percentuaisPermitidos.has(padrao)) return { ok: false, motivo: `percentual nao suportado pelos dados: ${x}` };
  }

  return { ok: true };
}


function auditarCamposTextuaisSolicitados(pergunta, resposta, linhas) {
  const p = normalizarTexto(pergunta);
  const txt = normalizarTexto(resposta);
  if (!txt) return { ok: false, motivo: "resposta vazia" };

  const enriquecidas = (linhas || []).map(enriquecerLinhaParaIA);

  if (/\b(recursos?|fontes? do recurso|fonte de recurso)\b/.test(p)) {
    const recursos = [...new Set(enriquecidas
      .map((l) => l?.recurso)
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
      .map((v) => String(v).trim()))];

    if (recursos.length) {
      if (/nao informad|sem informacao|nao consta|nao especificad/.test(txt)) {
        return { ok: false, motivo: "a resposta disse que o recurso nao existe, mas ha recurso preenchido nos dados" };
      }
      const citouAlgum = recursos.some((r) => txt.includes(normalizarTexto(r)));
      if (!citouAlgum) {
        return { ok: false, motivo: "a resposta omitiu os recursos reais retornados pela consulta" };
      }
    }
  }

  const exigirCampo = (regexPergunta, campo, rotulo) => {
    if (!regexPergunta.test(p)) return null;
    const valores = [...new Set(enriquecidas
      .map((l) => l?.[campo])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
      .map((v) => String(v).trim()))];
    if (!valores.length) return null;
    if (campo === "valor_total" || campo === "valor_executado") {
      if (!/r\$\s*\d/i.test(resposta || "")) return `a resposta omitiu ${rotulo} pedido pelo usuario`;
      return null;
    }
    const citou = valores.some((v) => txt.includes(normalizarTexto(v)));
    return citou ? null : `a resposta omitiu ${rotulo} pedido pelo usuario`;
  };

  const checks = [
    [/\b(valor total|valores totais|valor cadastrado|valores cadastrados|investid\w*|investimentos?|custos?)\b/, "valor_total", "o valor total"],
    [/\b(valor executado|valores executados|ja executado|quanto executou|executad\w*)\b/, "valor_executado", "o valor executado"],
    [/\b(status|situacao)\b/, "status", "o status"],
    [/\b(engenheiros?|responsaveis?|arquitetos?)\b/, "engenheiro", "o responsavel tecnico"],
    [/\b(empresas?|executoras?|construtoras?)\b/, "empresa", "a empresa"],
    [/\b(bairros?|localizacao)\b/, "bairro", "o bairro"],
  ];
  for (const [rx, campo, rotulo] of checks) {
    const motivo = exigirCampo(rx, campo, rotulo);
    if (motivo) return { ok: false, motivo };
  }

  return { ok: true };
}

// ============================================================
// MODO AGENTE COM FERRAMENTAS
// ============================================================
// Diferenca para o fluxo SQL de uma unica tentativa:
// - a IA NAO recebe a planilha inteira nem responde de memoria;
// - ela decide qual consulta precisa fazer;
// - o Node valida e executa a consulta em modo somente leitura;
// - o resultado volta para a IA, que pode pedir outra consulta complementar;
// - so depois ela redige a resposta final.
//
// Isso aproxima o comportamento de um assistente com acesso ao dataset inteiro,
// sem deixar o modelo solto para escrever no banco ou inventar numeros.

function extrairJSONSeguro(texto = "") {
  const limpo = texto.toString().replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(limpo); } catch {}
  const ini = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (ini >= 0 && fim > ini) {
    try { return JSON.parse(limpo.slice(ini, fim + 1)); } catch {}
  }
  return null;
}

function estadoDaUltimaConsulta(historico = []) {
  const sql = ultimaSQLDoHistorico(historico);
  const where = whereDaSQL(sql);
  let escopo = "nao_identificado";
  if (/aba_origem\s+IN\s*\(\s*'EM_ANDAMENTO'\s*,\s*'PAVIMENTAÇÃO'\s*\)/i.test(sql)) escopo = "obras";
  else if (/aba_origem\s*=\s*'EM_ANDAMENTO'/i.test(sql)) escopo = "obras_em_andamento";
  else if (/aba_origem\s*=\s*'PAVIMENTAÇÃO'/i.test(sql)) escopo = "pavimentacoes";
  else if (/aba_origem\s*=\s*'EM_PROJETO'/i.test(sql)) escopo = "projetos";
  else if (/aba_origem\s*=\s*'EM_LICITAÇÃO'/i.test(sql)) escopo = "licitacoes";

  const captura = (rx) => {
    const m = sql.match(rx);
    return m ? m[1] : null;
  };
  return {
    sql: sql || null,
    where: where || null,
    escopo,
    filtros_detectados: {
      engenheiro: captura(/engenheiro[^\n]*?ILIKE\s+unaccent\('\%([^%']+)\%'/i),
      bairro: captura(/bairro[^\n]*?ILIKE\s+unaccent\('\%([^%']+)\%'/i),
      empresa: captura(/empresa[^\n]*?ILIKE\s+unaccent\('\%([^%']+)\%'/i),
      status: captura(/status[^\n]*?ILIKE\s+unaccent\('\%([^%']+)\%'/i),
      objeto: captura(/objeto[^\n]*?ILIKE\s+unaccent\('\%([^%']+)\%'/i),
    },
  };
}

function contextoPrioritario(historico = []) {
  if (!Array.isArray(historico) || historico.length === 0) {
    return { turno_anterior: null, estado_consulta: estadoDaUltimaConsulta([]) };
  }
  let ultimoAssistente = null;
  let ultimoUsuario = null;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (!ultimoAssistente && m?.role === "assistant") ultimoAssistente = m;
    if (!ultimoUsuario && m?.role === "user") ultimoUsuario = m;
    if (ultimoAssistente && ultimoUsuario) break;
  }
  const estadoSalvo = ultimoAssistente?.estado && typeof ultimoAssistente.estado === "object"
    ? ultimoAssistente.estado
    : null;
  return {
    turno_anterior: {
      usuario: ultimoUsuario?.content?.toString().slice(0, 500) || null,
      assistente: ultimoAssistente?.content?.toString().slice(0, 700) || null,
      sql: ultimoAssistente?.sql?.toString().slice(0, 1200) || null,
    },
    // Estado estruturado salvo pelo servidor vence; a leitura da SQL e fallback.
    estado_semantico: estadoSalvo,
    estado_consulta: estadoDaUltimaConsulta(historico),
  };
}

function serializarConsultasFerramenta(consultas = []) {
  return consultas.map((c, i) => ({
    passo: i + 1,
    objetivo: c.objetivo || "consulta",
    sql: c.sql,
    quantidade_linhas: c.linhas.length,
    // O dataset atual e pequeno; ainda assim limitamos o material enviado ao LLM
    // para manter custo/latencia previsiveis. Campos livres recebem aliases
    // canonicos (recurso, convenio, contrato...) antes da redacao.
    dados: c.linhas.slice(0, 80).map(enriquecerLinhaParaIA),
  }));
}

async function planejarPassoFerramenta(pergunta, historico, consultas = [], erroAnterior = null) {
  const contextoBancoCompleto = await contextoAtualDoBanco();
  const contextoBanco = contextoBancoCompacto(contextoBancoCompleto, pergunta);
  const amostrasBanco = await amostrasRelevantesDoBanco(pergunta);
  const prioritario = contextoPrioritario(historico);
  const resultados = serializarConsultasFerramenta(consultas);
  const pistas = pistasInterpretacaoPergunta(pergunta);
  const conhecimento = exemplosRelevantes(pergunta, 4);

  const prompt = `Voce e o PLANEJADOR de um assistente que conversa livremente com uma base de obras publicas.
Voce NAO responde usando conhecimento proprio. Voce possui uma unica ferramenta: CONSULTAR_BANCO, que executa SELECT somente leitura na tabela obras.

SCHEMA DE NEGOCIO:
${SCHEMA}

METADADOS REAIS DO BANCO:
${contextoBanco}

AMOSTRAS RELEVANTES (ate 8 linhas candidatas; use apenas para data-linking):
${amostrasBanco}

CONTEXTO PRIORITARIO DO TURNO IMEDIATAMENTE ANTERIOR:
${JSON.stringify(prioritario)}

HISTORICO RECENTE (apoio secundario):
${resumoHistorico(historico)}

CONSULTAS JA FEITAS NESTE TURNO:
${JSON.stringify(resultados)}

PISTAS DE INTERPRETACAO GERADAS PELO NODE (apoio; nao sao resposta):
${JSON.stringify(pistas)}

EXEMPLOS SEMANTICOS RELEVANTES (ensinam regra; NAO sao frases fixas):
${conhecimento.texto || "(use schema e regras gerais)"}

REGRAS DE COMPORTAMENTO:
- Entenda linguagem natural, sinonimos, erros de digitacao e perguntas nunca vistas. Nao dependa de frases cadastradas.
- Referencias como ela/ele/dela/dele/dessas/deles/essas/esses devem apontar primeiro para o turno imediatamente anterior.
- Se CONTEXTO PRIORITARIO.estado_semantico trouxer foco_objeto, use esse item para referencia singular (ela/dela/esse item).
- Se trouxer foco_engenheiro, frases como "obras dele" referem-se a esse profissional; nao herde por engano um status intermediario de outro follow-up.
- Se trouxer where_conjunto, referencias plurais (essas/dessas/elas) mantem esse conjunto, salvo novo filtro explicito do usuario.
- Se os dados ja retornados forem suficientes para responder TUDO o que foi pedido, finalize. Se faltar algo, faca outra consulta complementar.
- Nunca invente nomes, valores, percentuais, quantidades, bairros, empresas, status ou responsaveis.
- \"obras\" generico significa EM_ANDAMENTO + PAVIMENTAÇÃO. Projeto e licitacao sao categorias separadas.
- \"obras em andamento\" significa origem EM_ANDAMENTO. Etapa de licitacao com a palavra andamento nao e obra em andamento.
- Se o usuario pedir explicitamente projeto, pavimentacao ou licitacao, use a origem correspondente.
- Se pedir \"tudo/todas as categorias/todos os registros\", ai sim pode considerar todas as origens.
- Para valores: valor_total, valor_executado e valores pagos sao conceitos diferentes. Nao substitua um pelo outro.
- Para campos livres (recurso, contrato, convenio, aditivo, prazo, datas, observacoes), use dados_extras.
- RECURSO/FONTE DO RECURSO muda de nome conforme a aba (por exemplo RECURSO, CONVENIO/RECURSO ou FONTE DO RECURSO). Quando recurso for pedido, selecione SEMPRE dados_extras inteiro; o Node cria um campo canonico "recurso" depois. Nao escolha uma unica chave JSON para varias origens.
- Qualquer palavra, sigla, apelido, tipo de equipamento, nome parcial ou termo que nao seja um campo conhecido pode ser um valor do campo objeto. Trate-o como termo livre e procure nos dados; NAO dependa de uma lista cadastrada de entidades.
- Se o usuario citar uma entidade/termo novo sem dizer obra/projeto/licitacao, procure em TODAS as categorias e diferencie os tipos na resposta. So herde filtros antigos quando houver referencia clara (ela, ele, essas, delas, desse etc.).
- Se uma busca direta por um termo retornar 0 linhas, antes de concluir que nao existe, faca uma descoberta dos nomes existentes em objeto e tente reconhecer abreviacao, sinonimo ou grafia aproximada.
- Erros simples de digitacao devem ser entendidos pelo significado normalizado fornecido nas pistas.
- Para ranking/contagem/soma/comparacao, deixe o PostgreSQL calcular. Nao faca contas de cabeca.
- Para uma pergunta com varios pedidos, obtenha dados suficientes para responder todos.
- So use SELECT na tabela obras; sem JOIN, escrita, comentarios ou outras tabelas.

FORMATO OBRIGATORIO: retorne APENAS um JSON valido, sem markdown.
Mantenha tambem um ESTADO SEMANTICO compacto do conjunto atual. Ele NAO e resposta pronta; serve para memoria entre turnos.
Formato do estado: {"escopo":"obras|obras_em_andamento|pavimentacoes|projetos|licitacoes|todos|indefinido","filtros":{"bairro":null,"engenheiro":null,"empresa":null,"status":null,"objeto":null},"conjunto":"descricao curta do recorte atual","entidade_foco":null}.
O estado deve refletir a consulta REAL que voce esta pedindo, nao um assunto antigo.

Antes da SQL, represente a intencao em um PLANO compacto. O plano serve apenas para o Node auditar coerencia; nao e mostrado ao usuario.
Campos do plano: operacao (listar|contar|somar|media|ranking|comparar|detalhar|descobrir), entidade_livre (texto ou null), campos (array), filtros (objeto), agrupamento (texto ou null).

Para consultar:
{"acao":"consultar","objetivo":"descricao curta","plano":{"operacao":"listar","entidade_livre":null,"campos":[],"filtros":{},"agrupamento":null},"sql":"SELECT ... FROM obras ...","estado":{"escopo":"...","filtros":{},"conjunto":"...","entidade_foco":null}}
Quando os dados ja forem suficientes:
{"acao":"finalizar","objetivo":"dados suficientes","estado":{"escopo":"...","filtros":{},"conjunto":"...","entidade_foco":null}}
Use sem_consulta SOMENTE quando a pergunta estiver claramente fora do dominio dos dados. Qualquer termo livre pode ser um nome/trecho de objeto, bairro, pessoa, empresa ou valor textual ainda nao reconhecido; faca ao menos uma SELECT de descoberta antes de desistir.
Se a pergunta realmente estiver fora desta base:
{"acao":"sem_consulta","objetivo":"motivo curto","estado":{"escopo":"indefinido","filtros":{},"conjunto":"","entidade_foco":null}}
${erroAnterior ? `\nA tentativa anterior foi rejeitada/falhou: ${erroAnterior}. Corrija a proxima acao sem mudar a intencao.` : ""}`;

  const bruto = await chamarIAbruta([
    { role: "system", content: prompt },
    { role: "user", content: (pergunta || "").toString().slice(0, 1600) },
  ], {
    max_tokens: 520,
    temperature: 0,
    reasoning_effort: "low",
  });

  const obj = extrairJSONSeguro(bruto);
  if (!obj || !obj.acao) throw new Error("planejador nao retornou JSON valido");
  return obj;
}


function validarPlanoFerramenta(pergunta = "", decisao = {}, historico = []) {
  if (!decisao || decisao.acao !== "consultar") return { ok: true };
  const sql = String(decisao.sql || "");
  const plano = decisao.plano && typeof decisao.plano === "object" ? decisao.plano : {};
  const p = normalizarTexto(pergunta);
  const pedidos = camposSolicitados(pergunta);

  // Auditoria generica de campos pedidos. Nao depende de uma frase especifica.
  const mapa = {
    recurso: /\bdados_extras\b/i,
    status: /\bstatus\b/i,
    engenheiro: /\bengenheiro\b/i,
    empresa: /\bempresa\b/i,
    bairro: /\bbairro\b/i,
    valor_total: /\bvalor_total\b/i,
    valor_executado: /\bvalor_executado\b/i,
    percentual_executado: /\bpercentual_executado\b/i,
  };
  for (const campo of pedidos) {
    if (mapa[campo] && !mapa[campo].test(sql)) {
      return { ok: false, motivo: `o plano/SQL omitiu o campo solicitado: ${campo}` };
    }
  }

  // Se ha um termo livre real e nao e um follow-up referencial, a consulta alvo
  // precisa procurar objeto ou assumir explicitamente que esta em descoberta.
  const livres = termosLivresCandidatos(pergunta);
  const referencial = /\b(ela|ele|delas?|deles?|essas?|esses?|dessas?|desses?|nessa|nesse|nela|nele)\b/.test(p);
  const operacao = normalizarTexto(plano.operacao || "");
  if (livres.length && !referencial && !/\bobjeto\b/i.test(sql) && operacao !== "descobrir") {
    const estrutural = livres.every((t) => ["centro", "andamento", "concluida", "concluido"].includes(t));
    if (!estrutural) return { ok: false, motivo: "ha termo livre na pergunta, mas a consulta nao procura nem seleciona objeto" };
  }

  // Se o usuario forneceu um VALOR de recurso (ex.: "com recurso X",
  // "quais usam recurso X"), a consulta precisa filtrar esse valor. Pedir o
  // campo recurso e diferente de filtrar por um recurso especifico.
  const termoRecurso = termoFiltroRecursoDaPergunta(pergunta);
  if (termoRecurso) {
    const termoEsc = termoRecurso.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const temFiltroRecursoSQL = /dados_extras/i.test(sql) &&
      /(?:ilike|=)/i.test(sql) &&
      new RegExp(termoEsc, "i").test(normalizarTexto(sql));
    if (!temFiltroRecursoSQL) {
      return { ok: false, motivo: `a pergunta filtra por recurso '${termoRecurso}', mas a SQL nao aplicou esse filtro` };
    }
  }

  // Contagem/ranking/soma devem ser calculados pelo banco quando a pergunta
  // explicitamente exige uma metrica. Listar linhas para contar no Node continua
  // valido quando a mesma pergunta tambem pede detalhes/campos de cada item.
  const pedeDetalhes = /\b(quais|liste|mostre|recursos?|status|responsaveis?|engenheiros?|empresas?|bairros?|detalhes?)\b/.test(p);
  if (/\bmais\b/.test(p) && /\b(engenheir|responsavel|arquit)/.test(p) && !/\bgroup\s+by\s+engenheiro\b/i.test(sql)) {
    return { ok: false, motivo: "ranking de responsavel precisa agrupar por engenheiro" };
  }
  if (/\b(soma|somando|total investid\w*|valor investid\w*)\b/.test(p) && !pedeDetalhes && !/\bsum\s*\(/i.test(sql)) {
    return { ok: false, motivo: "pedido de total financeiro sem detalhes deve usar SUM no banco" };
  }

  return { ok: true };
}

function tipoHumanoDaLinha(l = {}) {
  const a = normalizarTexto(l.aba_origem || "");
  if (a.includes("em projeto")) return "projeto";
  if (a.includes("em licitacao")) return "licitacao";
  if (a.includes("pavimentacao")) return "pavimentacao";
  if (a.includes("em andamento")) return "obra";
  return normalizarTexto(l.categoria || "") || "registro";
}

function formatarValorBR(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
}

// Resposta deterministica para pedidos simples de campos. Isso economiza uma
// segunda chamada de IA e mantem o bot funcional mesmo se Groq/Gemini estiverem
// temporariamente indisponiveis. A logica e por CAMPOS/INTENCAO, nao por frase.
function respostaDeterministicaFerramentas(pergunta = "", consultas = []) {
  const p = normalizarTexto(pergunta);
  if (/\b(maior|menor|mais adiantad|mais avancad|ranking|media|compare|comparar|diferenca|por que|porque)\b/.test(p)) return null;
  const alvo = [...consultas].reverse().find((c) => !c.descoberta && Array.isArray(c.linhas));
  if (!alvo || !alvo.linhas.length) return null;
  const linhas = alvo.linhas.map(enriquecerLinhaParaIA);
  if (!linhas.some((l) => l && l.objeto)) return null;

  const campos = camposSolicitados(pergunta);
  const pedeQuantidade = /\b(quantas|quantos|quantidade|numero de|total de)\b/.test(p);
  const pedeLista = /\b(quais|liste|lista|mostre|mostrar|fala|fale|diga|recursos?|status|responsaveis?|engenheiros?|empresas?|bairros?)\b/.test(p);
  if (!campos.length && !pedeQuantidade && !pedeLista) return null;

  // Perguntas financeiras sobre um CONJUNTO precisam priorizar os valores,
  // mesmo quando a consulta tambem trouxe engenheiro/empresa para contexto.
  // Ex.: "quais os valores investidos nas obras concluidas?" -> lista os
  // valores e apresenta o total, em vez de cair num resumo de responsaveis.
  const resumoFinanceiro = montarResumoSomaDetalhada(pergunta, linhas);
  if (resumoFinanceiro) {
    const rotulo = resumoFinanceiro.campo === "valor_executado" ? "Total executado" : "Valor total cadastrado";
    const itens = resumoFinanceiro.comValor.slice(0, 40).map((i) =>
      `• *${i.objeto}* — ${formatarValorBR(i.valor)}`
    );
    let out = `${rotulo}: *${formatarValorBR(resumoFinanceiro.total)}*.`;
    if (itens.length) out += `\n\n${itens.join("\n")}`;
    if (resumoFinanceiro.semValor.length) {
      out += `\n\n${resumoFinanceiro.semValor.length} registro${resumoFinanceiro.semValor.length === 1 ? " ficou" : "s ficaram"} fora da soma por nao ter valor cadastrado.`;
    }
    return out;
  }

  const rotulos = {
    recurso: "Recurso",
    status: "Status",
    engenheiro: "Responsavel",
    empresa: "Empresa",
    bairro: "Bairro",
    valor_total: "Valor total",
    valor_executado: "Valor executado",
    percentual_executado: "Percentual executado",
  };

  const partes = [];
  if (pedeQuantidade) partes.push(`Encontrei *${linhas.length} registro${linhas.length === 1 ? "" : "s"}*.`);
  if (pedeLista || campos.length) {
    const multiplosTipos = new Set(linhas.map(tipoHumanoDaLinha)).size > 1;
    for (const l of linhas.slice(0, 40)) {
      const detalhes = [];
      if (multiplosTipos) detalhes.push(`Tipo: ${tipoHumanoDaLinha(l)}`);
      for (const campo of campos) {
        let v = l?.[campo];
        if (campo === "valor_total" || campo === "valor_executado") v = formatarValorBR(v);
        if (campo === "percentual_executado" && v !== null && v !== undefined && v !== "") {
          const n = Number(v); v = Number.isFinite(n) ? `${n.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : String(v);
        }
        if (v !== null && v !== undefined && String(v).trim() !== "") detalhes.push(`${rotulos[campo]}: ${v}`);
      }
      partes.push(`• *${l.objeto}*${detalhes.length ? ` — ${detalhes.join(" — ")}` : ""}`);
    }
  }
  return partes.join("\n");
}

function linhasParaAuditoria(consultas = []) {
  return consultas.flatMap((c) => Array.isArray(c.linhas) ? c.linhas.map(enriquecerLinhaParaIA) : []);
}

async function redigirComFerramentas(pergunta, historico, consultas) {
  const dados = serializarConsultasFerramenta(consultas);
  const prompt = `Voce e o Assistente de Obras da Prefeitura de Mamanguape.
Responda em portugues claro e direto usando EXCLUSIVAMENTE os resultados das ferramentas abaixo.

PERGUNTA ATUAL:
${pergunta}

CONTEXTO PRIORITARIO:
${JSON.stringify(contextoPrioritario(historico))}

RESULTADOS REAIS DAS FERRAMENTAS:
${JSON.stringify(dados)}

REGRAS:
- Responda primeiro exatamente o que foi perguntado.
- Se houver varios pedidos na mesma mensagem, responda todos.
- Nunca invente um numero, nome, obra, bairro, empresa, responsavel, status ou percentual que nao apareca nos resultados.
- Nao use memoria antiga para acrescentar dados que nao aparecem nos resultados atuais.
- Diferencie obras, pavimentacoes, projetos e licitacoes conforme aba_origem/categoria.
- Se a pergunta disser \"obras\" genericamente, nao chame projeto ou licitacao de obra.
- Explique a diferenca entre valor total, executado e pago quando isso for relevante.
- Quando os dados trouxerem o campo canonico recurso, use esse valor. Nunca diga "recurso nao informado" se recurso estiver preenchido no resultado normalizado.
- Se a consulta retornou zero linhas, diga que nao encontrou registro correspondente; nao suponha.
- Nao mencione SQL, banco, JSON, ferramenta ou detalhes internos.
- Seja conciso, mas liste os itens quando o usuario pedir quais sao.
`;

  return await chamarIAbruta([{ role: "user", content: prompt }], {
    max_tokens: 900,
    temperature: 0,
    reasoning_effort: "low",
  });
}


function operacaoCanonicaDoPadrao(plano = {}, sql = "") {
  let op = Array.isArray(plano?.operacao) ? plano.operacao[0] : plano?.operacao;
  op = normalizarTexto(op || "");
  const mapa = {
    listar: "listar", lista: "listar", contar: "contar", count: "contar",
    somar: "somar", soma: "somar", sum: "somar", media: "media", avg: "media",
    ranking: "ranking", comparar: "comparar", detalhar: "detalhar", descobrir: "descobrir",
  };
  if (mapa[op]) return mapa[op];
  if (/\bsum\s*\(/i.test(sql)) return "somar";
  if (/\bavg\s*\(/i.test(sql)) return "media";
  if (/\bcount\s*\(/i.test(sql)) return /\bgroup\s+by\b/i.test(sql) ? "ranking" : "contar";
  if (/\bgroup\s+by\b/i.test(sql)) return "comparar";
  return "listar";
}

function listaCanonicaPadrao(v) {
  const arr = Array.isArray(v) ? v : (v === null || v === undefined || v === "" ? [] : [v]);
  return [...new Set(arr.map((x) => normalizarTexto(String(x))).filter(Boolean))].sort();
}

function escopoCanonicoDoPadrao(estado = {}, sql = "") {
  const declarado = normalizarTexto(estado?.escopo || "").replace(/\s+/g, "_");
  if (declarado && declarado !== "indefinido") return declarado;
  const s = normalizarTexto(sql);
  const tem = (x) => s.includes(normalizarTexto(x));
  if (tem("EM_PROJETO") && !tem("EM_ANDAMENTO") && !tem("PAVIMENTAÇÃO")) return "projetos";
  if (tem("EM_LICITAÇÃO") && !tem("EM_ANDAMENTO") && !tem("PAVIMENTAÇÃO")) return "licitacoes";
  if (tem("PAVIMENTAÇÃO") && !tem("EM_ANDAMENTO")) return "pavimentacoes";
  if (tem("EM_ANDAMENTO") && tem("PAVIMENTAÇÃO")) return "obras";
  if (tem("EM_ANDAMENTO")) return "obras_em_andamento";
  return declarado || "indefinido";
}

function filtrosEstruturaisDoPadrao(plano = {}, estado = {}, sql = "") {
  const chaves = new Set();
  const adicionar = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || String(v).trim() === "") continue;
      const nk = normalizarTexto(k).replace(/\s+/g, "_");
      if (nk && nk !== "aba_origem") chaves.add(nk);
    }
  };
  adicionar(plano?.filtros);
  adicionar(estado?.filtros);

  const cols = ["bairro", "engenheiro", "empresa", "status", "objeto", "categoria", "valor_total", "valor_executado", "percentual_executado"];
  for (const c of cols) {
    const re = new RegExp(`\\b${c}\\b`, "i");
    const where = String(sql).split(/\border\s+by\b|\bgroup\s+by\b|\blimit\b/i)[0];
    if (/\bwhere\b/i.test(where) && re.test(where.replace(/^.*?\bwhere\b/i, ""))) chaves.add(c);
  }
  return [...chaves].sort();
}

function agrupamentoDoPadrao(plano = {}, sql = "") {
  const p = normalizarTexto(plano?.agrupamento || "").replace(/\s+/g, "_");
  if (p) return p;
  const m = String(sql).match(/\bgroup\s+by\s+([a-z_][a-z0-9_]*)/i);
  return m ? normalizarTexto(m[1]).replace(/\s+/g, "_") : null;
}

function generalizarSQLParaPadrao(sql = "") {
  const preservar = new Set(["EM_ANDAMENTO", "PAVIMENTAÇÃO", "EM_PROJETO", "EM_LICITAÇÃO"]);
  return String(sql)
    .replace(/'((?:''|[^'])*)'/g, (literal, conteudo) => {
      const valor = String(conteudo).replace(/''/g, "'");
      if (preservar.has(valor)) return literal;
      return "'<VALOR>'";
    })
    .replace(/\s+/g, " ")
    .trim();
}

async function responderComFerramentas(pergunta, historico = []) {
  const consultas = [];
  let erroAnterior = null;
  let sqlAnteriorNoTurno = "";
  let estadoAtual = ultimoEstadoDoHistorico(historico) || null;
  let ultimoPlanoValido = {}; // usado apenas para auditoria do turno; nao e salvo

  for (let passo = 0; passo < MAX_PASSOS_FERRAMENTAS; passo++) {
    const decisao = await planejarPassoFerramenta(pergunta, historico, consultas, erroAnterior);
    erroAnterior = null;
    if (decisao?.estado && typeof decisao.estado === "object") estadoAtual = decisao.estado;

    if (decisao.acao === "sem_consulta") {
      if (consultas.length) break;

      // O bot e especializado nesta base. Antes de desistir de uma pergunta
      // desconhecida, faz UMA descoberta generica dos nomes/tipos existentes.
      // Assim siglas, apelidos e entidades nunca vistas (nao apenas UBS) podem
      // ser reconhecidas no passo seguinte sem cadastrar frases no codigo.
      if (passo < MAX_PASSOS_FERRAMENTAS - 1) {
        try {
          const descoberta = await executarDescobertaUniversal(pergunta);
          consultas.push(descoberta);
          erroAnterior = "antes de usar sem_consulta, examine a descoberta real da base e tente relacionar os termos livres da pergunta aos objetos/categorias encontrados. Se houver correspondencia, faca uma consulta alvo; se nao houver, finalize informando que nao encontrou";
          continue;
        } catch (e) {
          erroAnterior = `falha na consulta de descoberta: ${e.message}`;
          continue;
        }
      }

      return {
        resposta: "Nao encontrei dados suficientes na planilha para responder isso com seguranca. Pode detalhar um pouco mais o que deseja consultar?",
        semConsulta: true,
        estado: estadoAtual,
        modoAgente: "ferramentas_controladas",
      };
    }

    if (decisao.acao === "finalizar") {
      if (consultas.length) break;
      erroAnterior = "voce tentou finalizar sem consultar o banco; faca ao menos uma consulta para pergunta de dados";
      continue;
    }

    if (decisao.acao !== "consultar" || typeof decisao.sql !== "string") {
      erroAnterior = "acao invalida; use consultar, finalizar ou sem_consulta";
      continue;
    }

    const planoCheck = validarPlanoFerramenta(pergunta, decisao, historico);
    if (!planoCheck.ok) {
      erroAnterior = `plano rejeitado pelo auditor: ${planoCheck.motivo}`;
      console.warn("AGENTE/FERRAMENTAS:", erroAnterior);
      continue;
    }
    ultimoPlanoValido = decisao.plano && typeof decisao.plano === "object" ? decisao.plano : {};

    let sql = decisao.sql.replace(/```sql/gi, "").replace(/```/g, "").replace(/;$/, "").trim();
    const m = sql.match(/select[\s\S]+/i);
    if (m) sql = m[0].trim();

    // A IA escolhe a consulta, mas o Node garante o escopo de negocio.
    sql = aplicarEscopoNegocioNaSQL(pergunta, sql, historico);

    // Evita loop pedindo a mesma ferramenta repetidamente.
    if (sqlAnteriorNoTurno && normalizarTexto(sqlAnteriorNoTurno) === normalizarTexto(sql)) {
      break;
    }

    // Para follow-up, validamos com o tipo herdado do contexto quando a frase
    // atual nao o repete. Isso mantem a conversa sem depender de frase fixa.
    const perguntaValidacao = perguntaParaEscopo(pergunta, historico);
    const check = validarConsulta(perguntaValidacao, sql);
    if (!check.ok) {
      erroAnterior = `SQL rejeitada pelo guardrail: ${check.motivo}. SQL=${sql.slice(0, 700)}`;
      console.warn("AGENTE/FERRAMENTAS:", erroAnterior);
      continue;
    }

    try {
      const r = await queryReadOnly(comLimite(sql));
      consultas.push({
        objetivo: (decisao.objetivo || "consulta").toString().slice(0, 160),
        sql,
        linhas: r.rows || [],
      });
      sqlAnteriorNoTurno = sql;
      console.log(`AGENTE/FERRAMENTAS: passo ${passo + 1}, ${r.rows.length} linha(s).`);

      // Busca alvo sem resultado pode ser apenas abreviacao/sinonimo/grafia.
      // Em vez de responder "nao sei" imediatamente, carregamos um indice
      // compacto dos objetos e deixamos a IA relacionar semanticamente no
      // proximo passo. Isso funciona para QUALQUER entidade nova.
      const jaDescobriu = consultas.some((c) => c.descoberta);
      if (r.rows.length === 0 && !jaDescobriu && passo < MAX_PASSOS_FERRAMENTAS - 1) {
        try {
          const descoberta = await executarDescobertaUniversal(pergunta);
          consultas.push(descoberta);
          erroAnterior = "a busca alvo retornou 0 linhas. Use a descoberta de objetos para reconhecer sinonimos, siglas, grafia aproximada ou outro nome equivalente e faca uma nova consulta alvo antes de concluir que nao existe";
        } catch (e) {
          console.warn("AGENTE/FERRAMENTAS: descoberta apos zero linhas falhou:", e.message);
        }
      }
    } catch (e) {
      erroAnterior = `erro ao executar: ${e.message}. SQL=${sql.slice(0, 700)}`;
      console.warn("AGENTE/FERRAMENTAS:", erroAnterior);
    }
  }

  if (!consultas.length) {
    throw new Error(erroAnterior || "nenhuma consulta valida foi executada");
  }

  const direta = respostaDeterministicaFerramentas(pergunta, consultas);
  if (direta) {
    const ultimaDireta = [...consultas].reverse().find((c) => !c.descoberta) || consultas[consultas.length - 1];
    const linhasDiretasAuditadas = linhasParaAuditoria(consultas);
    const auditNumDireta = auditarRespostaNumerica(direta, linhasDiretasAuditadas);
    const auditTxtDireta = auditarCamposTextuaisSolicitados(pergunta, direta, linhasDiretasAuditadas);
    if (auditNumDireta.ok && auditTxtDireta.ok) {
      estadoAtual = construirEstadoSemantico(pergunta, ultimaDireta.sql, ultimaDireta.linhas, historico);
      return {
        resposta: direta,
        sql: ultimaDireta.sql,
        linhas: ultimaDireta.linhas.length,
        consultas: consultas.map((c) => c.sql),
        estado: estadoAtual,
        respostaDeterministica: true,
        modoAgente: "ferramentas_controladas",
      };
    }
    console.warn("AGENTE/FERRAMENTAS: resposta deterministica rejeitada -",
      !auditNumDireta.ok ? auditNumDireta.motivo : auditTxtDireta.motivo);
    // Continua para a redacao por IA; se ela falhar, o fallback local tambem
    // respeita a intencao. Nenhum conhecimento e salvo ate a resposta passar.
  }

  let resposta = await redigirComFerramentas(pergunta, historico, consultas);
  const linhasAuditadas = linhasParaAuditoria(consultas);
  let auditoria = auditarRespostaNumerica(resposta, linhasAuditadas);
  let auditoriaTexto = auditarCamposTextuaisSolicitados(pergunta, resposta, linhasAuditadas);
  if (!auditoria.ok || !auditoriaTexto.ok) {
    const motivo = !auditoria.ok ? auditoria.motivo : auditoriaTexto.motivo;
    console.warn("AGENTE/FERRAMENTAS: redacao rejeitada -", motivo);
    resposta = await redigirComFerramentas(
      `${pergunta}\nATENCAO: a resposta anterior falhou na auditoria por: ${motivo}. Use somente os dados reais retornados, inclua todos os campos explicitamente pedidos e nunca diga que um campo nao foi informado quando ele estiver preenchido.`,
      historico,
      consultas
    );
    auditoria = auditarRespostaNumerica(resposta, linhasAuditadas);
    auditoriaTexto = auditarCamposTextuaisSolicitados(pergunta, resposta, linhasAuditadas);
  }

  const ultima = consultas[consultas.length - 1];
  estadoAtual = construirEstadoSemantico(pergunta, ultima.sql, ultima.linhas, historico);
  if (!auditoria.ok || !auditoriaTexto.ok) {
    return {
      resposta: redigirLocal(pergunta, ultima.linhas.map(enriquecerLinhaParaIA)),
      sql: ultima.sql,
      linhas: ultima.linhas.length,
      consultas: consultas.map((c) => c.sql),
      estado: estadoAtual,
      fallbackLocal: true,
      modoAgente: "ferramentas_controladas",
    };
  }

  return {
    resposta,
    sql: ultima.sql,
    linhas: ultima.linhas.length,
    consultas: consultas.map((c) => c.sql),
    estado: estadoAtual,
    modoAgente: "ferramentas_controladas",
  };
}

async function tentarFallbackLocalUniversal(pergunta, historico = [], motivo = "") {
  let sql = gerarSQLRapida(pergunta, historico) || gerarSQLFallbackUniversal(pergunta, historico);
  if (!sql) return null;

  sql = aplicarEscopoNegocioNaSQL(pergunta, sql, historico);
  const perguntaValidacao = perguntaParaEscopo(pergunta, historico);
  const check = validarConsulta(perguntaValidacao, sql);
  if (!check.ok) {
    console.warn("AGENTE/FALLBACK LOCAL: SQL rejeitada -", check.motivo);
    return null;
  }

  try {
    const r = await queryReadOnly(comLimite(sql));
    const linhas = (r.rows || []).map(enriquecerLinhaParaIA);
    const estado = construirEstadoSemantico(pergunta, sql, linhas, historico);
    console.log(`AGENTE/FALLBACK LOCAL: ${linhas.length} linha(s) sem depender da IA.${motivo ? ` Motivo original: ${motivo}` : ""}`);
    return {
      resposta: redigirLocal(pergunta, linhas),
      sql,
      linhas: linhas.length,
      estado,
      fallbackLocal: true,
      modoAgente: "fallback_universal_sem_ia",
    };
  } catch (e) {
    console.error("AGENTE/FALLBACK LOCAL: consulta falhou:", e.message);
    return null;
  }
}

// Camada 0.5: consulta deterministica de alta confianca.
// Inspirada no padrao de agentes de dados em que o modelo e usado para o que
// exige interpretacao, mas filtros/contagens evidentes passam por ferramentas
// controladas. Isso reduz alucinacao, tokens e dependencia de provedor.
async function tentarCamadaDireta(pergunta, historico = []) {
  if (!USAR_CAMADA_DIRETA) return null;

  let sql = gerarSQLRapida(pergunta, historico);
  if (!sql) return null;

  sql = aplicarEscopoNegocioNaSQL(pergunta, sql, historico);
  const perguntaValidacao = perguntaParaEscopo(pergunta, historico);
  const check = validarConsulta(perguntaValidacao, sql);
  if (!check.ok) {
    console.warn("AGENTE/DIRETO: consulta recusada; entregando para o agente IA -", check.motivo);
    return null;
  }

  try {
    const r = await queryReadOnly(comLimite(sql));
    const linhas = (r.rows || []).map(enriquecerLinhaParaIA);

    // Termo livre sem resultado ganha uma segunda chance no agente de
    // ferramentas, que pode usar descoberta/schema para resolver abreviacao ou
    // sinonimo. Nao respondemos "nao existe" cedo demais.
    const p = normalizarTexto(pergunta);
    const temFiltroEstruturado = !!(
      filtroStatusDaPergunta(p) || condicaoLocalDaPergunta(p) ||
      condicaoEngenheiroDaPergunta(p) || condicaoEngenheiroImplicitoDaPergunta(p) ||
      condicaoRecursoDaPergunta(p) || filtroComparacaoNumericaDaPergunta(p)
    );
    const temTermoLivre = termosLivresCandidatos(pergunta).length > 0;
    if (linhas.length === 0 && temTermoLivre && !temFiltroEstruturado) {
      console.log("AGENTE/DIRETO: busca livre zerou; deixando o agente fazer descoberta semantica.");
      return null;
    }

    const estado = construirEstadoSemantico(pergunta, sql, linhas, historico);
    console.log(`AGENTE/DIRETO: ${linhas.length} linha(s), sem LLM para gerar SQL.`);
    return {
      resposta: redigirLocal(pergunta, linhas),
      sql,
      linhas: linhas.length,
      estado,
      respostaDeterministica: true,
      modoAgente: "agente1_direto_controlado",
    };
  } catch (e) {
    console.warn("AGENTE/DIRETO: execucao falhou; entregando para o agente de ferramentas:", e.message);
    return null;
  }
}


// ============================================================
// MODO ASSISTENTE — INTERPRETACAO ANTES DA CONSULTA
// ============================================================
// Esta camada aproxima o comportamento de um assistente conversacional: primeiro
// entende o que o cidadao quer; depois escolhe como buscar. Ela NAO gera SQL.
// O Node continua sendo o responsavel por localizar candidatos reais, validar e
// executar consultas somente-leitura.
const ACOES_PLANO_ASSISTENTE = new Set([
  "consultar_campo", "descrever", "listar", "contar", "somar",
  "existencia", "comparar", "ranking", "outro"
]);
const CAMPOS_PLANO_ASSISTENTE = new Set([
  "recurso", "status", "engenheiro", "empresa", "bairro",
  "valor_total", "valor_executado", "percentual_executado",
  "contrato", "convenio", "tipo_recurso", "data_inicio",
  "data_prev_termino", "saldo_devedor", "observacoes"
]);

function alvoPlanoEhGenericoOuFiltro(alvo = "", pergunta = "") {
  const a = normalizarTexto(alvo);
  if (!a) return true;
  if (/^(?:obra|obras|projeto|projetos|licitacao|licitacoes|pavimentacao|pavimentacoes|registro|registros)$/.test(a)) return true;

  const p = normalizarTexto(pergunta);
  const conds = [
    condicaoLocalDaPergunta(p),
    condicaoEngenheiroDaPergunta(p),
    condicaoEngenheiroImplicitoDaPergunta(p),
    condicaoRecursoDaPergunta(p),
    filtroStatusDaPergunta(p),
  ].filter(Boolean);
  const literais = conds.flatMap(extrairLiteraisILIKE).map(normalizarTexto).filter(Boolean);
  return literais.some((x) => a === x || (a.split(/\s+/).length <= 2 && (a.includes(x) || x.includes(a))));
}

function sanitizarPlanoAssistente(raw = {}, pergunta = "") {
  if (!raw || typeof raw !== "object") return null;
  const acao = ACOES_PLANO_ASSISTENTE.has(raw.acao) ? raw.acao : "outro";
  const campos = [...new Set((Array.isArray(raw.campos) ? raw.campos : [])
    .map((x) => String(x || "").trim())
    .filter((x) => CAMPOS_PLANO_ASSISTENTE.has(x)))];
  const alvo = sanitizarPistaSemantica(raw.alvo || "");
  const fortes = [...new Set([
    alvo,
    ...(Array.isArray(raw.equivalentes_fortes) ? raw.equivalentes_fortes : [])
  ].map(sanitizarPistaSemantica).filter(Boolean))].slice(0, 5);
  const relacionados = [...new Set((Array.isArray(raw.relacionados) ? raw.relacionados : [])
    .map(sanitizarPistaSemantica)
    .filter((x) => x && !fortes.includes(x)))].slice(0, 4);
  const confiancaNum = Number(raw.confianca);
  const confianca = Number.isFinite(confiancaNum) ? Math.max(0, Math.min(confiancaNum, 1)) : 0.5;
  const perguntaEsclarecimento = String(raw.pergunta_esclarecimento || "").trim().slice(0, 220);

  return {
    acao,
    campos,
    alvo,
    equivalentes_fortes: fortes,
    relacionados,
    usar_contexto: raw.usar_contexto === true,
    novo_alvo: raw.novo_alvo === true && !!alvo,
    precisa_esclarecer: raw.precisa_esclarecer === true,
    pergunta_esclarecimento: perguntaEsclarecimento,
    confianca,
    pergunta_normalizada: normalizarTexto(pergunta),
  };
}

async function interpretarPerguntaComoAssistente(pergunta = "", historico = []) {
  if (!USAR_MODO_ASSISTENTE) return null;

  const estado = ultimoEstadoDoHistorico(historico);
  const resumoEstado = estado ? {
    escopo: estado.escopo || null,
    foco_objeto: estado.foco_objeto || null,
    foco_engenheiro: estado.foco_engenheiro || null,
    tem_conjunto: !!estado.where_conjunto,
  } : null;

  const prompt = `Voce e a camada de COMPRETENSAO de um chatbot de obras publicas.\n` +
    `NAO escreva SQL e NAO responda a pergunta. Apenas transforme a mensagem em um plano curto.\n\n` +
    `Mensagem atual: ${JSON.stringify(pergunta)}\n` +
    `Estado recente da conversa: ${JSON.stringify(resumoEstado)}\n\n` +
    `Retorne SOMENTE JSON valido no formato:\n` +
    `{"acao":"consultar_campo|descrever|listar|contar|somar|existencia|comparar|ranking|outro",` +
    `"campos":["..."],"alvo":"...","usar_contexto":false,"novo_alvo":true,` +
    `"precisa_esclarecer":false,"pergunta_esclarecimento":"",` +
    `"equivalentes_fortes":["..."],"relacionados":["..."],"confianca":0.0}\n\n` +
    `REGRAS IMPORTANTES:\n` +
    `1. Separe O QUE O USUARIO QUER VER do ALVO que deve ser localizado. ` +
    `Ex.: "qual o recurso das UBS" => campo=recurso e alvo=UBS.\n` +
    `2. "status", "engenheiro", "recurso", "valor" etc. quando pedidos sao CAMPOS, nao filtros.\n` +
    `3. Se o usuario nomeou uma obra/projeto/local/entidade no turno atual, novo_alvo=true e usar_contexto=false. ` +
    `O novo alvo vence filtros antigos da conversa.\n` +
    `4. Se a mensagem e apenas "ela", "delas", "dessas", "o engenheiro?", "e o recurso?" sem novo nome, usar_contexto=true.\n` +
    `5. Para "fale sobre", "me explique", "detalhes" use acao=descrever.\n` +
    `6. equivalentes_fortes sao apenas grafias/correcoes ou expressoes realmente equivalentes. ` +
    `Termos apenas proximos ficam em relacionados. Ex.: "posto de saude" pode ser relacionado a UBS, mas nao assuma que e sempre a mesma coisa.\n` +
    `7. Nao invente nomes de obras, bairros, pessoas ou empresas. As pistas servem somente para buscar registros reais.\n` +
    `8. Se a pergunta estiver incompleta e nao houver contexto suficiente, precisa_esclarecer=true.\n` +
    `9. Campos permitidos: recurso,status,engenheiro,empresa,bairro,valor_total,valor_executado,percentual_executado,contrato,convenio,tipo_recurso,data_inicio,data_prev_termino,saldo_devedor,observacoes.\n` +
    `10. Se a pergunta for apenas sobre obras/projetos de um BAIRRO, engenheiro ou status, nao use esse filtro como alvo semantico; deixe alvo vazio e novo_alvo=false. Ex.: "obras do Centro" => Centro e filtro de local, nao alvo.\n` +
    `11. confianca vai de 0 a 1. Nao inclua explicacoes fora do JSON.`;

  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 360,
      temperature: 0,
      reasoning_effort: "low",
    });
    return sanitizarPlanoAssistente(extrairJSONSeguro(bruto) || {}, pergunta);
  } catch (e) {
    console.warn("AGENTE/MODO ASSISTENTE: interpretacao indisponivel; seguindo fluxo normal:", e.message);
    return null;
  }
}

function campoNumericoDoPlano(plano = {}, pergunta = "") {
  const p = normalizarTexto(pergunta);
  if (plano.campos?.includes("valor_executado") || /\b(executado|executou|pago|pagou)\b/.test(p)) return "valor_executado";
  if (plano.campos?.includes("percentual_executado") || /\b(percentual|porcentagem|avancad|adiantad)\b/.test(p)) return "percentual_executado";
  return "valor_total";
}

function respostaPlanoPorLinhas(pergunta = "", plano = {}, diretas = [], relacionadas = []) {
  const p = normalizarTexto(pergunta);
  const alvo = plano.alvo || "esse assunto";
  const campos = plano.campos?.length ? plano.campos : camposSolicitados(pergunta);

  if (plano.acao === "descrever") {
    if (diretas.length === 1) return formatarFichaRegistro(diretas[0]);
    if (diretas.length > 1) {
      return `Encontrei ${diretas.length} registros que podem corresponder a “${alvo}”:\n` +
        diretas.slice(0, 12).map((l) => `• ${l.objeto}`).join("\n") +
        `\n\nQual deles voce quer que eu detalhe?`;
    }
  }

  if (plano.acao === "contar") {
    let out = `Encontrei ${diretas.length} registro${diretas.length === 1 ? "" : "s"} diretamente relacionado${diretas.length === 1 ? "" : "s"} a “${alvo}”.`;
    if (relacionadas.length) out += ` Tambem ha ${relacionadas.length} registro${relacionadas.length === 1 ? "" : "s"} relacionado${relacionadas.length === 1 ? "" : "s"}, que nao contei automaticamente como equivalente.`;
    return out;
  }

  if (plano.acao === "somar") {
    const campo = campoNumericoDoPlano(plano, pergunta);
    const vals = diretas.map((l) => Number(l?.[campo])).filter(Number.isFinite);
    if (!vals.length) return `Encontrei os registros de “${alvo}”, mas nenhum deles tem esse valor cadastrado.`;
    const total = vals.reduce((a, b) => a + b, 0);
    const rotulo = campo === "valor_executado" ? "Valor executado somado" : campo === "percentual_executado" ? "Percentual somado" : "Valor total cadastrado";
    const valor = campo === "percentual_executado" ? `${total.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : formatarMoedaSemantica(total);
    return `${rotulo}: ${valor}.\n\nConsiderados ${vals.length} registro${vals.length === 1 ? "" : "s"} com valor informado.`;
  }

  if (plano.acao === "comparar" || plano.acao === "ranking") {
    const campo = campoNumericoDoPlano(plano, pergunta);
    const validas = diretas.filter((l) => Number.isFinite(Number(l?.[campo])));
    if (validas.length) {
      const querMenor = /\b(menor|menos|mais barata|mais barato|menos avancad|menos adiantad)\b/.test(p);
      validas.sort((a, b) => querMenor ? Number(a[campo]) - Number(b[campo]) : Number(b[campo]) - Number(a[campo]));
      const vencedora = validas[0];
      return formatarLinhaSemantica(vencedora, [campo, ...campos.filter((c) => c !== campo)]);
    }
  }

  return redigirResultadoSemantico(
    pergunta,
    { alvo, termos_originais: [alvo] },
    diretas,
    relacionadas
  );
}

async function tentarResolverComPlanoAssistente(pergunta = "", historico = [], plano = null) {
  if (!plano || plano.confianca < CONFIANCA_MIN_PLANO) return null;
  if (plano.precisa_esclarecer) {
    return {
      resposta: plano.pergunta_esclarecimento || "Pode me dizer qual obra, projeto, licitacao ou conjunto voce quer consultar?",
      desambiguacao: true,
      modoAgente: "agente1_modo_assistente",
    };
  }

  // Referencias puras devem continuar usando a memoria de IDs/WHERE ja existente.
  if (plano.usar_contexto && !plano.novo_alvo) return null;
  if (!plano.novo_alvo || !plano.alvo) return null;
  // Bairro, engenheiro, recurso/status e escopos genericos ja possuem filtros
  // estruturados melhores que busca semantica. Ex.: "obras do Centro" nao deve
  // exigir que a palavra Centro apareca no nome da obra.
  if (alvoPlanoEhGenericoOuFiltro(plano.alvo, pergunta)) return null;

  // Analises totalmente gerais (ex.: "qual engenheiro tem mais obras?") sao
  // melhores no agente de ferramentas/SQL. Esta camada assume um ALVO localizavel.
  if (!plano.equivalentes_fortes?.length) return null;

  try {
    const filtros = filtrosEstruturadosParaSemantica(pergunta);
    const buscaDireta = await buscarCandidatosSemanticos(plano.equivalentes_fortes, filtros);
    const diretasMap = new Map((buscaDireta.rows || []).map((r) => [Number(r.id), r]));

    let buscaRelacionada = { rows: [], sql: "", params: [] };
    if (plano.relacionados?.length) {
      buscaRelacionada = await buscarCandidatosSemanticos(plano.relacionados, filtros);
    }
    const relacionadas = (buscaRelacionada.rows || []).filter((r) => !diretasMap.has(Number(r.id)));
    const diretas = [...diretasMap.values()];
    if (!diretas.length && !relacionadas.length) return null;

    // O foco conversacional usa apenas correspondencias fortes quando elas existem.
    // Relacionados aparecem como apoio, mas nao inflacionam contagens nem follow-ups.
    const foco = diretas.length ? diretas : relacionadas;
    const ids = foco.map((x) => x.id);
    const sqlFinal = sqlDefinitivaPorIds(ids);
    if (!sqlFinal || !sqlSegura(sqlFinal).ok) return null;
    const final = await queryReadOnly(sqlFinal);
    const linhasFoco = (final.rows || []).map(enriquecerLinhaParaIA);
    const linhasRelacionadas = diretas.length ? relacionadas.map(enriquecerLinhaParaIA) : [];

    const resposta = respostaPlanoPorLinhas(
      pergunta,
      plano,
      diretas.length ? linhasFoco : [],
      diretas.length ? linhasRelacionadas : linhasFoco
    );
    if (!resposta) return null;

    // Para comparacao/ranking o item escolhido deve virar foco singular da conversa.
    let linhasEstado = linhasFoco;
    if ((plano.acao === "comparar" || plano.acao === "ranking") && linhasFoco.length > 1) {
      const campo = campoNumericoDoPlano(plano, pergunta);
      const validas = linhasFoco.filter((l) => Number.isFinite(Number(l?.[campo])));
      if (validas.length) {
        const querMenor = /\b(menor|menos|mais barata|mais barato|menos avancad|menos adiantad)\b/.test(normalizarTexto(pergunta));
        validas.sort((a, b) => querMenor ? Number(a[campo]) - Number(b[campo]) : Number(b[campo]) - Number(a[campo]));
        linhasEstado = [validas[0]];
      }
    }

    const estado = construirEstadoSemantico(pergunta, sqlFinal, linhasEstado, historico);
    return {
      resposta,
      sql: sqlFinal,
      linhas: linhasFoco.length,
      estado,
      modoAgente: "agente1_modo_assistente",
      planoAssistente: {
        acao: plano.acao,
        campos: plano.campos,
        alvo: plano.alvo,
        confianca: plano.confianca,
      },
      consultas: [buscaDireta.sql, buscaRelacionada.sql, sqlFinal].filter(Boolean),
    };
  } catch (e) {
    console.warn("AGENTE/MODO ASSISTENTE: resolucao por plano falhou; seguindo fluxo tradicional:", e.message);
    return null;
  }
}

// --- FLUXO COMPLETO ---
export async function responderPergunta(pergunta, historico = []) {
  // 0. Saudacao/agradecimento/despedida - responde sem tocar no banco.
  const social = respostaSocial(pergunta);
  if (social) {
    console.log("AGENTE: resposta social (sem SQL).");
    return { resposta: social, social: true };
  }

  // 0.1. Modo Assistente: compreende a intencao ANTES de decidir como consultar.
  // A camada devolve somente um plano JSON; SQL continua sob controle do Node.
  const planoAssistente = await interpretarPerguntaComoAssistente(pergunta, historico);
  if (planoAssistente) {
    const resolvidaPeloPlano = await tentarResolverComPlanoAssistente(pergunta, historico, planoAssistente);
    if (resolvidaPeloPlano) return resolvidaPeloPlano;
  }

  // 0.2. Se falta o alvo e nao existe contexto anterior, pergunta antes de
  // consultar. Isso evita respostas gigantes ou incorretas por suposicao.
  const esclarecer = respostaDesambiguacao(pergunta, historico);
  if (esclarecer) {
    console.log("AGENTE: pergunta ambigua; pedindo esclarecimento sem SQL.");
    return { resposta: esclarecer, desambiguacao: true };
  }

  // 0.4. Resolucao semantica de assunto: extrai o conceito, busca candidatos
  // REAIS no PostgreSQL e executa a consulta definitiva por IDs. Isto evita
  // depender de listas manuais de sinonimos e evita transformar cada palavra
  // da pergunta em um ILIKE obrigatorio. Se nao houver sinal suficiente, a
  // camada simplesmente devolve null e o fluxo tradicional continua.
  const semantica = await tentarResolucaoSemantica(pergunta, historico);
  if (semantica) return semantica;

  // Antes da IA, tenta a camada de alta confianca. Ela entende operacoes e
  // filtros de forma generica, incluindo termos livres, sem perguntas fixas.
  const direta = await tentarCamadaDireta(pergunta, historico);
  if (direta) return direta;

  // Modo principal: a IA trabalha como agente de consulta com ferramentas.
  // O fluxo antigo permanece logo abaixo como contingencia automatica.
  if (USAR_AGENTE_FERRAMENTAS) {
    try {
      return await responderComFerramentas(pergunta, historico);
    } catch (e) {
      console.error("AGENTE/FERRAMENTAS: falhou; tentando fallback local antes de chamar a IA novamente:", e.message);
      const local = await tentarFallbackLocalUniversal(pergunta, historico, e.message);
      if (local) return local;
    }
  }

  // 1. Gera SQL. A IA interpreta a frase livremente. Se os provedores
  // estiverem fora do ar, tentamos o mecanismo deterministico como contingencia.
  let sql;
  try {
    sql = await gerarSQL(pergunta, historico);
  } catch (e) {
    console.error("AGENTE: IA nao conseguiu gerar SQL; tentando fallback rapido:", e.message);
    const rapida = gerarSQLRapida(pergunta, historico) || gerarSQLFallbackUniversal(pergunta, historico);
    if (rapida) sql = rapida;
    else return { resposta: "Desculpe, tive um problema ao entender sua pergunta. Pode reformular?", erro: "gerar_sql: " + e.message };
  }
  // 1a.5. Aplica apenas o escopo de negocio que nao pode ficar a criterio
  // da IA (obra x projeto x licitacao x pavimentacao). Nomes, bairros, valores
  // e demais filtros continuam sendo interpretados dinamicamente pela IA.
  sql = aplicarEscopoNegocioNaSQL(pergunta, sql, historico);
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

  // 2. Valida SEGURANCA + COERENCIA DE NEGOCIO. A IA interpreta, mas nao
  // decide sozinha o que pode consultar nem pode misturar categorias/campos.
  // Para erros comuns, permitimos UMA correcao e auditamos novamente.
  let check = validarConsulta(pergunta, sql);
  if (!check.ok) {
    console.warn("AGENTE: primeira SQL rejeitada -", check.motivo);
    try {
      const anterior = sql;
      let corrigida = await gerarSQL(pergunta, historico, {
        sql: anterior,
        erro: `validacao de seguranca: ${check.motivo}`,
      });
      corrigida = aplicarEscopoNegocioNaSQL(pergunta, corrigida, historico);
      const checkCorrigida = validarConsulta(pergunta, corrigida);
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
      let corrigida = await gerarSQL(pergunta, historico, {
        sql,
        erro: e.message,
      });
      corrigida = aplicarEscopoNegocioNaSQL(pergunta, corrigida, historico);
      const checkCorrigida = validarConsulta(pergunta, corrigida);
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
    let resposta = await redigir(pergunta, linhas, ehInicio, historico, sql);
    let auditoria = auditarRespostaNumerica(resposta, linhas);

    // So gasta uma chamada extra quando a primeira redacao introduziu numero
    // financeiro/percentual que nao existe no resultado real.
    if (!auditoria.ok) {
      console.warn("AGENTE: resposta numerica rejeitada -", auditoria.motivo);
      resposta = await redigir(
        `${pergunta}

ATENCAO DE AUDITORIA: na tentativa anterior apareceu ${auditoria.motivo}. Responda novamente copiando SOMENTE os numeros retornados nos dados.`,
        linhas, ehInicio, historico, sql
      );
      auditoria = auditarRespostaNumerica(resposta, linhas);
    }

    if (!auditoria.ok) {
      console.error("AGENTE: segunda redacao tambem falhou auditoria; usando fallback local.");
      return {
        resposta: redigirLocal(pergunta, linhas),
        sql,
        linhas: linhas.length,
        estado: construirEstadoSemantico(pergunta, sql, linhas, historico),
        fallbackLocal: true,
        auditoriaFalhou: auditoria.motivo,
      };
    }

    return { resposta, sql, linhas: linhas.length, estado: construirEstadoSemantico(pergunta, sql, linhas, historico), modoAgente: "ia_controlada" };
  } catch (e) {
    console.error("AGENTE: redacao por IA falhou; usando resposta local:", e.message);
    return {
      resposta: redigirLocal(pergunta, linhas),
      sql,
      linhas: linhas.length,
      estado: construirEstadoSemantico(pergunta, sql, linhas, historico),
      fallbackLocal: true,
    };
  }
}
