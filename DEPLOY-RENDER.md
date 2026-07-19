# Deploy no Render (plano grátis) — passo a passo

Objetivo: deixar o chatbot **online 24/7 sem pagar nada**. O código fica no
GitHub, e o Render puxa esse código e roda o servidor.

> Lembrete do plano grátis: o serviço **dorme após ~15 min sem uso** e a
> **primeira** mensagem depois disso demora ~30–60s pra ele acordar. As
> seguintes são rápidas. Isso não gera cobrança — continua R$ 0,00.

Antes de começar, tenha em mãos (dos passos anteriores):
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `GROQ_API_KEY`,
`GOOGLE_SHEETS_ID` e o arquivo `service-account.json`.

---

## Passo 1 — Subir o código no GitHub

Crie um repositório novo em [github.com](https://github.com) (pode ser privado).
Depois, no terminal, **dentro da pasta do projeto**:

```bash
git init
git add .
git commit -m "chatbot obras mamanguape"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/chatbot-obras-mamanguape.git
git push -u origin main
```

> ✅ O `.gitignore` já impede que o `.env` e o `service-account.json` subam pro
> GitHub. Confira no site do GitHub que **esses dois arquivos NÃO aparecem** no
> repositório — são segredos, ficam de fora.

---

## Passo 2 — Criar conta no Render

Acesse [render.com](https://render.com) → **Get Started** → entre **com o GitHub**
(assim ele já enxerga seus repositórios). **Não pede cartão de crédito.**

---

## Passo 3 — Criar o serviço pelo Blueprint

1. No painel do Render, clique em **New** → **Blueprint**.
2. Escolha o repositório que você subiu no Passo 1.
3. O Render lê o arquivo `render.yaml` e mostra o serviço
   **chatbot-obras-mamanguape** já no plano **Free**.
4. Ele vai pedir os valores dos segredos (as variáveis marcadas como *sync:false*).
   Preencha cada um:
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `VERIFY_TOKEN`
   - `GROQ_API_KEY`
   - `GOOGLE_SHEETS_ID`
5. Clique em **Apply** / **Create**.

> Se preferir sem blueprint: **New → Web Service** → conecte o repo → Runtime
> **Node** → Build `npm install` → Start `npm start` → plano **Free** → e
> adicione as variáveis manualmente na aba *Environment*.

---

## Passo 4 — Adicionar a credencial do Google (Secret File)

A conta de serviço do Google é um arquivo secreto — no Render ele entra como
"Secret File", não como variável comum:

1. Abra o serviço → aba **Environment** → seção **Secret Files** → **Add Secret File**.
2. **Filename:** `service-account.json`
3. **Contents:** cole **todo** o conteúdo do JSON que você baixou do Google Cloud.
4. Salve.

O Render monta esse arquivo em `/etc/secrets/service-account.json`, que é
exatamente o caminho já configurado no `render.yaml`
(`GOOGLE_APPLICATION_CREDENTIALS`). Não precisa mexer em mais nada.

> ⚠️ Não esqueça: o e-mail dessa conta de serviço (`client_email`, dentro do
> JSON) precisa estar **compartilhado como Leitor** na planilha do Google Sheets.

---

## Passo 5 — Primeiro deploy

O Render já dispara o build sozinho. Acompanhe na aba **Logs**.
Quando aparecer `Servidor rodando na porta ...`, está no ar.

Sua URL pública será algo como:
```
https://chatbot-obras-mamanguape.onrender.com
```
Abra no navegador — deve mostrar **"Chatbot de Obras de Mamanguape no ar."**
(na primeira vez pode demorar um pouco, é o serviço acordando).

---

## Passo 6 — Ligar o Webhook na Meta com essa URL

No painel do App (developers.facebook.com) → **WhatsApp → Configuração → Webhook**:

- **URL de callback:** `https://SUA-URL.onrender.com/webhook`
- **Token de verificação:** o mesmo valor do `VERIFY_TOKEN`.
- Clique em **Verificar e salvar**.
- Em *Campos do webhook*, assine (**Subscribe**) o campo **messages**.

---

## Passo 7 — Testar de verdade

Mande uma mensagem do número cadastrado no teste:
*"como está a obra da praça do centro?"* — o bot responde.

Se ele estava dormindo, a **primeira** resposta demora ~30–60s. Depois normaliza.

---

## Depois do deploy

**Atualizar o código:** com `autoDeploy` ligado, todo `git push` no branch `main`
faz o Render reimplantar sozinho.

**Trocar o token do WhatsApp** (o de teste expira em 24h; o real é permanente):
vá em **Environment**, edite `WHATSAPP_TOKEN`, salve — o Render redeploya sozinho.

**Opcional, evitar a hibernação:** um serviço externo gratuito como o
[UptimeRobot](https://uptimerobot.com) ou o [cron-job.org](https://cron-job.org)
pode "pingar" sua URL a cada ~10 minutos pra manter o serviço acordado. Cabe
dentro das 750 horas/mês do plano grátis. É um paliativo; se a instantaneidade
for essencial, o caminho definitivo é o plano pago do Render (sem hibernação).
