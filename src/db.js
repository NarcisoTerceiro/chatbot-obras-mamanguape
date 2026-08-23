// ============================================================
//  db.js
//  Conexao com o Supabase (PostgreSQL) usando a biblioteca 'pg'.
//  A string de conexao vem da variavel de ambiente DATABASE_URL
//  (voce pega no Supabase: Settings > Database > Connection string).
// ============================================================

import pg from "pg";

const { Pool } = pg;

// Conexao com o Supabase.
// O Transaction pooler (porta 6543) as vezes recusa quando o SSL e forcado
// pelo cliente. A forma mais compativel e NAO forcar ssl aqui e deixar o
// modo ser definido pela propria connection string (adicionamos ?sslmode
// mais abaixo, se nao vier). rejectUnauthorized:false evita erro de
// certificado auto-assinado do pooler.
function montarConfig() {
  let url = process.env.DATABASE_URL || "";

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

const pool = new Pool(montarConfig());

// Executa uma query. Uso interno.
export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

export { pool };
