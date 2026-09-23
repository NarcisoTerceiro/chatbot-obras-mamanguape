// ============================================================
//  db.js
//  Conexao com o Supabase (PostgreSQL) usando a biblioteca 'pg'.
//  Sao usadas duas credenciais separadas:
//  - DATABASE_URL: usuario somente leitura, usado pelo chatbot.
//  - DATABASE_ADMIN_URL: usuario de escrita, usado apenas na sincronizacao.
// ============================================================

import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;

// Conexao com o Supabase.
// O Transaction pooler (porta 6543) as vezes recusa quando o SSL e forcado
// pelo cliente. A forma mais compativel e NAO forcar ssl aqui e deixar o
// modo ser definido pela propria connection string (adicionamos ?sslmode
// mais abaixo, se nao vier). rejectUnauthorized:false evita erro de
// certificado auto-assinado do pooler.
function montarConfig(urlOriginal) {
  let url = urlOriginal || "";

  // Se a URL nao traz sslmode, adiciona um que o pooler aceita.
  if (url && !/sslmode=/.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "sslmode=no-verify";
  }

  return {
    connectionString: url,
    // aceita o certificado do pooler sem exigir CA
    ssl: { rejectUnauthorized: false },
    // --- Ajustes de desempenho/estabilidade (importantes no plano gratuito) ---
    // max: o Supabase gratuito tem POUCAS conexoes. Um pool pequeno evita
    // estourar o limite e ficar esperando na fila (o que parece "SQL lento").
    max: 5,
    // Fecha conexoes ociosas rapido, liberando slots do Supabase.
    idleTimeoutMillis: 10000,
    // Se a conexao nao estabelece em 10s, falha rapido em vez de pendurar.
    connectionTimeoutMillis: 10000,
    // Se uma query travar por mais de 15s, aborta (evita ficar pendurado).
    statement_timeout: 15000,
  };
}

const pool = new Pool(montarConfig(process.env.DATABASE_URL));
const adminPool = process.env.DATABASE_ADMIN_URL
  ? new Pool(montarConfig(process.env.DATABASE_ADMIN_URL))
  : null;

// Memoria conversacional persistente (opcional).
// Se DATABASE_MEMORY_URL nao existir, reaproveita DATABASE_ADMIN_URL.
// O chatbot continua consultando obras somente pela DATABASE_URL read-only.
const memoryPool = process.env.DATABASE_MEMORY_URL
  ? new Pool(montarConfig(process.env.DATABASE_MEMORY_URL))
  : adminPool;

