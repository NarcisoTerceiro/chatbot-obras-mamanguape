// ============================================================
// analistaPython.js - Ponte Node -> Python (pandas) do agente
// ============================================================
// Fluxo (Program-of-Thoughts + Self-Debugging):
// 1) Carrega a planilha inteira (somente leitura, com cache) da view/tabela.
// 2) Gera um PERFIL real das colunas (tipos, preenchimento, exemplos) via Python.
// 3) A IA escreve codigo pandas que atribui `resultado`.
// 4) Python executa em ambiente restrito; se der erro, o traceback real volta
//    para a IA corrigir (ate MAX_REPAROS_PY vezes).
// 5) O resultado (tabela/valor) volta para a redacao final do agente.
// ============================================================
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.AGENTE_PY_SCRIPT || path.join(DIR, "analista.py");
const PYTHON = process.env.AGENTE_PYTHON || (process.platform === "win32" ? "python" : "python3");
const MAX_REPAROS_PY = Math.max(0, Math.min(Number(process.env.AGENTE_MAX_REPAROS_PY || 3), 5));
const MAX_LINHAS_BASE = Math.max(500, Math.min(Number(process.env.AGENTE_MAX_LINHAS_PY || 20000), 100000));
const CACHE_BASE_MS = Math.max(30_000, Number(process.env.AGENTE_CACHE_BASE_PY_MS || 180_000));
const TIMEOUT_PROC_MS = 20_000;

let cacheBase = { quando: 0, relacao: null, rows: null, perfil: null };
let pythonDisponivel = null;

export function rodarPython(payload) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let proc;
    try {
      proc = spawn(PYTHON, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, erro: `Python indisponivel: ${e.message}`, indisponivel: true });
    }
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, TIMEOUT_PROC_MS);
    proc.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, erro: `Python indisponivel: ${e.message}`, indisponivel: true }); });
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", () => {
      clearTimeout(timer);
      const linha = out.trim().split("\n").pop() || "";
      try { resolve(JSON.parse(linha)); }
      catch { resolve({ ok: false, erro: (err || out || "Saida invalida do Python").slice(-1500) }); }
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}

export async function pythonOk() {
  if (pythonDisponivel !== null) return pythonDisponivel;
  const r = await rodarPython({ modo: "perfil", dados: [] });
  pythonDisponivel = !!r.ok;
  if (!pythonDisponivel) console.warn("ANALISTA PY: desativado ->", r.erro);
  return pythonDisponivel;
}

export async function carregarBase(queryReadOnly, relacao) {
  if (cacheBase.rows && cacheBase.relacao === relacao && Date.now() - cacheBase.quando < CACHE_BASE_MS) return cacheBase;
  const r = await queryReadOnly(`SELECT * FROM public.${relacao} LIMIT ${MAX_LINHAS_BASE}`);
  const rows = r.rows || [];
  const p = await rodarPython({ modo: "perfil", dados: rows });
  cacheBase = { quando: Date.now(), relacao, rows, perfil: p.ok ? p.perfil : [] };
  return cacheBase;
}

function perfilParaPrompt(perfil = []) {
  return perfil.map((c) => {
    const base = `- ${c.coluna} (${c.tipo}${c.origem !== "coluna" ? `, chave da planilha "${c.origem}"` : ""}; preenchidos=${c.preenchidos})`;
    if (c.tipo === "numero") return `${base} min=${c.min} max=${c.max}`;
    return `${base} distintos=${c.distintos} exemplos=${JSON.stringify((c.exemplos || []).map((x) => String(x).slice(0, 60)))}`;
  }).join("\n");
}

