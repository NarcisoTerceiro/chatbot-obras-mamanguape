// ============================================================
// agentePlanilha.js — Agente que lê a PLANILHA direto (sem banco)
//
// Replica o modelo do Data Formulator (AnalystAgent):
//   1) A IA ESCREVE CÓDIGO PANDAS para responder a pergunta.
//   2) O código roda no SANDBOX PYTHON (sandbox/app.py) sobre os dados reais.
//   3) A IA recebe o resultado calculado e redige a resposta em português.
//   4) Se o código der erro, a IA corrige e tenta de novo (self-healing).
//
// Usa os mesmos significados de aba (MEANINGS) e regras de interpretação do
// sistema de referência. Quando o sandbox NÃO está configurado (SANDBOX_URL
// vazia), cai num modo alternativo: manda a planilha inteira + contagens já
// calculadas em Node para a IA responder (bom para planilhas pequenas).
//
// Assinatura mantida: responderPergunta(pergunta, historico, opts) -> { resposta, ... }
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";
import { sandboxDisponivel, executarNoSandbox } from "./sandboxClient.js";

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

// --- Metadados por aba (mesmos significados do sistema de referência) ---
const SIGNIFICADOS = {
  em_andamento:
    "Obras físicas. Consulte STATUS, não o nome da aba. Valor contratado, executado e pago são medidas distintas.",
  pavimentacao:
    "Obras físicas de pavimentação. RUA identifica a via e SITUAÇÃO indica o status. Incluir nas obras físicas.",
  em_projeto:
    "Projetos técnicos. Projeto concluído não significa obra física concluída.",
  em_licitacao:
    "Licitações. STATUS é a fase da contratação e OBSERVAÇÕES são notas. Não representam conclusão física.",
  pendencias:
    "Anotações de impedimentos. Não contar como novas obras nem presumir vínculos sem identificador.",
};

function significadoDaAba(aba) {
  return (
    SIGNIFICADOS[norm(aba)] ||
    "Consulte as colunas e os valores. O nome da aba não comprova o status dos registros."
  );
}

// Regras de interpretação (as mesmas do Data Formulator), usadas nos dois modos.
const REGRAS_INTERPRETACAO = `Regras de interpretação dos dados (siga à risca):
— O nome da aba não comprova o status. Em EM_ANDAMENTO consulte a coluna STATUS.
— PAVIMENTAÇÃO são obras físicas; RUA identifica a obra e SITUAÇÃO é o status.
— EM_PROJETO são projetos técnicos: projeto concluído não é obra fisicamente concluída.
— EM_LICITAÇÃO descreve fases da contratação, não conclusão física.
— PENDÊNCIAS e "recursos a pagar" não são novas obras; "a pagar" não significa "pago".
— Não some projetos e licitações como se fossem obras físicas.
— Não deduplique registros só pelo nome: contratos e etapas podem ser registros diferentes.
— Valores contratado, executado e pago são diferentes. Célula vazia NÃO é zero.
— A coluna _aba indica de qual aba cada linha veio; _linha é a linha original.`;

