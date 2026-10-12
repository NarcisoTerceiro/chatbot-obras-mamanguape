import DecimalBase from 'decimal.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {paraCentavos,colunaMonetaria} from './moeda.js';

const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_UP});
export const schemaPlano=JSON.parse(readFileSync(new URL('./analise-plan.schema.json',import.meta.url),'utf8'));
export const schemaInspecao={type:'object',additionalProperties:false,properties:{
  columns:{type:'array',items:{type:'string'},minItems:1,maxItems:6},
  filters:schemaPlano.properties.filters,any_filters:schemaPlano.properties.any_filters,
  limit:{type:'integer',minimum:1,maximum:50,default:30},
  offset:{type:'integer',minimum:0,maximum:1000000,default:0}
},required:['columns']};
const norm=v=>String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
const empty=v=>v==null||(typeof v==='string'&&!v.trim());
const numericTypes=new Set(['money','number','percent']);
const serial=v=>v instanceof Decimal?v.toFixed():v instanceof Date?v.toISOString():v??null;
const key=v=>JSON.stringify(serial(v));
const today=()=>new Date().toISOString().slice(0,10);

function validate(value,schema,path='plano') {
  if(schema.anyOf){
    for(const option of schema.anyOf){try{validate(value,option,path);return;}catch{}}
    throw Error(`${path}: tipo de valor inválido.`);
  }
  const kind=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(schema.type==='integer'?!Number.isSafeInteger(value):schema.type&&kind!==schema.type)
    throw Error(`${path}: tipo esperado ${schema.type}.`);
  if(kind==='number'&&!Number.isFinite(value))throw Error(`${path}: número não finito.`);
  if(schema.enum&&!schema.enum.includes(value))throw Error(`${path}: operação inválida.`);
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error(`${path}: nome inválido.`);
  if(schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum)
    throw Error(`${path}: valor fora dos limites.`);
  if(kind==='array'){
    if(schema.minItems!=null&&value.length<schema.minItems)throw Error(`${path}: lista vazia ou pequena demais.`);
    if(schema.maxItems!=null&&value.length>schema.maxItems)throw Error(`${path}: lista muito grande.`);
    value.forEach((v,i)=>validate(v,schema.items,`${path}[${i}]`));
  }
  if(kind==='object'){
    for(const name of schema.required||[])if(!Object.hasOwn(value,name))throw Error(`${path}: falta ${name}.`);
    for(const [name,v] of Object.entries(value)){
      if(!Object.hasOwn(schema.properties||{},name)){
        if(schema.additionalProperties===false)throw Error(`${path}: campo desconhecido ${name}.`);
      }else validate(v,schema.properties[name],`${path}.${name}`);
    }
  }
}
function plan(input){
  validate(input,schemaPlano);
  return {clarification:null,filters:[],any_filters:[],derived:[],group_by:[],metrics:[],select:[],sort:[],limit:50,offset:0,...input};
}
function number(v,locale='en_US'){
  if(empty(v))return null;
  if(v instanceof Decimal)return v;
  if(typeof v==='number'){
    if(!Number.isFinite(v))throw Error('Número não finito.');
    return new Decimal(String(v));
  }
  if(typeof v!=='string')throw Error('Valor numérico inválido.');
  let raw=v.trim().replace(/R\$|%|\s/g,'');
  const pattern=locale==='pt_BR'?/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/:/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if(!pattern.test(raw))throw Error(`Número inválido para ${locale}: ${v}`);
  raw=locale==='pt_BR'?raw.replace(/\./g,'').replace(',','.'):raw.replace(/,/g,'');
  return new Decimal(raw);
}
function date(v,format='%d/%m/%Y'){
  if(empty(v))return null;
  if(v instanceof Date)return new Date(v);
  const formats={
    '%d/%m/%Y':[/^(\d{2})\/(\d{2})\/(\d{4})$/,[3,2,1]],
    '%Y-%m-%d':[/^(\d{4})-(\d{2})-(\d{2})$/,[1,2,3]],
    '%d-%m-%Y':[/^(\d{2})-(\d{2})-(\d{4})$/,[3,2,1]]
  };
  const spec=formats[format];if(!spec)throw Error(`Formato de data não suportado: ${format}`);
  const m=String(v).match(spec[0]);if(!m)throw Error(`Data inválida: ${v}; formato esperado ${format}.`);
  const [y,mo,d]=spec[1].map(i=>Number(m[i]));
  const out=new Date(0);out.setUTCFullYear(y,mo-1,d);out.setUTCHours(0,0,0,0);
  if(out.getUTCFullYear()!==y||out.getUTCMonth()!==mo-1||out.getUTCDate()!==d)throw Error(`Data inválida: ${v}`);
  return out;
}
const BASE={columns:Object.fromEntries(['id_registro','aba','tipo_registro','objeto','rua','bairro','status','engenheiro','empresa'].map(c=>[c,{type:'text'}]).concat([['valor_total',{type:'money'}],['valor_executado',{type:'money'}],['valor_contratado',{type:'money'}],['valor_contratado_calculado',{type:'money'}],['valor_pago',{type:'money'}]])),business_rules:[]};

