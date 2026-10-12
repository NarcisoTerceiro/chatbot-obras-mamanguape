import { parse } from 'pgsql-ast-parser';

// Valores monetários em strings decimais: pg/NUMERIC não passa por ponto flutuante.
export function decimalMoeda(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : null;
  let s = String(v).trim();
  if (!s || s === '-') return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^\((.*)\)$/, '$1').replace(/^[-+]/, '').replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(s)) return null;
  const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
  let decimal = null;
  if (comma >= 0 && dot >= 0) decimal = comma > dot ? ',' : '.';
  else if (comma >= 0 || dot >= 0) {
    const sep = comma >= 0 ? ',' : '.', parts = s.split(sep);
    if (parts.at(-1).length !== 3) decimal = sep;
  }
  let whole, fraction;
  if (decimal) {
    const i = s.lastIndexOf(decimal);
    whole = s.slice(0, i).replace(/[.,]/g, ''); fraction = s.slice(i + 1);
  } else { whole = s.replace(/[.,]/g, ''); fraction = ''; }
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents++;
  return `${negative && cents !== 0n ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

const SAFE_FUNCTIONS = new Set(('count sum avg min max abs round ceil ceiling floor trunc mod power sqrt coalesce nullif greatest least lower upper trim btrim ltrim rtrim length char_length concat concat_ws replace regexp_replace strpos substring split_part to_char to_date date_part date_trunc extract age now current_date jsonb_each jsonb_each_text jsonb_object_keys jsonb_array_elements jsonb_array_elements_text jsonb_typeof jsonb_extract_path_text jsonb_build_object jsonb_agg json_agg string_agg array_agg row_number rank dense_rank lag lead first_value last_value bool_and bool_or').split(' '));
const STATEMENTS = new Set(['select', 'with', 'union', 'union all']);
const RELATIONS = new Set(['obras', 'obras_chatbot', 'planilha_abas']);
export function validarSQL(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 24000) throw Error('Consulta SQL vazia ou muito longa.');
  const ast = parse(sql);
  if (ast.length !== 1 || !STATEMENTS.has(ast[0].type)) throw Error('Envie uma única consulta SELECT, com CTE opcional.');
  const aliases = new Set();
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'with') for (const b of node.bind || []) aliases.add(b.alias.name);
    for (const v of Object.values(node)) if (Array.isArray(v)) v.forEach(collect); else collect(v);
  }
  collect(ast[0]);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (['insert','update','delete','create table','drop table','truncate','with recursive'].includes(node.type)) throw Error('Operação SQL não permitida.');
    if (node.type === 'table') {
      const { name, schema } = node.name;
      const sourceView=schema==='planilha' && /^aba_[a-z0-9_]+$/.test(name);
      if (!sourceView && schema && schema !== 'public') throw Error('Somente public ou views autorizadas no schema planilha são permitidos.');
      if (!sourceView && !(RELATIONS.has(name) || (!schema && aliases.has(name)))) throw Error(`Relação não permitida: ${name}.`);
    }
    if (node.type === 'call') {
      const f = node.function;
      if ((f.schema && f.schema !== 'pg_catalog') || !SAFE_FUNCTIONS.has(f.name.toLowerCase())) throw Error(`Função não permitida: ${f.name}.`);
    }
    if (node.type === 'cast') {
      const name = node.to?.name?.toLowerCase();
      if (!['text','varchar','numeric','decimal','integer','int','int4','int8','bigint','smallint','float','float4','float8','real','double precision','boolean','bool','date','timestamp','timestamptz','interval','json','jsonb'].includes(name)) throw Error('Tipo de conversão não permitido.');
    }
    if (node.into || node.for) throw Error('SELECT INTO e bloqueios não são permitidos.');
    for (const v of Object.values(node)) if (Array.isArray(v)) v.forEach(walk); else walk(v);
  }
  walk(ast[0]);
  return sql.trim().replace(/;\s*$/, '');
}

export const DOCUMENTOS = [
  'Organização por aba: public.planilha_abas guarda catálogo e células originais por GOOGLE_SHEETS_ID e aba. ativa=true identifica a fonte atual. Cada aba tem uma view no schema planilha, com cabeçalhos originais e tipos numeric/boolean somente quando a fonte comprova esses tipos. Consulte o catálogo de views reais, não invente nomes. Estas views mostram os mesmos registros de public.obras; não some dados duplicados entre fonte e tabela canônica. Matriz celulas conserva cabeçalhos, títulos e linhas não interpretadas; não é uma lista de obras.',
  'Fonte: public.obras contém uma linha por registro de cada aba. public.obras_chatbot é a view existente; prefira-a se tiver os campos necessários. Não una a tabela com sua view para somar: são os mesmos registros.',
  'Tipos: tipo_registro distingue obra, pavimentacao, projeto, licitacao, pendencia e outro. Categoria descreve a aba, não comprova status físico. Não excluir pavimentação de obras automaticamente. Examine nomes de abas e objetos para decidir o universo.',
  'Status: status_original conserva a célula; status é sua normalização. Aba em_andamento não comprova conclusão ou andamento quando status estiver vazio. Executada e concluída não são sinônimos.',
  'Finanças: valor_total é o total informado, valor_contratado usa total ou composição completa; valor_contratado_calculado soma inicial + aditivos + reajustes somente se os três existem. valor_executado é diferente de valor_pago. NULL significa ausente, não zero. SUM ignora NULL: informar quantos valores faltam.',
  'Pagamentos: valor_pago usa o campo total pago, se existe; caso contrário soma VALOR PAGO AAAA. Não somar total e anos juntos. Consulte dados_extras para um ano específico e avisos_fonte para soma parcial.',
  'Saúde educação UBS: descobrir objeto, recurso e classificações reais antes de filtrar. Creche e escola pertencem à educação; UBS e hospital à saúde. Não usar apenas uma palavra no recurso se o objeto também define a área. UBS: distinguir número de registros de obras de número de unidades físicas; reforma e construção podem ser registros da mesma unidade.',
  'Origem: aba_origem e linha_origem identificam o registro. dados_extras é JSONB com todas as células e cabeçalhos originais, incluindo vazios e zeros. Acesse com dados_extras ->> \'NOME EXATO\'. Não inventar nomes. Campos novos entram nesse JSONB sem migração.',
  'Contagens e listagens: usar o mesmo universo e filtros. COUNT(*) conta registros; COUNT(campo) conta preenchidos; COUNT(DISTINCT campo) conta distintos. Para quantas obras, não contar só a página exibida. Ranking por engenheiro exige GROUP BY engenheiro e SUM ou COUNT conforme pedido; retornar nome e valor.',
  'Contexto: a pergunta atual define os filtros. Histórico explica referências como dessas/quais são. Não herdar bairro ou status de pergunta anterior independente. Se ambiguidades alteram o resultado, pedir esclarecimento curto.',
  'Datas: cabeçalhos originais podem conter texto DD/MM/YYYY, ISO ou serial Sheets. Inspecionar valores antes de converter. Não presumir que data de previsão é conclusão efetiva.',
];
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const tokens = s => norm(s).match(/[a-z0-9]+/g) || [];
// BM25 sobre documentação semântica, inspirado no retriever do RAG_NLP_SQL.
export function recuperarContexto(pergunta, adicionais = [], k = 5) {
  const docs = [...DOCUMENTOS, ...adicionais.map(x => typeof x === 'string' ? x : [x.regra_negocio, x.pergunta_exemplo, x.sql_exemplo].filter(Boolean).join('\n'))];
  const words = docs.map(tokens), avg = words.reduce((s,w) => s+w.length,0)/words.length;
  const q = [...new Set(tokens(pergunta))];
  return docs.map((doc,i) => ({doc, score:q.reduce((score,t) => {
    const df=words.filter(w => w.includes(t)).length, tf=words[i].filter(w => w===t).length;
    return score+Math.log(1+(words.length-df+.5)/(df+.5))*tf*2.2/(tf+1.2*(.25+.75*words[i].length/avg));
  },0)})).sort((a,b) => b.score-a.score).slice(0,k).map(x=>x.doc);
}

// Identifica filtros exatos simples de bairro para conferir grafias na fonte.
// Não altera SQL nem troca um filtro silenciosamente.
export function filtrosExatosBairro(sql, params = []) {
  const encontrados = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'binary' && ['=', 'ILIKE', 'LIKE'].includes(node.op.toUpperCase())) {
      let left = node.left, right = node.right;
      if (right?.type === 'ref' && right.name === 'bairro') [left, right] = [right, left];
      if (left?.type === 'ref' && left.name === 'bairro') {
        const v = right?.type === 'string' ? right.value : right?.type === 'parameter' ? params[Number(right.name.slice(1))-1] : null;
        if (typeof v === 'string' && v.trim() && v.length <= 150 && !/[%_]/.test(v)) encontrados.add(v);
      }
    }
    for (const v of Object.values(node)) if (Array.isArray(v)) v.forEach(visit); else visit(v);
  }
  parse(sql).forEach(visit);
  return [...encontrados];
}
