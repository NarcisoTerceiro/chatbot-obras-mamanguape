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
    if (!Array.isArray(tools)) throw Error('Catálogo de ferramentas inválido.');
    if (!tools.length && options.tool_choice === 'required') throw Error('Uma chamada que exige ferramenta precisa de um catálogo não vazio.');
    const started=Date.now();let httpRequests=0;
    let configs = configuracoes(env);
    // Mantém preferência pelo provedor atual, permitindo fallback em falha.
    const atual = options.provider;
    const preferido = String(atual || env.IA_PROVIDER || env.AI_PROVIDER || '').trim().toLowerCase();
    if (preferido && !['nvidia', 'groq', 'gemini'].includes(preferido)) throw Error('IA_PROVIDER deve ser nvidia, groq ou gemini.');
    if (preferido) configs.sort((a,b) => Number(b.nome === preferido) - Number(a.nome === preferido));
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
      // Limite documentado do endpoint NVIDIA GPT-OSS: até 4096 tokens.
      const gptoss = /gpt-oss-(?:20b|120b)/i.test(c.modelo);
      const hostedNvidia = c.nome === 'nvidia' && url.hostname === 'integrate.api.nvidia.com';
      const cap = hostedNvidia && gptoss ? 4096 : 12000;
      const initialTokens = Math.max(128, Math.min(Number(options.max_tokens) || 2400, cap));
      const effort = options.reasoning_effort || env.IA_REASONING_EFFORT || 'medium';
      if(gptoss && !['low','medium','high'].includes(effort)) throw Error('IA_REASONING_EFFORT deve ser low, medium ou high.');
      const switching = atual && c.nome !== atual;
      const providerMessages = (switching || c.nome !== 'gemini') ? messages.map(m => {
        const result={role:m.role,content:m.content ?? null};
        if(m.tool_call_id)result.tool_call_id=m.tool_call_id;
        if(m.tool_calls)result.tool_calls=m.tool_calls.map(call=>({id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments}}));
        return result;
      }) : messages;
      for(let attempt=0;attempt<2;attempt++) {
        const body={model:c.modelo,messages:providerMessages,
          max_tokens:attempt ? Math.min(cap, Math.max(initialTokens+512,initialTokens*2)) : initialTokens,
          stream:false};
        if(tools.length){body.tools=tools;body.tool_choice=options.tool_choice || 'auto';}
        if(gptoss && ['nvidia','groq'].includes(c.nome)) body.reasoning_effort=attempt?'low':effort;
        try {
          httpRequests++;
          const res=await fetchImpl(url.toString(),{method:'POST',headers:{Authorization:`Bearer ${c.chave}`,'Content-Type':'application/json'},
            body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
          if(!res.ok) {erros.push(`${c.nome}: HTTP ${res.status}`);break;}
          const json=await res.json(),choice=json.choices?.[0],raw=choice?.message;
          const empty=!raw || (!raw.tool_calls?.length && !String(raw.content||'').trim());
          if(choice?.finish_reason==='length'||empty) {
            if(attempt===0) continue;
            erros.push(`${c.nome}: ${choice?.finish_reason==='length'?'saída cortada pelo limite de tokens':'resposta sem texto nem ferramentas'}`);break;
          }
          // Nunca usa mensagem ou argumentos truncados como resposta válida.
          const message={...raw,role:'assistant',content:raw.content??null};
          if(message.tool_calls!=null && !Array.isArray(message.tool_calls)) {erros.push(`${c.nome}: chamadas de ferramentas inválidas`);break;}
          if(message.tool_calls?.length) {
            if(body.tool_choice==='none'||message.tool_calls.some(call=>!call.id||call.type!=='function'||!tools.some(t=>t.function.name===call.function?.name)||typeof call.function?.arguments!=='string')) {
              erros.push(`${c.nome}: chamada incompatível com o catálogo`);break;
            }
          }else if(body.tool_choice==='required') {erros.push(`${c.nome}: resposta sem ferramenta exigida`);break;}
          return {provider:c.nome,model:c.modelo,message,http_requests:httpRequests,elapsed_ms:Date.now()-started,usage:json.usage||null};
        }catch(e) {
          erros.push(`${c.nome}: ${['TimeoutError','AbortError'].includes(e?.name)?'tempo limite excedido':'falha de conexão ou resposta inválida'}`);break;
        }
      }
    }
    const error=Error(`Não foi possível chamar a IA. ${erros.join('; ')}.`);error.http_requests=httpRequests;throw error;
  };
}
export const chamarIAComTools = criarChamadorTools();