function build(data,override){
  if(!Array.isArray(data)||!data.length)throw Error('Snapshot vazio ou inválido.');
  const config={...BASE,...override,columns:{...BASE.columns,...override.columns}};
  const warnings=new Set();
  const sourceWarnings=new Map(data.map(r=>[r.id_registro,r.avisos_fonte||[]]));
  let records=data.map(record=>{
    for(const warning of record.avisos_fonte||[])warnings.add(String(warning));
    const r=Object.fromEntries(Object.entries(record).filter(([k])=>k!=='avisos_fonte'&&k!=='dados_originais'&&k!=='valor_total_formatado'&&!k.endsWith('_centavos')));
    for(const [c,v] of Object.entries(record.dados_originais||{})){
      const name='original:'+c;r[name]=v;
    }
    for(const name of ['valor_total','valor_executado','valor_contratado','valor_contratado_calculado','valor_pago']){
      const cents=record[name+'_centavos'];r[name]=cents==null?null:new Decimal(cents).div(100);
      if(record[name+'_invalido'])warnings.add(`Há ${name.replace(/_/g,' ')} inválido; análise financeira pode ficar parcial.`);
    }
    return r;
  });
  const columns=[...new Set(records.flatMap(r=>Object.keys(r)))];
  // Não inferir o tipo da coluna inteira a partir de uma única célula numérica.
  // Códigos/documentos e colunas de números misturados com texto permanecem texto.
  for(const name of columns.filter(c=>c.startsWith('original:'))){
    if(Object.hasOwn(config.columns,name))continue;
    const values=records.map(r=>r[name]).filter(v=>!empty(v));
    const identifier=/\b(?:cnpj|cpf|cep)\b/.test(norm(name.slice(9)));
    if(colunaMonetaria(name.slice(9)))config.columns[name]={type:'money',locale:'auto'};
    else if(!identifier&&values.length&&values.every(v=>typeof v==='number'&&Number.isFinite(v)))
      config.columns[name]={type:'number'};
  }
  const names=columns.map(c=>config.rename?.[c]??c.trim());
  if(new Set(names).size!==names.length)throw Error('Mapeamento de colunas duplicado.');
  const types=Object.fromEntries(names.map(c=>[c,config.columns[c]?.type||'text']));
  const issues=new Map(),issueRows=new Map(),multipliers=new Map();
  for(const name of names){
    const spec=config.columns[name]||{type:'text'};
    if(!['text','bool','date',...numericTypes].includes(spec.type))throw Error(`Tipo desconhecido em ${name}.`);
    if(numericTypes.has(spec.type))multipliers.set(name,number(spec.multiplier??1));
  }
  const rawRecords=records;
  records=records.map(r=>Object.fromEntries(columns.map((c,i)=>{
    const name=names[i],spec=config.columns[name]||{type:'text'};let v=empty(r[c])?null:r[c];
    try{
    if(numericTypes.has(spec.type)){
      if(spec.type==='money'&&spec.locale==='auto'){
        const cents=paraCentavos(v);if(v!==null&&cents===null)throw Error('Moeda inválida; preserve e confira a fonte.');
        v=cents===null?null:new Decimal(cents.toString()).div(100);
      }else v=number(v,spec.locale||'en_US');
      if(v!==null)v=v.mul(multipliers.get(name));
      if(spec.type==='percent'&&v!==null&&(v.lt(0)||v.gt(100)))warnings.add(`${name}: percentual fora de 0–100; confira a escala na fonte.`);
    }else if(spec.type==='date')v=date(v,spec.format);
    else if(spec.type==='bool'&&v!==null){
      const b={true:true,false:false,sim:true,nao:false,'1':true,'0':false};
      if(!Object.hasOwn(b,norm(v)))throw Error(`${name}: booleano inválido.`);v=b[norm(v)];
    }
    }catch(e){
      // Uma célula malformada não impede consultar as demais linhas/abas.
      // Mantém o valor bruto internamente e reporta amostras e referências.
      if(!issues.has(name))issues.set(name,{column:name,count:0,examples:[]});
      const issue=issues.get(name);issue.count++;
      if(!issueRows.has(name))issueRows.set(name,new Set());issueRows.get(name).add(r.id_registro);
      if(issue.examples.length<3)issue.examples.push({id_registro:r.id_registro,aba:r.aba,
        value:String(r[c]).slice(0,160),reason:String(e.message).slice(0,200)});
      v=null;
    }
    return [name,v];
  })));
  for(const issue of issues.values())warnings.add(`${issue.column}: ${issue.count} valor(es) inválido(s) não foram convertidos; cálculos/filtros nessa coluna podem ficar incompletos. Não foram tratados como zero.`);
  const seen=new Set();
  for(const r of records){const k=JSON.stringify(r);if(seen.has(k))warnings.add('Há linhas duplicadas; contagem usa registros, sem excluir duplicatas automaticamente.');seen.add(k);}
  const profile=Object.fromEntries(names.map(c=>{
    const values=records.map(r=>r[c]),unique=[...new Map(values.filter(v=>v!==null).map(v=>[key(v),v])).values()];
    return [c,{type:types[c],missing:values.filter(v=>v===null).length,distinct:unique.length,examples:unique.slice(0,8).map(v=>String(serial(v)).slice(0,140)),examples_complete:unique.length<=8}];
  }));
  // Mapa por aba construído da fonte, sem replicar todas as linhas no contexto.
  // As chaves de consulta respeitam inclusive renames declarados na configuração.
  const tabs=new Map();
  for(const record of data){
    const tab=String(record.aba||'Não informada');
    if(!tabs.has(tab))tabs.set(tab,{aba:tab,rows:0,tipos_registro:new Set(),headers:new Set()});
    const entry=tabs.get(tab);entry.rows++;entry.tipos_registro.add(record.tipo_registro);
    for(const header of Object.keys(record.dados_originais||{}))entry.headers.add(header);
  }
  const abas=[...tabs.values()].map(t=>({aba:t.aba,rows:t.rows,
    tipos_registro:[...t.tipos_registro].filter(Boolean),
    colunas:[...t.headers].map(header=>{const key='original:'+header;const queryName=config.rename?.[key]??key.trim();
      return {cabecalho:header,coluna_consulta:queryName,tipo:types[queryName]};})}));
  return {records,rawRecords,types,sourceWarnings,issueRows,metadata:{columns:profile,abas,rows:records.length,warnings:[...warnings],conversion_issues:[...issues.values()],business_rules:config.business_rules||[]}};
}
const compare=(a,b)=>a instanceof Decimal?a.comparedTo(b):a instanceof Date?Math.sign(a.getTime()-b.getTime()):a===b?0:a>b?1:-1;

