// Adaptador de chamadas nativas de ferramentas. Node.js 18+; sem pacote adicional.
// Lê chaves apenas das variáveis de ambiente; nunca registra tokens ou prompts.
function configuracoes(env) {
  return [
    { nome: 'nvidia', chave: env.NVIDIA_API_KEY, modelo: env.NVIDIA_MODEL || 'openai/gpt-oss-120b',
      base: env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1' },
    { nome: 'groq', chave: env.GROQ_API_KEY, modelo: env.GROQ_MODEL || 'openai/gpt-oss-20b',
      base: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' },
    { nome: 'gemini', chave: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, modelo: env.GEMINI_MODEL,
      base: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai' },
  ].filter(c => c.chave);
}

export function criarChamadorTools({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function chamar(messages, tools, options = {}) {
    if (typeof fetchImpl !== 'function') throw Error('Use Node.js 18 ou superior.');
    if (!Array.isArray(messages) || !messages.length) throw Error('Lista de mensagens inválida.');
    if (!Array.isArray(tools) || !tools.length) throw Error('Catálogo de ferramentas inválido.');
    let configs = configuracoes(env);
    // Na redação, mantém o provedor que produziu as chamadas e seus metadados.
    const fixo = options.provider;
    const preferido = String(env.IA_PROVIDER || env.AI_PROVIDER || '').trim().toLowerCase();
    if (fixo) configs = configs.filter(c => c.nome === fixo);
    else if (preferido) {
      if (!['nvidia', 'groq', 'gemini'].includes(preferido)) throw Error('IA_PROVIDER deve ser nvidia, groq ou gemini.');
      configs.sort((a, b) => Number(b.nome === preferido) - Number(a.nome === preferido));
    }
    if (!configs.length) throw Error('Configure NVIDIA_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY.');
    const timeout = Math.max(1000, Math.min(Number(env.IA_TIMEOUT_MS) || 45000, 60000));
    const erros = [];
    for (const c of configs) {
      if (!c.modelo) { erros.push(`${c.nome}: configure GEMINI_MODEL`); continue; }
      let url;
      try {
        url = new URL(c.base.replace(/\/+$/, '') + '/chat/completions');
        if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      } catch { erros.push(`${c.nome}: URL de API inválida`); continue; }
      const body = { model: c.modelo, messages, tools,
        tool_choice: options.tool_choice || 'auto',
        max_tokens: Math.max(128, Math.min(Number(options.max_tokens) || 2400, 12000)),
        stream: false };
      try {
        const res = await fetchImpl(url.toString(), {
          method: 'POST', headers: { Authorization: `Bearer ${c.chave}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          // Não devolve corpo do provedor, que pode conter prompts ou dados pessoais.
          erros.push(`${c.nome}: HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        const choice = json.choices?.[0];
        const raw = choice?.message;
        if (!raw || choice.finish_reason === 'length') {
          erros.push(`${c.nome}: resposta vazia ou interrompida pelo limite de saída`); continue;
        }
        // Preserva metadados nativos (ex.: thought signatures do Gemini).
        const message = { ...raw, role: 'assistant', content: raw.content ?? null };
        if (message.tool_calls != null && !Array.isArray(message.tool_calls)) {
          erros.push(`${c.nome}: chamadas de ferramentas inválidas`); continue;
        }
        if (message.tool_calls?.length) {
          if (body.tool_choice === 'none' || message.tool_calls.some(call =>
            !call.id || call.type !== 'function' || !tools.some(t => t.function.name === call.function?.name)
            || typeof call.function?.arguments !== 'string')) {
            erros.push(`${c.nome}: chamada incompatível com o catálogo`); continue;
          }
        } else if (!String(message.content || '').trim() || body.tool_choice === 'required') {
          erros.push(`${c.nome}: resposta sem conteúdo exigido`); continue;
        }
        return { provider: c.nome, model: c.modelo, message };
      } catch (e) {
        erros.push(`${c.nome}: ${['TimeoutError', 'AbortError'].includes(e?.name) ? 'tempo limite excedido' : 'falha de conexão ou resposta inválida'}`);
      }
    }
    throw Error(`Não foi possível chamar a IA. ${erros.join('; ')}.`);
  };
}
export const chamarIAComTools = criarChamadorTools();
