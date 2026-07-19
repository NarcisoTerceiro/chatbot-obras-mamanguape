# Chatbot de Obras — Prefeitura de Mamanguape

Bot de WhatsApp que responde, em linguagem natural, sobre o andamento das obras
públicas do município. O cidadão pergunta (ex.: *"como está a obra da praça do
centro?"*) e recebe a resposta com base na planilha oficial
**"ChatBot - Obras Mamanguape"** do Google Sheets. A interpretação da pergunta e
a redação da resposta ficam por conta de uma IA generativa gratuita (**Groq**).

Tudo roda em serviços com **camada gratuita** — dá pra colocar no ar sem pagar nada.

```
WhatsApp (cidadão) → Webhook (nosso servidor) → Google Sheets (busca a obra)
   → Groq (interpreta e responde) → WhatsApp Cloud API (envia) → cidadão
```

---

## Índice
- [Como o projeto está organizado](#como-o-projeto-está-organizado)
- [Pré-requisitos](#pré-requisitos)
- [PARTE 1 — MODO TESTE (ver funcionando)](#parte-1--modo-teste-ver-funcionando)
- [PARTE 2 — MODO REAL (colocar no ar de graça)](#parte-2--modo-real-colocar-no-ar-de-graça)
- [PARTE 3 — Atender o público de verdade (número real)](#parte-3--atender-o-público-de-verdade-número-real)
- [Custos](#custos)
- [Problemas comuns (troubleshooting)](#problemas-comuns-troubleshooting)
- [Ajustes rápidos](#ajustes-rápidos)

---

## Como o projeto está organizado

| Arquivo             | O que faz                                                       |
|---------------------|-----------------------------------------------------------------|
| `src/server.js`     | Servidor + webhook (verificação e recebimento) + orquestração   |
| `src/sheets.js`     | Lê a planilha via Conta de Serviço do Google (cache de 60s)     |
| `src/search.js`     | Acha a(s) obra(s) por palavra-chave (bairro/rua/tipo)          |
| `src/groq.js`       | Manda pergunta + dados pra IA e recebe a resposta               |
| `src/whatsapp.js`   | Envia a resposta de volta pela WhatsApp Cloud API               |
| `.env.example`      | Modelo das variáveis de ambiente (você copia pra `.env`)        |
| `render.yaml`       | Configuração pronta pra publicar no Render (Parte 2)            |
| `DEPLOY-RENDER.md`  | Versão resumida só do deploy (o passo a passo completo está aqui)|

---

## Pré-requisitos

- **Node.js 18.17+** instalado (confira com `node -v`).
- Uma **conta Google** (pra planilha e Google Cloud).
- Uma **conta na Meta/Facebook** (pra WhatsApp).
- Uma **conta na Groq** (IA — gratuita, sem cartão).
- Para a Parte 2: uma **conta no GitHub** e uma **conta no Render** (ambas grátis).

Instale as dependências uma vez:

```bash
npm install
```

---

# PARTE 1 — MODO TESTE (ver funcionando)

Objetivo desta parte: rodar o bot **no seu próprio computador** e conversar com
ele usando o número de teste que a Meta fornece de graça. Nada aqui exige chip,
número próprio ou cartão de crédito.

### 1.1 — WhatsApp Cloud API (número de teste)

1. Acesse **developers.facebook.com** → *Meus Apps* → **Criar App** → tipo **Empresa/Business**.
2. No painel do App, adicione o produto **WhatsApp**.
3. Em *API do WhatsApp → Introdução*, a Meta já cria um **número de teste**. Anote:
   - **ID do número de telefone** → será o `WHATSAPP_PHONE_NUMBER_ID`.
   - **Token de acesso temporário** → será o `WHATSAPP_TOKEN` *(atenção: dura só 24h no teste)*.
4. Ainda nessa tela, em *Para*, cadastre até **5 números** que poderão conversar
   com o bot (coloque o seu WhatsApp).
5. Invente um texto qualquer para o **token de verificação** (ex.: `mamanguape123`)
   e guarde — ele será o `VERIFY_TOKEN`, usado no passo 1.6.

### 1.2 — Planilha no Google Sheets

1. Se a planilha ainda está em Excel local, suba para o Google Sheets
   (abra um Sheets em branco → *Arquivo → Importar*, ou arraste o `.xlsx` para o
   Drive e abra como Planilhas Google).
2. Copie o **ID da planilha** da URL — é o trecho entre `/d/` e `/edit`:
   `docs.google.com/spreadsheets/d/`**`ESTE_TRECHO_É_O_ID`**`/edit`.
   Ele será o `GOOGLE_SHEETS_ID`.
3. Confira os nomes exatos das abas. Se diferirem do padrão, ajuste `SHEETS_TABS`
   no `.env` (respeite acentos: se a aba é `EM_LICITAÇÃO`, escreva com acento).

### 1.3 — Conta de Serviço do Google (a "chave" que lê a planilha)

Esta é a etapa que mais gente erra — vá com calma:

1. Acesse **console.cloud.google.com** → crie um projeto (ou use um existente).
2. *APIs e serviços → Biblioteca* → busque **Google Sheets API** → **Ativar**.
3. *APIs e serviços → Credenciais* → **Criar credenciais** → **Conta de serviço**.
4. Entre na conta criada → aba **Chaves** → **Adicionar chave → Criar nova chave → JSON**.
   Baixe o arquivo e salve como **`service-account.json`** na raiz do projeto.
5. Abra esse JSON e copie o valor de **`client_email`**
   (algo como `...@...iam.gserviceaccount.com`).
6. Na planilha do Google Sheets, clique em **Compartilhar** e adicione esse
   e-mail como **Leitor**.
   > Sem este compartilhamento, o servidor sobe mas **não consegue ler os dados**.

### 1.4 — Chave da Groq (IA)

1. Acesse **console.groq.com** → crie a conta gratuita (sem cartão).
2. Em *API Keys* → **Create API Key** → copie a chave → será o `GROQ_API_KEY`.
3. O modelo já vem certo no `.env.example`: `openai/gpt-oss-120b`.
   > Observação: os modelos `llama-3.3-70b-versatile` e `llama-3.1-8b-instant`,
   > citados no documento técnico original, foram descontinuados pela Groq em
   > junho/2026. O `openai/gpt-oss-120b` é o substituto recomendado no plano grátis.

### 1.5 — Preencher o `.env` e rodar

Copie o modelo e edite com seus valores:

```bash
cp .env.example .env
```

Abra o `.env` e preencha: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`VERIFY_TOKEN`, `GROQ_API_KEY`, `GOOGLE_SHEETS_ID`, `SHEETS_TABS` e deixe
`GOOGLE_APPLICATION_CREDENTIALS=./service-account.json`. Depois:

```bash
npm start
```

Deve aparecer `Servidor rodando na porta 3000`. Abra `http://localhost:3000` no
navegador — deve mostrar *"Chatbot de Obras de Mamanguape no ar."*

### 1.6 — Deixar o servidor acessível pela internet (ngrok)

A Meta precisa de uma **URL pública (https)** pra entregar as mensagens. Na fase
de teste, o mais rápido é um túnel com o **ngrok**:

1. Baixe o ngrok em **ngrok.com** e crie a conta grátis.
2. Com o servidor rodando (`npm start`), abra **outro** terminal e rode:
   ```bash
   ngrok http 3000
   ```
3. Ele mostra uma URL tipo `https://xxxx-xx-xx.ngrok-free.app`. Copie ela.
   > Deixe o ngrok e o `npm start` abertos — se fechar, o bot para.

### 1.7 — Ligar o Webhook na Meta

No painel do App → **WhatsApp → Configuração → Webhook**:

- **URL de callback:** `https://SUA-URL-DO-NGROK/webhook`
- **Token de verificação:** o mesmo valor do `VERIFY_TOKEN`.
- Clique em **Verificar e salvar** (o servidor responde à verificação sozinho).
- Em *Campos do webhook*, assine (**Subscribe**) o campo **messages**.

### 1.8 — Testar

Do WhatsApp do número que você cadastrou no passo 1.1, mande uma mensagem para o
número de teste: *"como está a obra da praça do centro?"*. O bot deve responder.

✅ **Chegou até aqui? O bot está funcionando em modo teste.** Agora é hora de
colocá-lo no ar de forma permanente.

---

# PARTE 2 — MODO REAL (colocar no ar de graça)

Objetivo: publicar o servidor no **Render (plano grátis, R$ 0,00)**, pra ele
ficar online 24/7 sem depender do seu computador ligado nem do ngrok.

> Sobre o plano grátis do Render: o serviço **dorme após ~15 min sem uso** e a
> **primeira** mensagem depois disso demora ~30–60s pra acordar. As seguintes são
> rápidas. Isso **não gera cobrança**. Pra um bot de consulta, costuma ser
> perfeitamente aceitável. (Se quiser eliminar essa espera, o caminho é o plano
> pago do Render, ~US$ 7/mês — opcional.)

### 2.1 — Subir o código no GitHub

Crie um repositório novo em **github.com** (pode ser privado). No terminal,
dentro da pasta do projeto:

```bash
git init
git add .
git commit -m "chatbot obras mamanguape"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/chatbot-obras-mamanguape.git
git push -u origin main
```

> ✅ O `.gitignore` já impede que o `.env` e o `service-account.json` subam.
> Confira no site do GitHub que **esses dois arquivos NÃO aparecem** no repositório.

### 2.2 — Criar conta no Render

Acesse **render.com** → **Get Started** → entre **com o GitHub** (assim ele já
enxerga seus repositórios). **Não pede cartão.**

### 2.3 — Criar o serviço pelo Blueprint

1. No Render, clique em **New → Blueprint**.
2. Escolha o repositório que você subiu.
3. O Render lê o `render.yaml` e mostra o serviço **chatbot-obras-mamanguape**
   no plano **Free**.
4. Ele pede os valores dos segredos (variáveis *sync:false*). Preencha:
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `GROQ_API_KEY`,
   `GOOGLE_SHEETS_ID`.
5. Clique em **Apply / Create**.

### 2.4 — Adicionar a credencial do Google (Secret File)

No Render, o `service-account.json` entra como arquivo secreto:

1. Abra o serviço → aba **Environment** → seção **Secret Files** → **Add Secret File**.
2. **Filename:** `service-account.json`
3. **Contents:** cole **todo** o conteúdo do JSON baixado do Google Cloud.
4. Salve.

O Render monta esse arquivo em `/etc/secrets/service-account.json`, que é
exatamente o caminho já configurado no `render.yaml`. Não precisa mexer em mais nada.

### 2.5 — Primeiro deploy e URL

O Render dispara o build sozinho — acompanhe na aba **Logs**. Quando aparecer
`Servidor rodando na porta ...`, está no ar. Sua URL pública será algo como:

```
https://chatbot-obras-mamanguape.onrender.com
```

Abra no navegador pra conferir (a primeira vez pode demorar, é o serviço acordando).

### 2.6 — Reapontar o Webhook para a URL do Render

Volte ao painel da Meta → **WhatsApp → Configuração → Webhook** e troque a URL do
ngrok pela do Render:

- **URL de callback:** `https://SUA-URL.onrender.com/webhook`
- **Token de verificação:** o mesmo `VERIFY_TOKEN`.
- **Verificar e salvar** → confirme que o campo **messages** continua assinado.

### 2.7 — Testar de novo

Mande a mensagem outra vez. Agora a resposta vem do servidor no Render, sem
precisar do seu PC. (Lembre da espera de ~30–60s na primeira mensagem após ociosidade.)

✅ **O bot está online 24/7, de graça.** Ainda em número de teste (até 5 pessoas).
A Parte 3 libera o atendimento ao público em geral.

---

# PARTE 3 — Atender o público de verdade (número real)

O número de teste da Meta só fala com os 5 contatos cadastrados. Pra abrir o bot
a qualquer cidadão, é preciso migrar para um número real e um token permanente:

1. **Verificação da conta empresarial (Business Verification):** no
   *Meta Business Suite / Gerenciador de Negócios*, conclua a verificação da
   empresa (documento da prefeitura/CNPJ). É o que libera o uso em produção.
2. **Número de telefone real:** associe ao App um número que **não esteja ativo em
   outro WhatsApp** no momento do cadastro (um chip dedicado ao bot).
3. **Token permanente:** o token de teste morre em 24h. Gere um token permanente
   criando um **Usuário do Sistema** no Gerenciador de Negócios, com permissão no
   App do WhatsApp. Troque o `WHATSAPP_TOKEN` por esse token novo.
   - No Render: aba **Environment** → edite `WHATSAPP_TOKEN` → salve
     (o Render redeploya sozinho).
4. **Confira o número de origem:** se o `WHATSAPP_PHONE_NUMBER_ID` mudou para o do
   número real, atualize também essa variável no Render.
5. **Teste final** com um número que **não** estava na lista dos 5 — deve funcionar.

✅ **Pronto: bot público, no ar, atendendo qualquer cidadão.**

---

## Custos

| Serviço                     | Plano                                   | Custo    |
|-----------------------------|-----------------------------------------|----------|
| WhatsApp Cloud API          | Conversas iniciadas pelo usuário (24h)  | R$ 0,00  |
| Google Sheets + Sheets API  | Gratuito                                | R$ 0,00  |
| Groq API                    | Free tier (sem cartão)                  | R$ 0,00  |
| Hospedagem (Render)         | Free tier                               | R$ 0,00* |

\* O plano grátis do Render hiberna após inatividade (primeira resposta mais
lenta). Sem custo. Plano pago (~US$ 7/mês) elimina a hibernação, se desejar.

---

## Problemas comuns (troubleshooting)

**"Verificar e salvar" do webhook falha (Meta):**
confira que o servidor está no ar, que a URL termina em `/webhook`, e que o
`VERIFY_TOKEN` digitado na Meta é **idêntico** ao do `.env` / Render.

**O bot responde "não encontrei nenhuma obra":**
provavelmente ele não está lendo a planilha. Verifique se o **`client_email`** da
conta de serviço foi **compartilhado como Leitor** na planilha, e se `SHEETS_TABS`
tem os nomes das abas **exatamente** como aparecem (com acentos).

**Erro de credencial do Google nos logs:**
local → confira o caminho `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json`.
Render → confira que o Secret File se chama exatamente `service-account.json`.

**Groq retorna 401 / erro de modelo:**
`GROQ_API_KEY` errada, ou o modelo em `GROQ_MODEL` foi descontinuado. Use
`openai/gpt-oss-120b` (ou `openai/gpt-oss-20b`).

**O bot parou de responder depois de um dia (modo teste):**
o token de teste do WhatsApp **expira em 24h**. Gere outro na tela de introdução
e atualize `WHATSAPP_TOKEN`. (Na Parte 3 isso deixa de acontecer, com o token permanente.)

**Primeira mensagem demora muito (Render grátis):**
é a hibernação — normal. Opcional: um serviço como **UptimeRobot** ou
**cron-job.org** pinga a URL a cada ~10 min pra manter o serviço acordado (cabe
nas 750h/mês do plano grátis).

---

## Ajustes rápidos

- **Trocar o modelo da IA:** edite `GROQ_MODEL` no `.env` (ou no Render).
- **Ler mais/menos abas:** edite `SHEETS_TABS`.
- **Quantas obras a IA recebe por pergunta:** o `3` em
  `buscarObras(pergunta, obras)` dentro de `src/server.js`.
- **Tempo de cache da planilha:** `CACHE_MS` em `src/sheets.js` (padrão 60s).
- **Tom/estilo das respostas:** o `SYSTEM_PROMPT` em `src/groq.js`.
