// V19: fluxo "planilha no chat". O Node le a planilha, seleciona as linhas relevantes,
// calcula totais exatos e entrega uma TABELA para a IA ler e responder, como um chat faz com um arquivo.
import {getObras,getDiagnostico} from './sheets.js';
import {chamarIAbruta} from './groq.js';
import {numero,norm,vazio} from './motor.js';

const ORCAMENTO=14000;   // caracteres de tabela enviados na resposta final (cabe no limite da Groq)
const TTL=600000;

// ---------- utilidades ----------
const colunasDe=r=>Object.keys(r).filter(c=>!c.startsWith('_'));
const curto=(v,n=80)=>{const s=String(v??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;};
function parseJSON(t){const s=String(t||'').replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/```(?:json)?/gi,'').trim();
 try{return JSON.parse(s);}catch{const i=s.indexOf('{'),j=s.lastIndexOf('}');if(i<0||j<i)return null;try{return JSON.parse(s.slice(i,j+1));}catch{return null;}}}
const PARADAS=new Set('a o e as os de da do das dos em no na nos nas um uma que qual quais quanto quantos quanta quantas com por para pra pro sobre me mostre mostra liste lista listar ver tem ha existe existem sao estao esta obra obras todas todos tudo informe diga fale onde como quando ja foi foram ser sera planilha favor isso esse essa este valor valores total'.split(' '));
const termosDe=t=>[...new Set(norm(t).replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w=>w.length>2&&!PARADAS.has(w)))];
const bate=(v,t)=>norm(v).split(/[^a-z0-9]+/).some(w=>w===t||(t.length>4&&w.startsWith(t.slice(0,-1))));

// Mapa da planilha: abas, colunas preenchidas e exemplos (pequeno, so para a IA escolher)
export function criarCatalogo(linhas){
 const abas=new Map();
 for(const r of linhas){if(!abas.has(r._aba))abas.set(r._aba,{aba:r._aba,total:0,colunas:new Map()});const t=abas.get(r._aba);t.total++;
  for(const c of colunasDe(r)){if(!t.colunas.has(c))t.colunas.set(c,{nome:c,preenchidos:0,exemplos:[]});const k=t.colunas.get(c);
   if(!vazio(r[c])){k.preenchidos++;const e=curto(r[c],35);if(k.exemplos.length<2&&!k.exemplos.includes(e))k.exemplos.push(e);}}}
 return [...abas.values()].map(t=>({aba:t.aba,total:t.total,colunas:[...t.colunas.values()].filter(c=>c.preenchidos)}));
}
const mapaTexto=cat=>cat.map(t=>`ABA "${t.aba}" (${t.total} linhas): `+t.colunas.map(c=>`${c.nome} [ex: ${c.exemplos.join(' | ')}]`).join('; ')).join('\n');

// ---------- passo 1: IA escolhe onde olhar (resposta pequena e tolerante) ----------
async function escolher(pergunta,cat,conversa){
 const sys=`Voce ajuda a localizar dados numa planilha de obras publicas. Leia o MAPA e a pergunta e diga onde procurar.
Responda SOMENTE JSON: {"abas":["nomes exatos"],"colunas":["cabecalhos exatos uteis para responder, incluindo nome/objeto da obra"],"termos":["palavras que devem aparecer nas linhas, ex: nome de bairro, empresa, rua; vazio se a pergunta e geral"],"fora":false}
Regras: "obras" em geral inclui EM_ANDAMENTO, PAVIMENTAÇÃO e outras abas de obras; em duvida inclua mais abas. Termos sao so filtros concretos citados pelo usuario (nao use palavras como obra, valor, status). Se a pergunta nao tem relacao com a planilha, "fora":true. Se a pergunta continua a conversa anterior, reaproveite o assunto dela.`;
 const user=`MAPA:\n${mapaTexto(cat)}\n\nCONVERSA RECENTE:\n${conversa||'(nenhuma)'}\n\nPERGUNTA: ${pergunta}`;
 const j=parseJSON(await chamarIAbruta([{role:'system',content:sys},{role:'user',content:user}],{max_tokens:500,temperature:0}));
 return j&&typeof j==='object'?j:{};
}

// Corrige nomes que a IA escreveu diferente (acento, maiuscula)
const chave=s=>norm(s).replace(/[^a-z0-9]/g,'');
function resolverEscolha(e,cat,pergunta){
 let abas=(Array.isArray(e.abas)?e.abas:[]).map(a=>cat.find(t=>chave(t.aba)===chave(a))).filter(Boolean);
 if(!abas.length)abas=cat;
 const pedidas=(Array.isArray(e.colunas)?e.colunas:[]).map(chave);
 const colunas=new Map(abas.map(t=>{let cs=t.colunas.filter(c=>pedidas.includes(chave(c.nome))).map(c=>c.nome);
  if(cs.length<2)cs=t.colunas.map(c=>c.nome);return [t.aba,cs];}));
 let termos=(Array.isArray(e.termos)?e.termos:[]).map(String).filter(Boolean);
 if(!Array.isArray(e.termos))termos=termosDe(pergunta);
 return {abas:abas.map(t=>t.aba),colunas,termos,fora:e.fora===true};
}

// ---------- passo 2: Node filtra e calcula (sem IA, sem erro de conta) ----------
function selecionar(linhas,esc){
 let sel=linhas.filter(r=>esc.abas.includes(r._aba));
 let filtroUsado=[];
 if(esc.termos.length){
  const ts=esc.termos.flatMap(termosDe);
  // linha precisa conter TODOS os termos; se nada bater, aceita QUALQUER termo
  const todos=sel.filter(r=>ts.every(t=>colunasDe(r).some(c=>bate(r[c],t))));
  const algum=sel.filter(r=>ts.some(t=>colunasDe(r).some(c=>bate(r[c],t))));
  if(todos.length){sel=todos;filtroUsado=ts;}else if(algum.length){sel=algum;filtroUsado=ts;}
  else filtroUsado=['(nenhuma linha contem: '+ts.join(', ')+')'];
 }
 return {sel,filtroUsado};
}
function totais(sel,esc){
 const out=[];
 for(const aba of esc.abas){const rs=sel.filter(r=>r._aba===aba);if(!rs.length)continue;
  const partes=[`${aba}: ${rs.length} linha(s)`];
  for(const c of esc.colunas.get(aba)||[]){const vs=rs.map(r=>r[c]).filter(v=>!vazio(v));if(!vs.length)continue;
   const ns=vs.map(numero);
   if(ns.every(n=>n!==null)&&/valor|r\$|saldo|pago|aditiv|reajust|contrat|total|m²|\(m\)/i.test(c)){
    const soma=ns.reduce((a,b)=>a+b,0);partes.push(`soma de ${c} = ${soma.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})} (${vs.length} preenchidos)`);}
   else if(vs.length>1&&new Set(vs.map(norm)).size<=12&&numero(vs[0])===null){
    const cont=new Map();vs.forEach(v=>cont.set(String(v).trim(),(cont.get(String(v).trim())||0)+1));
    partes.push(`${c}: `+[...cont].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}=${n}`).join(', '));}
  }
  out.push(partes.join(' | '));
 }
 return out.join('\n');
}
function tabela(sel,esc){
 const blocos=[];let usado=0,mostradas=0;
 for(const aba of esc.abas){const rs=sel.filter(r=>r._aba===aba);if(!rs.length)continue;const cs=esc.colunas.get(aba);
  const linhas=[`### ${aba}`,'linha | '+cs.join(' | ')];
  for(const r of rs){const l=r._linha+' | '+cs.map(c=>vazio(r[c])?'-':curto(r[c])).join(' | ');
   if(usado+l.length>ORCAMENTO)break;linhas.push(l);usado+=l.length;mostradas++;}
  blocos.push(linhas.join('\n'));
 }
 return {texto:blocos.join('\n\n'),mostradas};
}

