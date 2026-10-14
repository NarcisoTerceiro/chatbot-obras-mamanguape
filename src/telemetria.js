// Métricas por atendimento. Usa apenas módulos nativos do Node.js 18+.
// Não armazena prompts, SQL, nomes, telefones, respostas nem credenciais.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const contexto = new AsyncLocalStorage();
const MAX_EVENTOS = 100;
const arredondar = n => Math.round(n * 100) / 100;
const numero = n => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const erroSeguro = e => ["AbortError", "TimeoutError", "SyntaxError", "TypeError"].includes(e?.name) ? e.name : "Error";
const canalSeguro = canal => ["teste", "whatsapp", "direto"].includes(canal) ? canal : "direto";
const adicionar = (lista, item) => { if (lista.length < MAX_EVENTOS) lista.push(item); };

function novaMedicao(canal) {
  return {
    versao: "etapa1",
    consulta_id: randomUUID(),
    canal: canalSeguro(canal),
    total_ms: 0,
    status: "ok",
    etapas: {},
    cache_schema: { acertos: 0, faltas: 0 },
    ia: {
      chamadas_logicas: 0,
      requisicoes_http: 0,
      caracteres_entrada: 0,
      requisicoes_com_uso: 0,
      tokens_reportados: { entrada: null, saida: null, total: null, raciocinio: null },
      tentativas: [],
    },
    parser_sql: [],
  };
}

// As etapas se sobrepõem: schema/geração/reparo/redação podem incluir banco/HTTP.
// total_ms é o tempo de parede; não se deve somar todas as etapas.
export async function medirEtapa(nome, executar) {
  const atual = contexto.getStore();
  if (!atual) return executar();
  const inicio = performance.now();
  const etapa = atual.metricas.etapas[nome] ||= { ms: 0, execucoes: 0, falhas: 0 };
  etapa.execucoes++;
  try {
    return await contexto.run({ ...atual, etapa: nome }, executar);
  } catch (e) {
    etapa.falhas++;
    throw e;
  } finally {
    etapa.ms = arredondar(etapa.ms + performance.now() - inicio);
  }
}

export function registrarCacheSchema(acerto) {
  const m = contexto.getStore()?.metricas;
  if (m) m.cache_schema[acerto ? "acertos" : "faltas"]++;
}

export function registrarChamadaIA(mensagens = []) {
  const m = contexto.getStore()?.metricas;
  if (!m) return;
  m.ia.chamadas_logicas++;
  m.ia.caracteres_entrada += mensagens.reduce((soma, item) => soma + String(item?.content ?? "").length, 0);
}

function usoTokens(provedor, dados) {
  const u = provedor === "gemini" ? dados?.usageMetadata : dados?.usage;
  if (!u || typeof u !== "object") return null;
  const uso = provedor === "gemini"
    ? { entrada: numero(u.promptTokenCount), saida: numero(u.candidatesTokenCount), total: numero(u.totalTokenCount), raciocinio: numero(u.thoughtsTokenCount) }
    : { entrada: numero(u.prompt_tokens), saida: numero(u.completion_tokens), total: numero(u.total_tokens), raciocinio: numero(u.completion_tokens_details?.reasoning_tokens) };
  return Object.values(uso).some(n => n !== null) ? uso : null;
}

// O callback devolve somente o resultado já lido da requisição HTTP.
// A medição inclui a leitura/parse do corpo. Dados brutos não entram na métrica.
export async function medirRequisicaoIA({ provedor, modelo }, executar) {
  const atual = contexto.getStore();
  if (!atual) return executar();
  const m = atual.metricas;
  const inicio = performance.now();
  const tentativa = {
    etapa: atual.etapa || "agente",
    provedor,
    modelo,
    ms: 0,
    status_http: null,
    erro: null,
    finalizacao: null,
    caracteres_saida: null,
    uso: null,
  };
  m.ia.requisicoes_http++;
  adicionar(m.ia.tentativas, tentativa);
  try {
    return await medirEtapa("ia_http", async () => {
      const r = await executar();
      tentativa.status_http = numero(r?.status);
      const dados = r?.data;
      const choice = dados?.choices?.[0];
      const candidate = dados?.candidates?.[0];
      const finalizacao = provedor === "gemini" ? candidate?.finishReason : choice?.finish_reason;
      // Lista fechada evita copiar texto arbitrário de uma resposta HTTP para logs.
      tentativa.finalizacao = ["stop", "length", "tool_calls", "content_filter", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER"].includes(finalizacao) ? finalizacao : null;
      const texto = provedor === "gemini"
        ? (candidate?.content?.parts || []).filter(p => p?.thought !== true).map(p => typeof p?.text === "string" ? p.text : "").join("")
        : choice?.message?.content;
      tentativa.caracteres_saida = typeof texto === "string" ? texto.length : null;
      tentativa.uso = usoTokens(provedor, dados);
      if (tentativa.uso) {
        m.ia.requisicoes_com_uso++;
        for (const [campo, valor] of Object.entries(tentativa.uso)) {
          if (valor !== null) m.ia.tokens_reportados[campo] = (m.ia.tokens_reportados[campo] ?? 0) + valor;
        }
      }
      return r;
    });
  } catch (e) {
    tentativa.erro = erroSeguro(e);
    throw e;
  } finally {
    tentativa.ms = arredondar(performance.now() - inicio);
  }
}

export function registrarSaidaSQL({ formato, caracteres, sqlExtraida }) {
  const atual = contexto.getStore();
  if (!atual) return;
  adicionar(atual.metricas.parser_sql, {
    etapa: atual.etapa || "agente",
    formato: ["json", "json_invalido", "bloco", "texto", "vazio", "outro"].includes(formato) ? formato : "outro",
    caracteres: numero(caracteres),
    sql_extraida: sqlExtraida === true,
  });
}

// Reutiliza o contexto do WhatsApp quando o agente é chamado dentro dele.
// Cada atendimento concorrente tem seu próprio AsyncLocalStorage.
export async function executarComMetricas(canal, executar, { logger = console.log } = {}) {
  if (contexto.getStore()) return executar();
  const metricas = novaMedicao(canal);
  const inicio = performance.now();
  return contexto.run({ metricas, etapa: "agente" }, async () => {
    let resultado;
    try {
      resultado = await executar();
      if (resultado?.erro) metricas.status = "falha";
    } catch (e) {
      metricas.status = "falha";
      metricas.erro = erroSeguro(e);
      throw e;
    } finally {
      metricas.total_ms = arredondar(performance.now() - inicio);
      // Falha do logger não pode derrubar o atendimento.
      if (process.env.AGENTE_LOG_METRICAS !== "false") {
        try { logger(JSON.stringify({ evento: "chatbot_metricas", ...metricas })); } catch {}
      }
    }
    if (resultado && typeof resultado === "object" && !Array.isArray(resultado)) {
      return { ...resultado, metricas };
    }
    return resultado;
  });
}