// REGRAS DE RESPOSTA — texto idêntico ao do sistema de referência (Data
// Formulator), para que as respostas saiam 100% no mesmo padrão.
const REGRAS_RESPOSTA = `Responda em português do Brasil, somente com fatos obtidos das tabelas disponíveis.
O canal é WhatsApp. Entregue texto legível e listas; não exponha Python, SQL, caminhos ou logs.
Não use tabelas Markdown, barras verticais, blocos de código ou títulos com #.
Organize listas com travessão (—), um item por bloco. Não use | como separador.
Comece pela resposta direta. Para listar registros, use um bloco por item, com nome
em destaque e campos em linhas separadas. Separe os itens com uma linha em branco.
Use negrito WhatsApp com um asterisco de cada lado. Inclua somente campos solicitados
ou indispensáveis para identificar o registro. Não termine oferecendo menus de opções.
Nomes de abas não comprovam status. Conte registros válidos consultados; linhas vazias,
cabeçalhos e totais não são novas obras. Não invente contagens, contratos ou sobreposições.
Ao mencionar a origem dos dados, escreva na própria frase "na aba/tabela *NOME*", usando
o nome real da aba ou tabela consultada. Exemplo: "Na aba/tabela *EM_ANDAMENTO*, encontrei...".
Não some projetos e licitações como obras físicas nem deduplique obras sem identificadores.
Consulte todas as tabelas relevantes antes de responder. Diferencie obra física, projeto e licitação.
Em EM_ANDAMENTO o nome da aba não determina o status: consulte STATUS.
PAVIMENTAÇÃO contém obras físicas; RUA identifica a obra e SITUAÇÃO é o status.
EM_PROJETO contém projetos técnicos: projeto concluído não é obra fisicamente concluída.
EM_LICITAÇÃO descreve fases da contratação, não conclusão física. STATUS e OBSERVAÇÕES são distintos.
PENDÊNCIAS e recursos próprios a pagar não são novas obras. A pagar não significa pago.
Valores contratado, executado e pago são diferentes. Vazio não significa zero.
REGRAS PARA CÁLCULOS:
- Toda soma, contagem, média, percentual ou ranking deve vir de cálculo sobre os
  dados completos do recorte (código ou contagens verificadas). Nunca faça
  aritmética mental nem conte somente amostras, previews ou itens do histórico.
- Para dinheiro, preserve números já numéricos. Em textos brasileiros, remova
  R$, espaços e separadores de milhar e interprete a vírgula como decimal.
  Não aplique essa limpeza de texto a valores já numéricos.
- Mantenha ausentes e valores inválidos separados. Informe quantos registros
  possuem o valor solicitado e quantos não possuem; não preencha faltantes com zero.
- Confira filtros, status, abas, unidade e denominador. Não misture valor pago,
  executado e contratado. Não deduplique só pelo nome: contratos e etapas podem
  representar registros diferentes. Percentual agregado exige base explícita;
  não use média simples de percentuais para representar execução financeira total.
- Copie na resposta os resultados calculados e verificados. Não crie números
  novos na redação. Se a verificação falhar ou os dados forem insuficientes,
  explique a limitação e não apresente o total como confirmado.
Use o histórico para referências como "dessas obras". Não misture filtros de conversas distintas.
Se a pergunta for ambígua, faça uma pergunta curta de esclarecimento em texto.
Retorne todos os itens solicitados. Não invente dados ausentes nem corte listas silenciosamente.
Finalize com resposta textual explícita.
Não busque dados na internet nem carregue outras fontes: utilize somente as abas da planilha fornecidas.`;

const CAMPOS_INTERNOS = new Set(["_aba", "_linha", "_avisos"]);
const MAX_REPAROS = Math.max(0, Math.min(Number(process.env.AGENTE_MAX_REPAROS || 2), 3));

function agruparPorAba(obras) {
  const grupos = new Map();
  for (const o of obras) {
    const aba = o._aba || "(sem aba)";
    if (!grupos.has(aba)) grupos.set(aba, []);
    grupos.get(aba).push(o);
  }
  return grupos;
}

function colunasDaAba(linhas) {
  const cols = [];
  const vistas = new Set();
  for (const linha of linhas) {
    for (const k of Object.keys(linha)) {
      if (CAMPOS_INTERNOS.has(k) || vistas.has(k)) continue;
      vistas.add(k);
      cols.push(k);
    }
  }
  return cols;
}

