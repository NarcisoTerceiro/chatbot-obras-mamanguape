import { createInterface } from 'node:readline/promises';

try {
  process.loadEnvFile('../.env');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

const agente = await import('./agente.js');
const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Digite uma pergunta ou sair.');

try {
  while (true) {
    const pergunta = (await rl.question('\nVocê: ')).trim();
    if (pergunta.toLowerCase() === 'sair') break;
    if (!pergunta) continue;

    try {
      const resultado = await agente.responderPergunta(pergunta);
      console.log('\nBot:', resultado.resposta);
      if (resultado.erro) console.log('Erro:', resultado.erro);
      if (resultado.diagnostico) {
        console.log(JSON.stringify(resultado.diagnostico, null, 2));
      }
    } catch (e) {
      console.error(e);
    }
  }
} finally {
  rl.close();
  agente.fecharPandas?.();
}