// Executa uma query. Uso interno.
export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Executa varias operacoes na MESMA conexao e na MESMA transacao.
// E indispensavel para a sincronizacao: se qualquer lote falhar depois do
// TRUNCATE, o rollback restaura automaticamente a versao anterior da tabela.
export async function withTransaction(executar, { readOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    const resultado = await executar(client);
    await client.query("COMMIT");
    return resultado;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErro) {
      console.error("Falha ao executar rollback:", rollbackErro.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Escrita administrativa exclusiva da ingestao. Nao existe fallback para a
// credencial do chatbot: se DATABASE_ADMIN_URL faltar, a sincronizacao falha
// fechada em vez de ampliar silenciosamente as permissoes do agente.
export async function withAdminTransaction(executar) {
  if (!adminPool) {
    throw new Error("DATABASE_ADMIN_URL nao configurada para a sincronizacao");
  }
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await executar(client);
    await client.query("COMMIT");
    return resultado;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErro) {
      console.error("Falha ao executar rollback administrativo:", rollbackErro.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Consultas produzidas pelo agente sempre rodam numa transacao explicitamente
// somente-leitura. A credencial DATABASE_URL tambem deve ser read-only no
// Supabase; esta camada funciona como uma segunda barreira.
export async function queryReadOnly(sql, params = []) {
  return withTransaction((client) => client.query(sql, params), { readOnly: true });
}


// ============================================================
//  CONHECIMENTO PERMANENTE DO AGENTE
// ============================================================
// A tabela agent_knowledge NAO guarda respostas prontas. Ela guarda exemplos
// de interpretacao/SQL e regras do negocio. Somente itens APPROVED sao usados
// para orientar a IA. Consultas novas entram como CANDIDATE e nunca viram
// conhecimento aprovado automaticamente.

let cacheConhecimentoAgente = { quando: 0, linhas: [] };
const CACHE_CONHECIMENTO_MS = 60 * 1000;

function tabelaConhecimentoAusente(e) {
  return e?.code === "42P01" || /agent_knowledge.*does not exist/i.test(e?.message || "");
}

export async function buscarConhecimentoAprovado({ limite = 200, ignorarCache = false } = {}) {
  const agora = Date.now();
  if (!ignorarCache && cacheConhecimentoAgente.linhas.length && agora - cacheConhecimentoAgente.quando < CACHE_CONHECIMENTO_MS) {
    return cacheConhecimentoAgente.linhas.slice(0, limite);
  }

  const max = Math.max(1, Math.min(Number(limite) || 200, 500));
  try {
    let r;
    try {
      r = await queryReadOnly(
        `SELECT id, pergunta_exemplo, intencao, escopo, regra_negocio, sql_exemplo,
                campos_envolvidos, tags, origem, vezes_utilizado,
                padrao_chave, padrao, sucessos
           FROM public.agent_knowledge
          WHERE status_aprovacao = 'approved'
          ORDER BY vezes_utilizado DESC, sucessos DESC, id ASC
          LIMIT $1`,
        [max]
      );
    } catch (e) {
      if (e?.code !== "42703") throw e;
      r = await queryReadOnly(
        `SELECT id, pergunta_exemplo, intencao, escopo, regra_negocio, sql_exemplo,
                campos_envolvidos, tags, origem, vezes_utilizado
           FROM public.agent_knowledge
          WHERE status_aprovacao = 'approved'
          ORDER BY vezes_utilizado DESC, id ASC
          LIMIT $1`,
        [max]
      );
    }
    cacheConhecimentoAgente = { quando: agora, linhas: r.rows || [] };
    return cacheConhecimentoAgente.linhas;
  } catch (e) {
    if (tabelaConhecimentoAusente(e)) return [];
    console.warn("DB: falha ao ler agent_knowledge:", e.message);
    return [];
  }
}

function fingerprintConhecimento({ pergunta_exemplo = "", sql_exemplo = "", escopo = "", padrao_chave = "" } = {}) {
  const base = padrao_chave
    ? `padrao|${String(padrao_chave).trim().toLowerCase()}`
    : `${String(pergunta_exemplo).trim().toLowerCase()}|${String(escopo).trim().toLowerCase()}|${String(sql_exemplo).replace(/\s+/g, " ").trim().toLowerCase()}`;
  return createHash("sha256").update(base).digest("hex");
}

export async function registrarConhecimentoCandidato({
  pergunta_exemplo,
  intencao = {},
  escopo = "indefinido",
  regra_negocio = "Padrao de consulta candidato; aguarda aprovacao humana.",
  sql_exemplo = null,
  campos_envolvidos = [],
  tags = "",
  origem = "agente_padrao",
  padrao_chave = null,
  padrao = {},
} = {}) {
  if (!adminPool || !pergunta_exemplo || !sql_exemplo || !padrao_chave) {
    return { ok: false, motivo: "admin_ou_padrao_indisponivel" };
  }

  const fingerprint = fingerprintConhecimento({ pergunta_exemplo, sql_exemplo, escopo, padrao_chave });
  try {
    const r = await adminPool.query(
      `INSERT INTO public.agent_knowledge
        (pergunta_exemplo, intencao, escopo, regra_negocio, sql_exemplo,
         campos_envolvidos, tags, status_aprovacao, origem, fingerprint,
         padrao_chave, padrao, sucessos, ultima_execucao)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6::text[], $7, 'candidate', $8, $9,
               $10, $11::jsonb, 1, now())
       ON CONFLICT (padrao_chave) DO UPDATE SET
         updated_at = now(),
         ultima_execucao = now(),
         sucessos = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'rejected' THEN public.agent_knowledge.sucessos
           ELSE public.agent_knowledge.sucessos + 1
         END,
         intencao = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'candidate' THEN EXCLUDED.intencao
           ELSE public.agent_knowledge.intencao
         END,
         padrao = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'candidate' THEN EXCLUDED.padrao
           ELSE public.agent_knowledge.padrao
         END,
         sql_exemplo = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'candidate' THEN EXCLUDED.sql_exemplo
           ELSE public.agent_knowledge.sql_exemplo
         END,
         campos_envolvidos = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'candidate' THEN EXCLUDED.campos_envolvidos
           ELSE public.agent_knowledge.campos_envolvidos
         END,
         tags = CASE
           WHEN public.agent_knowledge.status_aprovacao = 'candidate' THEN EXCLUDED.tags
           ELSE public.agent_knowledge.tags
         END
       RETURNING id, status_aprovacao, sucessos, padrao_chave`,
      [
        String(pergunta_exemplo).slice(0, 1000),
        JSON.stringify(intencao && typeof intencao === "object" ? intencao : {}),
        String(escopo || "indefinido").slice(0, 80),
        String(regra_negocio || "").slice(0, 2000),
        String(sql_exemplo).slice(0, 8000),
        Array.isArray(campos_envolvidos) ? campos_envolvidos.map(String).slice(0, 30) : [],
        String(tags || "").slice(0, 1000),
        String(origem || "agente_padrao").slice(0, 80),
        fingerprint,
        String(padrao_chave).slice(0, 500),
        JSON.stringify(padrao && typeof padrao === "object" ? padrao : {}),
      ]
    );
    return { ok: true, ...(r.rows?.[0] || {}) };
  } catch (e) {
    if (tabelaConhecimentoAusente(e)) return { ok: false, motivo: "tabela_ausente" };
    if (e?.code === "42703") {
      console.warn("DB: estrutura de padroes ainda nao criada. Rode supabase_agent_knowledge_padrao.sql antes de aprender novos padroes.");
      return { ok: false, motivo: "migracao_padrao_pendente" };
    }
    console.warn("DB: falha ao registrar conhecimento candidato:", e.message);
    return { ok: false, motivo: e.message };
  }
}

export async function registrarUsoConhecimento(ids = []) {
  if (!adminPool || !Array.isArray(ids) || !ids.length) return;
  const unicos = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 20);
  if (!unicos.length) return;
  try {
    await adminPool.query(
      `UPDATE public.agent_knowledge
          SET vezes_utilizado = vezes_utilizado + 1,
              updated_at = now()
        WHERE status_aprovacao = 'approved' AND id = ANY($1::bigint[])`,
      [unicos]
    );
  } catch (e) {
    if (!tabelaConhecimentoAusente(e)) {
      console.warn("DB: falha ao registrar uso de conhecimento:", e.message);
    }
  }
}


// ============================================================
//  MEMORIA CONVERSACIONAL PERSISTENTE DO SQL AGENT
// ============================================================
// A tabela e criada pelo arquivo 01_criar_chat_history.sql.
// Falha fechada/graciosa: se a tabela/credencial nao existir, o server usa
// apenas a memoria local em RAM e o chatbot continua funcionando.

function tabelaHistoricoAusente(e) {
  return e?.code === "42P01" || /chat_history.*does not exist/i.test(e?.message || "");
}

export async function carregarHistoricoAgente(sessionId, limite = 20) {
  if (!memoryPool || !sessionId) return [];
  const max = Math.max(1, Math.min(Number(limite) || 20, 50));
  try {
    const sid = String(sessionId).slice(0, 128);
    const [r, resumo] = await Promise.all([
      memoryPool.query(
        `SELECT role, content, sql, linhas, estado
           FROM public.chat_history
          WHERE session_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [sid, max]
      ),
      carregarResumoAgente(sid),
    ]);
    const recentes = (r.rows || []).reverse().map((x) => ({
      role: x.role === "assistant" ? "assistant" : "user",
      content: String(x.content || ""),
      sql: x.sql || null,
      linhas: x.linhas ?? null,
      estado: x.estado && typeof x.estado === "object" ? x.estado : null,
    }));
    return resumo ? [resumo, ...recentes] : recentes;
  } catch (e) {
    if (!tabelaHistoricoAusente(e)) console.warn("DB: falha ao carregar chat_history:", e.message);
    return [];
  }
}

export async function salvarHistoricoAgente(sessionId, mensagens = []) {
  if (!memoryPool || !sessionId || !Array.isArray(mensagens) || !mensagens.length) return false;
  const sid = String(sessionId).slice(0, 128);
  const client = await memoryPool.connect();
  try {
    await client.query("BEGIN");
    for (const m of mensagens.slice(-6)) {
      if (!m?.content) continue;
      await client.query(
        `INSERT INTO public.chat_history (session_id, role, content, sql, linhas, estado)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          sid,
          m.role === "assistant" ? "assistant" : "user",
          String(m.content).slice(0, 12000),
          m.sql ? String(m.sql).slice(0, 12000) : null,
          Number.isFinite(Number(m.linhas)) ? Number(m.linhas) : null,
          JSON.stringify(m.estado && typeof m.estado === "object" ? m.estado : {}),
        ]
      );
    }
    await client.query("COMMIT");
    // Limpeza global limitada a no maximo uma execucao a cada 6 horas.
    void limparMemoriaPersistenteAntiga().catch(() => {});
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    if (!tabelaHistoricoAusente(e)) console.warn("DB: falha ao salvar chat_history:", e.message);
    return false;
  } finally {
    client.release();
  }
}


// ============================================================
//  RETENCAO E COMPACTACAO DA MEMORIA PERSISTENTE
// ============================================================
// Objetivo:
// - manter no maximo cerca de 20 a 30 mensagens recentes por sessao;
// - guardar um resumo curto do historico antigo em chat_memory_summary;
// - apagar historico e resumos sem atividade ha mais de 30 dias;
// - nunca armazenar o telefone bruto: session_id ja chega como hash do server.

const MEMORIA_MANTER_RECENTES = Math.max(10, Math.min(Number(process.env.MEMORIA_MANTER_RECENTES || 20), 50));
const MEMORIA_GATILHO_COMPACTACAO = Math.max(
  MEMORIA_MANTER_RECENTES + 2,
  Math.min(Number(process.env.MEMORIA_GATILHO_COMPACTACAO || 30), 80)
);
const MEMORIA_RETENCAO_DIAS = Math.max(1, Math.min(Number(process.env.MEMORIA_RETENCAO_DIAS || 30), 365));
let ultimaLimpezaMemoria = 0;
const LIMPEZA_MEMORIA_INTERVALO_MS = 6 * 60 * 60 * 1000;

export async function carregarResumoAgente(sessionId) {
  if (!memoryPool || !sessionId) return null;
  try {
    const r = await memoryPool.query(
      `SELECT resumo, estado, updated_at
         FROM public.chat_memory_summary
        WHERE session_id = $1
        LIMIT 1`,
      [String(sessionId).slice(0, 128)]
    );
    const x = r.rows?.[0];
    if (!x?.resumo) return null;
    return {
      role: "assistant",
      content: `[RESUMO DA CONVERSA ANTERIOR] ${String(x.resumo)}`,
      estado: x.estado && typeof x.estado === "object" ? x.estado : {},
      memoriaResumo: true,
    };
  } catch (e) {
    if (!tabelaHistoricoAusente(e) && e?.code !== "42P01") {
      console.warn("DB: falha ao carregar chat_memory_summary:", e.message);
    }
    return null;
  }
}

export async function prepararCompactacaoHistoricoAgente(
  sessionId,
  { manter = MEMORIA_MANTER_RECENTES, gatilho = MEMORIA_GATILHO_COMPACTACAO } = {}
) {
  if (!memoryPool || !sessionId) return { necessario: false, mensagens: [], resumoAnterior: null };
  const sid = String(sessionId).slice(0, 128);
  const keep = Math.max(2, Math.min(Number(manter) || MEMORIA_MANTER_RECENTES, 50));
  const trigger = Math.max(keep + 2, Math.min(Number(gatilho) || MEMORIA_GATILHO_COMPACTACAO, 80));
  try {
    const contagem = await memoryPool.query(
      `SELECT COUNT(*)::int AS total FROM public.chat_history WHERE session_id = $1`,
      [sid]
    );
    const total = Number(contagem.rows?.[0]?.total || 0);
    if (total <= trigger) return { necessario: false, total, mensagens: [], resumoAnterior: await carregarResumoAgente(sid) };

    const excesso = Math.max(1, total - keep);
    const antigos = await memoryPool.query(
      `SELECT id, role, content, sql, linhas, estado, created_at
         FROM public.chat_history
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [sid, excesso]
    );
    return {
      necessario: antigos.rows.length > 0,
      total,
      manter: keep,
      mensagens: antigos.rows || [],
      resumoAnterior: await carregarResumoAgente(sid),
    };
  } catch (e) {
    if (!tabelaHistoricoAusente(e)) console.warn("DB: falha ao preparar compactacao de memoria:", e.message);
    return { necessario: false, mensagens: [], resumoAnterior: null };
  }
}

export async function concluirCompactacaoHistoricoAgente(sessionId, { ids = [], resumo = "", estado = {} } = {}) {
  if (!memoryPool || !sessionId || !Array.isArray(ids) || !ids.length) return false;
  const sid = String(sessionId).slice(0, 128);
  const unicos = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unicos.length) return false;
  const client = await memoryPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.chat_memory_summary (session_id, resumo, estado, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         resumo = EXCLUDED.resumo,
         estado = EXCLUDED.estado,
         updated_at = NOW()`,
      [sid, String(resumo || "").slice(0, 6000), JSON.stringify(estado && typeof estado === "object" ? estado : {})]
    );
    await client.query(
      `DELETE FROM public.chat_history WHERE session_id = $1 AND id = ANY($2::bigint[])`,
      [sid, unicos]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    if (!tabelaHistoricoAusente(e) && e?.code !== "42P01") {
      console.warn("DB: falha ao concluir compactacao de memoria:", e.message);
    }
    return false;
  } finally {
    client.release();
  }
}

export async function limparMemoriaPersistenteAntiga({ dias = MEMORIA_RETENCAO_DIAS, forcar = false } = {}) {
  if (!memoryPool) return false;
  const agora = Date.now();
  if (!forcar && agora - ultimaLimpezaMemoria < LIMPEZA_MEMORIA_INTERVALO_MS) return true;
  ultimaLimpezaMemoria = agora;
  const d = Math.max(1, Math.min(Number(dias) || MEMORIA_RETENCAO_DIAS, 365));
  try {
    await memoryPool.query(
      `DELETE FROM public.chat_history
        WHERE created_at < NOW() - make_interval(days => $1::int)`,
      [d]
    );
    await memoryPool.query(
      `DELETE FROM public.chat_memory_summary
        WHERE updated_at < NOW() - make_interval(days => $1::int)`,
      [d]
    );
    return true;
  } catch (e) {
    if (!tabelaHistoricoAusente(e) && e?.code !== "42P01") {
      console.warn("DB: falha na limpeza automatica da memoria:", e.message);
    }
    return false;
  }
}

export { pool };
