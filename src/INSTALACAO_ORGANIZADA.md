# Obras Mamanguape — organização por aba

## Instalação

1. Faça backup do projeto e do banco. No SQL Editor do Supabase, execute `banco_organizado.sql`. Ele acrescenta estruturas e mantém a tabela `public.obras` e as colunas da view fornecida `public.obras_chatbot`; não exclui registros.
2. Substitua os sete arquivos JavaScript do pacote na pasta `src` real do projeto: server.js, agente.js, ingestao.js, db.js, sqlUtils.js, iaTools.js e sheets.js. Preserve seu whatsapp.js original, .env, credenciais Google, package.json e package-lock.json. O pacote é uma atualização, não um projeto standalone.
3. Na pasta de package.json: `npm install pg pgsql-ast-parser@12.0.2`. Preserve express/dotenv/googleapis e as dependências já utilizadas pelo WhatsApp. Use módulos ES (`"type":"module"`). Envie package.json e package-lock.json atualizados ao GitHub. O Build Command do Render deve instalar as dependências, e o Start Command deve iniciar o servidor real (normalmente `node src/server.js`).
4. Configure NODE_ENV=production no Render. Confira GOOGLE_SHEETS_ID. Para importar todas as abas, deixe SHEETS_TABS e SHEETS_TABS_IGNORAR vazias; se essas variáveis estiverem preenchidas, somente as abas selecionadas serão lidas. As duas planilhas podem continuar compartilhadas com a mesma conta de serviço.
5. Configure DATABASE_ADMIN_URL com permissão de escrita e criação de views no schema planilha. Configure DATABASE_URL com o login de leitura associado a obras_chatbot_leitura, sem propriedade/escrita. A migração concede o acesso de leitura; a ingestão concede leitura nas views criadas.
6. Faça deploy e acione POST /sincronizar com o Authorization Bearer ADMIN_TOKEN já usado. É essa operação que relê a fonte e substitui os dados normalizados antigos. Aplicar o SQL sozinho não corrige valores que já estavam mal importados.
7. Confira /diagnostico: ele mostra fonte ativa, quantidade por aba, avisos e última sincronização. Use também `verificar_banco.sql`. Compare uma amostra por aba com a planilha vigente antes de colocar em uso.

## Estrutura

| Estrutura | Conteúdo |
|---|---|
| public.planilha_abas | Catálogo por GOOGLE_SHEETS_ID + nome da aba, leitura original em matriz JSONB, cabeçalhos, tipos, avisos, quantidade e horário. |
| schema planilha | Uma view por aba com seus cabeçalhos como colunas, linha de origem e dados originais. O nome exato é informado no catálogo; não deve ser adivinhado. |
| public.obras | Registros preparados com origem, valores separados e células originais em dados_extras. |
| public.obras_chatbot | Visão semântica consolidada, com distinção entre obra física, projeto, licitação e resumo. |
| public.obras_sync | Última sincronização concluída. |

Não são criadas cópias somáveis do mesmo conjunto: as views por aba e obras_chatbot apontam para public.obras. Conte registros ou entidades conforme o pedido, sem somar os mesmos dados em várias representações. Linhas de totais/resumos não devem contar como obras individuais. Nenhuma deduplicação de obras é feita sem evidência.

Campos numéricos reais da fonte ficam numeric nas views por aba. Textos, valores mistos ou ausentes ficam text; não há conversão arbitrária. Nomes duplicados recebem indicação de coluna; colunas sem cabeçalho também recebem um identificador. A matriz original preserva o conteúdo lido, inclusive títulos, linhas repetidas e linhas não interpretadas como registros. O parser de cabeçalhos continua sendo uma heurística: confira o catálogo e avisos quando a aba tiver layout irregular.

