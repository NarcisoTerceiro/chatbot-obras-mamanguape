CHATBOT OBRAS - AJUSTE DE IA / TOKENS
=====================================

Arquivos alterados:
- agente.js
- groq.js
- server.js

O que mudou
-----------
1) Removidos GLM/Z.ai e OmniRoute. Ficaram somente:
   Groq (principal) -> Gemini (fallback).

2) O modelo Groq openai/gpt-oss-120b deixa de ser usado mesmo se GROQ_MODEL
   ainda estiver configurado com esse valor. Nesse caso o codigo troca para:
   llama-3.1-8b-instant

3) Perguntas comuns nao gastam IA para gerar SQL.
   Exemplos tratados diretamente:
   - Quais as obras concluidas?
   - Quantas obras concluidas?
   - Quais os engenheiros dessas obras?
   - E os engenheiros?
   - Qual o valor dessas?
   - Quais empresas dessas obras?
   - Quanto foi investido nessas obras?

4) O contexto usa a SQL anterior validada. Assim "dessas obras" reaproveita o
   WHERE da consulta anterior sem mandar toda a conversa para a IA.

5) Respostas comuns sao formatadas pelo proprio Node.js, sem segunda chamada de
   IA. A IA de redacao fica reservada principalmente para campos livres de
   dados_extras (recurso, contrato, convenio, aditivo, prazo etc.).

6) Quando Groq devolve 429, nao existe sleep de 60 s dentro do webhook. O codigo
   marca Groq em descanso pelo tempo indicado e tenta Gemini imediatamente.
   Isso reduz timeout/"This operation was aborted".

7) Limites de saida foram reduzidos e o historico enviado para IA ficou curto.

8) A memoria de conversa do WhatsApp passou de 10 para 30 minutos, mas o prompt
   continua usando apenas contexto curto, para nao aumentar tokens.

Variaveis recomendadas no Render
--------------------------------
GROQ_API_KEY=sua_chave
GROQ_MODEL=llama-3.1-8b-instant
GEMINI_API_KEY=sua_chave
GEMINI_MODEL=gemini-3.5-flash-lite
USAR_AGENTE_SQL=true

Se GROQ_MODEL ainda estiver como openai/gpt-oss-120b, esta versao troca para
llama-3.1-8b-instant automaticamente. Mesmo assim e melhor corrigir a variavel
no Render para ficar claro.

Nao coloque chaves reais no GitHub.

Teste principal esperado
------------------------
1. Usuario: Quais as obras concluidas?
   -> SQL local, sem IA: SELECT objeto ... WHERE status concluido
   -> resposta local com lista e total.

2. Usuario: Quais os engenheiros dessas obras?
   -> reutiliza o filtro anterior
   -> SELECT objeto, engenheiro ... mesmo WHERE
   -> resposta local obra -> engenheiro.

Resultado: essas duas mensagens podem ser respondidas sem consumir tokens de IA.
