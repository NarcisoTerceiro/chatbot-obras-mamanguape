// ============================================================
//  agente.js
//  O CORACAO do sistema novo. Fluxo (padrao de 2 chamadas):
//    1) IA recebe a PERGUNTA + o schema da tabela -> gera SQL
//    2) Validamos a SQL (so SELECT, bloqueia comandos perigosos)
//    3) Executamos no banco
//    4) IA recebe o RESULTADO -> escreve a resposta em portugues
//
//  A IA NUNCA ve os dados crus, so o schema. Ela nunca calcula:
//  quem calcula e o banco (exato). Isso evita alucinacao.
// ============================================================

import { query } from "./db.js";
import { chamarIAbruta } from "./groq.js"; // reaproveita a chamada de IA que ja existe

// Descricao da tabela que a IA recebe (o "schema"). Se mudar a
// tabela, atualize aqui.
const SCHEMA = `
Tabela: obras
Colunas:
- id (numero) - identificador
- objeto (texto) - nome/descricao da obra
- bairro (texto) - bairro onde fica
- status (texto) - situacao: 'Concluída', 'Em andamento', 'Em licitação', 'Em projeto', 'Paralisada', 'A iniciar', 'Homologada'
- categoria (texto) - categoria da aba de origem
- valor_total (numero) - valor total da obra em reais (pode ser nulo)
- valor_executado (numero) - valor ja executado (pode ser nulo)
- percentual_executado (numero) - % executada (pode ser nulo)
- engenheiro (texto) - engenheiro responsavel
- empresa (texto) - empresa executora
- aba_origem (texto) - de qual aba da planilha veio
`;

// --- SEGURANCA: valida a SQL antes de executar ---
const PALAVRAS_PROIBIDAS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "grant", "revoke", "replace", "merge", "call", "execute", "--", "/*", "#",
];

function sqlSegura(sql) {
  const s = sql.toLowerCase().trim();
  // Tem que comecar com SELECT
  if (!s.startsWith("select")) return { ok: false, motivo: "so SELECT e permitido" };
  // Nao pode ter palavra proibida
  for (const p of PALAVRAS_PROIBIDAS) {
    if (s.includes(p)) return { ok: false, motivo: `comando proibido: ${p}` };
  }
  // So uma instrucao (sem ; no meio)
  const semFinal = s.endsWith(";") ? s.slice(0, -1) : s;
  if (semFinal.includes(";")) return { ok: false, motivo: "multiplas instrucoes" };
  return { ok: true };
}

// Garante um LIMIT para nao trazer dados demais.
function comLimite(sql, max = 200) {
  const s = sql.trim().replace(/;$/, "");
  if (/\blimit\b/i.test(s)) return s;
  return `${s} LIMIT ${max}`;
}

// --- CHAMADA 1: pergunta -> SQL ---
async function gerarSQL(pergunta, historico = []) {
  const prompt = `Voce e um tradutor de perguntas para SQL (PostgreSQL).
Recebe uma pergunta de um cidadao sobre obras publicas e gera UMA consulta SQL.

${SCHEMA}

REGRAS:
- Gere APENAS SELECT. Nunca INSERT/UPDATE/DELETE/DROP.
- Use os nomes de coluna exatos do schema.
- Para status, use os valores exatos (ex.: 'Concluída' com acento).
- Entenda linguagem informal: "prontas"/"terminadas" = status 'Concluída';
  "em obra"/"tocando" = 'Em andamento'.
- Se pedir soma/total de valor, use SUM(valor_total).
- Se pedir contagem, use COUNT(*).
- Para filtrar por texto (bairro/empresa/engenheiro/objeto), use unaccent()
  nos DOIS lados para ignorar acento E maiuscula. Exemplo:
  WHERE unaccent(bairro) ILIKE unaccent('%centro%')
  Isso faz "sao jose" achar "São José" e "rodoviario" achar "rodoviário".
- Responda SOMENTE com a SQL, sem explicacao, sem marcadores de codigo, sem ponto e virgula.

Pergunta: ${pergunta}
SQL:`;

  const resposta = await chamarIAbruta([
    { role: "user", content: prompt },
  ]);
  // Limpa possiveis marcadores de codigo
  let sql = resposta.replace(/```sql/gi, "").replace(/```/g, "").trim();
  // Pega so a primeira linha que comeca com SELECT, se vier texto junto
  const m = sql.match(/select[\s\S]+/i);
  if (m) sql = m[0].trim();
  return sql.replace(/;$/, "").trim();
}

