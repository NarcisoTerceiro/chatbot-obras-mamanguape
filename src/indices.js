import { createHash } from 'node:crypto';

const cache = new WeakMap();
const normalizar = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const vazio = v => v == null || (typeof v === 'string' && !v.trim());
export const referencia = l => JSON.stringify([l._aba, l._linha]);

// Referências são locais à versão: nunca reutilizar a linha após alteração da base.
export function indexar(linhas) {
  if (cache.has(linhas)) return cache.get(linhas);
  const colunas = new Map(), registros = new Map();
  for (const linha of linhas) {
    registros.set(referencia(linha), linha);
    for (const [nome, valor] of Object.entries(linha)) {
      if (nome.startsWith('_') && nome !== '_aba') continue;
      if (!colunas.has(nome)) colunas.set(nome, new Map());
      const valores = colunas.get(nome), chave = vazio(valor) ? null : normalizar(valor);
      if (!valores.has(chave)) valores.set(chave, { valor, linhas: new Set() });
      valores.get(chave).linhas.add(linha);
    }
  }
  const versao = createHash('sha256').update(JSON.stringify(linhas)).digest('hex');
  const resultado = { colunas, registros, versao };
  cache.set(linhas, resultado);
  return resultado;
}

// Testa cada valor distinto uma vez. Preserva a semântica de filtros do agente.
export function consultarIndice(linhas, coluna, filtro, comparar) {
  const valores = indexar(linhas).colunas.get(coluna);
  if (!valores) throw new Error(`Coluna inexistente: ${coluna}`);
  const encontrados = new Set();
  if (filtro.op === 'igual') {
    for (const valor of [].concat(filtro.valor)) {
      for (const linha of valores.get(normalizar(valor))?.linhas || []) encontrados.add(linha);
    }
  } else {
    for (const entrada of valores.values()) {
      if (comparar(entrada.valor, filtro)) for (const linha of entrada.linhas) encontrados.add(linha);
    }
  }
  // Colunas ausentes numa aba têm o mesmo significado que células vazias.
  if (comparar(undefined, filtro)) {
    for (const linha of linhas) if (!(coluna in linha)) encontrados.add(linha);
  }
  return encontrados;
}

function significado(nome) {
  const n = normalizar(nome);
  if (/engenheiro|arquiteto/.test(n)) return 'Responsável técnico registrado; preservar o cargo original.';
  if (/^(status|situacao)/.test(n)) return 'Situação do registro nesta aba; projeto concluído não equivale a obra concluída.';
  if (/bairro/.test(n)) return 'Localização registrada; pode conter endereço livre ou múltiplas localidades.';
  if (/valor executado/.test(n)) return 'Valor de execução informado, distinto de contratado e pago.';
  if (/pago/.test(n)) return 'Pagamento no período ou gestão indicado no cabeçalho; não presumir total geral.';
  if (/data|prazo/.test(n)) return 'Data ou prazo definido no cabeçalho; confirmar previsão versus realização.';
  if (/objeto|^obra$|^rua$/.test(n)) return 'Nome ou descrição do registro, não identificador único.';
  return 'Campo original: ' + nome + '. Não inferir definições adicionais ou somar campos sobrepostos.';
}

export function catalogoPorAba(linhas) {
  const abas = new Map();
  for (const linha of linhas) {
    if (!abas.has(linha._aba)) abas.set(linha._aba, new Map());
    const cols = abas.get(linha._aba);
    for (const nome of Object.keys(linha).filter(c => !c.startsWith('_'))) {
      if (!cols.has(nome)) cols.set(nome, { indice: JSON.stringify([linha._aba, nome]), coluna: nome, significado: significado(nome) });
    }
  }
  return [...abas].map(([aba, cols]) => ({ aba, colunas: [...cols.values()] }));
}
