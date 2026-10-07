// ============================================================
// agente.js - SQL AGENT CONVERSACIONAL SEMANTICO + SELF-HEALING + EVIDENCE GROUNDING (Node.js) - V16
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
const MAX_EVIDENCE_ROWS = Math.max(500, Math.min(Number(process.env.AGENTE_MAX_EVIDENCIAS || 5000), 20000));
const MAX_RAW_VALUES_PER_BATCH = Math.max(20, Math.min(Number(process.env.AGENTE_MAX_RAW_POR_LOTE || 70), 120));

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

// Regras de negocio por frase foram removidas no V16.
// A interpretacao agora passa pelo resolvedor, plano semantico e validacao por evidencias.

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
    const estado = m?.estado ? `\nESTADO_ANTERIOR: ${jsonSeguro(m.estado, 1800)}` : "";
    return `${papel}: ${conteudo}${sql}${estado}`;
  }).join("\n\n");
}


// ------------------------------------------------------------
// Resolucao conversacional por IA (sem regex de negocio)
// ------------------------------------------------------------
// Antes de qualquer planejamento SQL, transforma a mensagem atual em uma
// pergunta AUTONOMA, carregando somente o contexto que o usuario realmente
// manteve do turno anterior. Isso resolve follow-ups como:
//   "em quais obras?" -> "quais obras do Centro compoem o valor investido?"
//   "e os engenheiros dessas obras?" -> "quais engenheiros das obras do Centro?"
// A decisao de herdar/substituir filtros e feita pela IA com base no historico,
// nao por listas de frases, palavras-chave ou regex de dominio.
async function resolverPerguntaConversacional(pergunta, historico, ctx) {
  if (!Array.isArray(historico) || historico.length === 0) {
    return {
      pergunta_autonoma: pergunta,
      is_followup: false,
      scope: {},
      confidence: 1,
      note: "sem historico",
    };
  }

  const prompt = `Voce e o RESOLVEDOR DE CONTEXTO de um chatbot Text-to-SQL.\n` +
    `Sua unica tarefa e reescrever a mensagem atual como uma pergunta AUTONOMA, completa e inequívoca. NAO gere SQL.\n` +
    `Use o historico para resolver referencias como "essas", "eles", "quais", "em quais obras", "e os engenheiros", "e o valor" etc.\n` +
    `Preserve filtros, universo e conjunto de registros do assunto ativo quando a mensagem atual for continuacao.\n` +
    `Se a mensagem atual trouxer explicitamente um novo filtro/alvo que substitui o anterior, use o novo.\n` +
    `Nao herde assuntos antigos que nao estejam ligados ao encadeamento atual.\n` +
    `Nao invente filtros, nomes, status ou valores.\n` +
    `Quando houver ESTADO_ANTERIOR/context_scope no historico, trate-o como memoria estruturada do recorte conversacional; use-o apenas se for coerente com as ultimas mensagens do usuario.\n` +
    `Se a pergunta ja for autonoma, devolva-a praticamente igual.\n\n` +
    `SCHEMA DISPONIVEL (apenas para entender nomes de conceitos):\n${schemaCompactoParaPlanejamento(ctx)}\n\n` +
    `HISTORICO RECENTE:\n${resumoHistorico(historico)}\n\n` +
    `MENSAGEM ATUAL: ${JSON.stringify(pergunta)}\n\n` +
    `Retorne SOMENTE JSON:\n` +
    `{"pergunta_autonoma":"...","is_followup":true,"scope":{"universe":null,"subjects":[],"filters":[],"requested_focus":null,"source_turn":"descricao curta"},"confidence":0.0,"note":"..."}`;

  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 500,
      temperature: 0,
      reasoning_effort: "low",
    });
    const obj = objetoJSONEmTexto(bruto) || {};
    const perguntaAutonoma = textoSeguro(obj.pergunta_autonoma || obj.standalone_question || "", 1800) || pergunta;
    return {
      pergunta_autonoma: perguntaAutonoma,
      is_followup: obj.is_followup === true,
      scope: obj.scope && typeof obj.scope === "object" ? obj.scope : {},
      confidence: Math.max(0, Math.min(1, Number(obj.confidence || 0))),
      note: textoSeguro(obj.note || "", 800),
    };
  } catch (e) {
    console.warn("SQL AGENT - resolucao conversacional falhou; usando pergunta original:", e?.message || e);
    return {
      pergunta_autonoma: pergunta,
      is_followup: false,
      scope: {},
      confidence: 0,
      note: "resolver_indisponivel",
    };
  }
}

