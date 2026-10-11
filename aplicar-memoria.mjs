// Executar na raiz do projeto: node aplicar-memoria.mjs
// Acrescenta somente a identidade da conversa, preservando o servidor instalado.
import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const path='src/server.js';
const source=readFileSync(path,'utf8');let changes=0;
const updated=source.replace(/responderPergunta\(\s*pergunta\s*,\s*(historicoAg|historicoTeste)\s*\)/g,(_,history)=>{
 changes++;return `responderPergunta(pergunta, ${history}, { conversationId: ${history==='historicoAg'?'de':'chaveTeste'} })`;
});
if(!changes){
 if(/responderPergunta\([^\n]*conversationId/.test(source)){console.log('Identidade da conversa já configurada.');process.exit(0);}
 throw Error('Este server.js usa outra chamada do agente. Envie esse arquivo para adaptar sem alterar o restante do servidor.');
}
const temp='src/.server-memoria-check.mjs';
if(existsSync(temp))throw Error('Arquivo temporário já existe; não foi sobrescrito.');
writeFileSync(temp,updated);const check=spawnSync(process.execPath,['--check',temp],{encoding:'utf8'});unlinkSync(temp);
if(check.status!==0)throw Error('Verificação de sintaxe falhou; server.js preservado. '+check.stderr);
const backup=`src/server.js.backup-${Date.now()}`;
writeFileSync(backup,source,{flag:'wx'});writeFileSync(path,updated);
console.log(`Memória por conversa habilitada em ${changes} chamada(s). Backup: ${backup}`);
