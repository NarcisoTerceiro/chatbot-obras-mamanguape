// Google Sheets read-only. Preserve numeric values/zero and original source row.
const normaliza=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const filled=v=>v!==null&&v!==undefined&&(typeof v!=='string'||v.trim()!=='');
const words=['objeto','obra','rua','situacao','status','contrato','empresa','recurso','engenheiro','arquiteto','valor','bairro','endereco','fonte','convenio','proposta','data','prazo','aditivo','logradouro'];
function headerScore(row){
 return (row||[]).reduce((score,cell)=>{
  if(typeof cell!=='string')return score;
  const label=normaliza(cell);if(label.length>90)return score;
  return score+Number(words.some(word=>new RegExp(`\\b${word}\\b`).test(label)));
 },0);
}
export function acharLinhaCabecalho(rows,maxLinhasAnalisadas=15){
 if(!Array.isArray(rows)||!rows.length)return -1;
 let best=-1,score=1;
 for(let i=0;i<Math.min(rows.length,maxLinhasAnalisadas);i++){
  const n=headerScore(rows[i]);
  if(n>score){score=n;best=i;}
 }
 if(best!==-1)return best;
 // Keep support for unknown tables, choosing the widest candidate when no strong header exists.
 let width=1;
 for(let i=0;i<Math.min(rows.length,maxLinhasAnalisadas);i++){
  const n=(rows[i]||[]).filter(filled).length;if(n>width){width=n;best=i;}
 }
 return best;
}
export function rowsToObjects(rows,tabName){
 const idx=acharLinhaCabecalho(rows);
 if(idx<0)return {obras:[],cabecalho:[],ignoradas:0};
 const header=(rows[idx]||[]).map(h=>String(h??'').trim());
 const names=header.filter(Boolean);
 if(new Set(names).size!==names.length)throw Error(`Aba ${tabName}: cabeçalhos duplicados. Corrija a fonte antes de consultar.`);
 if(names.some(n=>['_aba','_linha'].includes(n)))throw Error(`Aba ${tabName}: cabeçalho reservado.`);
 const obras=[];let ignoradas=0;
 for(let i=idx+1;i<rows.length;i++){
  const row=rows[i]||[];
  if(!row.some(filled)){ignoradas++;continue;}
  const obj={_aba:tabName,_linha:i+1};let count=0;
  header.forEach((name,j)=>{
   if(!name||!filled(row[j]))return;
   const value=typeof row[j]==='string'?row[j].trim():row[j];
   obj[name]=value;count++;
  });
  if(!count){ignoradas++;continue;}
  // Repeated headers inside the same tab are not records.
  const repeat=names.length>1&&header.every((name,j)=>!name||normaliza(row[j])===normaliza(name));
  if(repeat){ignoradas++;continue;}
  obras.push(obj);
 }
 return {obras,cabecalho:names,ignoradas};
}
const split=s=>String(s||'').split(',').map(t=>t.trim()).filter(Boolean);
const duration=(s,fallback)=>{const n=Number(s);return Number.isFinite(n)&&n>=0&&s!==undefined&&s!==''?n:fallback;};

export function criarLeitorSheets({api,env=process.env,now=()=>Date.now(),logger=console}={}){
 let source=api;
 let initializing=null;
 let cache={data:null,time:0};let tabsCache={nomes:null,time:0};
 let diagnostic={abas:[],total:0,quando:null};
 let pending=null;let generation=0;let revision=0;
 async function getApi(){
  if(source)return source;
  if(!initializing)initializing=(async()=>{
   const {google}=await import('googleapis');
   const inline=env.GOOGLE_SERVICE_ACCOUNT_JSON;
   const scopes=['https://www.googleapis.com/auth/spreadsheets.readonly'];
   const auth=new google.auth.GoogleAuth(inline?.trim()?{credentials:JSON.parse(inline),scopes}:{scopes});
   source=google.sheets({version:'v4',auth});return source;
  })().catch(e=>{initializing=null;throw e;});
  return initializing;
 }
 function limparCache(){
  generation++;revision++;pending=null;
  cache={data:null,time:0};tabsCache={nomes:null,time:0};
 }
 async function getObras({force=false}={}){
  const id=env.GOOGLE_SHEETS_ID;
  if(!id)throw Error('Configure GOOGLE_SHEETS_ID no .env.');
  const cacheMs=duration(env.SHEETS_CACHE_MS,180000);
  if(!force&&cache.data!==null&&now()-cache.time<cacheMs)return cache.data;
  if(pending)return pending;
  const currentGeneration=generation;
  const task=(async()=>{
   const sheets=await getApi();
   let tabs=split(env.SHEETS_TABS);
   if(!tabs.length){
    const cacheTabsMs=duration(env.SHEETS_CACHE_ABAS_MS,300000);
    if(!force&&tabsCache.nomes&&now()-tabsCache.time<cacheTabsMs)tabs=tabsCache.nomes;
    else{
     const resp=await sheets.spreadsheets.get({spreadsheetId:id,fields:'sheets.properties.title'});
     const ignored=split(env.SHEETS_TABS_IGNORAR).map(normaliza);
     tabs=(resp.data.sheets||[]).map(s=>s.properties?.title).filter(t=>t&&!ignored.includes(normaliza(t)));
     if(generation===currentGeneration)tabsCache={nomes:tabs,time:now()};
    }
   }
   let values=[];
   if(tabs.length){
    const ranges=tabs.map(t=>"'"+t.replace(/'/g,"''")+"'");
    const response=await sheets.spreadsheets.values.batchGet({spreadsheetId:id,ranges,
     valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'FORMATTED_STRING'});
    values=response.data.valueRanges||[];
    if(values.length!==tabs.length)throw Error('O Google não retornou todas as abas solicitadas; leitura cancelada.');
   }
   const all=[];const report=[];
   values.forEach((vr,i)=>{
    const {obras,cabecalho,ignoradas}=rowsToObjects(vr.values||[],tabs[i]);all.push(...obras);
    report.push({aba:tabs[i],linhas_lidas:(vr.values||[]).length,obras:obras.length,linhas_ignoradas:ignoradas,cabecalho});
   });
   if(generation!==currentGeneration)throw Error('Leitura invalidada por uma atualização. Tente novamente.');
   cache={data:all,time:now()};revision++;
   diagnostic={abas:report,total:all.length,quando:new Date(now()).toISOString()};
   logger?.log?.(`SHEETS: ${all.length} registros lidos em ${report.length} abas.`);
   return all;
  })();
  pending=task;
  try{return await task;}finally{if(pending===task)pending=null;}
 }
 return {getObras,limparCache,getDiagnostico:()=>diagnostic,getVersaoCache:()=>revision};
}
const defaultReader=criarLeitorSheets();
export const getObras=options=>defaultReader.getObras(options);
export const limparCache=()=>defaultReader.limparCache();
export const getDiagnostico=()=>defaultReader.getDiagnostico();
export const getVersaoCache=()=>defaultReader.getVersaoCache();