// ---------- passo 3: IA le a tabela e responde ----------
async function redigir(pergunta,conversa,tab,tot,total,filtro){
 const sys=`Voce responde perguntas sobre uma planilha de obras publicas, pelo WhatsApp, em portugues simples.
Use SOMENTE os dados abaixo. Nunca invente obra, valor ou data.
- Os TOTAIS foram calculados pelo sistema sobre TODAS as linhas filtradas: para quantidades e somas use exatamente esses numeros, nao recalcule.
- A TABELA pode estar cortada (veja "linhas exibidas"); se estiver, diga que existem mais itens.
- Para listas, numere os itens com nome e os dados pedidos. Valores em R$ no formato brasileiro.
- Celula "-" significa nao preenchido (nao e zero).
- Se os dados nao respondem a pergunta, diga o que existe e peca para detalhar.
Sem introducoes longas. Nao mostre JSON nem fale de "abas" ou "colunas" tecnicamente.`;
 const user=`CONVERSA RECENTE:\n${conversa||'(nenhuma)'}\n\nPERGUNTA: ${pergunta}\n\nFILTRO APLICADO: ${filtro.length?filtro.join(', '):'nenhum (todas as linhas das abas escolhidas)'}\nTOTAL DE LINHAS ENCONTRADAS: ${total} | linhas exibidas na tabela: ${tab.mostradas}\n\nTOTAIS:\n${tot||'-'}\n\nTABELA:\n${tab.texto||'(vazia)'}`;
 const t=String(await chamarIAbruta([{role:'system',content:sys},{role:'user',content:user}],{max_tokens:1800,temperature:0.1})||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
 if(!t)throw Error('IA respondeu vazio');
 return t;
}

// ---------- plano B sem IA ----------
function semIA(sel,esc,total,filtro){
 if(!total)return 'Não encontrei registros para essa pergunta. Tente citar um bairro, empresa, status ou nome de obra.';
 const nome=r=>{const k=colunasDe(r).find(c=>/objeto|^obra$|^rua$|nome/i.test(c)&&!vazio(r[c]))||colunasDe(r).find(c=>!vazio(r[c])&&numero(r[c])===null);return k?curto(r[k],150):`linha ${r._linha}`;};
 const extra=r=>['BAIRRO','STATUS','SITUAÇÃO'].map(c=>colunasDe(r).find(x=>chave(x)===chave(c))).filter(k=>k&&!vazio(r[k])).map(k=>`${k}: ${curto(r[k],50)}`).join(' — ');
 const out=[`Encontrei ${total} registro(s)${filtro.length?` com "${filtro.join(' ')}"`:''}:`];
 sel.slice(0,60).forEach((r,i)=>out.push(`${i+1}. ${nome(r)} (${r._aba})${extra(r)?' — '+extra(r):''}`));
 if(total>60)out.push(`Exibidos 60 de ${total}.`);
 return out.join('\n');
}

export function dividirMensagens(text,max=3500){const output=[];let cur='';for(let line of String(text).split('\n')){while(line.length>max){if(cur){output.push(cur);cur='';}output.push(line.slice(0,max));line=line.slice(max);}if(cur.length+line.length+1>max){output.push(cur);cur='';}cur+=(cur?'\n':'')+line;}if(cur)output.push(cur);return output;}
const pronto=(resposta,extra={})=>{resposta=String(resposta||'').trim()||'Não consegui montar a resposta. Pode reformular?';return {resposta,partes:dividirMensagens(resposta),...extra};};

export function criarAgente({ler=getObras,escolhedor=escolher,redator=redigir}={}){
 return async function responder(pergunta,historico=[],opcoes={}){
  const inicio=Date.now(),texto=String(pergunta||'').trim().slice(0,1800);
  if(!texto)return pronto('Envie sua pergunta sobre a planilha.');
  if(/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[!. ]*$/i.test(texto))return pronto('Olá! O que você quer consultar na planilha de obras?',{social:true});
  let linhas;
  try{linhas=await ler();}catch(e){console.error('AGENTE PLANILHA: leitura',e.message);return pronto('Não consegui acessar a planilha agora. Tente novamente em instantes.',{erro:e.message});}
  const cat=criarCatalogo(linhas);
  const agora=Date.now();
  const conversa=(Array.isArray(historico)?historico:[]).filter(m=>!m?.estado?.quando||agora-m.estado.quando<TTL).slice(-4).map(m=>`${m.role==='assistant'?'Bot':'Usuário'}: ${curto(m.content,300)}`).join('\n');
  let esc,etapa='escolha';
  try{
   let e={};try{e=await escolhedor(texto,cat,conversa);}catch(err){console.warn('AGENTE PLANILHA: escolha falhou, usando todas as abas:',err.message);}
   esc=resolverEscolha(e,cat,texto);
   if(esc.fora)return pronto('Só consigo responder sobre as obras da planilha. O que você quer saber delas?',{modoAgente:'fora_do_escopo'});
   const {sel,filtroUsado}=selecionar(linhas,esc);
   const tot=totais(sel,esc),tab=tabela(sel,esc);
   etapa='resposta';
   try{
    const r=await redator(texto,conversa,tab,tot,sel.length,filtroUsado);
    console.log('AGENTE PLANILHA v19: abas',esc.abas.join(', '),'| linhas',sel.length,'| ms',Date.now()-inicio);
    return pronto(r,{linhas:sel.length,modoAgente:'planilha_v19',estado:{pergunta:texto,quando:Date.now(),abas:esc.abas,termos:esc.termos}});
   }catch(err){console.warn('AGENTE PLANILHA: redacao falhou, resposta sem IA:',err.message);
    return pronto(semIA(sel,esc,sel.length,filtroUsado),{linhas:sel.length,modoAgente:'planilha_v19_sem_ia'});}
  }catch(err){
   console.error('AGENTE PLANILHA: erro em',etapa,err.message);
   const e2=resolverEscolha({},cat,texto),{sel,filtroUsado}=selecionar(linhas,e2);
   return pronto(semIA(sel,e2,sel.length,filtroUsado),{modoAgente:'planilha_v19_sem_ia',erro:err.message});
  }
 };
}
export const responderPergunta=criarAgente();
// Mantido por compatibilidade com quem importava estas funcoes.
export {getDiagnostico};
