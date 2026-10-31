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

const REGRAS_RESPOSTA = `Responda em português do Brasil, só com os fatos calculados. É WhatsApp:
não use tabelas Markdown, barras verticais (|), blocos de código, nem títulos com #.
Organize listas com travessão (—), um item por bloco, uma linha em branco entre itens, e
*negrito do WhatsApp* (um asterisco de cada lado) no nome de cada item. Comece pela resposta
direta. Inclua só os campos pedidos ou indispensáveis para identificar o registro. Não ofereça
menus de opções no final. Não invente números: use apenas o resultado calculado.`;

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
  return (bloco ? bloco[1] : t).trim();
}

// ---- MODO 1: execução de código no sandbox Python (igual ao Data Formulator) ----
async function responderComSandbox(pergunta, obras, historico) {
  const esquema = montarEsquema(obras);
  const instrucoesCodigo =
    `Você analisa a planilha de obras públicas escrevendo código Python (pandas).\n` +
    `Os dados estão num DataFrame chamado df (todas as abas juntas; a coluna _aba diz a aba).\n` +
    `${REGRAS_INTERPRETACAO}\n\n` +
    `Escreva SOMENTE código Python, sem explicação, que calcule a resposta e atribua a uma\n` +
    `variável chamada resultado (um número, texto, lista ou dict pequeno — já pronto para ser\n` +
    `exibido). Regras do ambiente: NÃO use import, open, arquivos nem rede (só df, pd e funções\n` +
    `básicas). Para dinheiro em texto brasileiro (ex.: "1.250.000,00"), limpe com métodos de\n` +
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
    // Não conseguiu calcular com código: devolve orientação, sem inventar número.
    return {
      resposta:
        "Não consegui calcular isso com segurança agora. Pode reformular a pergunta ou pedir de outra forma?",
      erro: "falha_codigo",
      diagnostico: erroAnterior,
      codigo: codigoFinal || null,
      linhas: obras.length,
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

export { montarContextoCompleto as montarContexto, montarEsquema };
export default { responderPergunta };