function contagensVerificadas(aba, linhas, colunas) {
  const partes = [`Aba *${aba}*: ${linhas.length} registro(s).`];
  const colsStatus = colunas.filter((c) =>
    ["status", "situacao", "situacao da obra", "fase"].includes(norm(c))
  );
  for (const col of colsStatus) {
    const contagem = new Map();
    let semValor = 0;
    for (const linha of linhas) {
      const v = linha[col];
      if (v === null || v === undefined || String(v).trim() === "") {
        semValor++;
        continue;
      }
      const chave = String(v).trim();
      contagem.set(chave, (contagem.get(chave) || 0) + 1);
    }
    const itens = [...contagem.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`);
    if (semValor) itens.push(`sem ${col}: ${semValor}`);
    if (itens.length) partes.push(`  Por ${col} — ${itens.join("; ")}.`);
  }
  return partes.join("\n");
}

// Esquema compacto (colunas + significado + contagens + 2 exemplos por aba),
// entregue à IA para ela escrever o código pandas certo.
function montarEsquema(obras) {
  const grupos = agruparPorAba(obras);
  const blocos = [];
  for (const [aba, linhas] of grupos) {
    const colunas = colunasDaAba(linhas);
    const exemplos = linhas.slice(0, 2).map((l) => {
      const o = {};
      for (const c of colunas) if (l[c] !== null && l[c] !== undefined) o[c] = l[c];
      return JSON.stringify(o);
    });
    blocos.push(
      `Aba "${aba}" (${significadoDaAba(aba)})\n` +
        `  Colunas: ${colunas.join(", ")}\n` +
        contagensVerificadas(aba, linhas, colunas) +
        (exemplos.length ? `\n  Exemplos: ${exemplos.join(" ; ")}` : "")
    );
  }
  return blocos.join("\n\n");
}

function historicoParaMensagens(historico = []) {
  const msgs = [];
  for (const h of historico.slice(-6)) {
    if (!h || !h.role || !h.content) continue;
    if (h.role === "user" || h.role === "assistant")
      msgs.push({ role: h.role, content: String(h.content) });
  }
  return msgs;
}

function extrairCodigo(texto) {
  const t = String(texto || "");
  const bloco = t.match(/```(?:python)?\s*([\s\S]*?)```/i);
  let codigo = (bloco ? bloco[1] : t).trim();
  // Remove linhas de comentário inteiras (ex.: "# sem usar import"): elas
  // poderiam bater no filtro de segurança do sandbox por conter palavras como
  // "import". Mantém apenas o código executável.
  codigo = codigo
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .trim();
  return codigo;
}

// Saudações e small talk: não geram código, respondem com uma orientação curta.
function ehSaudacao(texto) {
  return /^(oi+|ol[aá]+|opa|e a[ií]|eai|salve|bom dia|boa tarde|boa noite|tudo bem\??|como vai\??|ajuda|menu|in[ií]cio|come[çc]ar|start)\W*$/i.test(
    texto.trim()
  );
}

// ---- MODO 1: execução de código no sandbox Python (igual ao Data Formulator) ----
async function responderComSandbox(pergunta, obras, historico) {
  const esquema = montarEsquema(obras);
  const instrucoesCodigo =
    `Você analisa a planilha de obras públicas escrevendo código Python (pandas).\n` +
    `Os dados estão num DataFrame chamado df (todas as abas juntas; a coluna _aba diz a aba).\n` +
    `${REGRAS_INTERPRETACAO}\n\n` +
    `Escreva APENAS código Python executável, SEM comentários e SEM explicações, que calcule a\n` +
    `resposta e atribua a uma variável chamada resultado (um número, texto, lista ou dict pequeno,\n` +
    `já pronto para ser exibido). Não escreva a palavra import em lugar nenhum. Use somente df, pd\n` +
    `e funções básicas (sem abrir arquivos nem rede). Para filtrar por texto use métodos de string\n` +
    `do pandas com case=False e na=False (ex.: .str.contains('conclu', case=False, na=False)).\n` +
    `Para dinheiro em texto brasileiro (ex.: "1.250.000,00"), limpe com métodos de\n` +
    `string do pandas antes de converter: .str.replace('.', '', regex=False).str.replace(',', '.', regex=False)\n` +
    `e depois pd.to_numeric(..., errors='coerce'). Não trate célula vazia/NaN como zero.\n\n` +
    `ESQUEMA DAS ABAS:\n${esquema}`;

  let erroAnterior = "";
  let resultado = null;
  let codigoFinal = "";

  for (let tentativa = 0; tentativa <= MAX_REPAROS; tentativa++) {
    const msgsCodigo = [
      { role: "system", content: instrucoesCodigo },
      ...historicoParaMensagens(historico),
      {
        role: "user",
        content: erroAnterior
          ? `A pergunta é: "${pergunta}".\nSeu código anterior deu este erro ao rodar:\n${erroAnterior}\nCorrija e reescreva o código completo.`
          : `Pergunta: "${pergunta}". Escreva o código que calcula a resposta em resultado.`,
      },
    ];
    const respostaCodigo = await chamarIAbruta(msgsCodigo, {
      max_tokens: 900,
      temperature: 0,
      reasoning_effort: "medium",
    });
    codigoFinal = extrairCodigo(respostaCodigo);
    if (!codigoFinal) {
      erroAnterior = "não veio código";
      continue;
    }
    try {
      resultado = await executarNoSandbox(codigoFinal, obras);
      erroAnterior = "";
      break;
    } catch (e) {
      erroAnterior = e.message || String(e);
      resultado = null;
    }
  }

  if (erroAnterior) {
    // O código falhou após as tentativas: em vez de desistir, responde pelo
    // modo alternativo (planilha + contagens no contexto), que não depende de
    // gerar código. Assim o usuário sempre recebe uma resposta.
    console.warn("Código falhou; usando modo alternativo. Último erro:", erroAnterior);
    const alt = await responderSemSandbox(pergunta, obras, historico);
    return {
      ...alt,
      modoAgente: "contexto-node (fallback)",
      diagnosticoCodigo: erroAnterior,
      codigo: codigoFinal || null,
    };
  }

  // 2ª etapa: a IA redige a resposta em português a partir do resultado calculado.
  const msgsResposta = [
    {
      role: "system",
      content: `Você é o assistente de obras públicas da Prefeitura de Mamanguape no WhatsApp.\n${REGRAS_RESPOSTA}\n${REGRAS_INTERPRETACAO}`,
    },
    ...historicoParaMensagens(historico),
    {
      role: "user",
      content: `Pergunta do cidadão: "${pergunta}".\n\nResultado calculado pelos dados da planilha (use só isto, não invente):\n${JSON.stringify(
        resultado
      ).slice(0, 6000)}\n\nEscreva a resposta final para o WhatsApp.`,
    },
  ];
  const resposta = await chamarIAbruta(msgsResposta, {
    max_tokens: 1000,
    temperature: 0.2,
    reasoning_effort: "low",
  });

  return {
    resposta: String(resposta || "").trim() || "Não consegui formular a resposta agora.",
    linhas: obras.length,
    codigo: codigoFinal,
    modoAgente: "sandbox-python",
  };
}

// ---- MODO 2 (fallback): planilha inteira + contagens no contexto ----
const DADOS_MAX_CHARS = Math.max(
  10000,
  Math.min(Number(process.env.DADOS_MAX_CHARS || 48000), 120000)
);

function linhaCompacta(linha, colunas) {
  const campos = [];
  for (const col of colunas) {
    const v = linha[col];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    campos.push(`${col}=${String(v).trim()}`);
  }
  return `  [linha ${linha._linha}] ${campos.join(" | ")}`;
}

function montarContextoCompleto(obras) {
  const grupos = agruparPorAba(obras);
  const contagens = [];
  const dadosBlocos = [];
  for (const [aba, linhas] of grupos) {
    const colunas = colunasDaAba(linhas);
    contagens.push(contagensVerificadas(aba, linhas, colunas));
    const cab = `=== Aba ${aba} (${significadoDaAba(aba)}) ===\nColunas: ${colunas.join(", ")}`;
    dadosBlocos.push(`${cab}\n${linhas.map((l) => linhaCompacta(l, colunas)).join("\n")}`);
  }
  let dados = dadosBlocos.join("\n\n");
  let aviso = "";
  if (dados.length > DADOS_MAX_CHARS) {
    dados = dados.slice(0, DADOS_MAX_CHARS);
    aviso = "\n[Dados truncados por tamanho; peça para restringir por aba/bairro se faltar algo.]";
  }
  return (
    "CONTAGENS VERIFICADAS (use estes números para contagens):\n" +
    contagens.join("\n") +
    "\n\nDADOS DAS TABELAS:\n" +
    dados +
    aviso
  );
}

async function responderSemSandbox(pergunta, obras, historico) {
  const contexto = montarContextoCompleto(obras);
  const mensagens = [
    {
      role: "system",
      content: `Você é o assistente de obras públicas da Prefeitura de Mamanguape no WhatsApp.\n${REGRAS_RESPOSTA}\nUse SOMENTE os números do bloco "CONTAGENS VERIFICADAS" e os valores das linhas. Não invente.\n${REGRAS_INTERPRETACAO}\n\n${contexto}`,
    },
    ...historicoParaMensagens(historico),
    { role: "user", content: pergunta },
  ];
  const resposta = await chamarIAbruta(mensagens, {
    max_tokens: 1000,
    temperature: 0.2,
    reasoning_effort: "medium",
  });
  return {
    resposta: String(resposta || "").trim() || "Não consegui formular a resposta agora.",
    linhas: obras.length,
    modoAgente: "contexto-node",
  };
}

export async function responderPergunta(pergunta, historico = [], opts = {}) {
  const texto = String(pergunta || "").trim();
  if (!texto) return { resposta: "Pode me dizer sua pergunta sobre as obras?", linhas: 0 };

  // Saudação/small talk: responde direto, sem gerar código nem ler a planilha.
  if (ehSaudacao(texto)) {
    return {
      resposta:
        "Olá! Sou o assistente de obras públicas de Mamanguape. Pergunte sobre as obras — por exemplo:\n\n" +
        "— *Quais obras estão em andamento?*\n" +
        "— *Quantas obras já foram concluídas?*\n" +
        "— *Como está a obra da praça do centro?*\n" +
        "— *Qual o valor contratado das obras de pavimentação?*",
      linhas: 0,
      modoAgente: "saudacao",
    };
  }

  let obras;
  try {
    obras = await getObras();
  } catch (e) {
    console.error("Falha ao ler a planilha:", e.message);
    return {
      resposta: "Não consegui ler a planilha de obras agora. Tente novamente em instantes.",
      erro: "leitura_planilha",
    };
  }
  if (!obras.length) {
    return {
      resposta:
        "A planilha está acessível, mas não encontrei registros. Confira se as abas têm dados e estão compartilhadas com a conta de serviço.",
      linhas: 0,
    };
  }

  try {
    if (sandboxDisponivel()) return await responderComSandbox(texto, obras, historico);
    return await responderSemSandbox(texto, obras, historico);
  } catch (e) {
    console.error("Falha ao responder:", e.message);
    return {
      resposta: "Tive um problema para responder agora. Pode tentar de novo em instantes?",
      erro: "falha_agente",
      linhas: obras.length,
    };
  }
}

export { montarContextoCompleto as montarContexto, montarEsquema, extrairCodigo, ehSaudacao };
export default { responderPergunta };
