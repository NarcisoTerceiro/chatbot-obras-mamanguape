import { parse } from 'pgsql-ast-parser';

const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const labels = {
  objeto:'Obra',bairro:'Bairro',status:'Situação',status_original:'Situação',empresa:'Empresa',engenheiro:'Responsável',
  valor_total:'Valor contratado',valor_contratado:'Valor contratado',valor_executado:'Valor executado',valor_pago:'Valor pago',
  quanto_falta:'Valor restante',percentual_executado:'Percentual executado',data_inicio:'Início',data_prev_termino:'Previsão de término',
  recurso:'Recurso',tipo_recurso:'Tipo de recurso',contrato:'Contrato',convenio:'Convênio',observacoes:'Observações',categoria:'Categoria'
};
const privateText = /\b(?:sql|select|from|where|view|null|postgres\w*|supabase|nvidia|groq|gemini|api|tokens?|banco(?: de dados)?|planilhas?|tabelas?|colunas?|campos?|tipo_negocio|concluido|valor_executado|valor_total|dados_extras)\b/i;
export function textoPublico(value) {
  const s=String(value || '').trim().replace(/\*\*([^*]+)\*\*/g,'*$1*');
  return !s || privateText.test(s) ? 'Não consegui preparar a resposta agora. Pode reformular a pergunta?' : s;
}
function visit(node, fn) {
  if(!node || typeof node!=='object')return;
  fn(node);
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(v=>visit(v,fn));else visit(value,fn);
}
// Conferência da consulta antes da execução; nunca troca filtros silenciosamente.
export function conferirConsulta(sql, pergunta, catalogo=[]) {
  const q=norm(pergunta), ast=parse(sql), calls=[], refs=[], tables=[];
  let physical=false;
  visit(ast,n=>{
    if(n.type==='call')calls.push(n);
    if(n.type==='ref')refs.push(n.name);
    if(n.type==='table')tables.push(n.name?.name);
    if(n.type==='binary' && ['=','IN'].includes(n.op?.toUpperCase())){
      const sides=[n.left,n.right];
      if(sides.some(s=>s?.type==='ref'&&['tipo_negocio','tipo_registro','aba_origem'].includes(s.name))) {
        const vals=[];sides.forEach(s=>visit(s,v=>{if(v.type==='string')vals.push(norm(v.value));}));
        if(vals.some(v=>['obra','pavimentacao','em_andamento','pavimentacao'].includes(v)))physical=true;
      }
    }
  });
  const known=tables.some(t=>['obras','obras_chatbot'].includes(t));
  const works=/\bobras?\b/.test(q)||(/engenheiro|responsavel/.test(q)&&/mais|menos|maior|menor/.test(q));
  const explicitOther=/\bprojetos?\b|licitac|todos os registros|todas as abas|inclu.*projeto/.test(q);
  const available=catalogo.some(c=>['tipo_negocio','tipo_registro'].includes(c.column_name));
  if(known&&works&&!explicitOther&&available&&!physical)throw Error("A pergunta pede obras físicas. Inclua tipo_negocio = 'obra' na view (ou os tipos físicos na tabela base), preservando os demais filtros; projetos e licitações não são obras. Se o catálogo não permitir isso, peça esclarecimento.");
  if(/engenheiro|responsavel/.test(q)&&/mais|menos|maior|menor/.test(q)&&/\bLIMIT\s+\d+/i.test(sql))throw Error('Ranking deve incluir todos os empatados. Use CTE para agrupar e filtre a métrica igual a MAX/MIN; não limite o ranking antes de conferir empates.');
  const sums=calls.filter(c=>c.function?.name?.toLowerCase()==='sum');
  const counts=calls.filter(c=>c.function?.name?.toLowerCase()==='count');
  for(const sum of sums){
    const expr=JSON.stringify(sum.args?.[0]);
    if(!counts.some(c=>JSON.stringify(c.args?.[0])===expr)||!counts.some(c=>c.args?.[0]?.type==='ref'&&c.args[0].name==='*'))throw Error('Para a soma, retorne COUNT(*) e COUNT da mesma expressão somada, com aliases distintos. Total de registros não comprova que todos tenham valor informado.');
  }
  if(known&&/saude/.test(q)&&!refs.includes('objeto'))throw Error('Saúde deve considerar o objeto e o recurso, após inspecionar os valores reais. Inclua UBS, hospital, CAPS e unidade de saúde; recurso FNS/Ministério da Saúde. FNDE, escolas e creches são educação. Preserve o universo pedido.');
}
const money=v=>{
  const m=String(v).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  return m?`${m[1]}R$ ${m[2].replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${(m[3]||'').padEnd(2,'0').slice(0,2)}`:'não informado';
};
const safeValue=v=>v==null?'não informado':typeof v==='object'?'não informado':String(v).replace(/\r?\n/g,' ').slice(0,300);
function aggregates(sql) {
  const columns=[];
  visit(parse(sql),n=>{if(n.type==='select')columns.push(...(n.columns||[]));});
  return columns.map(c=>({key:c.alias?.name||(c.expr?.type==='call'?c.expr.function.name:null),fn:c.expr?.type==='call'?c.expr.function.name.toLowerCase():null,arg:c.expr?.args?.[0]}));
}
export function respostaConferida(result, pergunta='') {
  const rows=result.rows||[];
  if(!rows.length)return 'Não encontrei resultados para o que você pediu.';
  const ag=aggregates(result.sql||'SELECT 1'),q=norm(pergunta);
  const ranking=rows.every(r=>r.engenheiro!=null)&&ag.some(a=>a.fn==='count')&&!rows.some(r=>r.objeto);
  if(ranking){
    const metric=ag.find(a=>a.fn==='count')?.key;
    if(!metric||!rows.every(r=>r[metric]!=null))return null;
    const tied=rows.length>1&&rows.every(r=>String(r[metric])===String(rows[0][metric]));
    const heading=tied?`*Empate*: ${rows.length} responsáveis têm *${rows[0][metric]} ${/registro|projeto|licitac/.test(q)?'registros':'obras'}* cada.`:'*Responsáveis e quantidade de obras:*';
    return [heading,...rows.map(r=>`• ${safeValue(r.engenheiro)} — ${r[metric]}`)].join('\n');
  }
  if(rows.length===1&&ag.some(a=>a.fn)){
    const row=rows[0],lines=[];
    const total=ag.find(a=>a.fn==='count'&&a.arg?.name==='*');
    const sums=ag.filter(a=>a.fn==='sum');
    for(const a of sums){
      const field=a.arg?.name,label=labels[field]||'Valor total';
      const filled=ag.find(c=>c.fn==='count'&&JSON.stringify(c.arg)===JSON.stringify(a.arg));
      lines.push(`*${label}: ${row[a.key]==null?'não informado':money(row[a.key])}*`);
      if(total&&filled&&row[total.key]!=null&&row[filled.key]!=null){
        const n=Number(row[total.key]),known=Number(row[filled.key]);
        lines.push(`São ${n} obras; ${known} têm esse valor informado.`);
        if(n>known)lines.push(`O total considera os valores disponíveis. ${n-known} obras não têm esse valor informado.`);
      }
    }
    if(!sums.length){
      for(const a of ag.filter(a=>a.fn==='count'))if(row[a.key]!=null)lines.push(`*Quantidade: ${row[a.key]}*`);
    }
    if(lines.length)return lines.join('\n');
  }
  const fields=Object.keys(rows[0]).filter(k=>labels[k]);
  if(!fields.length)return null;
  const works=fields.includes('objeto'),chunks=[];
  let shown=0;
  for(const row of rows){
    const lines=fields.filter(k=>row[k]!==undefined).map(k=>`${labels[k]}: ${k.startsWith('valor_')||k==='quanto_falta'?row[k]==null?'não informado':money(row[k]):safeValue(row[k])}`);
    const block='• '+lines.join('\n');
    if(chunks.join('\n\n').length+block.length>3100&&shown)break;
    chunks.push(block);shown++;
  }
  const limited=result.has_more||/\b(?:LIMIT|OFFSET)\b/i.test(result.sql||'');
  const heading=works?(!limited?`Encontrei *${rows.length} obras*.`:'*Obras encontradas:*'):'*Informações encontradas:*';
  if(shown<rows.length||limited)chunks.push(limited?`Mostrando ${shown} resultados. A lista é parcial; peça para continuar.`:`Mostrando ${shown} das ${rows.length} obras. Peça para continuar.`);
  return [heading,...chunks].join('\n\n');
}
