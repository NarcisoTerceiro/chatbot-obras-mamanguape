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
  // Detecta SQL TRUNCADO (cortado no meio pela IA): aspas ou parenteses
  // desbalanceados. Sem isso, um SELECT cortado vira erro de sintaxe no banco.
  const aspas = (sql.match(/'/g) || []).length;
  if (aspas % 2 !== 0) return { ok: false, motivo: "SQL truncado (aspas abertas)" };
  const abre = (sql.match(/\(/g) || []).length;
  const fecha = (sql.match(/\)/g) || []).length;
  if (abre !== fecha) return { ok: false, motivo: "SQL truncado (parenteses desbalanceados)" };
  return { ok: true };
}

// Garante um LIMIT para nao trazer dados demais.
function comLimite(sql, max = 200) {
  const s = sql.trim().replace(/;$/, "");
  if (/\blimit\b/i.test(s)) return s;
  return `${s} LIMIT ${max}`;
}

// Monta um resumo curto das ultimas trocas, para dar contexto ao gerar SQL.
// So as ultimas 2-3 trocas importam para perguntas de acompanhamento.
function resumoHistorico(historico = []) {
  if (!Array.isArray(historico) || historico.length === 0) {
    return "(inicio da conversa - sem contexto anterior)";
  }
  // pega as ultimas 4 mensagens (2 trocas)
  const recentes = historico.slice(-4);
  return recentes
    .map((m) => {
      const quem = m.role === "user" ? "Cidadao perguntou" : "Assistente respondeu";
      const txt = (m.content || "").toString().slice(0, 200);
      return `${quem}: ${txt}`;
    })
    .join("\n");
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
- Se pedir contagem, use COUNT(*). MAS ATENCAO ao que esta sendo contado:
  * "quantas OBRAS" -> COUNT(*) das obras.
  * "quantos ENGENHEIROS" -> COUNT(DISTINCT engenheiro) - conta pessoas, nao obras.
  * "quantas EMPRESAS" -> COUNT(DISTINCT empresa).
  * "quantos BAIRROS" -> COUNT(DISTINCT bairro).
  NUNCA responda a contagem de engenheiros/empresas/bairros com a contagem de
  obras. Sao coisas diferentes. Se a pergunta e sobre engenheiros, conte
  engenheiros distintos, mesmo que ela venha logo depois de uma pergunta sobre obras.
- Se a pergunta for sobre a conversa em si (ex.: "por que voce disse isso?",
  "voce tem certeza?", "e mesmo?"), e NAO sobre as obras, gere uma consulta que
  reflita o dado real que responde a pergunta ANTERIOR verdadeira - nunca repita
  um numero solto. Na duvida, prefira contar corretamente a partir da tabela.
- Para filtrar por texto (bairro/empresa/engenheiro/objeto), use unaccent()
  nos DOIS lados para ignorar acento E maiuscula. Exemplo:
  WHERE unaccent(bairro) ILIKE unaccent('%centro%')
  Isso faz "sao jose" achar "São José" e "rodoviario" achar "rodoviário".
- USE TERMOS CURTOS no ILIKE, nunca a frase inteira da pergunta. Extraia so a
  palavra-chave essencial. Ex.: para "informacoes sobre a construcao da praca de
  lazer em Nova Mamanguape", NAO busque '%praca de lazer nova mamanguape%'
  (quase nunca acha e incha a consulta). Busque so '%praca de lazer%' ou
  '%praca%'. Frase longa dentro do ILIKE quase nunca da resultado.
- IMPORTANTE - ao filtrar por BAIRRO ou LOCAL (ex.: "obras no Centro",
  "valores no Bela Vista"), procure o lugar TANTO na coluna bairro QUANTO
  na coluna objeto, porque as vezes o bairro esta no nome da obra
  (ex.: "Rua do Cruzeiro - Centro"). Use:
  WHERE (unaccent(bairro) ILIKE unaccent('%centro%')
         OR unaccent(objeto) ILIKE unaccent('%centro%'))
- Responda SOMENTE com a SQL, sem explicacao, sem marcadores de codigo, sem ponto e virgula.

CONTEXTO DA CONVERSA (use para entender perguntas de acompanhamento como
"e o valor dessas?", "quais delas no Centro?", "e os engenheiros?"):
${resumoHistorico(historico)}

Pergunta atual: ${pergunta}
SQL:`;

  const resposta = await chamarIAbruta([
    { role: "user", content: prompt },
  ], { max_tokens: 512 });
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
  const muitasLinhas = linhas.length > 8;
  const prompt = `Voce e o Assistente de Obras da Prefeitura de Mamanguape no WhatsApp.
O cidadao perguntou: "${pergunta}"
O sistema consultou o banco e retornou EXATAMENTE estes dados (JSON): ${dados}

Escreva uma resposta clara e cordial em portugues, formato WhatsApp.

REGRAS ABSOLUTAS (nunca quebre):
- Responda USANDO SOMENTE os dados do JSON acima. Todo numero, nome ou valor
  na sua resposta TEM que aparecer no JSON. Se nao esta no JSON, NAO existe.
- NUNCA reutilize numeros de mensagens anteriores da conversa. Um numero que
  apareceu antes (ex.: quantidade de obras) NAO vale para outra pergunta
  (ex.: quantidade de engenheiros). Cada resposta usa SO o JSON desta consulta.
- Se o JSON tem um COUNT/total, use exatamente esse numero. Se tem uma lista,
  conte os itens da lista. Nao arredonde nem estime.
- NAO concorde automaticamente com o que o cidadao afirmou. Se ele disser
  "sao 24 engenheiros, ne?" e o JSON mostrar outro numero, corrija com educacao
  ("Na verdade, sao X..."). A verdade e o JSON, nao a pergunta.
- Se os dados vierem vazios, diga que nao encontrou essa informacao e peca para
  reformular. NUNCA invente um numero para preencher.

OUTRAS REGRAS:
- Valores em reais no formato R$ 1.234.567,00.
- Nao mencione "banco", "SQL", "dados" nem que voce e uma IA.
- No maximo um emoji sutil.
${muitasLinhas ? "- A lista e LONGA: seja ENXUTO. Liste um item por linha, so o essencial (nome e, se houver, valor). NAO repita rotulos como 'Status:' em toda linha. NAO escreva introducao longa." : "- Seja conciso."}`;

  // max_tokens maior para listas longas nao cortarem no meio.
  const limite = muitasLinhas ? 2048 : 1024;
  return await chamarIAbruta([{ role: "user", content: prompt }], { max_tokens: limite });
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
