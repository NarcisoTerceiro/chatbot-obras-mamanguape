# Sandbox de execução — passo a passo

Este é o **segundo serviço** do chatbot: um microsserviço em Python que executa,
de forma isolada e segura, o código que a IA escreve para responder perguntas
complexas. O bot (Node.js) continua sendo o serviço principal; este sandbox só
recebe código + dados, executa e devolve o resultado.

## O que tem nesta pasta
- `app.py` — o serviço (Flask). Recebe `{codigo, obras}`, executa isolado, devolve `{ok, resultado}`.
- `requirements.txt` — dependências (Flask, pandas, numpy, gunicorn).
- `Dockerfile` — imagem mínima, roda como usuário sem privilégio.

## Segurança já embutida
- Bloqueio de palavras perigosas (`import`, `open`, `exec`, `os.`, `requests`...) antes de rodar.
- Builtins do Python restritos (sem acesso a arquivo/rede).
- Timeout de 5s por execução, em processo separado (mata se travar).
- Token compartilhado: só quem tem o `SANDBOX_TOKEN` consegue chamar `/run`.

---

## Passo a passo do deploy no Render

### 1. Subir esta pasta para o GitHub
Coloque a pasta `sandbox/` no mesmo repositório do bot (ou num repositório novo,
tanto faz). O importante é o Render conseguir enxergá-la.

### 2. Criar o serviço do sandbox no Render
- No painel do Render: **New +** → **Web Service**.
- Aponte para o repositório.
- Em **Root Directory**, coloque `sandbox` (a pasta deste serviço).
- Em **Runtime/Environment**, escolha **Docker** (ele detecta o `Dockerfile`).
- Nome sugerido: `chatbot-sandbox`.

### 3. Definir o token do sandbox
Ainda na criação, em **Environment**, adicione:
- Key: `SANDBOX_TOKEN` — Value: uma senha longa que você inventa (ex.: `sbx_9f3k...`).
  Guarde esse valor; você vai usá-lo também no bot.

### 4. (Recomendado) Deixar o sandbox interno
- Se o seu plano do Render permitir **Private Service**, use-o em vez de Web
  Service — assim o sandbox não fica exposto na internet, só o bot acessa.
- Se só houver Web Service, tudo bem: o `SANDBOX_TOKEN` já protege o `/run`.
- Se a plataforma permitir, **desabilite o egress de rede** do sandbox (camada
  extra: mesmo que algo escapasse, não teria como sair para a internet).

### 5. Pegar a URL do sandbox
Depois do deploy, o Render mostra a URL do serviço (ex.:
`https://chatbot-sandbox.onrender.com` ou uma URL interna, se for Private).

### 6. Ligar o bot ao sandbox
No serviço do **bot** (não neste), em **Environment**, adicione duas variáveis:
- `SANDBOX_URL` — a URL do passo 5.
- `SANDBOX_TOKEN` — **o mesmo** valor do passo 3.

Salve. O bot passa a usar o sandbox automaticamente para perguntas que o cálculo
comum (DSL) não cobrir. Se essas variáveis não existirem, o bot ignora o sandbox
e continua funcionando normalmente.

### 7. Testar
- Acesse `SUA_URL_DO_SANDBOX/health` no navegador → deve responder
  `{"ok": true, "pandas": true}`.
- No WhatsApp, faça uma pergunta complexa que o menu comum não cobre, por
  exemplo: **"qual a segunda obra mais cara?"** ou **"top 3 bairros por
  investimento"**. No log do bot deve aparecer `DEBUG sandbox proprio:
  resultado obtido`.

---

## Como o bot decide usar o sandbox
1. Pergunta chega.
2. O bot tenta o **DSL** (cálculo determinístico do próprio código) — cobre a
   maioria: somas, contagens, médias, filtros, maior/menor.
3. Se o DSL não montar o cálculo, o bot pede à IA um **código Python** e manda
   para **este sandbox** executar.
4. Se o sandbox não estiver configurado ou falhar, cai no **Code Execution do
   Gemini** (sandbox do Google) como última reserva.
5. Se nada funcionar, o bot avisa o cidadão e sugere reformular — nunca trava.