function query(entry,input,includeRecords=false){
  const p=plan(input);
  if(p.clarification)return {status:'clarification',resposta:p.clarification,plan:p};
  const types={...entry.types};let work=entry.records.map(r=>({...r}));
  const column=c=>{if(!Object.hasOwn(types,c))throw Error(`Coluna inexistente: ${c}`);};
  const numeric=c=>{column(c);if(!numericTypes.has(types[c]))throw Error(`${c}: configure o tipo numérico antes de calcular.`);};
  for(const d of p.derived){
    if(['__proto__','constructor','prototype'].includes(d.name))throw Error('Nome derivado reservado.');
    if(Object.hasOwn(types,d.name))throw Error('Nome derivado sobrescreve coluna existente.');
    column(d.left);if(d.right!=='@today')column(d.right);
    let fixed;
    if(d.op==='days_between'){
      if(types[d.left]!=='date'||d.right!=='@today'&&types[d.right]!=='date')throw Error('Diferença em dias exige datas configuradas.');
      if(d.right==='@today')fixed=date(today(),'%Y-%m-%d');
    }else{numeric(d.left);numeric(d.right);}
    for(const r of work){
      const a=r[d.left],b=fixed??r[d.right];
      r[d.name]=a===null||b===null?null:d.op==='days_between'?new Decimal(Math.floor((b-a)/86400000)):
        d.op==='add'?a.plus(b):d.op==='subtract'?a.minus(b):b.isZero()?null:a.div(b);
    }
    types[d.name]=['add','subtract'].includes(d.op)&&types[d.left]==='money'&&types[d.right]==='money'?'money':'number';
  }
  function predicate(f){
    column(f.column);const type=types[f.column];
    if(f.op==='is_null')return r=>r[f.column]===null;
    if(f.op==='not_null')return r=>r[f.column]!==null;
    if(f.value==null)throw Error('Filtro precisa de valor.');
    if(f.op==='in'){
      if(!Array.isArray(f.value))throw Error('in exige lista de textos.');
      const values=new Set(f.value.map(norm));return r=>r[f.column]!==null&&values.has(norm(serial(r[f.column])));
    }
    if(f.op==='contains'){
      if(type!=='text'||typeof f.value!=='string')throw Error('contains exige texto.');
      return r=>r[f.column]!==null&&norm(r[f.column]).includes(norm(f.value));
    }
    let right=f.value;
    if(type==='text'){
      if(!['eq','ne'].includes(f.op)||Array.isArray(right))throw Error('Texto aceita eq/ne; comparação numérica exige configurar tipo.');right=norm(right);
    }else if(numericTypes.has(type))right=number(right);
    else if(type==='date')right=date(right,'%Y-%m-%d');
    else if(typeof right!=='boolean'||!['eq','ne'].includes(f.op))throw Error('Filtro booleano exige true/false e eq/ne.');
    return r=>{
      if(r[f.column]===null)return false;
      const cmp=compare(type==='text'?norm(r[f.column]):r[f.column],right);
      return {eq:cmp===0,ne:cmp!==0,gt:cmp>0,ge:cmp>=0,lt:cmp<0,le:cmp<=0}[f.op];
    };
  }
  const all=p.filters.map(predicate),any=p.any_filters.map(predicate);
  work=work.filter(r=>all.every(f=>f(r))&&(!any.length||any.some(f=>f(r))));
  const matched=work.length;
  const used=new Set([...p.select,...p.group_by,...p.filters.map(f=>f.column),...p.any_filters.map(f=>f.column),...p.metrics.map(m=>m.column).filter(Boolean)]);
  used.forEach(column);
  const missing=Object.fromEntries([...used].map(c=>[c,work.filter(r=>r[c]===null).length]).filter(([,n])=>n));
  const names=p.metrics.map(m=>m.name);
  if(new Set(names).size!==names.length||names.some(c=>p.group_by.includes(c)))throw Error('Nomes de métricas duplicados.');
  for(const m of p.metrics){
    if(m.op!=='rows'&&!m.column)throw Error('Métrica exige coluna.');
    if(['sum','mean'].includes(m.op))numeric(m.column);
  }
  const aggregate=(rows,m)=>{
    if(m.op==='rows')return rows.length;
    const values=rows.map(r=>r[m.column]).filter(v=>v!==null);
    if(m.op==='count')return values.length;
    if(m.op==='nunique')return new Set(values.map(key)).size;
    if(!values.length)return null;
    if(['sum','mean'].includes(m.op)){
      const total=values.reduce((a,b)=>a.plus(b),new Decimal(0));return m.op==='mean'?total.div(values.length):total;
    }
    return values.reduce((a,b)=>(m.op==='min'?compare(a,b)>0:compare(a,b)<0)?b:a);
  };
  let result,outputCols;
  if(p.metrics.length){
    if(p.select.length)throw Error('Use select apenas em listagens; métricas retornam seus próprios campos.');
    const groups=new Map();
    if(!p.group_by.length)groups.set('all',{values:[],rows:work});
    else for(const r of work){const values=p.group_by.map(c=>r[c]),k=JSON.stringify(values.map(serial));if(!groups.has(k))groups.set(k,{values,rows:[]});groups.get(k).rows.push(r);}
    result=[...groups.values()].map(g=>Object.fromEntries([...p.group_by.map((c,i)=>[c,g.values[i]]),...p.metrics.map(m=>[m.name,aggregate(g.rows,m)])]));
    outputCols=[...p.group_by,...names];
  }else{
    if(p.group_by.length)throw Error('Agrupamento exige métricas.');result=work;outputCols=Object.keys(types);
  }
  for(const s of p.sort)if(!outputCols.includes(s.column))throw Error(`Ordenação inválida: ${s.column}`);
  result.sort((a,b)=>{
    for(const s of p.sort){const x=a[s.column],y=b[s.column];if(x===null&&y===null)continue;if(x===null)return 1;if(y===null)return -1;const n=compare(x,y)*(s.descending?-1:1);if(n)return n;}return 0;
  });
  if(p.select.length)outputCols=p.select;
  const total=result.length;
  const rows=result.slice(p.offset,p.offset+p.limit).map(r=>Object.fromEntries(outputCols.map(c=>[c,serial(r[c])])));
  const warnings=[...new Set(work.flatMap(r=>entry.sourceWarnings?.get(r.id_registro)||[]))];
  const ids=new Set(work.map(r=>r.id_registro));
  for(const issue of entry.metadata.conversion_issues||[])if(used.has(issue.column)&&([...p.filters,...p.any_filters].some(f=>f.column===issue.column)||[...(entry.issueRows?.get(issue.column)||[])].some(id=>ids.has(id))))
    warnings.push(`${issue.column}: há valores inválidos no recorte; cálculos/filtros podem ficar incompletos, sem tratar erros como zero.`);
  for(const c of used)if(work.some(r=>r[c+'_invalido']))warnings.push(`${c}: há valor inválido no recorte; análise financeira pode ficar parcial.`);
  if(!matched)warnings.push('Nenhum registro corresponde aos filtros. Isso não confirma que a obra não exista fora desta fonte.');
  if(Object.keys(missing).length)warnings.push('Há dados ausentes; cálculos ignoram campos vazios e não os tratam como zero.');
  if(total>p.offset+p.limit)warnings.push('Resultado parcial: há mais linhas. Use offset para continuar.');
  const moneyColumns=outputCols.filter(c=>types[c]==='money'||p.metrics.some(m=>m.name===c&&types[m.column]==='money'&&['sum','mean','min','max'].includes(m.op)));
  const evidence={money_columns:moneyColumns,matched_source_rows:matched,
    source_samples:work.slice(0,20).map(r=>({id_registro:serial(r.id_registro),aba:serial(r.aba)})),
    source_samples_complete:matched<=20,
    selected_columns:outputCols,filters:p.filters,any_filters:p.any_filters,
    group_by:p.group_by,metrics:p.metrics,derived:p.derived};
  return {status:'ok',matched_rows:matched,total_result_rows:total,rows,missing,warnings,plan:p,evidence,
    ...(includeRecords?{_matched_records:work.map(r=>Object.fromEntries(Object.keys(entry.types).map(c=>[c,r[c]])))}:{})};
}

