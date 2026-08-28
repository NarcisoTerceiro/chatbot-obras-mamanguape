// ============================================================
//  db.js
//  Conexao com o Supabase (PostgreSQL) usando a biblioteca 'pg'.
//  Sao usadas duas credenciais separadas:
//  - DATABASE_URL: usuario somente leitura, usado pelo chatbot.
//  - DATABASE_ADMIN_URL: usuario de escrita, usado apenas na sincronizacao.
// ============================================================

import pg from "pg";

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

export { pool };
