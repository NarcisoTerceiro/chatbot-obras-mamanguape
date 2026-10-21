// ============================================================
// compreensao.js - CAMADA DE COMPREENSAO DO AGENTE (V14)
// ============================================================
// Pipeline geral (nao depende de regras por frase):
//
//   1. ENTENDER   -> a IA le pergunta + memoria + schema e devolve uma
//                    pergunta AUTONOMA (sem pronomes), a intencao, os termos
//                    citados e a confianca. Se faltar algo essencial, devolve
//                    UMA pergunta de esclarecimento.
//   2. ANCORAR    -> cada termo citado e procurado nos VALORES REAIS do banco
//                    (sem acento/caixa, por palavra). Assim "joao", "ubs do
//                    centro", "pav. rua 10" viram valores que existem de fato.
//                    Se um nome bate em varias pessoas diferentes, pergunta qual.
//   3. VERIFICAR  -> depois de executar a SQL, a IA confere se as linhas
//                    respondem MESMO a pergunta. Se nao, explica o motivo e o
//                    agente refaz a consulta uma vez.
//
// Memoria: o estado devolvido (perguntaAutonoma, entidades, clarificacao
// pendente) vai no historico e e relido no proximo turno.
// ============================================================

import { queryReadOnly } from "./db.js";
import { chamarIAbruta } from "./groq.js";

const CAMPOS_ANCORA = ["engenheiro", "empresa", "bairro", "objeto", "recurso", "tipo_recurso", "status", "status_original"];
const CAMPOS_PESSOA = new Set(["engenheiro", "empresa"]);

const STOPWORDS = new Set(
  "a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que qual quais quanto quantos quantas quem onde como tem ter e sao ser foi esta estao obra obras projeto projetos licitacao licitacoes rua av avenida".split(" ")
);

