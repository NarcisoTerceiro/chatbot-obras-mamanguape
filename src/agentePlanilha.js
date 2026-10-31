// ============================================================
// agentePlanilha.js — Agente que lê a PLANILHA direto (sem banco)
//
// Substitui o agente SQL/Postgres: carrega as abas do Google Sheets em
// memória (via sheets.js), monta um contexto com os metadados e as regras
// de interpretação do sistema de referência (Data Formulator) e deixa a IA
// (Groq/NVIDIA/Gemini via groq.js) responder qualquer pergunta sobre os dados.
//
// As contagens e somas são calculadas aqui no Node e entregues já verificadas
// para a IA, evitando aritmética "de cabeça" (a planilha é pequena e cabe
// inteira no contexto).
//
// Mantém a mesma assinatura do agente anterior:
//   responderPergunta(pergunta, historico, opts) -> { resposta, ... }
// ============================================================

import { getObras } from "./sheets.js";
import { chamarIAbruta } from "./groq.js";

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

// --- Metadados por aba (os mesmos significados do sistema de referência) ---
// A chave é o nome da aba normalizado (sem acento, minúsculo), para casar
// tanto "EM_LICITACAO" quanto "EM_LICITAÇÃO".
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

// --- Regras de resposta (adaptadas do prompt do sistema de referência) ---
const REGRAS = `Você é o assistente de obras públicas da Prefeitura de Mamanguape no WhatsApp.
Responda em português do Brasil, somente com fatos obtidos das tabelas fornecidas abaixo.
Não exponha código, SQL, caminhos ou logs. Não use tabelas Markdown, barras verticais (|),
blocos de código ou títulos com #. Organize listas com travessão (—), um item por bloco,
com uma linha em branco entre os itens. Use *negrito do WhatsApp* (um asterisco de cada lado)
no nome de cada item. Comece sempre pela resposta direta. Inclua só os campos pedidos ou
indispensáveis para identificar o registro. Não termine oferecendo menus de opções.

Interpretação dos dados (muito importante):
— O nome da aba não comprova o status. Em EM_ANDAMENTO, consulte a coluna STATUS.
— PAVIMENTAÇÃO são obras físicas; RUA identifica a obra e SITUAÇÃO é o status.
— EM_PROJETO são projetos técnicos: projeto concluído não é obra fisicamente concluída.
— EM_LICITAÇÃO descreve fases da contratação, não conclusão física.
— PENDÊNCIAS e "recursos a pagar" não são novas obras; "a pagar" não significa "pago".
— Não some projetos e licitações como se fossem obras físicas.
— Não deduplique registros só pelo nome: contratos e etapas podem ser registros diferentes.
— Valores contratado, executado e pago são diferentes. Célula vazia não é zero.

Cálculos: use SOMENTE os números do bloco "CONTAGENS VERIFICADAS" e os valores das linhas
fornecidas. Não invente contagens nem totais. Se faltar informação para calcular com
segurança, diga o que falta em vez de chutar um número.

Use o histórico da conversa para entender referências como "dessas obras". Se a pergunta
for ambígua, faça uma pergunta curta de esclarecimento. Responda de forma completa, mas
objetiva — é WhatsApp.`;

// Limite de caracteres do bloco de dados enviado à IA (protege o limite de
// tokens do plano gratuito). A planilha de Mamanguape cabe com folga.
const DADOS_MAX_CHARS = Math.max(
  10000,
  Math.min(Number(process.env.DADOS_MAX_CHARS || 48000), 120000)
);

const CAMPOS_INTERNOS = new Set(["_aba", "_linha", "_avisos"]);

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

// Contagens verificadas calculadas em Node (não pela IA): total por aba e,
// para colunas de status, a distribuição de valores.
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

function linhaCompacta(linha, colunas) {
  const campos = [];
  for (const col of colunas) {
    const v = linha[col];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    campos.push(`${col}=${String(v).trim()}`);
  }
  return `  [linha ${linha._linha}] ${campos.join(" | ")}`;
}

export function montarContexto(obras) {
  const grupos = agruparPorAba(obras);
  const blocosContagem = [];
  const blocosDados = [];

  for (const [aba, linhas] of grupos) {
    const colunas = colunasDaAba(linhas);
    blocosContagem.push(contagensVerificadas(aba, linhas, colunas));
    const cabecalho = `=== Aba ${aba} (${significadoDaAba(aba)}) ===\nColunas: ${colunas.join(
      ", "
    )}`;
    const corpo = linhas.map((l) => linhaCompacta(l, colunas)).join("\n");
    blocosDados.push(`${cabecalho}\n${corpo}`);
  }

  let dados = blocosDados.join("\n\n");
  let aviso = "";
  if (dados.length > DADOS_MAX_CHARS) {
    dados = dados.slice(0, DADOS_MAX_CHARS);
    aviso =
      "\n[Observação: os dados foram truncados por tamanho. Se a pergunta exigir uma aba não totalmente exibida, peça para o usuário restringir por aba ou bairro.]";
  }

  return (
    "CONTAGENS VERIFICADAS (use estes números para contagens):\n" +
    blocosContagem.join("\n") +
    "\n\nDADOS DAS TABELAS:\n" +
    dados +
    aviso
  );
}

function historicoParaMensagens(historico = []) {
  const msgs = [];
  for (const h of historico.slice(-6)) {
    if (!h || !h.role || !h.content) continue;
    if (h.role === "user" || h.role === "assistant") {
      msgs.push({ role: h.role, content: String(h.content) });
    }
  }
  return msgs;
}

export async function responderPergunta(pergunta, historico = [], opts = {}) {
  const texto = String(pergunta || "").trim();
  if (!texto) {
    return { resposta: "Pode me dizer sua pergunta sobre as obras?", linhas: 0 };
  }

  let obras;
  try {
    obras = await getObras();
  } catch (e) {
    console.error("Falha ao ler a planilha:", e.message);
    return {
      resposta:
        "Não consegui ler a planilha de obras agora. Tente novamente em instantes.",
      erro: "leitura_planilha",
    };
  }

  if (!obras.length) {
    return {
      resposta:
        "A planilha de obras está acessível, mas não encontrei registros. Confira se as abas têm dados e estão compartilhadas com a conta de serviço.",
      linhas: 0,
    };
  }

  const contexto = montarContexto(obras);
  const mensagens = [
    { role: "system", content: `${REGRAS}\n\n${contexto}` },
    ...historicoParaMensagens(historico),
    { role: "user", content: texto },
  ];

  try {
    const resposta = await chamarIAbruta(mensagens, {
      max_tokens: 1200,
      temperature: 0.2,
      reasoning_effort: "medium",
    });
    return {
      resposta: String(resposta || "").trim() || "Não consegui formular a resposta agora.",
      linhas: obras.length,
      canal: opts.canal || "whatsapp",
    };
  } catch (e) {
    console.error("Falha na IA:", e.message);
    return {
      resposta:
        "Tive um problema para responder agora. Pode tentar de novo em instantes?",
      erro: "falha_ia",
      linhas: obras.length,
    };
  }
}

export default { responderPergunta };
