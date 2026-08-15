// ============================================================
//  testar-ingestao.js
//  Roda a ingestao UMA vez, pra testar. Le a planilha, limpa,
//  e popula o Supabase. Mostra quantas obras entraram.
//
//  COMO USAR (na raiz do projeto):
//    node testar-ingestao.js
//
//  Precisa das variaveis no .env:
//    GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_JSON (ou credenciais),
//    DATABASE_URL (a connection string do Supabase).
// ============================================================

import "dotenv/config";
import { sincronizar } from "./src/ingestao.js";
import { query, pool } from "./src/db.js";

async function main() {
  try {
    console.log("=== TESTE DE INGESTAO ===\n");

    // 1) Testa a conexao com o banco.
    console.log("1. Testando conexao com o Supabase...");
    await query("SELECT 1;");
    console.log("   OK, conectado!\n");

    // 2) Roda a ingestao.
    console.log("2. Rodando a ingestao (planilha -> banco)...");
    const r = await sincronizar();
    console.log(`   OK! ${r.inseridas} obras inseridas.\n`);

    // 3) Confere: conta quantas obras tem no banco agora.
    console.log("3. Conferindo o banco...");
    const total = await query("SELECT COUNT(*) FROM obras;");
    console.log(`   Total de obras no banco: ${total.rows[0].count}`);

    const porStatus = await query(
      "SELECT status, COUNT(*) as n FROM obras GROUP BY status ORDER BY n DESC;"
    );
    console.log("\n   Por status:");
    porStatus.rows.forEach((row) => {
      console.log(`     ${row.n}x  ${row.status}`);
    });

    console.log("\n=== SUCESSO! Os dados estao no Supabase. ===");
  } catch (e) {
    console.error("\n=== ERRO ===");
    console.error(e.message);
    console.error("\nVerifique: DATABASE_URL no .env, senha correta, e se a tabela 'obras' existe.");
  } finally {
    await pool.end();
  }
}

main();
