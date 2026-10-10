// O código da IA roda no QuickJS/WASM, nunca no contexto Node deste worker.
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

let runtime, contexto;
try {
  const QuickJS = await getQuickJS();
  runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  contexto = runtime.newContext();
  // Só entra uma string JSON. Nenhum objeto/função do host, rede, importador ou env é exposto.
  const json = contexto.newString(workerData.snapshotJSON);
  contexto.setProp(contexto.global, '__snapshotJSON', json);
  json.dispose();
  const inicializar = contexto.evalCode(`
    'use strict';
    const dadosObras = JSON.parse(__snapshotJSON);
    delete globalThis.__snapshotJSON;
    const normalizar = v => String(v == null ? '' : v).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[_\\s]+/g, ' ').trim();
    const centavos = o => o.valor_total_centavos == null ? null : BigInt(o.valor_total_centavos);
    const moeda = c => {
      c = BigInt(c); const negativo = c < 0n; if (negativo) c = -c;
      return (negativo ? '-' : '') + 'R$ ' + (c / 100n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.') + ',' + (c % 100n).toString().padStart(2, '0');
    };
    const hoje = ${JSON.stringify(new Date().toISOString())};
    const congelar = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(congelar); } };
    congelar(dadosObras);
    let resultadoFinal = null;
  `, 'preparacao.js');
  if (inicializar.error) {
    inicializar.error.dispose(); throw Error('Não foi possível preparar os dados dentro dos limites.');
  }
  inicializar.value.dispose();
  // Aceita atribuição a resultadoFinal OU return de uma função imediatamente executada.
  const analise = contexto.evalCode(`(function() { 'use strict';\n${workerData.codigo}\n})()`, 'analise.js');
  if (analise.error) {
    const detalhe = contexto.dump(analise.error);
    analise.error.dispose();
    throw Error(String(detalhe?.message || 'Erro de execução').slice(0, 500));
  }
  contexto.setProp(contexto.global, '__retorno', analise.value);
  analise.value.dispose();
  const serializado = contexto.evalCode(`
    (function() {
      const valor = resultadoFinal === null ? __retorno : resultadoFinal;
      if (valor === null || typeof valor !== 'object' || Array.isArray(valor) || typeof valor.then === 'function') {
        throw new Error('Retorne um objeto síncrono com o resultado da análise.');
      }
      const s = JSON.stringify(valor, (k, v) => {
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Cálculo produziu número inválido.');
        if (typeof v === 'function' || typeof v === 'symbol') throw new Error('Resultado não serializável.');
        return typeof v === 'bigint' ? v.toString() : v;
      });
      if (s.length > 50000) throw new Error('Resultado grande demais. Retorne agregados ou uma página com total e aviso de lista parcial.');
      return s;
    })()
  `, 'resultado.js');
  if (serializado.error) {
    const detalhe = contexto.dump(serializado.error); serializado.error.dispose();
    throw Error(String(detalhe?.message || 'Resultado inválido').slice(0, 500));
  }
  const resultadoJSON = contexto.getString(serializado.value);
  serializado.value.dispose();
  parentPort.postMessage({ ok: true, resultadoJSON });
} catch (e) {
  parentPort.postMessage({ ok: false, erro: String(e?.message || 'Falha na análise').slice(0, 500) });
} finally {
  contexto?.dispose(); runtime?.dispose();
}