A leitura preserva os valores retornados pela API do Google Sheets. Não inclui fórmulas originais, formatação, comentários, imagens, histórico do Google ou dados de abas excluídas pelas variáveis de configuração. Não reordena nem edita a planilha Google. Se a planilha contiver valores errados, a importação não inventa substitutos; os originais permitem conferência.

Dinheiro é armazenado como NUMERIC e strings decimais sem passar por cálculos de ponto flutuante no Node. Valor executado não é valor pago. Pagamentos anuais e total informado não são somados em duplicidade. Ausência não é zero. O contratado calculado só é preenchido quando os componentes estão disponíveis. Divergências permanecem visíveis em avisos_fonte.

Conclusão exige status original explícito e natureza de obra física. Finalização de projeto, licitação concluída, proposta e ata genérica não comprovam obra finalizada. Atas de reforma de uma obra individual não são excluídas apenas pela palavra ATA. Bairros são inspecionados em seus valores reais; endereço com mais de um bairro não autoriza atribuir todo o valor exclusivamente a um deles.

## Troca de planilha

Alterar GOOGLE_SHEETS_ID e sincronizar troca a fonte ativa de public.obras. A leitura anterior em public.planilha_abas permanece com ativa=false. A conta de serviço não precisa receber novamente a planilha se o compartilhamento foi mantido. Para voltar, restaure o ID e sincronize. As matrizes guardam a última leitura de cada aba por planilha; não substituem backup completo ou histórico de versões. Views de fontes antigas ficam sem registros ativos e não devem ser usadas para a pergunta atual.

Mudanças de cabeçalho geram um nome de view com versão de contrato. Não há DROP/CASCADE para forçar alterações. Views antigas podem permanecer para proteger dependências; o catálogo sempre aponta a versão atual.

## Referências usadas

- Silversky/LangChain/FastAPI: metadados das tabelas/views, ferramentas SQL, resultados brutos e sessão de conversa. Mantivemos o backend Node existente.
- SQL Query Engine: esquema real, transações somente leitura, SQLSTATE, SAVEPOINT e correções limitadas por erro real. Vazio pode ser um resultado válido.
- RAG_NLP_SQL: documentação semântica recuperada por BM25, separada dos registros; o catálogo informa significado, origem e nomes reais.

https://medium.com/@silverskytechnology/building-a-conversational-sql-agent-with-langchain-and-fastapi-7fb2c96228a5
https://arxiv.org/pdf/2604.16511
https://github.com/flaviagaia/RAG_NLP_SQL

## Correção de falha de IA

A preferência de provedor não bloqueia mais os outros provedores configurados. Saída cortada/vazia recebe uma repetição limitada. Para GPT-OSS na API pública NVIDIA, max_tokens respeita o limite documentado de 4096, e o esforço de raciocínio é reduzido na repetição. Falhas são distinguidas de ausência de registros. Se já houver SQL válido e somente a redação falhar, o sistema apresenta os dados retornados, sem inventar uma resposta. Uma consulta nova inválida impede reutilização indevida do resultado anterior. Listas diretas extensas são marcadas como parciais.

https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-120b-infer

## Validação e limites

Passaram testes locais com PostgreSQL embarcado: migração reaplicável, preservação de view, matrizes por aba, novas abas/colunas, colisões de cabeçalhos, dinheiro em milhões, pagos versus executados, fonte vazia, rollback completo, troca de planilha, classificação de status, busca por bairros, reparo SQL, READ ONLY, recuperação após truncamento de IA, fallback de provedor, preservação do resultado SQL, autenticação e HMAC do webhook.

Os provedores, Google Sheets e WhatsApp foram simulados nos testes. Nenhum dado foi alterado no seu Supabase, Render ou Google Sheets nesta entrega. É necessário instalar, sincronizar e comparar com a fonte vigente. O CSV antigo disponível não valida os valores atuais porque contém conversões monetárias antigas incorretas. Nenhuma das três referências garante 100% de acerto para qualquer pergunta.

O pacote de produção não contém agentes ou servidores simulados de teste.
