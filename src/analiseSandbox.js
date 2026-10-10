import { Worker } from 'node:worker_threads';

let ativos = 0;
export async function executarCodigoDaIA(codigoRecebido, dadosObras, { timeoutMs = 2000 } = {}) {
  if (typeof codigoRecebido !== 'string' || !codigoRecebido.trim() || codigoRecebido.length > 20000) {
    throw Error('Código vazio ou maior que 20 mil caracteres.');
  }
  if (!Array.isArray(dadosObras)) throw Error('Snapshot inválido.');
  if (ativos >= 2) throw Error('Análises ocupadas. Tente novamente em instantes.');
  const snapshotJSON = JSON.stringify(dadosObras);
  if (Buffer.byteLength(snapshotJSON) > 8 * 1024 * 1024) throw Error('Snapshot excede o limite de 8 MiB.');
  const prazo = Math.max(100, Math.min(Number(timeoutMs) || 2000, 5000));
  ativos++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./analiseWorker.js', import.meta.url), {
        workerData: { codigo: codigoRecebido, snapshotJSON, timeoutMs: prazo },
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let concluido = false;
      const concluir = async (erro, valor) => {
        if (concluido) return;
        concluido = true; clearTimeout(timer);
        // Só libera a vaga depois de finalizar o worker.
        try { await worker.terminate(); } catch {}
        if (erro) reject(erro); else resolve(valor);
      };
      // Limite externo inclui carregamento do WASM; interrompe mesmo se o motor travar.
      const timer = setTimeout(() => concluir(Error('Análise excedeu o tempo máximo.')), prazo + 6000);
      worker.once('message', msg => {
        if (!msg?.ok) { concluir(Error(msg?.erro || 'Falha no interpretador.')); return; }
        if (typeof msg.resultadoJSON !== 'string' || msg.resultadoJSON.length > 50000) {
          concluir(Error('Resultado excede o limite permitido.')); return;
        }
        try { concluir(null, JSON.parse(msg.resultadoJSON)); }
        catch { concluir(Error('Resultado inválido.')); }
      });
      worker.once('error', () => concluir(Error('Não foi possível iniciar o interpretador. Verifique quickjs-emscripten e os arquivos do pacote.')));
      worker.once('exit', () => { if (!concluido) concluir(Error('Interpretador encerrou sem resultado.')); });
    });
  } finally { ativos--; }
}
