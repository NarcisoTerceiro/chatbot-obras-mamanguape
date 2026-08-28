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

import { getObras, limparCache } from "./sheets.js";
import { withAdminTransaction } from "./db.js";

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

// Junta todos os nomes de coluna ja usados pelos campos fixos (com sinonimos),
// pra saber quais colunas da planilha JA foram aproveitadas. O resto vira extra.
const NOMES_FIXOS_USADOS = new Set();
for (const campo of Object.keys(MAPA)) {
  for (const sin of MAPA[campo]) NOMES_FIXOS_USADOS.add(sin);
}

// Coleta TODAS as outras colunas da planilha (as que nao viraram campo fixo)
// num objeto "dados_extras". Assim NADA se perde: recurso, convenio, contrato,
// aditivos, prazo, datas - tudo que a planilha tiver e nao for campo fixo entra
// aqui, com o nome original da coluna. Se a planilha ganhar coluna nova amanha,
// ela entra sozinha, sem mexer no codigo.
function coletarExtras(obra) {
  const extras = {};
  for (const chave of Object.keys(obra)) {
    if (chave === "_aba") continue;              // controle interno, ignora
    if (NOMES_FIXOS_USADOS.has(norm(chave))) continue; // ja virou campo fixo
    const valor = (obra[chave] || "").toString().trim();
    if (valor) extras[chave.trim()] = valor;     // guarda com o nome original
  }
  return Object.keys(extras).length ? extras : null;
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
    dados_extras: coletarExtras(obra), // TODAS as outras colunas da planilha
  };
}

// Roda a ingestao completa: le planilha -> limpa -> substitui no banco.
export async function sincronizar() {
  console.log("INGESTAO: lendo planilha...");
  limparCache(); // forca releitura da planilha fresca (ignora cache velho)
  const cruas = await getObras();
  const limpas = cruas.map(limpar).filter(Boolean);
  console.log(`INGESTAO: ${cruas.length} linhas lidas, ${limpas.length} obras limpas.`);

  if (limpas.length === 0) {
    console.log("INGESTAO: nenhuma obra para inserir. Abortando (nao apaga o banco).");
    return { inseridas: 0 };
  }

  // Insere em lote.
  const campos = ["objeto","bairro","status","categoria","valor_total",
    "valor_executado","percentual_executado","engenheiro","empresa","aba_origem",
    "dados_extras"];

  // INSERCAO EM LOTE: junta varias obras numa unica query, em blocos.
  // Antes era uma query por obra (2000 obras = 2000 idas ao banco = timeout).
  // Agora insere ~100 por vez, o que aguenta milhares de obras em segundos.
  // Postgres limita ~65535 parametros por query; com 11 campos, 100 obras =
  // 1100 parametros, bem dentro do limite e com folga.
  const TAMANHO_LOTE = 100;
  let inseridas = 0;

  function valoresDaObra(o) {
    return campos.map((c) => {
      if (c === "dados_extras") return o[c] ? JSON.stringify(o[c]) : null;
      return o[c];
    });
  }

  // TRUNCATE + TODOS os lotes ficam na mesma transacao. O PostgreSQL torna o
  // TRUNCATE transacional: se um INSERT falhar, o banco volta integralmente ao
  // estado anterior, sem ficar vazio ou pela metade.
  await withAdminTransaction(async (client) => {
    await client.query("TRUNCATE TABLE obras RESTART IDENTITY;");

    for (let inicio = 0; inicio < limpas.length; inicio += TAMANHO_LOTE) {
      const bloco = limpas.slice(inicio, inicio + TAMANHO_LOTE);
      const todosValores = [];
      const gruposMarcadores = [];

      bloco.forEach((o, idxObra) => {
        const vals = valoresDaObra(o);
        const marcadores = vals.map((_, idxCampo) => {
          const posicao = idxObra * campos.length + idxCampo + 1;
          return `$${posicao}`;
        });
        gruposMarcadores.push(`(${marcadores.join(",")})`);
        todosValores.push(...vals);
      });

      await client.query(
        `INSERT INTO obras (${campos.join(",")}) VALUES ${gruposMarcadores.join(",")}`,
        todosValores
      );
      inseridas += bloco.length;
      console.log(`INGESTAO: lote inserido (${inseridas}/${limpas.length}).`);
    }
  });

  console.log(`INGESTAO: ${inseridas} obras inseridas no banco.`);
  return { inseridas };
}
