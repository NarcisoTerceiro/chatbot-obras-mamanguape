// ============================================================
//  ingestao.js
//  Le a planilha (via sheets.js / conta de servico), LIMPA e
//  padroniza os dados, e popula a tabela "obras" no Supabase.
//
//  FLEXIVEL: acha as colunas pelo NOME (nao pela posicao), entao
//  aguenta a planilha mudar de estrutura ou ganhar abas novas.
//
//  Estrategia de atualizacao: substitui tudo (TRUNCATE + INSERT).
//  Assim o banco fica sempre IGUAL a planilha - simples e seguro.
// ============================================================

import { getObras } from "./sheets.js";
import { query } from "./db.js";

// --- utilidades de limpeza ---
function norm(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

// Cada campo do banco -> nomes possiveis na planilha (sinonimos).
// Para suportar uma planilha nova, e so acrescentar nomes aqui.
const MAPA = {
  objeto: ["objeto da obra", "objeto", "obra", "rua", "descricao", "nome da obra"],
  bairro: ["bairro", "localizacao", "local", "distrito"],
  status: ["status", "situacao", "situacao atual", "fase"],
  valor_total: ["valor total da obra", "valor (r$)", "valor", "valor da obra", "valor contratado"],
  valor_executado: ["valor executado", "valor pago", "executado"],
  percentual_executado: ["% executada", "% executado", "percentual executado", "percentual"],
  engenheiro: ["engenheiro", "engenheiro responsavel", "engenheiro/arquiteto responsavel",
               "engenheiro/arquiteto", "responsavel tecnico", "responsavel"],
  empresa: ["empresa", "empresa responsavel", "construtora", "contratada"],
};

// Dado um objeto-obra (com chaves = nomes de coluna da planilha),
// acha o valor de um campo do banco procurando pelos sinonimos.
function pegar(obra, campo) {
  const chaves = Object.keys(obra);
  for (const sin of MAPA[campo]) {
    const achou = chaves.find((k) => norm(k) === sin);
    if (achou && obra[achou]) return obra[achou];
  }
  return null;
}

function padronizarStatus(txt) {
  const s = norm(txt);
  if (!s) return "";
  // ORDEM IMPORTA. Casos especificos primeiro, para evitar que uma palavra
  // solta ("concluido" numa observacao) classifique errado.
  // "Em elaboracao" / "em projeto" tem prioridade - sao status de projeto,
  // nao de obra concluida, mesmo que o texto tenha "conclu" em outra parte.
  if (s.includes("elabora") || s.includes("em projeto") || s.includes("estudo")) return "Em projeto";
  if (s.includes("andamento") || s.includes("em obra") || s.includes("execu")) return "Em andamento";
  if (s.includes("licita") || s.includes("edital") || s.includes("propost") || s.includes("habilita")) return "Em licitação";
  if (s.includes("parad") || s.includes("paralis") || s.includes("suspens")) return "Paralisada";
  if (s.includes("homolog")) return "Homologada";
  if (s.includes("iniciar")) return "A iniciar";
  // Concluida por ultimo: so classifica assim se o status for claramente isso
  // (comeca com "conclu"/"finaliz" ou e exatamente a palavra), nao se "conclu"
  // aparecer perdido no meio de uma frase.
  if (s.startsWith("conclu") || s.startsWith("finaliz") ||
      s === "concluida" || s === "concluido" || s === "finalizado" ||
      s === "concluída" || s === "concluído") {
    return "Concluída";
  }
  return (txt || "").toString().trim();
}

function parseValor(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  let s = v.toString().replace(/r\$/i, "").replace(/\s/g, "").trim();
  if (!s || s === "-") return null;
  s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function categoriaDaAba(aba) {
  const n = norm(aba);
  if (n.includes("andamento")) return "Em andamento";
  if (n.includes("licita")) return "Em licitação";
  if (n.includes("projeto")) return "Em projeto";
  if (n.includes("paviment")) return "Pavimentação";
  if (n.includes("pendenc")) return "Pendência";
  return (aba || "").toString().trim();
}

// Tenta extrair o bairro do NOME da obra quando a coluna bairro esta vazia.
// Muitas obras vem como "Rua do Cruzeiro - Centro" ou "Avenida X - Bela Vista",
// onde o bairro esta depois do traco. Sem isso, buscas por bairro perdem
// essas obras (elas nao tem a coluna bairro preenchida).
function bairroDoNome(nome) {
  if (!nome) return null;
  const partes = nome.toString().split(/\s+[-\u2013\u2014]\s+/); // separa por " - "
  if (partes.length >= 2) {
    const ultima = partes[partes.length - 1].trim();
    // so aceita se parecer um bairro (curto, sem numeros de contrato etc.)
    if (ultima.length >= 3 && ultima.length <= 40 && !/^\d+$/.test(ultima)) {
      return ultima;
    }
  }
  return null;
}

// Transforma uma obra crua (da planilha) numa linha limpa pro banco.
function limpar(obra) {
  const objeto = pegar(obra, "objeto");
  if (!objeto) return null; // sem nome, ignora
  const categoria = categoriaDaAba(obra._aba);
  // bairro: primeiro tenta a coluna; se vazia, tenta extrair do nome.
  let bairro = (pegar(obra, "bairro") || "").toString().trim();
  if (!bairro) {
    bairro = bairroDoNome(objeto) || "";
  }
  return {
    objeto: objeto.toString().trim(),
    bairro: bairro || null,
    status: padronizarStatus(pegar(obra, "status")) || categoria,
    categoria,
    valor_total: parseValor(pegar(obra, "valor_total")),
    valor_executado: parseValor(pegar(obra, "valor_executado")),
    percentual_executado: parseValor(pegar(obra, "percentual_executado")),
    engenheiro: (pegar(obra, "engenheiro") || "").toString().trim() || null,
    empresa: (pegar(obra, "empresa") || "").toString().trim() || null,
    aba_origem: obra._aba || null,
  };
}

// Roda a ingestao completa: le planilha -> limpa -> substitui no banco.
export async function sincronizar() {
  console.log("INGESTAO: lendo planilha...");
  const cruas = await getObras();
  const limpas = cruas.map(limpar).filter(Boolean);
  console.log(`INGESTAO: ${cruas.length} linhas lidas, ${limpas.length} obras limpas.`);

  if (limpas.length === 0) {
    console.log("INGESTAO: nenhuma obra para inserir. Abortando (nao apaga o banco).");
    return { inseridas: 0 };
  }

  // Substitui tudo: limpa a tabela e insere as novas.
  await query("TRUNCATE TABLE obras RESTART IDENTITY;");

  // Insere em lote.
  const campos = ["objeto","bairro","status","categoria","valor_total",
    "valor_executado","percentual_executado","engenheiro","empresa","aba_origem"];
  let inseridas = 0;
  for (const o of limpas) {
    const valores = campos.map((c) => o[c]);
    const marcadores = campos.map((_, i) => `$${i + 1}`).join(",");
    await query(
      `INSERT INTO obras (${campos.join(",")}) VALUES (${marcadores})`,
      valores
    );
    inseridas++;
  }

  console.log(`INGESTAO: ${inseridas} obras inseridas no banco.`);
  return { inseridas };
}