export function normalizar(s = "") {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function texto(s = "", max = 600) {
  return String(s ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function lerJSON(bruto = "") {
  const t = String(bruto || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const ini = t.indexOf("{");
  const fim = t.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(t.slice(ini, fim + 1)); } catch { return null; }
}

function ultimoEstado(historico = []) {
  if (!Array.isArray(historico)) return null;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m?.role === "assistant") return m?.estado || null;
  }
  return null;
}

function historicoCurto(historico = []) {
  if (!Array.isArray(historico) || !historico.length) return "(sem conversa anterior)";
  const resumo = historico.find((m) => m?.memoriaResumo === true);
  const recentes = historico.filter((m) => m?.memoriaResumo !== true).slice(-8);
  return [resumo, ...recentes].filter(Boolean).map((m) => {
    const papel = m.memoriaResumo ? "MEMORIA" : m.role === "assistant" ? "ASSISTENTE" : "USUARIO";
    const autonoma = m?.estado?.perguntaAutonoma ? ` [entendido como: ${texto(m.estado.perguntaAutonoma, 250)}]` : "";
    return `${papel}: ${texto(m.content, m.memoriaResumo ? 1000 : 350)}${autonoma}`;
  }).join("\n");
}

function resumoSchema(ctx) {
  const cols = (ctx?.colunas || []).map((c) => c.column_name).join(", ");
  const extras = (ctx?.chavesDadosExtras || []).slice(0, 100).join(" | ");
  const cats = Object.entries(ctx?.categorias || {})
    .filter(([k, v]) => v?.length && ["tipo_negocio", "status", "subtipo_negocio"].includes(k))
    .map(([k, v]) => `${k}: ${v.slice(0, 12).join(" | ")}`).join("\n");
  return `COLUNAS: ${cols}\nCAMPOS EXTRAS DA PLANILHA: ${extras || "-"}\n${cats}`;
}

// ------------------------------------------------------------
// 1. ENTENDER
// ------------------------------------------------------------
export async function entenderPergunta(pergunta, historico, ctx) {
  const estado = ultimoEstado(historico);
  const pendente = estado?.aguardandoClarificacao ? estado : null;

  const prompt =
    `Voce e a camada de COMPREENSAO de um assistente que responde perguntas sobre uma planilha de obras publicas ` +
    `(obras, projetos, licitacoes, valores, engenheiros, empresas, bairros, recursos, prazos, status e qualquer outro campo).\n\n` +
    `Sua tarefa: entender o que o usuario quer, usando a conversa como memoria.\n\n` +
    `DIRETRIZES:\n` +
    `- Reescreva a pergunta como uma PERGUNTA AUTONOMA, completa e clara, trocando pronomes e referencias ("ela", "dessas", "e o valor?", "e no centro?") pelo que foi dito antes.\n` +
    `- Corrija erros de digitacao e girias sem mudar o sentido.\n` +
    `- Se o usuario mudar claramente de assunto, NAO carregue o recorte anterior.\n` +
    `- Entenda QUALQUER pergunta: contagem, lista, soma, media, ranking, comparacao, prazos, atrasos, quem cuida, onde fica, quanto falta, resumo geral etc.\n` +
    `- So marque "ambigua" quando for IMPOSSIVEL responder bem sem perguntar (ex.: duas interpretacoes que dao resultados muito diferentes e o contexto nao decide). Na duvida leve, escolha a interpretacao mais provavel e siga.\n` +
    `- Se for "ambigua", escreva UMA pergunta curta de esclarecimento, oferecendo as opcoes.\n` +
    `- "conversa" = cumprimento, agradecimento, pergunta sobre o proprio assistente. Responda em "resposta_direta".\n` +
    `- "fora_escopo" = nada a ver com a planilha. Responda educadamente em "resposta_direta" dizendo o que voce sabe responder.\n` +
    `- Liste em "termos" os nomes proprios/valores citados que precisam existir na base (pessoa, empresa, bairro, rua, equipamento), com o campo provavel.\n` +
    (pendente
      ? `\nATENCAO: na mensagem anterior VOCE pediu esclarecimento: ${JSON.stringify(pendente.perguntaClarificacao || "")}\n` +
        `A pergunta original era: ${JSON.stringify(pendente.perguntaOriginal || "")}\n` +
        `A mensagem atual provavelmente e a RESPOSTA a esse esclarecimento: combine as duas numa pergunta autonoma.\n`
      : "") +
    `\nESTRUTURA DOS DADOS:\n${resumoSchema(ctx)}\n\n` +
    `CONVERSA RECENTE:\n${historicoCurto(historico)}\n\n` +
    `MENSAGEM ATUAL: ${JSON.stringify(pergunta)}\n\n` +
    `Responda SOMENTE com JSON:\n` +
    `{"tipo":"dados|conversa|fora_escopo|ambigua","pergunta_autonoma":"...","termos":[{"termo":"...","campo":"engenheiro|empresa|bairro|objeto|recurso|status|outro"}],` +
    `"confianca":0.0,"pergunta_clarificacao":"","resposta_direta":""}`;

  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], { max_tokens: 500, temperature: 0, reasoning_effort: "low" });
    const j = lerJSON(bruto);
    if (!j) return null;
    const tipo = ["dados", "conversa", "fora_escopo", "ambigua"].includes(j.tipo) ? j.tipo : "dados";
    return {
      tipo,
      perguntaAutonoma: texto(j.pergunta_autonoma || pergunta, 800) || pergunta,
      termos: Array.isArray(j.termos) ? j.termos.filter((t) => t?.termo).slice(0, 6) : [],
      confianca: Math.max(0, Math.min(1, Number(j.confianca) || 0)),
      perguntaClarificacao: texto(j.pergunta_clarificacao || "", 400),
      respostaDireta: texto(j.resposta_direta || "", 800),
      vinhaDeClarificacao: !!pendente,
    };
  } catch (e) {
    console.warn("COMPREENSAO: falha ao entender, seguindo com a pergunta original:", e.message);
    return null;
  }
}

// ------------------------------------------------------------
// 2. ANCORAR termos nos valores reais do banco
// ------------------------------------------------------------
const SEM_ACENTO = (col) => `translate(lower(${col}::text),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')`;

function palavrasChave(termo) {
  return normalizar(termo).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w)).slice(0, 4);
}