function inspect(entry,input){
  validate(input,schemaInspecao,'inspecao');
  if(new Set(input.columns).size!==input.columns.length)throw Error('Selecione colunas diferentes para inspecionar.');
  let name='_registros';while(Object.hasOwn(entry.types,name))name+='_' ;
  const result=query(entry,{filters:input.filters||[],any_filters:input.any_filters||[],
    group_by:input.columns,metrics:[{name,op:'rows'}],limit:input.limit??30,offset:input.offset??0});
  const offset=input.offset??0,hasMore=offset+result.rows.length<result.total_result_rows;
  return {...result,stage:'inspection',columns:input.columns,count_column:name,
    total_combinations:result.total_result_rows,has_more:hasMore,
    next_offset:hasMore?offset+result.rows.length:null,
    complete_view:offset===0&&!hasMore,
    column_types:Object.fromEntries(input.columns.map(c=>[c,entry.types[c]]))};
}

export function criarMotor({now=()=>performance.now(),config}={}){
  const cache=new Map(),snapshots=new Map();
  const configuration=()=>config??JSON.parse(readFileSync(new URL('./analise-config.json',import.meta.url),'utf8'));
  return async function executar(payload){
    const namespace=payload.cache_key||'default';let result;
    if(payload.acao==='abrir'){
      if(snapshots.size>=128)throw Error('Muitas análises simultâneas; tente novamente.');
      const entry={...build(payload.dados,configuration()),created:now(),loaded_at:new Date().toISOString(),version:randomUUID()};
      const id=randomUUID();snapshots.set(id,entry);
      result={status:'ok',...entry.metadata,snapshot_id:id,version:entry.version,loaded_at:entry.loaded_at,cache_age_seconds:0};
    }else if(payload.acao==='recortar'){
      const entry=snapshots.get(payload.snapshot_id);if(!entry)throw Error('Snapshot indisponível.');
      const selected=query(entry,payload.plano,true)._matched_records;
      if(!selected?.length)throw Error('Não há linhas para manter no contexto.');
      if(snapshots.size>=128)throw Error('Muitas análises simultâneas; tente novamente.');
      const ids=new Set(selected.map(r=>r.id_registro));
      const columns=Object.fromEntries(Object.keys(entry.types).map(c=>{
        const vals=selected.map(r=>r[c]),unique=[...new Map(vals.filter(v=>v!=null).map(v=>[key(v),v])).values()];
        return [c,{type:entry.types[c],missing:vals.filter(v=>v==null).length,distinct:unique.length,
          examples:unique.slice(0,8).map(v=>String(serial(v)).slice(0,140)),examples_complete:unique.length<=8}];
      }));
      const abas=entry.metadata.abas.map(tab=>({...tab,rows:selected.filter(r=>r.aba===tab.aba).length})).filter(tab=>tab.rows);
      const e={...entry,records:selected,rawRecords:entry.rawRecords.filter(r=>ids.has(r.id_registro)),
        metadata:{...entry.metadata,columns,abas,rows:selected.length}};
      const id=randomUUID();snapshots.set(id,e);
      result={status:'ok',...e.metadata,snapshot_id:id,version:e.version,loaded_at:e.loaded_at,cache_age_seconds:(now()-e.created)/1000};
    }else if(payload.acao==='carregar'){
      const built=build(payload.dados,configuration());
      const entry={...built,created:now(),loaded_at:new Date().toISOString(),version:randomUUID()};
      cache.set(namespace,entry);
      if(cache.size>64){const oldest=[...cache].filter(([k])=>k!==namespace).sort((a,b)=>a[1].created-b[1].created)[0];cache.delete(oldest[0]);}
      result={status:'loaded',version:entry.version,rows:entry.records.length};
    }else if(payload.acao==='invalidar'){cache.delete(namespace);result={status:'invalidated'};}
    else if(payload.acao==='estrutura'){
      const e=cache.get(namespace),ttl=Math.max(1,Math.min(Number(payload.cache_seconds??60),86400));
      if(!Number.isFinite(ttl))throw Error('Tempo de cache inválido.');
      if(!e||now()-e.created>=ttl*1000)return {status:'precisa_dados'};
      if(snapshots.size>=128)throw Error('Muitas análises simultâneas; tente novamente.');
      const id=randomUUID();snapshots.set(id,e);
      result={status:'ok',...e.metadata,snapshot_id:id,version:e.version,loaded_at:e.loaded_at,cache_age_seconds:(now()-e.created)/1000};
    }else if(payload.acao==='liberar'){snapshots.delete(payload.snapshot_id);result={status:'released'};}
    else if(['executar','inspecionar'].includes(payload.acao)){
      const e=snapshots.get(payload.snapshot_id);if(!e)throw Error('Snapshot indisponível. Refaça a pergunta.');
      result=payload.acao==='inspecionar'?inspect(e,payload.inspecao):query(e,payload.plano);
      result.warnings=[...new Set(result.warnings||[])];
      result.version=e.version;result.loaded_at=e.loaded_at;
    }else throw Error('Ação inválida.');
    if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw Error('Resultado maior que 8 MB. Reduza a consulta.');
    return result;
  };
}
export const executarAnalise=criarMotor();
