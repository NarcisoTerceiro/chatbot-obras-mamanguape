// Aceita células numéricas do Sheets e textos monetários BR/US completos.
// Não tenta reconstruir um valor que já chegou truncado da fonte.
export function paraCentavos(valor) {
  if (valor == null || String(valor).trim() === '') return null;
  let s;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor) || Math.abs(valor) > Number.MAX_SAFE_INTEGER / 100) return null;
    s = valor.toFixed(2);
  } else {
    s = String(valor).trim().replace(/R\$/gi, '').replace(/\s/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    const corpo = s.replace(/^[+-]/, '');
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(corpo)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(corpo)) s = s.replace(/,/g, '');
    else if (/^\d+(,\d{1,2})?$/.test(corpo)) s = s.replace(',', '.');
    else if (!/^\d+\.\d{1,2}$/.test(corpo)) return null;
  }
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [inteiro, fracao = ''] = s.replace(/^[+-]/, '').split('.');
  const cents = BigInt(inteiro) * 100n + BigInt(fracao.padEnd(2, '0'));
  return s.startsWith('-') ? -cents : cents;
}

export function colunaMonetaria(nome) {
  const n = String(nome).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/_/g, ' ').trim();
  return !/[％%]|PERCENTUAL/.test(n) && (/^VALOR(?:\s|$)/.test(n) || /^PAGO(?:\s|$)/.test(n));
}
