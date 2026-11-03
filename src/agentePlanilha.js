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
import { sandboxDisponivel, executarNoSandbox, perguntarNoSandbox } from "./sandboxClient.js";

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

// Converte número no formato brasileiro ("R$ 1.250.000,00", "45%", "1.200")
// para Number. Retorna null quando não é um número (não vira zero).
function parseNumeroBR(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (v === null || v === undefined) return null;
  let raw = String(v).trim().replace(/R\$/gi, "").replace(/ /g, "").replace(/\s/g, "");
  if (!raw) return null;
  const pct = raw.endsWith("%");
  if (pct) raw = raw.slice(0, -1);
  if (raw.includes(",")) {
    raw = raw.replace(/\./g, "").replace(",", "."); // 1.250.000,00 -> 1250000.00
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) {
    raw = raw.replace(/\./g, ""); // 1.250.000 -> 1250000 (ponto = milhar)
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = parseFloat(raw);
  return pct ? n / 100 : n;
}

// Para cada coluna, decide se é numérica pelos próprios dados (não por chute)
// e devolve soma + quantos têm valor + quantos não têm.
function resumoNumerico(col, linhas) {
  let soma = 0, comValor = 0, semValor = 0, naoNumerico = 0;
  for (const linha of linhas) {
    const v = linha[col];
    if (v === null || v === undefined || String(v).trim() === "") { semValor++; continue; }
    const n = parseNumeroBR(v);
    if (n === null) { naoNumerico++; continue; }
    soma += n; comValor++;
  }
  // Numérica só se a maioria dos preenchidos é número (evita somar texto).
  const numerica = comValor >= 1 && comValor >= naoNumerico;
  return { numerica, soma, comValor, semValor };
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function contagensVerificadas(aba, linhas, colunas) {
  const partes = [`Aba *${aba}*: ${linhas.length} registro(s).`];
  const colsStatus = colunas.filter((c) =>
    ["status", "situacao", "situacao da obra", "fase"].includes(norm(c))
  );
  for (const col of colsStatus) {
    // Agrupa sem diferenciar maiúscula/minúscula nem acento: "CONCLUÍDO",
    // "Concluído" e "concluido" contam como o mesmo status.
    const contagem = new Map(); // chaveNormalizada -> { label, n }
    let semValor = 0;
    for (const linha of linhas) {
      const v = linha[col];
      if (v === null || v === undefined || String(v).trim() === "") {
        semValor++;
        continue;
      }
      const raw = String(v).trim();
      const chave = norm(raw);
      const atual = contagem.get(chave) || { label: raw, n: 0 };
      atual.n += 1;
      contagem.set(chave, atual);
    }
    const itens = [...contagem.values()]
      .sort((a, b) => b.n - a.n)
      .map((x) => `${x.label}: ${x.n}`);
    if (semValor) itens.push(`sem ${col}: ${semValor}`);
    if (itens.length) partes.push(`  Por ${col} — ${itens.join("; ")}.`);
  }
  // Somas verificadas das colunas numéricas (valores, áreas, %, etc.).
  for (const col of colunas) {
    const r = resumoNumerico(col, linhas);
    if (!r.numerica) continue;
    partes.push(
      `  Soma de ${col} = ${fmtNum(r.soma)} (em ${r.comValor} registro(s) com valor; ${r.semValor} sem valor).`
    );
  }
  return partes.join("\n");
}

// Esquema compacto (colunas + significado + contagens + 2 exemplos por aba),
// entregue à IA para ela escrever o código pandas certo.
function totalGeral(obras) {
  const grupos = agruparPorAba(obras);
  const porAba = [...grupos.entries()].map(([a, l]) => `${a}: ${l.length}`);
  return `TOTAL GERAL: ${obras.length} registro(s) em ${grupos.size} aba(s) — ${porAba.join("; ")}.`;
}

function montarEsquema(obras) {
  const grupos = agruparPorAba(obras);
  const blocos = [totalGeral(obras)];
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
    `e depois pd.to_numeric(..., errors='coerce'). Não trate célula vazia/NaN como zero.\n` +
    `Para comparar STATUS/SITUAÇÃO, normalize sempre: use .astype(str).str.strip().str.lower()\n` +
    `antes de comparar (ex.: == 'concluído' ou .str.contains('conclu')), para não perder valores\n` +
    `escritos em MAIÚSCULA ou com acentos diferentes.\n` +
    `Ao listar registros, pegue os campos das PRÓPRIAS LINHAS filtradas do df (iterrows). NUNCA\n` +
    `escreva nomes ou números de memória: só o que está no df.\n` +
    `IMPORTANTE para perguntas que envolvem VÁRIAS ABAS:\n` +
    `- Cada aba tem colunas diferentes; uma coluna pode não existir em todas (cheque "if col in sub.columns").\n` +
    `- Para combinar abas, filtre por df['_aba'].isin([...]) com os nomes EXATOS de _aba do esquema.\n` +
    `- Some/CONTE por aba e depois junte os resultados; confira o total contra a soma das partes.\n` +
    `- Obras físicas = EM_ANDAMENTO e PAVIMENTAÇÃO; projetos (EM_PROJETO) e licitações (EM_LICITAÇÃO)\n` +
    `  NÃO entram em "obras físicas". Não misture valor contratado, pago e executado.\n\n` +
    `ESQUEMA DAS ABAS (com contagens e somas já verificadas — use para conferir seu resultado):\n${esquema}`;

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
      content: `Pergunta do cidadão: "${pergunta}".\n\nResultado calculado pelos dados da planilha (use SOMENTE isto):\n${JSON.stringify(
        resultado
      ).slice(0, 6000)}\n\nEscreva a resposta final para o WhatsApp. Liste APENAS os itens que estão\nneste resultado — não acrescente, não invente nomes nem números, e não repita itens. Se o\nresultado trouxer uma contagem mas não a lista completa, informe o número e diga que pode\nlistar os nomes se o cidadão pedir, em vez de inventar a lista.`,
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
    "CONTAGENS E SOMAS VERIFICADAS (use SEMPRE estes números; não recalcule somando as linhas na mão):\n" +
    totalGeral(obras) + "\n" +
    contagens.join("\n") +
    "\nPara perguntas que cruzam abas, some os números já verificados das abas certas; não conte linha por linha." +
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

// ====================================================================
// MODO PLANO (determinístico, igual ao Data Formulator): a IA só traduz a
// pergunta num PLANO; quem FILTRA, CONTA, SOMA e LISTA é o Node, sobre os
// dados reais. Assim o modelo nunca "conta de cabeça" nem inventa nomes —
// funciona bem até com modelo pequeno.
// ====================================================================

function extrairJSON(texto) {
  const t = String(texto || "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function resolverColuna(nome, colunas) {
  if (!nome) return null;
  const alvo = norm(nome);
  let hit = colunas.find((c) => norm(c) === alvo);
  if (hit) return hit;
  hit = colunas.find((c) => norm(c).includes(alvo) || alvo.includes(norm(c)));
  return hit || null;
}

const CONCEITO_STATUS = ["status", "situacao", "situacao da obra", "fase"];
const ehConceitoStatus = (nome) => CONCEITO_STATUS.includes(norm(nome));
const colunaStatusDe = (keys) => keys.find((k) => CONCEITO_STATUS.includes(norm(k))) || null;

function executarPlano(plano, obras) {
  const grupos = agruparPorAba(obras);
  const todasAbas = [...grupos.keys()];
  // Resolve abas pedidas (por nome normalizado); vazio/"todas" = todas.
  let abasPedidas = Array.isArray(plano.abas) ? plano.abas : plano.abas ? [plano.abas] : [];
  abasPedidas = abasPedidas.map((a) => String(a)).filter(Boolean);
  let abasAlvo;
  if (!abasPedidas.length || abasPedidas.some((a) => norm(a) === "todas")) {
    abasAlvo = todasAbas;
  } else {
    abasAlvo = todasAbas.filter((real) =>
      abasPedidas.some((p) => norm(p) === norm(real) || norm(real).includes(norm(p)) || norm(p).includes(norm(real)))
    );
    if (!abasAlvo.length) abasAlvo = todasAbas;
  }

  let linhas = [];
  for (const aba of abasAlvo) linhas.push(...grupos.get(aba));

  // Aplica filtros de texto (sem ligar para maiúscula/acento).
  const filtros = Array.isArray(plano.filtros) ? plano.filtros : [];
  for (const f of filtros) {
    if (!f || !f.coluna || f.valor === undefined || f.valor === null) continue;
    const alvoVal = norm(f.valor);
    const operador = norm(f.operador || "contem");
    linhas = linhas.filter((l) => {
      const keys = Object.keys(l);
      let col = resolverColuna(f.coluna, keys);
      // Se pediu STATUS mas a aba usa SITUAÇÃO (ou vice-versa), acha a de status.
      if (!col && ehConceitoStatus(f.coluna)) col = colunaStatusDe(keys);
      if (!col) return false;
      const v = norm(l[col]);
      if (!v) return false;
      return operador.startsWith("igual") ? v === alvoVal : v.includes(alvoVal);
    });
  }

  const operacao = norm(plano.operacao || "contar");
  const porAba = {};
  for (const l of linhas) porAba[l._aba] = (porAba[l._aba] || 0) + 1;

  if (operacao.startsWith("som") || operacao.startsWith("med")) {
    // alguma coluna de valor
    const col0 = plano.coluna_valor || plano.colunaValor || "";
    let soma = 0, comValor = 0, semValor = 0;
    for (const l of linhas) {
      const col = resolverColuna(col0, Object.keys(l));
      const n = col ? parseNumeroBR(l[col]) : null;
      if (n === null) { semValor++; continue; }
      soma += n; comValor++;
    }
    const valor = operacao.startsWith("med") ? (comValor ? soma / comValor : 0) : soma;
    return {
      tipo: operacao.startsWith("med") ? "media" : "soma",
      coluna: col0, valor, soma, comValor, semValor, total: linhas.length, porAba,
      resumoTexto:
        `${operacao.startsWith("med") ? "Média" : "Soma"} de ${col0}: ${fmtNum(valor)} ` +
        `(em ${comValor} registro(s) com valor; ${semValor} sem valor; ${linhas.length} no recorte).`,
    };
  }

  if (operacao.startsWith("list")) {
    const campos = (Array.isArray(plano.campos) ? plano.campos : [plano.campos])
      .filter(Boolean);
    const itens = linhas.slice(0, 60).map((l) => {
      if (!campos.length) {
        const col = resolverColuna("OBJETO", Object.keys(l)) || resolverColuna("RUA", Object.keys(l));
        return { aba: l._aba, texto: col ? String(l[col]) : `linha ${l._linha}` };
      }
      const partes = campos.map((c) => {
        const col = resolverColuna(c, Object.keys(l));
        return col ? `${col}: ${l[col]}` : null;
      }).filter(Boolean);
      return { aba: l._aba, texto: partes.join(" — ") };
    });
    return {
      tipo: "lista", total: linhas.length, porAba, itens,
      resumoTexto: `${linhas.length} registro(s) encontrados. Lista (até 60): ` +
        itens.map((i) => `• ${i.texto} [${i.aba}]`).join("\n"),
    };
  }

  // padrão: contagem
  const porAbaTxt = Object.entries(porAba).map(([a, n]) => `${a}: ${n}`).join("; ");
  return {
    tipo: "contagem", total: linhas.length, porAba,
    resumoTexto: `${linhas.length} registro(s)` + (porAbaTxt ? ` — por aba: ${porAbaTxt}.` : "."),
  };
}

const PLANO_SYSTEM = `Você traduz a pergunta do cidadão num PLANO JSON para consultar a planilha de obras.
NÃO calcule nada: só diga O QUE consultar. Quem conta/soma/lista é o sistema.
Responda SOMENTE com um JSON neste formato (sem texto fora do JSON):
{"abas":["NOME_DA_ABA"] ou ["todas"],
 "filtros":[{"coluna":"STATUS","operador":"igual","valor":"concluída"}],
 "operacao":"contar" | "listar" | "somar" | "media",
 "coluna_valor":"VALOR TOTAL DA OBRA",
 "campos":["OBJETO DA OBRA"]}
Regras:
- Use os nomes EXATOS de abas e colunas do ESQUEMA abaixo.
- "operador":"igual" para status exato (ex.: concluída); "contem" para texto parcial (bairro, rua, nome).
- "coluna_valor" só para somar/media. "campos" só para listar (o que mostrar).
- Não diferencie maiúscula/acento nos valores; o sistema normaliza.
- Quando a pergunta é sobre uma CATEGORIA que é o tema de uma aba, selecione ESSA aba e
  NÃO adicione filtro: licitações -> EM_LICITAÇÃO; projetos -> EM_PROJETO; pendências ->
  PENDÊNCIAS; obras (em geral/físicas) -> EM_ANDAMENTO e PAVIMENTAÇÃO. Nunca filtre por um
  valor igual ao nome da categoria (não existe STATUS "licitação").
- Obras físicas = EM_ANDAMENTO e PAVIMENTAÇÃO (não inclua projetos nem licitações).
EXEMPLOS:
- "quantas licitações?" -> {"abas":["EM_LICITAÇÃO"],"operacao":"contar"}
- "quantos projetos?" -> {"abas":["EM_PROJETO"],"operacao":"contar"}
- "quantas pendências?" -> {"abas":["PENDÊNCIAS"],"operacao":"contar"}
- "quantas obras concluídas?" -> {"abas":["EM_ANDAMENTO","PAVIMENTAÇÃO"],"filtros":[{"coluna":"STATUS","operador":"igual","valor":"concluída"}],"operacao":"contar"}
- "obras no bairro Centro" -> {"abas":["EM_ANDAMENTO","PAVIMENTAÇÃO"],"filtros":[{"coluna":"BAIRRO","operador":"contem","valor":"centro"}],"operacao":"listar","campos":["OBJETO DA OBRA"]}
- "valor total das obras concluídas" -> {"abas":["EM_ANDAMENTO"],"filtros":[{"coluna":"STATUS","operador":"igual","valor":"concluída"}],"operacao":"somar","coluna_valor":"VALOR TOTAL DA OBRA"}`;

async function responderComPlano(pergunta, obras, historico) {
  const esquema = montarEsquema(obras);
  const planoRaw = await chamarIAbruta(
    [
      { role: "system", content: `${PLANO_SYSTEM}\n\nESQUEMA:\n${esquema}` },
      ...historicoParaMensagens(historico),
      { role: "user", content: `Pergunta: "${pergunta}". Devolva só o JSON do plano.` },
    ],
    { max_tokens: 500, temperature: 0, reasoning_effort: "medium" }
  );
  const plano = extrairJSON(planoRaw);
  if (!plano) throw new Error("plano inválido");

  const resultado = executarPlano(plano, obras);

  // A IA só REDIGE a partir do resultado determinístico do Node.
  const resposta = await chamarIAbruta(
    [
      {
        role: "system",
        content: `Você é o assistente de obras de Mamanguape no WhatsApp.\n${REGRAS_RESPOSTA}`,
      },
      ...historicoParaMensagens(historico),
      {
        role: "user",
        content:
          `Pergunta: "${pergunta}".\n\nResultado JÁ CALCULADO pelo sistema sobre a planilha (use SOMENTE isto, ` +
          `não recalcule, não invente nomes nem números):\n${JSON.stringify(resultado).slice(0, 7000)}\n\n` +
          `Escreva a resposta final para o WhatsApp a partir desse resultado.`,
      },
    ],
    { max_tokens: 1200, temperature: 0.2, reasoning_effort: "low" }
  );

  return {
    resposta:
      String(resposta || "").trim() ||
      resultado.resumoTexto ||
      "Não consegui formular a resposta agora.",
    linhas: obras.length,
    modoAgente: "plano-node",
    plano,
  };
}

// MODO PANDASAI — a IA escreve e EXECUTA SQL sobre as abas (DuckDB), com
// auto-correção, no sandbox. Cada aba vira uma tabela com nome e descrição.
// O Node só REDIGE a frase final a partir do resultado já calculado.
async function responderComPandasAI(pergunta, obras, historico) {
  const grupos = agruparPorAba(obras);
  const abas = [];
  for (const [nome, linhas] of grupos) {
    const registros = linhas.map((l) => {
      const limpo = {};
      for (const [k, v] of Object.entries(l)) {
        if (CAMPOS_INTERNOS.has(k)) continue; // remove _aba/_linha/_avisos
        limpo[k] = v;
      }
      return limpo;
    });
    abas.push({ nome, descricao: significadoDaAba(nome), registros });
  }

  const regras = `${REGRAS_RESPOSTA}\n${REGRAS_INTERPRETACAO}`;
  const calc = await perguntarNoSandbox(pergunta, abas, regras); // { ok, tipo, valor, texto }

  // A IA só REDIGE a partir do resultado JÁ CALCULADO pelo PandasAI.
  const resposta = await chamarIAbruta(
    [
      {
        role: "system",
        content: `Você é o assistente de obras de Mamanguape no WhatsApp.\n${REGRAS_RESPOSTA}`,
      },
      ...historicoParaMensagens(historico),
      {
        role: "user",
        content:
          `Pergunta: "${pergunta}".\n\nResultado JÁ CALCULADO pelo sistema sobre a planilha ` +
          `(use SOMENTE isto, não recalcule, não invente nomes nem números):\n` +
          `${JSON.stringify({ tipo: calc.tipo, valor: calc.valor }).slice(0, 7000)}\n\n` +
          `Escreva a resposta final para o WhatsApp a partir desse resultado.`,
      },
    ],
    { max_tokens: 1200, temperature: 0.2, reasoning_effort: "low" }
  );

  return {
    resposta:
      String(resposta || "").trim() ||
      calc.texto ||
      "Não consegui formular a resposta agora.",
    linhas: obras.length,
    modoAgente: "pandasai",
    tipo: calc.tipo,
    valor: calc.valor,
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

  // 1º: PandasAI (a IA escreve e EXECUTA SQL, com auto-correção) — só quando
  // o sandbox está ligado. É o modo mais robusto para cálculos.
  if (sandboxDisponivel()) {
    try {
      return await responderComPandasAI(texto, obras, historico);
    } catch (e0) {
      console.warn("PandasAI falhou, tentando próximo modo:", e0.message);
    }
  }
  // 2º: modo PLANO determinístico (Node calcula). 3º: sandbox de código.
  // 4º: contexto. Cada um cai para o próximo se falhar.
  try {
    return await responderComPlano(texto, obras, historico);
  } catch (e1) {
    console.warn("Plano falhou, tentando próximo modo:", e1.message);
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

export { montarContextoCompleto as montarContexto, montarEsquema, extrairCodigo, ehSaudacao, executarPlano };
export default { responderPergunta };
