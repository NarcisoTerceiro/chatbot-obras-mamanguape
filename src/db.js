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

export { pool };
