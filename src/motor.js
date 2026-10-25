// Executor declarativo: nenhuma instrucao JavaScript/SQL gerada pela IA e executada.
export const vazio = v => v == null || (typeof v === 'string' && !v.trim());
export const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
export const ref = r => JSON.stringify([r._aba,r._linha]);
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const fail = m => { throw Error(m); };
function rational(v){
 if(vazio(v))return null;
 if(typeof v==='number'&&!Number.isFinite(v))return null;
 let s=String(v).trim().replace(/^R\$\s*/i,'').replace(/\s|%/g,'');
 if(/^\(.*\)$/.test(s))s='-'+s.slice(1,-1);
 if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');
 else if(typeof v==='string'&&/^-?\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,'');
 // Expand native numeric scientific notation before conversion.
 if(typeof v==='number'&&/e/i.test(s))s=v.toFixed(12).replace(/0+$/,'').replace(/\.$/,'');
 if(!/^[+-]?\d+(\.\d+)?$/.test(s))return null;
 const [a,b='']=s.replace(/^\+/,'').split('.');
 return {n:BigInt(a.replace('-','')+b)*(a.startsWith('-')?-1n:1n),d:10n**BigInt(b.length)};
}
const add=(a,b)=>({n:a.n*b.d+b.n*a.d,d:a.d*b.d});
const mul=(a,b)=>({n:a.n*b.n,d:a.d*b.d});
function decimal(a,digits=8){
 if(!a)return null;
 const scale=10n**BigInt(digits), negative=a.n<0n, abs=negative?-a.n:a.n;
 const n=(abs*scale*2n+a.d)/(2n*a.d);
 const s=String(n).padStart(digits+1,'0');
 const value=digits?s.slice(0,-digits)+'.'+s.slice(-digits):s;
 const clean=(negative&&n?'-':'')+value.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
 // Nao confundir decimal calculado com milhar brasileiro quando ha 3 casas.
 return /\.\d{3}$/.test(clean)?clean+'0':clean;
}
export const numero=v=>{const r=rational(v);return r?Number(r.n)/Number(r.d):null;};
export function calcular(e,row,depth=0){
 if(depth>12)fail('Expressao excede profundidade permitida.');
 if(typeof e==='string')return own(row,e)?row[e]:fail('Campo inexistente: '+e);
 if(typeof e==='number'||e===null)return e;
 if(!e||typeof e!=='object'||Array.isArray(e))fail('Expressao invalida.');
 if(own(e,'campo'))return calcular(e.campo,row,depth+1);
 if(own(e,'literal'))return e.literal;
 const args=(e.args||[]).map(x=>calcular(x,row,depth+1));
 if(e.op==='coalesce')return args.find(x=>!vazio(x))??null;
 if(e.op==='data'){
  const s=String(args[0]??'');let m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);const iso=m?`${m[3]}-${m[2]}-${m[1]}`:s;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso)&&!Number.isNaN(Date.parse(iso))?iso:null;
 }
 if(e.op==='ano'){const v=calcular({op:'data',args:[e.args?.[0]]},row,depth+1);return v?Number(v.slice(0,4)):null;}
 const ns=args.map(rational);if(ns.some(x=>!x))return null;
 let r=ns[0];if(!r)fail('Expressao sem argumentos.');
 for(const n of ns.slice(1)){
  if(e.op==='somar')r=add(r,n);
  else if(e.op==='subtrair')r=add(r,{n:-n.n,d:n.d});
  else if(e.op==='multiplicar')r=mul(r,n);
  else if(e.op==='dividir'){if(n.n===0n)return null;r=mul(r,{n:n.d,d:n.n});if(r.d<0n)r={n:-r.n,d:-r.d};}
  else fail('Operador de expressao desconhecido: '+e.op);
 }
 return decimal(r);
}
function condicao(c,row,depth=0){
 if(!c)return true;if(depth>12)fail('Filtro profundo demais.');
 if(c.todos){if(!Array.isArray(c.todos))fail('Filtro todos invalido.');return c.todos.every(x=>condicao(x,row,depth+1));}
 if(c.algum){if(!Array.isArray(c.algum))fail('Filtro algum invalido.');return c.algum.some(x=>condicao(x,row,depth+1));}
 if(c.nao)return !condicao(c.nao,row,depth+1);
 const a=calcular(c.campo,row), b=own(c,'outro_campo')?calcular(c.outro_campo,row):c.valor;
 if(c.op==='vazio')return vazio(a);if(c.op==='preenchido')return !vazio(a);
 if(vazio(a))return false;
 const vals=Array.isArray(b)?b:[b];
 switch(c.op){
 case 'igual': case 'em':return vals.some(x=>norm(a)===norm(x));
 case 'diferente':return vals.every(x=>norm(a)!==norm(x));
 case 'contem':return vals.some(x=>norm(a).includes(norm(x)));
 case 'nao_contem':return vals.every(x=>!norm(a).includes(norm(x)));
 case 'maior':case 'menor':case 'maior_igual':case 'menor_igual':{
  let x,y;
  if(c.tipo==='data'){x=calcular({op:'data',args:[c.campo]},row);y=calcular({op:'data',args:[{literal:b}]},row);}
  else{x=numero(a);y=numero(b);}
  if(x==null||y==null)return false;
  return c.op==='maior'?x>y:c.op==='menor'?x<y:c.op==='maior_igual'?x>=y:x<=y;
 }
 default:fail('Operador de filtro desconhecido: '+c.op);
 }
}
function agg(m,rows){
 if(m.op==='contar')return {valor:rows.length,preenchidos:rows.length,invalidos:0};
 const vals=rows.map(r=>calcular(m.expressao,r));
 const presentes=vals.filter(v=>!vazio(v));
 if(m.op==='distintos')return {valor:new Set(presentes.map(norm)).size,preenchidos:presentes.length,invalidos:0};
 const nums=presentes.map(rational),validos=nums.filter(Boolean);
 if(!['somar','media','min','max'].includes(m.op))fail('Agregacao desconhecida: '+m.op);
 if(!validos.length)return {valor:null,preenchidos:0,invalidos:presentes.length};
 let r;
 if(m.op==='somar'||m.op==='media'){
  r=validos.reduce(add,{n:0n,d:1n});if(m.op==='media')r={n:r.n,d:r.d*BigInt(validos.length)};
 }else r=validos.reduce((a,b)=>((a.n*b.d>b.n*a.d)===(m.op==='max'))?a:b);
 return {valor:decimal(r,m.tipo==='moeda'?2:8),preenchidos:validos.length,invalidos:presentes.length-validos.length};
}
function validateExpression(e,fields,depth=0){
 if(depth>12)fail('Expressao profunda.');
 if(typeof e==='string'){if(!fields.has(e))fail('Campo inexistente: '+e);return;}
 if(e===null||typeof e==='number')return;
 if(!e||typeof e!=='object'||Array.isArray(e))fail('Expressao invalida.');
 if(own(e,'campo'))return validateExpression(e.campo,fields,depth+1);
 if(own(e,'literal')){if(e.literal!==null&&!['string','number','boolean'].includes(typeof e.literal))fail('Literal invalido.');return;}
 if(!['coalesce','somar','subtrair','multiplicar','dividir','data','ano'].includes(e.op)||!Array.isArray(e.args)||!e.args.length)fail('Expressao nao suportada.');
 e.args.forEach(x=>validateExpression(x,fields,depth+1));
}
function validateFilter(c,fields,depth=0){
 if(!c)return;if(depth>12)fail('Filtro profundo.');
 if(c.todos||c.algum){const list=c.todos||c.algum;if(!Array.isArray(list))fail('Grupo invalido.');list.forEach(x=>validateFilter(x,fields,depth+1));return;}
 if(c.nao)return validateFilter(c.nao,fields,depth+1);
 validateExpression(c.campo,fields);
 if(!['igual','em','diferente','contem','nao_contem','vazio','preenchido','maior','menor','maior_igual','menor_igual'].includes(c.op))fail('Filtro invalido.');
 if(own(c,'outro_campo'))validateExpression(c.outro_campo,fields);
 else if(!['vazio','preenchido'].includes(c.op)&&!own(c,'valor'))fail('Valor ausente no filtro.');
}
export function executarConsulta(q,raw,catalogo,anterior){
 if(!q||!Array.isArray(q.fontes)||!q.fontes.length)fail('A IA deve escolher as abas.');
 if(!['nova','mesmos_registros','alterar_filtros'].includes(q.contexto))fail('Contexto do plano invalido.');
 if(!['listar','agregar','distintos'].includes(q.operacao))fail('Operacao invalida.');
 const aliases=Object.keys(q.fontes[0].mapa||{});if(!aliases.length||aliases.length>35)fail('Mapeamento de campos ausente ou excessivo.');
 const fields=new Set(aliases),tabs=new Set();
 for(const source of q.fontes){
  if(tabs.has(source.aba))fail('Aba repetida no plano.');tabs.add(source.aba);
  const tab=catalogo.find(t=>t.aba===source.aba);if(!tab)fail('Aba inexistente: '+source.aba);
  if(JSON.stringify(Object.keys(source.mapa||{}).sort())!==JSON.stringify([...aliases].sort()))fail('Todas as fontes devem mapear os mesmos aliases.');
  for(const [k,e]of Object.entries(source.mapa)){if(k.startsWith('_')||['__proto__','prototype','constructor'].includes(k))fail('Alias reservado.');validateExpression(e,new Set(tab.colunas.map(c=>c.nome)));}
 }
 validateFilter(q.filtro,fields);
 const mostrar=q.mostrar||[];if(!Array.isArray(mostrar))fail('Projecao invalida.');mostrar.forEach(k=>{if(!fields.has(k))fail('Campo de exibicao inexistente: '+k);});
 const grupos=q.agrupar||[];if(!Array.isArray(grupos))fail('Agrupamento invalido.');grupos.forEach(k=>{if(!fields.has(k))fail('Grupo inexistente: '+k);});
 const medidas=q.medidas||[];if(!Array.isArray(medidas))fail('Medidas invalidas.');
 const nomes=new Set(grupos);
 for(const m of medidas){if(!m.nome||nomes.has(m.nome)||m.nome.startsWith('_')||['__proto__','prototype','constructor'].includes(m.nome))fail('Nome de medida invalido.');nomes.add(m.nome);if(m.op!=='contar')validateExpression(m.expressao,fields);}
 if(q.operacao==='agregar'&&!medidas.length)fail('Agregacao sem medidas.');
 if(q.operacao!=='agregar'&&!mostrar.length)fail('Listagem sem campos de exibicao.');
 let selected=raw.filter(r=>tabs.has(r._aba));
 if(q.contexto==='mesmos_registros'){
  if(!anterior?.referencias)fail('Contexto anterior ausente.');
  const ids=new Set(anterior.referencias);const old=raw.filter(r=>ids.has(ref(r)));
  if(old.some(r=>!tabs.has(r._aba)))fail('Plano excluiu abas do conjunto anterior.');
  selected=old;
 }
 // Nao une obras com mesmo nome: cada linha conserva aba e linha originais.
 const sourceMap=new Map(q.fontes.map(s=>[s.aba,s]));
 const mapped=selected.map(r=>{const out=Object.create(null);out._ref=ref(r);for(const[k,e]of Object.entries(sourceMap.get(r._aba).mapa))out[k]=calcular(e,r);return out;});
 const filtered=mapped.filter(r=>condicao(q.filtro,r));
 const provenance={referencias:filtered.map(r=>r._ref),abas:[...tabs],total:filtered.length};
 let rows=[],evidencias=[];
 if(q.operacao==='agregar'){
  const buckets=new Map();if(!grupos.length)buckets.set('[]',[]);
  for(const r of filtered){const key=JSON.stringify(grupos.map(g=>r[g]??null));if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r);}
  for(const[key,items]of buckets){const out=Object.create(null),values=JSON.parse(key),ev={};grupos.forEach((g,i)=>out[g]=values[i]);
   for(const m of medidas){const a=agg(m,items);out[m.nome]=a.valor;ev[m.nome]={preenchidos:a.preenchidos,invalidos:a.invalidos,total:items.length};}
   rows.push(out);evidencias.push(ev);
  }
 }else{
  rows=filtered.map(r=>Object.fromEntries(mostrar.map(k=>[k,r[k]??null])));
  if(q.operacao==='distintos'){const seen=new Set();rows=rows.filter(r=>{const k=JSON.stringify(Object.values(r).map(v=>typeof v==='string'?norm(v):v));if(seen.has(k))return false;seen.add(k);return true;});}
 }
 const orders=q.ordenar||[];if(!Array.isArray(orders))fail('Ordenacao invalida.');
 const resultFields=q.operacao==='agregar'?nomes:new Set(mostrar);
 for(const o of orders){if(!resultFields.has(o.campo)||!['asc','desc'].includes(o.direcao)||!['numero','texto','data'].includes(o.tipo))fail('Ordenacao invalida.');}
 const indexed=rows.map((r,i)=>({r,ev:evidencias[i]}));
 indexed.sort((a,b)=>{for(const o of orders){const x=a.r[o.campo],y=b.r[o.campo];if(vazio(x)&&vazio(y))continue;if(vazio(x))return 1;if(vazio(y))return -1;const n=o.tipo==='numero'?((numero(x)??0)-(numero(y)??0)):norm(x).localeCompare(norm(y));if(n)return(o.direcao==='asc'?1:-1)*n;}return 0;});
 const totalSaida=indexed.length;
 if(q.limite!=null&&(!Number.isInteger(q.limite)||q.limite<1||q.limite>1000))fail('Limite invalido.');
 const output=q.limite?indexed.slice(0,q.limite):indexed;
 return {...provenance,linhas:output.map(x=>x.r),evidencias:output.map(x=>x.ev),total_saida:totalSaida,exibidos:output.length};
}