// --- CHAMADA 2: resultado -> resposta natural ---
async function redigir(pergunta, linhas) {
  const dados = JSON.stringify(linhas.slice(0, 50));
  const prompt = `Voce e o Assistente de Obras da Prefeitura de Mamanguape no WhatsApp.
O cidadao perguntou: "${pergunta}"
O sistema consultou o banco e retornou estes dados (JSON): ${dados}

Escreva uma resposta curta, clara e cordial em portugues, formato WhatsApp.
REGRAS:
- Use SOMENTE os dados acima. Nunca invente valores, nomes ou numeros.
- Se os dados vierem vazios, diga que nao encontrou e peca para reformular.
- Valores em reais no formato R$ 1.234.567,00.
- Nao mencione "banco", "SQL", "dados" nem que voce e uma IA.
- No maximo um emoji sutil.`;

  return await chamarIAbruta([{ role: "user", content: prompt }]);
}

// Detecta saudacoes, agradecimentos e despedidas simples - que nao precisam
// de banco de dados. Retorna uma resposta pronta, ou null se nao for saudacao.
function respostaSocial(pergunta) {
  const p = pergunta.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // remove pontuacao das bordas
  const limpo = p.replace(/[!?.,;]+/g, " ").replace(/\s+/g, " ").trim();

  // Saudacoes (oi, ola, bom dia, boa tarde, boa noite, e ce, salve...)
  const saudacoes = ["oi", "ola", "opa", "eai", "e ai", "salve", "bom dia",
    "boa tarde", "boa noite", "boas", "ei", "hello", "oii", "oie"];
  // Agradecimentos
  const agradece = ["obrigado", "obrigada", "obg", "vlw", "valeu", "grato",
    "grata", "agradecido", "thanks"];
  // Despedidas
  const despede = ["tchau", "ate mais", "ate logo", "adeus", "falou", "flw", "ate"];

  const comeca = (lista) => lista.some((s) => limpo === s || limpo.startsWith(s + " ") || limpo.endsWith(" " + s));

  // So trata como saudacao pura se a mensagem for CURTA (senao pode ter pergunta junto)
  const curta = limpo.split(" ").length <= 4;

  if (curta && comeca(agradece)) {
    return "Por nada! Estou aqui para ajudar com informacoes sobre as obras de Mamanguape. 😊";
  }
  if (curta && comeca(despede)) {
    return "Ate mais! Qualquer duvida sobre as obras da cidade, e so chamar. 👋";
  }
  if (curta && comeca(saudacoes)) {
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

  // 2. Valida seguranca
  const check = sqlSegura(sql);
  if (!check.ok) {
    console.warn("AGENTE: SQL bloqueada -", check.motivo, "| SQL:", sql);
    return { resposta: "Nao consegui responder essa pergunta com seguranca. Pode perguntar de outro jeito?", sqlBloqueada: sql };
  }

  // 3. Executa
  let linhas;
  try {
    const r = await query(comLimite(sql));
    linhas = r.rows;
  } catch (e) {
    console.error("AGENTE: erro ao executar SQL:", e.message, "| SQL:", sql);
    return { resposta: "Tive um problema ao buscar essa informacao. Pode tentar de novo?", erro: "executar: " + e.message };
  }
  console.log(`AGENTE: ${linhas.length} linha(s) retornada(s).`);

  // 4. Redige resposta
  try {
    const resposta = await redigir(pergunta, linhas);
    return { resposta, sql, linhas: linhas.length };
  } catch (e) {
    return { resposta: "Encontrei os dados, mas tive dificuldade para montar a resposta. Pode reformular?", erro: "redigir: " + e.message };
  }
}