export async function ancorarTermos(termos = [], ctx) {
  const nomes = new Set((ctx?.colunas || []).map((c) => c.column_name));
  const achados = [];

  for (const t of termos) {
    const palavras = palavrasChave(t.termo);
    if (!palavras.length) continue;
    const preferido = CAMPOS_ANCORA.includes(t.campo) && nomes.has(t.campo) ? [t.campo] : [];
    const campos = [...new Set([...preferido, ...CAMPOS_ANCORA.filter((c) => nomes.has(c))])];

    let melhor = null;
    for (const campo of campos) {
      const params = palavras.map((w) => `%${w}%`);
      const cond = palavras.map((_, i) => `${SEM_ACENTO(campo)} LIKE $${i + 1}`).join(" AND ");
      try {
        const r = await queryReadOnly(
          `SELECT ${campo}::text AS valor, COUNT(*)::int AS qtd FROM public.${ctx.relacao} WHERE ${cond} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
          params
        );
        const valores = (r.rows || []).filter((x) => x.valor && x.valor.trim());
        if (valores.length) { melhor = { campo, valores }; break; }
      } catch { /* campo nao textual: ignora */ }
    }

    // Busca mais solta (qualquer palavra) quando nenhuma combinacao exata existe.
    if (!melhor && palavras.length > 1) {
      const campo = preferido[0] || (nomes.has("objeto") ? "objeto" : null);
      if (campo) {
        try {
          const cond = palavras.map((_, i) => `${SEM_ACENTO(campo)} LIKE $${i + 1}`).join(" OR ");
          const r = await queryReadOnly(
            `SELECT ${campo}::text AS valor, COUNT(*)::int AS qtd FROM public.${ctx.relacao} WHERE ${cond} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
            palavras.map((w) => `%${w}%`)
          );
          const valores = (r.rows || []).filter((x) => x.valor && x.valor.trim());
          if (valores.length) melhor = { campo, valores, aproximado: true };
        } catch { /* ignora */ }
      }
    }

    achados.push({ termo: t.termo, campoSugerido: t.campo, ...(melhor || { campo: null, valores: [] }) });
  }
  return achados;
}

// Pessoa/empresa citada que bate em varios nomes diferentes -> perguntar qual.
export function clarificacaoPorAmbiguidadeDeNome(achados = []) {
  for (const a of achados) {
    if (!a.campo || !CAMPOS_PESSOA.has(a.campo) || a.aproximado) continue;
    const distintos = [...new Set(a.valores.map((v) => v.valor.trim()))];
    const exato = distintos.find((v) => normalizar(v) === normalizar(a.termo));
    if (!exato && distintos.length >= 2 && distintos.length <= 6) {
      return `Encontrei mais de um ${a.campo} parecido com "${a.termo}": ${distintos.join(", ")}. Qual deles você quer?`;
    }
  }
  return null;
}

export function dicasDeAncoragem(achados = []) {
  if (!achados.length) return "";
  const linhas = achados.map((a) => {
    if (!a.campo) return `- "${a.termo}": NAO existe na base com esse nome. Se a consulta voltar vazia, diga isso claramente.`;
    const vals = a.valores.map((v) => `${v.valor} (${v.qtd})`).join(" | ");
    return `- "${a.termo}" corresponde a valores REAIS em ${a.campo}${a.aproximado ? " (correspondencia aproximada)" : ""}: ${vals}. ` +
      `Filtre usando esses valores reais (translate/lower + ILIKE), nao o texto digitado.`;
  });
  return `ANCORAGEM DE TERMOS (valores conferidos no banco agora):\n${linhas.join("\n")}`;
}

// ------------------------------------------------------------
// 3. VERIFICAR se o resultado responde a pergunta
// ------------------------------------------------------------
export async function verificarResultado(perguntaAutonoma, sql, rows = []) {
  const amostra = JSON.stringify(rows.slice(0, 15)).slice(0, 3500);
  const prompt =
    `Voce e o REVISOR de um agente SQL. Avalie se o resultado responde EXATAMENTE a pergunta.\n` +
    `Verifique: filtro certo (obra/projeto/licitacao, pessoa, bairro, status), metrica certa (contagem x soma x maximo), ` +
    `campo pedido presente, agrupamento certo. Resultado vazio e CORRETO se a SQL procurou o que foi pedido e simplesmente nao existe.\n\n` +
    `PERGUNTA: ${JSON.stringify(perguntaAutonoma)}\nSQL: ${sql}\nLINHAS (${rows.length}): ${amostra}\n\n` +
    `Responda SOMENTE JSON {"ok":true|false,"motivo":"o que esta errado e como corrigir, se ok=false"}`;
  try {
    const bruto = await chamarIAbruta([{ role: "user", content: prompt }], { max_tokens: 220, temperature: 0, reasoning_effort: "low" });
    const j = lerJSON(bruto);
    if (!j) return { ok: true };
    return { ok: j.ok !== false, motivo: texto(j.motivo || "", 600) };
  } catch {
    return { ok: true };
  }
}
