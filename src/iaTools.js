// Chamadas nativas: NVIDIA/Groq Chat Completions e Gemini generateContent.
// Node 18+; não depende de pacote extra. Chaves somente no ambiente.
import { randomUUID } from 'node:crypto';
function configuracao(env) {
  const defs={
    nvidia:{key:env.NVIDIA_API_KEY,model:env.NVIDIA_MODEL||'nvidia/nemotron-3-super-120b-a12b',url:'https://integrate.api.nvidia.com/v1/chat/completions'},
    groq:{key:env.GROQ_API_KEY,model:env.GROQ_MODEL||'openai/gpt-oss-20b',url:'https://api.groq.com/openai/v1/chat/completions'},
    gemini:{key:env.GEMINI_API_KEY||env.GOOGLE_API_KEY||env.GOOGLE_GENAI_API_KEY,model:env.GEMINI_MODEL||'gemini-3.5-flash-lite'}
  };
  const ordem=(env.IA_TOOLS_ORDEM||'nvidia,groq,gemini').split(',').map(x=>x.trim());
  return [...new Set(ordem)].filter(n=>defs[n]?.key?.trim()).map(nome=>({nome,...defs[nome],key:defs[nome].key.trim()}));
}
function wireMessages(messages) {
  return messages.map(m=>{
    const out={role:m.role,content:m.content??null};
    if(m.tool_calls)out.tool_calls=m.tool_calls.map(t=>({id:t.id,type:'function',function:t.function}));
    if(m.tool_call_id)out.tool_call_id=m.tool_call_id;
    if(m.name)out.name=m.name;
    return out;
  });
}
function geminiSchema(schema) {
  if(Array.isArray(schema))return schema.map(geminiSchema);
  if(!schema||typeof schema!=='object')return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k])=>!['additionalProperties','$schema'].includes(k)).map(([k,v])=>[k,geminiSchema(v)]));
}
export function montarGemini(messages,tools,choice,maxTokens) {
  const contents=[], system=[];
  const calls=new Map();
  for(const m of messages) {
    if(m.role==='system'){system.push(m.content||'');continue;}
    if(m.tool_calls)for(const t of m.tool_calls)calls.set(t.id,t.function.name);
    let role=m.role==='assistant'?'model':'user',parts=[];
    if(m._geminiContent){role=m._geminiContent.role||'model';parts=m._geminiContent.parts;}
    else if(m.role==='tool') {
      const name=calls.get(m.tool_call_id);if(!name)throw Error('Resultado Gemini sem chamada correspondente.');
      let response;try{response=JSON.parse(m.content);}catch{response={resultado:m.content};}
      parts=[{functionResponse:{name,response:typeof response==='object'&&response!==null&&!Array.isArray(response)?response:{resultado:response}}}];
    } else {
      if(m.content)parts.push({text:m.content});
      if(m.tool_calls)parts.push(...m.tool_calls.map(t=>({functionCall:{name:t.function.name,args:JSON.parse(t.function.arguments)}})));
    }
    if(!parts?.length)continue;
    const previous=contents.at(-1);
    if(previous?.role===role)previous.parts.push(...parts);else contents.push({role,parts:structuredClone(parts)});
  }
  const body={contents,generationConfig:{maxOutputTokens:maxTokens,temperature:0}};
  if(system.length)body.systemInstruction={parts:[{text:system.join('\n\n')}]};
  if(tools.length) {
    body.tools=[{functionDeclarations:tools.map(t=>({name:t.function.name,description:t.function.description,parameters:geminiSchema(t.function.parameters)}))}];
    body.toolConfig={functionCallingConfig:{mode:choice==='none'?'NONE':choice==='required'?'ANY':'AUTO'}};
  }
  return body;
}
function normalizarOpenAI(data,provider) {
  const c=data.choices?.[0],m=c?.message;
  if(!m||c.finish_reason==='length')throw Error(`${provider}: resposta ausente/truncada.`);
  const tool_calls=(m.tool_calls||[]).map(t=>({id:t.id||randomUUID(),type:'function',function:{name:t.function?.name,arguments:t.function?.arguments||'{}'}}));
  if(!m.content&&!tool_calls.length)throw Error(`${provider}: resposta sem texto nem tool_calls.`);
  return {provider,message:{role:'assistant',content:m.content||null,...(tool_calls.length?{tool_calls}:{})},usage:data.usage};
}
function normalizarGemini(data) {
  const c=data.candidates?.[0];if(!c?.content||c.finishReason==='MAX_TOKENS')throw Error('gemini: resposta ausente/truncada.');
  const parts=c.content.parts||[];
  const tool_calls=parts.filter(p=>p.functionCall).map(p=>({id:p.functionCall.id||randomUUID(),type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}}));
  const content=parts.filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');
  if(!content&&!tool_calls.length)throw Error('gemini: resposta sem texto nem functionCall.');
  // Preserve todos os parts (inclusive thoughtSignature), sem reconstruir o histórico do modelo.
  return {provider:'gemini',message:{role:'assistant',content:content||null,...(tool_calls.length?{tool_calls}:{}),_geminiContent:structuredClone(c.content)},usage:data.usageMetadata};
}
export function criarClienteTools({env=process.env,fetchFn=globalThis.fetch}={}) {
  const provedores=configuracao(env),timeout=Math.max(1000,Math.min(Number(env.IA_TOOLS_TIMEOUT_MS)||30000,60000));
  return async function chamar(messages,tools,{provider=null,tool_choice='auto',max_tokens=2400}={}) {
    const ordem=provider?provedores.filter(p=>p.nome===provider):provedores;
    if(!ordem.length)throw Error('Nenhuma chave/provedor disponível para ferramentas nativas.');
    const falhas=[];
    for(const p of ordem) {
      try {
        const max=Math.max(256,Math.min(max_tokens,6000));
        const gemini=p.nome==='gemini';
        const url=gemini?`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`:p.url;
        const body=gemini?montarGemini(messages,tools,tool_choice,max):{
          model:p.model,messages:wireMessages(messages),stream:false,temperature:0,
          ...(p.nome==='groq'?{max_completion_tokens:max}:{max_tokens:max}),
          ...(tools.length?{tools,tool_choice,parallel_tool_calls:false}:{}),
          ...(p.nome==='nvidia'&&p.model==='nvidia/nemotron-3-super-120b-a12b'?{reasoning_effort:'none'}:{})
        };
        const resp=await fetchFn(url,{method:'POST',headers:{'Content-Type':'application/json',...(gemini?{'x-goog-api-key':p.key}:{Authorization:`Bearer ${p.key}`})},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
        if(!resp.ok||resp.status===202) {
          // Não expor corpo do provedor: pode conter conteúdo privado ou credenciais refletidas.
          throw Error(`${p.nome}: HTTP ${resp.status} em tool calling.`);
        }
        const data=await resp.json();
        const out=gemini?normalizarGemini(data):normalizarOpenAI(data,p.nome);
        const allowed=new Set(tools.map(t=>t.function.name));
        for(const call of out.message.tool_calls||[])if(!allowed.has(call.function.name))throw Error(`${p.nome}: ferramenta não autorizada.`);
        if(tool_choice==='none'&&out.message.tool_calls?.length)throw Error(`${p.nome}: chamou ferramenta durante redação.`);
        console.log('IA TOOLS',JSON.stringify({provedor:p.nome,modelo:p.model,chamadas:out.message.tool_calls?.map(t=>t.function.name)||[],uso:out.usage}));
        return out;
      }catch(e) {
        falhas.push(e.message);console.warn('IA TOOLS FALHA',JSON.stringify({provedor:p.nome,erro:e.message}));
        // No meio do ciclo, preserve o provedor para não perder assinaturas/histórico.
        if(provider)throw e;
      }
    }
    throw Error(falhas.join(' | '));
  };
}
export const chamarIAComTools=criarClienteTools();
