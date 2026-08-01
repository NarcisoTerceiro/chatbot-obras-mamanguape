// ============================================================
//  sandboxClient.js
//  Conecta o bot ao microsservico SANDBOX (Python) que executa, de forma
//  isolada, o codigo gerado pela IA. O bot nunca roda o codigo; ele so
//  envia { codigo, obras } e recebe { ok, resultado }.
//
//  Configuracao (variaveis de ambiente do BOT no Render):
//    SANDBOX_URL   -> URL interna do servico sandbox (ex.: http://sandbox:8000)
//    SANDBOX_TOKEN -> mesmo token configurado no sandbox (autenticacao)
//
//  Se SANDBOX_URL nao estiver definida, o recurso fica desligado e o bot
//  segue funcionando normalmente (sem a geracao de codigo).
// ============================================================

const SANDBOX_URL = process.env.SANDBOX_URL || "";
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "";

export function sandboxDisponivel() {
  return !!SANDBOX_URL;
}

// Envia o codigo + as obras ao sandbox e devolve o resultado calculado.
// Se o servico estiver "dormindo" (comum no plano gratuito do Render), a
// primeira chamada pode dar 502/503 enquanto ele acorda - entao tentamos
// algumas vezes, esperando um pouco entre as tentativas.
export async function executarNoSandbox(codigo, obras) {
  if (!SANDBOX_URL) throw new Error("SANDBOX_URL nao configurada");

  const url = `${SANDBOX_URL.replace(/\/$/, "")}/run`;
  const MAX_TENTATIVAS = 3;
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    // Timeout maior na 1a tentativa: pode estar acordando o servico.
    const limite = tentativa === 1 ? 45000 : 20000;
    const controle = new AbortController();
    const t = setTimeout(() => controle.abort(), limite);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SANDBOX_TOKEN ? { "X-Sandbox-Token": SANDBOX_TOKEN } : {}),
        },
        body: JSON.stringify({ codigo, obras }),
        signal: controle.signal,
      });

      // 502/503 = servico ainda acordando: espera e tenta de novo.
      if (resp.status === 502 || resp.status === 503) {
        ultimoErro = new Error(`sandbox acordando (HTTP ${resp.status})`);
        console.log(`DEBUG sandbox dormindo, tentativa ${tentativa}/${MAX_TENTATIVAS}...`);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`sandbox HTTP ${resp.status}: ${txt.slice(0, 150)}`);
      }

      const data = await resp.json();
      if (!data.ok) throw new Error(`sandbox recusou: ${data.erro}`);
      return data.resultado;
    } catch (e) {
      ultimoErro = e;
      // Se foi timeout/abort na 1a tentativa, tenta de novo (estava acordando).
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
    } finally {
      clearTimeout(t);
    }
  }

  throw ultimoErro || new Error("sandbox nao respondeu");
}