function extrairCodigo(texto = "") {
  const t = String(texto || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const bloco = t.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (bloco ? bloco[1] : t).trim();
}

const REGRAS_PANDAS = `
VOCE E UM ANALISTA DE DADOS PYTHON (pandas) de um chatbot de obras publicas.
Ja existe um DataFrame \`df\` com TODA a planilha (uma linha por registro). As chaves de dados_extras ja viraram colunas (nomes em snake_case sem acento).
Escreva SOMENTE codigo Python (sem import, sem print obrigatorio) que atribua a variavel \`resultado\`.
Disponivel: pd, np, re, math, df, HOJE (Timestamp de hoje), e helpers:
  numero_br(v) -> float de 'R$ 1.234,56' / '45%'
  data_br(v) -> Timestamp de 'dd/mm/aaaa'
  contem(serie, 'termo') -> mascara booleana tolerante a acento/caixa
  sem_acento(texto)
REGRAS:
- Responda EXATAMENTE ao que foi perguntado; nao invente colunas: use apenas as do PERFIL.
- tipo_negocio separa 'obra', 'projeto' e 'licitacao'. Filtre o universo certo quando a pergunta indicar.
- Filtros de texto: SEMPRE contem(df['col'], 'termo'), nunca ==, salvo valores exatos vistos nos exemplos.
- Numeros em texto: df['col'].map(numero_br). Datas: df['col'].map(data_br).
- Atrasos/vencimentos: compare datas com HOJE.
- Para listas, \`resultado\` deve ser um DataFrame com 'objeto' + campos pedidos (sem limite artificial).
- Para totais/medias/rankings: use groupby/agg e devolva DataFrame com a entidade + medida (ex.: engenheiro, qtd_obras, valor_total). Inclua os componentes quando for uma soma de poucos itens.
- Valores vazios: trate '' e None como ausentes (df['col'].replace('', np.nan)).
- Ranking por entidade "sem responsavel": mantenha separado como 'Sem cadastro'.
- Se a pergunta nao puder ser respondida com o perfil, resultado = {"aviso": "explicacao curta do que falta na planilha"}.
- Nada de open, os, sys, arquivos, rede, atributos com _ ou __.
`;

async function gerarCodigo(chamarIAbruta, { pergunta, historicoTxt, perfil, linhas, erro, codigoAnterior, dica }) {
  const prompt = REGRAS_PANDAS +
    `\nPERFIL REAL DO df (${linhas} linhas):\n${perfilParaPrompt(perfil)}\n\n` +
    `HISTORICO RECENTE (use para resolver 'essas', 'dele', 'e o valor?'):\n${historicoTxt || "(vazio)"}\n\n` +
    (dica ? `CONTEXTO: ${dica}\n\n` : "") +
    (erro ? `O CODIGO ANTERIOR FALHOU. Corrija usando o erro real.\nCODIGO:\n${codigoAnterior}\nERRO:\n${erro}\n\n` : "") +
    `PERGUNTA: ${JSON.stringify(pergunta)}\n` +
    `Responda apenas com um bloco \`\`\`python ... \`\`\`.`;
  const bruto = await chamarIAbruta([{ role: "user", content: prompt }], { max_tokens: 700, temperature: 0, reasoning_effort: "low" });
  return extrairCodigo(bruto);
}

// Converte o resultado do Python em "rows" compativeis com a redacao do agente.
function paraRows(r) {
  if (!r?.ok) return [];
  if (r.tipo === "tabela") return Array.isArray(r.resultado) ? r.resultado : [];
  if (r.tipo === "objeto") return [r.resultado];
  if (r.tipo === "lista") return r.resultado.map((v) => ({ valor: v }));
  return [{ resultado: r.resultado }];
}

/**
 * Analisa a pergunta com pandas. Retorna { ok, rows, codigo, tentativas, aviso }.
 */
export async function analisarComPython({ pergunta, historicoTxt, relacao, queryReadOnly, chamarIAbruta, dica = "" }) {
  if (!(await pythonOk())) return { ok: false, motivo: "python_indisponivel", rows: [] };
  const base = await carregarBase(queryReadOnly, relacao);
  if (!base.rows.length) return { ok: false, motivo: "base_vazia", rows: [] };

  const tentativas = [];
  let codigo = "", erro = "";
  for (let i = 0; i <= MAX_REPAROS_PY; i++) {
    codigo = await gerarCodigo(chamarIAbruta, {
      pergunta, historicoTxt, perfil: base.perfil, linhas: base.rows.length,
      erro, codigoAnterior: codigo, dica,
    });
    if (!codigo) { erro = "Nenhum codigo gerado."; tentativas.push({ i, erro }); continue; }
    const r = await rodarPython({ modo: "executar", codigo, dados: base.rows });
    if (r.ok) {
      const rows = paraRows(r);
      const aviso = r.tipo === "objeto" && r.resultado?.aviso ? r.resultado.aviso : null;
      tentativas.push({ i, ok: true, linhas: rows.length });
      // Resultado vazio pode estar certo, mas tenta 1 reparo semantico.
      if (!rows.length && i < MAX_REPAROS_PY && !erro.startsWith("VAZIO")) {
        erro = "VAZIO: o codigo executou mas retornou 0 registros. Verifique filtros (acentos, grafia, universo tipo_negocio, coluna certa). Se realmente nao existir, mantenha.";
        continue;
      }
      return { ok: true, rows, codigo, tentativas, aviso, tipo: r.tipo };
    }
    erro = r.erro || "erro desconhecido";
    tentativas.push({ i, ok: false, erro });
    console.warn(`ANALISTA PY - tentativa ${i} falhou:`, erro);
  }
  return { ok: false, motivo: "falhou_apos_reparos", erro, codigo, tentativas, rows: [] };
}

// Perguntas que pedem calculo/analise que pandas resolve melhor que SQL gerado.
export function perguntaAnalitica(pergunta = "") {
  const p = String(pergunta).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(media|mediana|desvio|percentual|porcentagem|proporcao|participacao|compar|diferenca|variacao|tendencia|evolucao|por (mes|ano|trimestre|semestre)|mensal|anual|correlac|distribuicao|ranking|top \d+|maior(es)?|menor(es)?|atrasad|vencid|prazo|dias|quanto tempo|analis[ea] (os|as|a|o) dados|estatistic|panorama|resumo geral|soma|somatorio|acumulad)\b/.test(p);
}