// V16: removido bloco legado de regex/rewrite de negocio.
// Regex abaixo deste ponto servem apenas a parsing/seguranca de SQL e formatacao tecnica.

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

async function planejarConsultaSemantica(pergunta, historico, ctx, contextScope = {}) {
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
    `ESCOPO CONVERSACIONAL RESOLVIDO (se houver):\n${jsonSeguro(contextScope || {}, 3000)}\n\n` +
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


async function revisarPlanoComContexto({ pergunta, plano, resolucao, ctx }) {
  if (!resolucao?.is_followup) return plano;
  const prompt = `Voce e o VALIDADOR DE CONTEXTO de um Text-to-SQL. NAO gere SQL.\n` +
    `A mensagem atual ja foi reescrita como pergunta autonoma. Confira se o plano preserva exatamente o conjunto referenciado pelo usuario.\n` +
    `Nao recupere filtros de assuntos antigos. Nao remova filtros do encadeamento atual. Nao invente filtros.\n` +
    `Se o plano estiver correto, devolva-o sem mudancas. Se perdeu o recorte, corrija somente o plano usando a pergunta autonoma e o escopo resolvido.\n\n` +
    `PERGUNTA AUTONOMA: ${JSON.stringify(pergunta)}\n` +
    `ESCOPO RESOLVIDO: ${jsonSeguro(resolucao.scope || {}, 3500)}\n` +
    `PLANO ATUAL: ${jsonSeguro(plano, 7000)}\n` +
    `SCHEMA: ${schemaCompactoParaPlanejamento(ctx)}\n\n` +
    `Retorne SOMENTE o JSON completo do plano, no mesmo formato recebido.`;
  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 800,
      temperature: 0,
      reasoning_effort: "low",
    });
    const revisto = normalizarPlano(objetoJSONEmTexto(bruto));
    return revisto.confidence > 0 ? revisto : plano;
  } catch (e) {
    console.warn("SQL AGENT - revisao de contexto falhou; mantendo plano:", e?.message || e);
    return plano;
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
    `HISTORICO/ANCORA:\n${resumoHistorico(historico)}\n\n` +
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
    // Segunda chance ainda dentro do pipeline semantico. Nao volta ao gerador
    // legado nem a regras/regex de negocio.
    const gerada = await gerarSQLPorPlano(
      pergunta, [], ctx, plano, exemplos, "decomposicao",
      "As tentativas anteriores falharam. Gere uma nova SQL seguindo estritamente o plano e o schema real."
    );
    if (!gerada?.query) throw new Error("Nao foi possivel gerar uma consulta SQL valida a partir do plano semantico.");
    const execucao = await executarComSelfHealing({ pergunta, historico: [], ctx, sqlInicial: gerada.query });
    const local = avaliarResultadoLocalSemantico(plano, execucao.sql, execucao.rows);
    const semantica = await avaliarCandidatoComIA({ pergunta, plano, sql: execucao.sql, rows: execucao.rows, avaliacaoLocal: local });
    return { plano, exemplos, candidato: { variante: "fallback_semantico", gerada, execucao, local, semantica, score: semantica.score }, candidatos };
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


function slugSemantico(s = "campo") {
  const n = normalizar(s).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return n || "campo";
}

function dimensaoPrincipalDoPlano(plano = {}) {
  const alvo = normalizar(plano.expected_result?.primary_concept || "");
  const entidades = Array.isArray(plano.entities) ? plano.entities : [];
  const candidatas = entidades.filter((e) => e && e.required !== false && (e.role === "dimension" || normalizar(e.concept || "") === alvo));
  const e = candidatas[0] || entidades.find((x) => x?.role === "dimension") || null;
  if (!e) return null;
  return {
    concept: e.concept || plano.expected_result?.primary_concept || "dimensao",
    source: e.source || null,
    json_keys: Array.isArray(e.json_keys) ? e.json_keys.filter(Boolean) : [],
  };
}

function medidaPrincipalDoPlano(plano = {}) {
  const medidas = Array.isArray(plano.measures) ? plano.measures.filter(Boolean) : [];
  const m = medidas[0] || null;
  if (!m) return null;
  return {
    concept: m.concept || "medida",
    source: m.source || null,
    json_keys: Array.isArray(m.json_keys) ? m.json_keys.filter(Boolean) : [],
    aggregation: normalizar(m.aggregation || "none"),
  };
}

function chaveDimensaoResultado(rows = [], dimensao = null) {
  if (!rows.length) return dimensao?.source && dimensao.source !== "dados_extras" ? dimensao.source : slugSemantico(dimensao?.concept || "dimensao");
  const keys = Object.keys(rows[0] || {});
  const source = normalizar(dimensao?.source || "");
  const concept = normalizar(dimensao?.concept || "");
  const exata = keys.find((k) => normalizar(k) === source || normalizar(k) === concept);
  if (exata) return exata;
  const bruta = keys.find((k) => normalizar(k).includes(source) || normalizar(k).includes(concept));
  return bruta || (dimensao?.source && dimensao.source !== "dados_extras" ? dimensao.source : slugSemantico(dimensao?.concept || "dimensao"));
}

function chaveMedidaResultado(rows = [], dimensaoKey = "", medida = null) {
  if (!rows.length) {
    if (medida?.aggregation === "count") return "quantidade";
    return `total_${slugSemantico(medida?.concept || "valor")}`;
  }
  const keys = Object.keys(rows[0] || {}).filter((k) => k !== dimensaoKey && k !== "id" && k !== "objeto");
  const numeric = keys.find((k) => rows.some((r) => numeroParaAnalise(r?.[k]) !== null));
  if (numeric) return numeric;
  if (medida?.aggregation === "count") return "quantidade";
  return `total_${slugSemantico(medida?.concept || "valor")}`;
}

async function gerarSQLDeEvidenciasSemanticas({ pergunta, plano, sqlOriginal, ctx, dimensao, medida }) {
  const prompt = `Voce e o GERADOR DE EVIDENCIAS de um pipeline Text-to-SQL.\n` +
    `Gere UMA SELECT em nivel de registro, para o MESMO conjunto/filtros da SQL original, sem GROUP BY, DISTINCT agregado ou resumo.\n` +
    `Objetivo: permitir ao Node validar e reagrupar uma dimensao categorica semanticamente suja sem deixar a IA inventar contagens.\n` +
    `Retorne obrigatoriamente: id::text AS __row_id (ou uma chave estavel equivalente se id nao existir), objeto quando existir, e a fonte BRUTA da dimensao como __dim_raw.\n` +
    `Se houver medida numerica com agregacao diferente de count/none, retorne o valor POR REGISTRO que entra no calculo como __measure_0. Para pagamento, respeite as json_keys do plano e nao duplique familias sobrepostas.\n` +
    `Preserve EXATAMENTE universo, filtros e recorte da SQL original. Nao amplie o conjunto.\n` +
    `Nao use LIMIT: o Node controla o limite de evidencias para nao truncar silenciosamente a agregacao.\n` +
    `Use somente public.${ctx.relacao}. Nao limpe/extraia a dimensao na SQL; queremos o texto bruto.\n` +
    `Retorne SOMENTE JSON {"description":"...","query":"SELECT ..."}.\n\n` +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n` +
    `PLANO: ${jsonSeguro(plano, 6500)}\n` +
    `DIMENSAO: ${jsonSeguro(dimensao, 1800)}\n` +
    `MEDIDA: ${jsonSeguro(medida, 1800)}\n` +
    `SQL ORIGINAL: ${sqlOriginal}\n` +
    `SCHEMA: ${schemaCompactoParaPlanejamento(ctx)}`;
  const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
    max_tokens: 520,
    temperature: 0,
    reasoning_effort: "low",
  });
  return extrairSQLDaResposta(bruto);
}


function catalogarValoresBrutos(evidenceRows = []) {
  const porRaw = new Map();
  for (const r of evidenceRows) {
    const raw = r?.__dim_raw == null ? "" : String(r.__dim_raw);
    const key = raw;
    if (!porRaw.has(key)) porRaw.set(key, { raw_id: String(porRaw.size + 1), raw });
  }
  return [...porRaw.values()];
}

async function mapearValoresPorEvidencia({ pergunta, plano, dimensao, evidenceRows }) {
  const catalogo = catalogarValoresBrutos(evidenceRows);
  const mappings = [];
  const notes = [];

  for (let i = 0; i < catalogo.length; i += MAX_RAW_VALUES_PER_BATCH) {
    const lote = catalogo.slice(i, i + MAX_RAW_VALUES_PER_BATCH);
    const prompt = `Voce e um CLASSIFICADOR DE EVIDENCIAS. Nao conte, nao some e nao produza resposta final.\n` +
      `Para cada valor bruto, extraia somente valores que REALMENTE representem o conceito ${JSON.stringify(dimensao.concept)} e estejam explicitamente escritos no raw.\n` +
      `A saida de cada valor deve conter label e evidence. evidence deve ser o trecho EXATO do raw que sustenta o label.\n` +
      `label pode apenas normalizar caixa, acento e espacos de evidence; nao pode trocar por sinonimo, completar, abreviar nem usar conhecimento externo.\n` +
      `Se raw for endereco/descricao e nao houver evidencia suficiente de que um trecho e o conceito pedido, retorne values:[] para esse raw.\n` +
      `Nao trate nome de rua, avenida, travessa, trecho, numero, referencia geografica ou descricao como o conceito pedido apenas porque aparece no campo.\n` +
      `Se dois valores do conceito estiverem explicitamente presentes no mesmo raw, pode retornar os dois.\n` +
      `Se o raw inteiro for claramente um valor categorico simples do conceito, evidence pode ser o raw inteiro.\n` +
      `Nunca invente contagens. O Node fara toda agregacao depois de validar as evidencias.\n\n` +
      `PERGUNTA: ${JSON.stringify(pergunta)}\nPLANO: ${jsonSeguro(plano, 4500)}\n` +
      `VALORES BRUTOS: ${jsonSeguro(lote, 18000)}\n\n` +
      `Retorne SOMENTE JSON {"mappings":[{"raw_id":"...","values":[{"label":"...","evidence":"..."}]}],"note":"..."}.`;

    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], {
      max_tokens: 2200,
      temperature: 0,
      reasoning_effort: "low",
    });
    const obj = objetoJSONEmTexto(bruto) || {};
    if (Array.isArray(obj.mappings)) mappings.push(...obj.mappings);
    if (obj.note) notes.push(textoSeguro(obj.note, 600));
  }

  return { mappings, note: notes.filter(Boolean).join(" ") };
}

function validarMapeamentosPorEvidencia(evidenceRows = [], mappings = []) {
  const catalogo = catalogarValoresBrutos(evidenceRows);
  const porRawId = new Map(catalogo.map((x) => [String(x.raw_id), x]));
  const validosPorRaw = new Map();

  for (const m of mappings || []) {
    const rawId = String(m?.raw_id ?? "");
    const item = porRawId.get(rawId);
    if (!item) continue;
    const rawN = normalizar(item.raw);
    const values = [];
    const vistos = new Set();
    for (const v of Array.isArray(m?.values) ? m.values : []) {
      const evidence = textoSeguro(v?.evidence || "", 500);
      const label = textoSeguro(v?.label || "", 500);
      const eN = normalizar(evidence);
      const lN = normalizar(label);
      if (!eN || !lN || !rawN.includes(eN)) continue;
      if (lN !== eN) continue;
      if (vistos.has(lN)) continue;
      vistos.add(lN);
      values.push({ label, evidence, key: lN });
    }
    validosPorRaw.set(item.raw, values);
  }

  return { validosPorRaw };
}

function reagruparPorEvidencias({ plano, originalRows, evidenceRows, validacao, dimensao, medida }) {
  const dimKey = chaveDimensaoResultado(originalRows, dimensao);
  const measureKey = chaveMedidaResultado(originalRows, dimKey, medida);
  const grupos = new Map();
  let mapeados = 0;
  let semEvidencia = 0;

  for (let i = 0; i < evidenceRows.length; i++) {
    const row = evidenceRows[i] || {};
    const raw = row.__dim_raw == null ? "" : String(row.__dim_raw);
    const values = validacao.validosPorRaw.get(raw) || [];
    if (!values.length) { semEvidencia++; continue; }
    mapeados++;
    const unicos = new Map(values.map((v) => [v.key, v]));
    for (const v of unicos.values()) {
      if (!grupos.has(v.key)) grupos.set(v.key, { label: v.label, count: 0, nums: [] });
      const g = grupos.get(v.key);
      g.count += 1;
      const n = numeroParaAnalise(row.__measure_0);
      if (n !== null) g.nums.push(n);
      // Prefere grafia informativa que nao seja toda caixa alta quando ambas existirem.
      const atualMaiuscula = g.label && g.label === g.label.toUpperCase();
      const novaMaiuscula = v.label && v.label === v.label.toUpperCase();
      if (atualMaiuscula && !novaMaiuscula) g.label = v.label;
    }
  }

  const agg = normalizar(medida?.aggregation || (plano.expected_result?.numeric_kind === "count" ? "count" : "none"));
  let rows = [...grupos.values()].map((g) => {
    const r = { [dimKey]: g.label };
    if (agg === "count" || plano.expected_result?.numeric_kind === "count") r[measureKey] = g.count;
    else if (agg === "sum") r[measureKey] = Number(decimalSomar(g.nums));
    else if (agg === "avg") r[measureKey] = g.nums.length ? g.nums.reduce((a, b) => a + b, 0) / g.nums.length : null;
    else if (agg === "max") r[measureKey] = g.nums.length ? Math.max(...g.nums) : null;
    else if (agg === "min") r[measureKey] = g.nums.length ? Math.min(...g.nums) : null;
    return r;
  });

  if (plano.expected_result?.shape === "distinct_list" || agg === "none") {
    rows = rows.map((r) => ({ [dimKey]: r[dimKey] }));
  } else if (plano.intent === "rank") {
    rows.sort((a, b) => (numeroParaAnalise(b?.[measureKey]) ?? -Infinity) - (numeroParaAnalise(a?.[measureKey]) ?? -Infinity));
  } else {
    rows.sort((a, b) => String(a?.[dimKey] || "").localeCompare(String(b?.[dimKey] || ""), "pt-BR", { sensitivity: "base" }));
  }

  const total = evidenceRows.length;
  const note = `${rows.length} valores de ${dimensao.concept} foram consolidados a partir de evidencias textuais de ${mapeados} de ${total} registros; ${semEvidencia} registro(s) sem evidencia suficiente foram omitidos da classificacao, sem inventar valores.`;
  return { rows: rows.slice(0, MAX_RESULTADOS), note, stats: { total, mapeados, semEvidencia, grupos: rows.length } };
}

async function normalizarResultadoSemanticoSeNecessario({ pergunta, plano, rows, avaliacao, sqlOriginal, ctx }) {
  const shape = plano.expected_result?.shape || "";
  const dimensao = dimensaoPrincipalDoPlano(plano);
  if (!Array.isArray(rows) || !rows.length || !dimensao) return { rows, changed: false, note: "", stats: null };

  const shapesAgrupaveis = new Set(["distinct_list", "grouped", "ranking"]);
  const precisa = plano.result_normalization?.needed === true || avaliacao?.normalization_needed === true || shapesAgrupaveis.has(shape);
  if (!precisa) return { rows, changed: false, note: "", stats: null };

  const medida = medidaPrincipalDoPlano(plano);
  let evidenceRows = [];

  try {
    if (shape === "distinct_list") {
      const dimKey = chaveDimensaoResultado(rows, dimensao);
      evidenceRows = rows.map((r, i) => ({ __row_id: String(i + 1), __dim_raw: r?.[dimKey] }));
    } else {
      const evid = await gerarSQLDeEvidenciasSemanticas({ pergunta, plano, sqlOriginal, ctx, dimensao, medida });
      if (!evid?.query) throw new Error("SQL de evidencias nao gerada");
      const valid = validarSQL(evid.query, ctx);
      if (!valid.ok) throw new Error(`SQL de evidencias rejeitada: ${valid.motivo}`);
      const sqlEvidencia = `SELECT * FROM (${valid.sql}) AS __evidence_scope LIMIT ${MAX_EVIDENCE_ROWS}`;
      const rr = await queryReadOnly(sqlEvidencia);
      evidenceRows = rr.rows || [];
      if (evidenceRows.length >= MAX_EVIDENCE_ROWS) {
        throw new Error(`O recorte de evidencias atingiu o limite seguro de ${MAX_EVIDENCE_ROWS} linhas; a normalizacao foi interrompida para nao produzir contagem parcial.`);
      }
    }

    if (!evidenceRows.length) {
      return { rows: [], changed: true, note: `Nao houve registros em nivel de evidencia para validar ${dimensao.concept}; nenhum valor foi inventado.`, stats: { total: 0, mapeados: 0, semEvidencia: 0, grupos: 0 } };
    }

    const mapeamento = await mapearValoresPorEvidencia({ pergunta, plano, dimensao, evidenceRows });
    const validacao = validarMapeamentosPorEvidencia(evidenceRows, mapeamento.mappings);
    const regroup = reagruparPorEvidencias({ plano, originalRows: rows, evidenceRows, validacao, dimensao, medida });
    const note = [regroup.note, mapeamento.note].filter(Boolean).join(" ");
    return { rows: regroup.rows, changed: true, note, stats: regroup.stats };
  } catch (e) {
    console.warn("SQL AGENT - normalizacao por evidencias falhou; resultado bruto NAO sera reclassificado:", e?.message || e);
    // Em caso de falha de normalizacao, nao deixamos a IA inventar uma limpeza.
    // Mantemos o resultado bruto e deixamos a nota explicita de qualidade.
    return {
      rows,
      changed: false,
      note: `Os dados de ${dimensao.concept} nao puderam ser normalizados com evidencias suficientes; exibindo apenas o resultado bruto do banco, sem reinterpretar valores.`,
      stats: null,
    };
  }
}

// ------------------------------------------------------------
// Validacao tecnica da SQL
// Regex daqui em diante sao exclusivamente de seguranca/parsing tecnico,
// nunca para decidir significado de pergunta ou regra de negocio.
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
    `ANCORA DO CONTEXTO ATUAL:\n${resumoHistorico(historico)}\n\n` +
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
  // V15: nenhuma reescrita semantica por regex/regra de frase.
  // A semantica e decidida pelo resolvedor + planejador + avaliador IA.
  // Aqui ficam somente limpeza/parsing da SQL; a seguranca READ ONLY continua
  // sendo garantida por validarSQL/queryReadOnly.
  return limparSQL(sql);
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
  if (!forcarSemantica && !planoSemantico) {
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
    `NOTA DE NORMALIZACAO/QUALIDADE: ${textoSeguro(analiseDados?.nota_normalizacao || "", 1000)}\n` +
    `Se essa nota informar registros omitidos por falta de evidencia, mencione isso de forma curta e NAO apresente os omitidos como categorias validas. As contagens em DADOS RETORNADOS ja foram recalculadas pelo Node e sao autoritativas.\n\n` +
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
// Fluxo principal V16 semantico
// ------------------------------------------------------------
export async function responderPergunta(pergunta, historico = []) {
  const texto = textoSeguro(pergunta, 1600);
  if (!texto) return { resposta: "Pode enviar sua pergunta sobre as obras?", erro: "pergunta_vazia" };

  const social = respostaSocial(texto, historico);
  if (social) return { resposta: social, social: true, modoAgente: "social" };

  try {
    const ctx = await carregarSchemaContexto();

    // V16: primeiro resolve a conversa inteira para UMA pergunta autonoma.
    // Depois disso, o planejador/gerador nao recebe o historico cru, evitando
    // que filtros antigos contaminem o turno atual ou que um follow-up perca o
    // recorte ativo.
    const resolucao = await resolverPerguntaConversacional(texto, historico, ctx);
    const perguntaResolvida = resolucao.pergunta_autonoma || texto;
    console.log("SQL AGENT - PERGUNTA AUTONOMA:", perguntaResolvida);
    console.log("SQL AGENT - CONTEXTO RESOLVIDO:", jsonSeguro(resolucao.scope || {}, 3000));

    // DIN-SQL: entende a pergunta autonoma e faz schema linking; so depois gera SQL.
    let plano = await planejarConsultaSemantica(perguntaResolvida, [], ctx, resolucao.scope || {});
    plano = await revisarPlanoComContexto({ pergunta: perguntaResolvida, plano, resolucao, ctx });
    console.log("SQL AGENT - PLANO SEMANTICO:", jsonSeguro(plano, 5000));

    if (plano.clarification?.needed && plano.clarification?.question) {
      return {
        resposta: plano.clarification.question,
        erro: null,
        modoAgente: "sql_agent_semantic_v16_clarification",
        plano: {
          intent: plano.intent,
          universes: plano.universes,
          confidence: plano.confidence,
        },
      };
    }

    // DAIL-SQL + CHASE-SQL lite: exemplos relevantes, um ou dois caminhos e
    // selecao pelo quanto a consulta/resultado realmente responde ao plano.
    const pipeline = await executarPipelineSemantico({ pergunta: perguntaResolvida, historico: [], ctx, plano });
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
      pergunta: perguntaResolvida,
      plano,
      rows: execucao.rows,
      avaliacao: escolhido.semantica,
      sqlOriginal: execucao.sql,
      ctx,
    });

    const rowsResposta = normalizado.rows;
    const analiseDados = await analisarResultadoLocal(rowsResposta);
    analiseDados.plano_semantico = {
      intent: plano.intent,
      universes: plano.universes,
      expected_result: plano.expected_result,
      confidence: plano.confidence,
    };
    analiseDados.contexto_conversacional = {
      pergunta_autonoma: perguntaResolvida,
      is_followup: resolucao.is_followup === true,
      scope: resolucao.scope || {},
      confidence: resolucao.confidence || 0,
    };
    analiseDados.avaliacao_semantica = {
      score: escolhido.score,
      verdict: escolhido.semantica?.verdict || "local",
      reason: escolhido.semantica?.reason || "",
    };
    analiseDados.nota_normalizacao = normalizado.note || "";
    analiseDados.estatisticas_normalizacao = normalizado.stats || null;
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
        context_scope: resolucao.scope || {},
        standalone_question: perguntaResolvida,
        semantic_scope: {
          universes: plano.universes || [],
          subject_terms: plano.subject_terms || [],
          filters: plano.filters || [],
          entities: (plano.entities || []).map((e) => ({ concept: e?.concept, source: e?.source, role: e?.role })),
          measures: (plano.measures || []).map((m) => ({ concept: m?.concept, source: m?.source, aggregation: m?.aggregation })),
          expected_result: plano.expected_result || {},
        },
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
      modoAgente: "sql_agent_semantic_v16_evidence_grounding",
    };
  } catch (e) {
    console.error("SQL AGENT: falha final:", e);
    return {
      resposta: "Tive um problema ao consultar os dados agora. Tente novamente em instantes.",
      erro: e.message,
      modoAgente: "sql_agent_semantic_v16_erro",
    };
  }
}
