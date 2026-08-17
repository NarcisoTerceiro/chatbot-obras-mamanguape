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
- dados_extras (JSONB) - TODAS as outras colunas da planilha que nao tem campo
  proprio acima. Guarda coisas como RECURSO (fonte do dinheiro), No DO CONTRATO,
  No DO CONVENIO/PROPOSTA, VALOR INICIAL DO CONTRATO, VALOR TOTAL DOS ADITIVOS,
  PRAZO, DATAS, etc. As chaves sao os nomes ORIGINAIS das colunas da planilha
  (em maiuscula, com acento).

COMO CONSULTAR dados_extras (JSONB no PostgreSQL):
- Para LER um campo: dados_extras->>'RECURSO' (retorna texto).
- Para FILTRAR/BUSCAR dentro dele, use ILIKE com unaccent, igual aos textos:
  WHERE unaccent(dados_extras->>'RECURSO') ILIKE unaccent('%proprio%')
- Se o cidadao perguntar sobre RECURSO, CONTRATO, CONVENIO, ADITIVO, PRAZO ou
  qualquer coisa que NAO tem coluna propria, procure em dados_extras.
- IMPORTANTE: os nomes das chaves variam (podem ter espacos, barras, acentos).
  Na duvida sobre o nome exato da chave, prefira trazer a obra inteira
  (SELECT objeto, dados_extras FROM ...) e deixe a resposta mostrar o campo.
`;

// --- SEGURANCA: valida a SQL antes de executar ---
const PALAVRAS_PROIBIDAS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate",
  "grant", "revoke", "replace", "merge", "call", "execute", "--", "/*", "#",
];

// Checa se o SQL parece COMPLETO (nao foi cortado pela IA no meio).
// Pega tres tipos de corte: aspas abertas, parenteses desbalanceados, e o
// SQL terminando numa palavra que nao pode ser o fim (OR, AND, ILIKE...) -
// esse ultimo caso causava o "syntax error at or near LIMIT".
function sqlCompleta(s) {
  if (!s) return false;
  const aspasOk = ((s.match(/'/g) || []).length % 2) === 0;
  if (!aspasOk) return false;
  const parOk = (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;
  if (!parOk) return false;
  const fim = s.replace(/;$/, "").trim().toLowerCase();
  const terminaMal = /(\bor|\band|\bwhere|\bilike|\blike|\bunaccent|\bfrom|\bselect|\bon|\bin|=|,|\()$/.test(fim);
  if (terminaMal) return false;
  return true;
}

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
  // Detecta SQL TRUNCADO (cortado no meio pela IA). Sem isso, um SELECT
  // cortado vira erro de sintaxe no banco (ex.: "syntax error at LIMIT").
  if (!sqlCompleta(sql)) return { ok: false, motivo: "SQL truncado (incompleto)" };
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
- Na DUVIDA, SEMPRE gere uma consulta SELECT. So use SEM_CONSULTA em casos
  OBVIOS de mensagem que NAO pede informacao: saudacao solta ("oi", "bom dia"),
  "ok", "kkk", "obrigado", ou texto sem sentido. QUALQUER mensagem que fale de
  obra, recurso, valor, bairro, engenheiro, empresa, prazo, status, praca, rua,
  escola, ou pergunte "qual/quanto/quantos/onde/quando" sobre algo DEVE virar
  SELECT - nunca SEM_CONSULTA. Exemplos que SAO consulta (gere SELECT):
  "qual o recurso da praca de lazer", "quem e o engenheiro", "quanto custou",
  "obras no centro". Na duvida entre consultar e recusar, CONSULTE.
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

  // A IA (Gemini/Groq no plano gratuito) as vezes devolve o SQL truncado -
  // corta no meio de '%pr... por instabilidade/cota, nao por max_tokens.
  // Por isso tentamos ate 3 vezes: se vier cortado, geramos de novo.
  let sql = "";
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const resposta = await chamarIAbruta([
      { role: "user", content: prompt },
    ], { max_tokens: 512 });
    // Limpa possiveis marcadores de codigo
    let s = resposta.replace(/```sql/gi, "").replace(/```/g, "").trim();
    // Pega so o trecho que comeca com SELECT, se vier texto junto
    const m = s.match(/select[\s\S]+/i);
    if (m) s = m[0].trim();
    s = s.replace(/;$/, "").trim();

    // O SQL veio completo? (mesma checagem usada na validacao)
    if (sqlCompleta(s)) {
      sql = s;
      break; // veio completo, pode usar
    }
    console.warn(`AGENTE: SQL incompleto na tentativa ${tentativa}/3, gerando de novo. Parcial:`, s);
    sql = s; // guarda o ultimo, caso todas falhem
  }
  return sql;
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

  // So trata como saudacao/social se a mensagem for CURTA (senao pode ter pergunta junto)
  const curta = limpo.split(" ").length <= 4;
  if (!curta) return null;

  // Saudacoes detectadas por PADRAO (aceita variacoes: oi/oii/oiii, ola/olaa,
  // eai/eaii, etc.) - mais robusto que uma lista fixa de palavras exatas.
  const ehSaudacao =
    /^o+i+$/.test(limpo) ||                                   // oi, oii, oiii, ooi...
    /^o+la+$/.test(limpo) ||                                  // ola, olaa, oola...
    /^(opa|opaa|salve|ei+|hey|hello|hi|oie|alo+)$/.test(limpo) ||
    /^e+ ?a+i+$/.test(limpo) ||                               // eai, e ai, eaii...
    /\b(bom dia|boa tarde|boa noite|boas)\b/.test(limpo);

  // Agradecimentos e despedidas
  const agradece = ["obrigado", "obrigada", "obg", "vlw", "valeu", "grato",
    "grata", "agradecido", "thanks"];
  const despede = ["tchau", "ate mais", "ate logo", "adeus", "falou", "flw", "ate"];
  const comeca = (lista) => lista.some((s) => limpo === s || limpo.startsWith(s + " ") || limpo.endsWith(" " + s));

  if (comeca(agradece)) {
    return "Por nada! Estou aqui para ajudar com informacoes sobre as obras de Mamanguape. 😊";
  }
  if (comeca(despede)) {
    return "Ate mais! Qualquer duvida sobre as obras da cidade, e so chamar. 👋";
  }
  if (ehSaudacao) {
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

  // 1b. A IA sinalizou que a mensagem nao e uma pergunta clara sobre obras?
  // (ex.: saudacao solta que escapou, "ok", algo vago). Pede reformular em vez
  // de inventar um numero. Cobre casos que a deteccao de saudacao nao pegou.
  if (/sem_consulta/i.test(sql) || !/select/i.test(sql)) {
    console.log("AGENTE: mensagem sem consulta clara - pedindo reformular.");
    return {
      resposta: "Nao entendi bem sua pergunta. Posso te informar sobre obras em andamento, concluidas, valores, bairros e engenheiros responsaveis. O que voce gostaria de saber? 🏗️",
      semConsulta: true,
    };
  }

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
