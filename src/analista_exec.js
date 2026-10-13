import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner=fileURLToPath(new URL('./analista_runner.py',import.meta.url));
export function executarAnalisePython(dados,codigo,{timeoutMs=6000}={}) {
  const input=JSON.stringify({dados,codigo});
  if(Buffer.byteLength(input)>16*1024*1024)return Promise.reject(Error('Dados excedem 16 MiB. Use filtros ou agregação SQL.'));
  const executable=process.env.PYTHON_COMMAND||(process.platform==='win32'?'py':'python3');
  const args=[...(process.platform==='win32'&&executable==='py'?['-3']:[]),'-I','-B',runner];
  const env={PATH:process.env.PATH||'',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot||''}:{})};
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',finished=false,bytes=0;
    const timer=setTimeout(()=>finish(Error('A análise ultrapassou o prazo. Simplifique o código ou use agregação SQL.')),timeoutMs);
    function finish(error,value){if(finished)return;finished=true;clearTimeout(timer);if(error)child.kill('SIGKILL');error?reject(error):resolve(value);}
    child.on('error',error=>finish(Error('Não foi possível iniciar Python. Instale Python 3 ou configure PYTHON_COMMAND. '+error.message)));
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>256*1024)return finish(Error('Resultado da análise muito extenso.'));stdout+=chunk;});
    child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk.toString().slice(0,2000-stderr.length);});
    child.stdin.on('error',()=>{});
    child.on('close',()=>{
      if(finished)return;
      let result;try {result=JSON.parse(stdout);}catch {return finish(Error('A análise foi interrompida ou não retornou JSON válido. '+stderr));}
      if(!result.ok)return finish(Error(result.erro||'Falha na análise Python.'));
      finish(null,result.resultado);
    });
    child.stdin.end(input);
  });
}
