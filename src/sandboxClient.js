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
// Lanca erro se o sandbox recusar, falhar, ou nao estiver configurado.
export async function executarNoSandbox(codigo, obras) {
  if (!SANDBOX_URL) throw new Error("SANDBOX_URL nao configurada");

  // Timeout de rede: nao deixa o bot travar esperando o sandbox.
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), 12000);

  try {
    const resp = await fetch(`${SANDBOX_URL.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SANDBOX_TOKEN ? { "X-Sandbox-Token": SANDBOX_TOKEN } : {}),
      },
      body: JSON.stringify({ codigo, obras }),
      signal: controle.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`sandbox HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (!data.ok) throw new Error(`sandbox recusou: ${data.erro}`);
    return data.resultado;
  } finally {
    clearTimeout(t);
  }
}
