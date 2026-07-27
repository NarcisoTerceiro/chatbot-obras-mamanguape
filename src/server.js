// ============================================================
//  server.js  -  ponto de entrada do chatbot
//
//  Fluxo:
//  WhatsApp -> Webhook (aqui)
//           -> A IA (Groq) interpreta o pedido usando o HISTORICO
//              da conversa e devolve tipo + termos (+ agregacao).
//           -> O SISTEMA busca na planilha (search.js) e, quando e
//              agregacao, CALCULA em JavaScript puro (agregacao.js).
//           -> O SISTEMA entrega esses dados de volta a IA.
//           -> A IA REDIGE a resposta final, conectada com a conversa.
//           -> WhatsApp Cloud API envia ao cidadao.
//
//  A IA lembra da conversa e redige, mas NUNCA acessa a planilha,
//  NUNCA faz conta e NUNCA inventa dado. Se a IA falhar, o proprio
//  sistema monta a resposta, sem travar o atendimento.
// ============================================================

import "dotenv/config";
import express from "express";

import { getObras, getDiagnostico } from "./sheets.js";
import { buscarObrasPorTermos, buscarObras } from "./search.js";
import { interpretarPergunta, redigirResposta } from "./groq.js";
import { executarAgregacao } from "./agregacao.js";
import { enviarTexto } from "./whatsapp.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Contato humano para escalar quando o bot nao resolve (opcional, via .env).
const CONTATO_SECRETARIA = process.env.CONTATO_SECRETARIA || "";

// Quantas obras mostrar no maximo numa resposta DETALHADA (cada uma ocupa
// bastante espaco). Numa resposta RESUMIDA (so nomes), cabe bem mais.
const LIMITE_RESULTADOS = 3;
const LIMITE_RESUMIDO = 15;

// --- Memoria de conversa por cidadao (numero de WhatsApp) ---
// MELHORIA 5: alem do historico e das obras, guardamos os ULTIMOS TERMOS de
// busca e o TIPO da ultima interacao. Isso permite refinar perguntas do tipo
// "e tem mais alguma por la?", que dependem do recorte anterior.
const memoriaPorUsuario = new Map();
const MEMORIA_VALIDADE_MS = 10 * 60 * 1000; // 10 minutos
const MAX_HISTORICO = 8; // guarda ate 8 mensagens (~4 trocas)

function memoriaVazia() {
  return { historico: [], obras: [], termos: [], tipo: "", falhas: 0, mostradas: 0 };
}

function lerMemoria(de) {
  const m = memoriaPorUsuario.get(de);
  if (!m) return memoriaVazia();
  if (Date.now() - m.time > MEMORIA_VALIDADE_MS) {
    memoriaPorUsuario.delete(de);
    return memoriaVazia();
  }
  return {
    historico: m.historico || [],
    obras: m.obras || [],
    termos: m.termos || [],
    tipo: m.tipo || "",
    falhas: m.falhas || 0,
    mostradas: m.mostradas || 0,
  };
}

function salvarMemoria(de, dados) {
  memoriaPorUsuario.set(de, {
    historico: (dados.historico || []).slice(-MAX_HISTORICO),
    obras: dados.obras || [],
    termos: dados.termos || [],
    tipo: dados.tipo || "",
    falhas: dados.falhas || 0,
    mostradas: dados.mostradas || 0,
    time: Date.now(),
  });
}

// MELHORIA 6: log estruturado das perguntas que o bot nao conseguiu responder.
// Nao guarda o numero de telefone (privacidade). Serve para quem administra o
// bot revisar depois e ajustar sinonimos no prompt ou completar a planilha.
function logPerguntaSemResultado(pergunta, termos, motivo) {
  console.log(
    "LOG_SEM_RESULTADO " +
      JSON.stringify({
        data: new Date().toISOString(),
        pergunta,
        termos,
        motivo,
      })
  );
}

// Rota de saude (util pra manter o servico "acordado" e testar no navegador).
app.get("/", (_req, res) => res.send("Chatbot de Obras de Mamanguape no ar."));

// ------------------------------------------------------------
//  Rota de DIAGNOSTICO da planilha (protegida pelo VERIFY_TOKEN).
//  Abra no navegador:
//    https://SEU-APP.onrender.com/diagnostico?token=SEU_VERIFY_TOKEN
//  Mostra quantas obras foram lidas de cada aba, quais colunas foram
//  detectadas e um exemplo de obra - util para conferir se a planilha
//  esta sendo lida do jeito certo.
// ------------------------------------------------------------
app.get("/diagnostico", async (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  try {
    const obras = await getObras();
    const diag = getDiagnostico();
    res.json({
      total_de_obras: obras.length,
      abas: diag.abas,
      exemplo_de_obra: obras[0] || null,
      lido_em: diag.quando,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ------------------------------------------------------------
//  1) VERIFICACAO DO WEBHOOK (a Meta chama isso 1 vez, via GET)
// ------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ------------------------------------------------------------
//  2) RECEBIMENTO DE MENSAGENS (a Meta manda cada msg via POST)
// ------------------------------------------------------------
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  processarWebhook(req.body).catch((e) =>
    console.error("Erro ao processar webhook:", e)
  );
});

// ------------------------------------------------------------
//  Formatacao de RESPALDO (fallback): usada so quando a IA de
//  redacao falha. O SISTEMA monta o texto com as colunas que
//  existirem na planilha, sem depender da IA.
// ------------------------------------------------------------

function campoNome(obra) {
  // Nomes comuns em varias abas (obras) e tambem "RUA" (aba de pavimentacao).
  const candidatos = [
    "OBJETO DA OBRA", "OBJETO", "NOME DA OBRA", "NOME", "OBRA",
    "RUA", "LOGRADOURO", "ENDEREÇO", "ENDERECO",
  ];
  for (const c of candidatos) {
    if (obra[c]) return obra[c];
  }
  // Fallback: procura qualquer coluna cujo nome contenha objeto/obra/rua/nome.
  for (const [k, v] of Object.entries(obra)) {
    if (k === "_aba" || !v) continue;
    const n = k.toLowerCase();
    if (n.includes("objeto") || n.includes("obra") || n.includes("rua") || n.includes("nome")) {
      return v;
    }
  }
  const primeiro = Object.entries(obra).find(([k, v]) => k !== "_aba" && v);
  return primeiro ? primeiro[1] : "Obra sem nome cadastrado";
}

function campoStatus(obra) {
  // "STATUS" (maioria das abas) ou "SITUAÇÃO" (aba de pavimentacao).
  if (obra["STATUS"]) return obra["STATUS"];
  if (obra["Status"]) return obra["Status"];
  if (obra["SITUAÇÃO"]) return obra["SITUAÇÃO"];
  if (obra["SITUACAO"]) return obra["SITUACAO"];
  for (const [k, v] of Object.entries(obra)) {
    if (k === "_aba" || !v) continue;
    const n = k.toLowerCase();
    if (n.includes("status") || n.includes("situa")) return v;
  }
  return "";
}

// MELHORIA 4: emoji conforme o status, para leitura visual rapida.
function emojiStatus(status) {
  const s = (status || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!s) return "";
  if (s.includes("conclu") || s.includes("finaliz") || s.includes("entregue")) return "✅";
  if (s.includes("andamento") || s.includes("execu") || s.includes("obra em")) return "🚧";
  if (s.includes("paralis") || s.includes("parada") || s.includes("suspens")) return "⏸️";
  if (s.includes("licita") || s.includes("projeto") || s.includes("planej")) return "📋";
  return "";
}

function formatarResumido(obra) {
  const status = campoStatus(obra);
  const emoji = emojiStatus(status);
  const prefixo = emoji ? `${emoji} ` : "• ";
  return status ? `${prefixo}${campoNome(obra)} (${status})` : `${prefixo}${campoNome(obra)}`;
}

function formatarListaResumida(obras) {
  return obras.map((o) => formatarResumido(o)).join("\n");
}

function formatarObra(obra) {
  const emoji = emojiStatus(campoStatus(obra));
  const linhas = [];
  if (emoji) linhas.push(`${emoji} *${campoNome(obra)}*`);
  for (const [chave, valor] of Object.entries(obra)) {
    if (chave === "_aba" || !valor) continue;
    const texto = valor.toString();
    const valorCurto = texto.length > 200 ? texto.slice(0, 200) + "…" : texto;
    linhas.push(`• *${chave}*: ${valorCurto}`);
  }
  return linhas.join("\n");
}

function formatarLista(obras) {
  return obras.map((o, i) => `${i + 1}) ${formatarObra(o)}`).join("\n\n");
}

// Quantas opcoes mostrar por vez quando ha varias obras parecidas.
const PAGINA_ESCOLHA = 3;

// Monta uma "pagina" da lista de opcoes, comecando de 'jaMostradas'. Mantem a
// numeracao global (se ja mostrou 3, a proxima comeca no 4). Retorna o texto e
// quantas opcoes ficam mostradas no total ate aqui.
function montarPerguntaDeEscolha(lista, jaMostradas = 0) {
  const fim = Math.min(jaMostradas + PAGINA_ESCOLHA, lista.length);
  const slice = lista.slice(jaMostradas, fim);

  const linhas = slice.map((o, k) => {
    const i = jaMostradas + k; // indice global (0-based)
    const status = campoStatus(o);
    const emoji = emojiStatus(status);
    const sufixo = status ? ` — ${status}` : "";
    return `${i + 1}. ${emoji ? emoji + " " : ""}${campoNome(o)}${sufixo}`;
  });

  const restante = lista.length - fim;
  const cabecalho =
    jaMostradas === 0
      ? `Encontrei ${lista.length} obras relacionadas. Sobre qual você quer saber?`
      : `Mais ${slice.length} obra(s):`;

  const rodape =
    restante > 0
      ? `\n\nResponda o número (ex.: "${jaMostradas + 1}") ou o nome — ou digite ` +
        `*MAIS* para ver as próximas ${Math.min(PAGINA_ESCOLHA, restante)}.`
      : `\n\nÉ só responder o número ou o nome.`;

  return { texto: cabecalho + "\n\n" + linhas.join("\n") + rodape, mostradas: fim };
}

// Detecta o pedido de "ver mais" opcoes durante a escolha.
function ehVerMais(msg) {
  return /^\s*(mais|ver mais|mais obras|mostra mais|proxim[oa]|próxim[oa]|continuar|continua|segue|\+)\s*[.!]*\s*$/i.test(
    msg || ""
  );
}

// Detecta se a mensagem atual e a ESCOLHA de uma das obras que o bot acabou
// de listar. Retorna a obra escolhida, ou null se nao for uma escolha clara.
// Cobre: "2", "a 2", "a segunda", "a de pavimentacao", "a primeira".
function detectarEscolha(pergunta, obrasContexto) {
  if (!obrasContexto || obrasContexto.length < 2) return null;

  const bruto = (pergunta || "").toLowerCase().trim();

  // 1) Numero: "2", "a 2", "op 3", "numero 1".
  const mNum = bruto.match(/\b(\d{1,2})\b/);
  if (mNum) {
    const idx = parseInt(mNum[1], 10) - 1;
    if (idx >= 0 && idx < obrasContexto.length) return obrasContexto[idx];
  }

  // 2) Ordinais por extenso.
  const ordinais = {
    primeira: 0, primeiro: 0,
    segunda: 1, segundo: 1,
    terceira: 2, terceiro: 2,
    quarta: 3, quarto: 3,
    quinta: 4, quinto: 4,
    ultima: obrasContexto.length - 1, ultimo: obrasContexto.length - 1,
  };
  for (const [palavra, idx] of Object.entries(ordinais)) {
    if (new RegExp(`\\b${palavra}\\b`).test(bruto) && idx >= 0 && idx < obrasContexto.length) {
      return obrasContexto[idx];
    }
  }

  // 3) Trecho do nome: "a de pavimentacao", "a rua do jacare".
  const semAcento = (s) =>
    (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const palavrasMsg = semAcento(bruto)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (palavrasMsg.length > 0) {
    let melhor = null;
    let melhorPontos = 0;
    for (const obra of obrasContexto) {
      const nome = semAcento(campoNome(obra));
      const pontos = palavrasMsg.filter((w) => nome.includes(w)).length;
      if (pontos > melhorPontos) {
        melhorPontos = pontos;
        melhor = obra;
      }
    }
    if (melhorPontos > 0) return melhor;
  }

  return null;
}

// Detecta o comando de SAIR da obra em foco: "x", "sair", "voltar", "menu".
function ehSaidaFoco(msg) {
  return /^\s*(x|sair|voltar|menu|inicio|in[ií]cio|outra|outras|outra obra)\s*[.!]*\s*$/i.test(
    msg || ""
  );
}

// Estando dentro de uma obra (modo foco), verifica se a mensagem aponta
// claramente para OUTRA obra da base - ou seja, a pessoa quer trocar de obra
// sem precisar digitar "X". So retorna true quando a busca acha uma obra que
// NAO e a focada e o match e razoavelmente forte (>= 2 palavras uteis), para
// nao confundir perguntas sobre a propria obra ("qual o valor?") com troca.
function mensagemApontaOutraObra(pergunta, obraFocada, obras) {
  const palavras = (pergunta || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  // Precisa de conteudo suficiente para parecer o nome de uma obra.
  if (palavras.length < 2) return false;

  const achadas = buscarObras(pergunta, obras, 3);
  if (achadas.length === 0) return false;

  const nomeFocada = campoNome(obraFocada);
  // Se a melhor obra encontrada e diferente da que esta em foco, e troca.
  return campoNome(achadas[0]) !== nomeFocada;
}

function montarRespostaLocal(encontradas, detalhe) {
  if (detalhe === "resumido" && encontradas.length > 1) {
    return `Encontrei ${encontradas.length} obra(s):\n\n` + formatarListaResumida(encontradas);
  }
  if (encontradas.length === 1) {
    return formatarObra(encontradas[0]);
  }
  return `Encontrei ${encontradas.length} obra(s):\n\n` + formatarLista(encontradas);
}

// MELHORIA 4: saudacao fixa (nao gasta Groq), com pequenas variacoes para
// nao soar sempre identica.
const SAUDACOES = [
  "Olá! Eu sou o assistente de obras públicas da Prefeitura de Mamanguape. " +
    "Pode perguntar sobre qualquer obra — por bairro, rua, tipo de obra ou nome.",
  "Oi! Aqui é o assistente de obras públicas da Prefeitura de Mamanguape. " +
    "Me diga o bairro, a rua ou o nome da obra que você quer acompanhar.",
  "Olá, tudo bem? Sou o assistente de obras públicas da Prefeitura de Mamanguape. " +
    "Posso informar situação, valor, prazo e empresa responsável das obras. É só perguntar.",
];

function saudacaoAleatoria() {
  return SAUDACOES[Math.floor(Math.random() * SAUDACOES.length)];
}

// Frase de escalada, usada quando o bot nao consegue ajudar repetidamente.
function textoEscalada() {
  return CONTATO_SECRETARIA
    ? `\n\nSe preferir falar com um atendente, procure a Secretaria de Obras: ${CONTATO_SECRETARIA}`
    : "\n\nSe preferir, a Secretaria de Obras também pode te atender diretamente.";
}

// ------------------------------------------------------------
//  Orquestracao principal
//  Cada ramo apenas DEFINE o "texto" e o que guardar na memoria.
//  O envio e o salvamento acontecem uma unica vez, no fim.
// ------------------------------------------------------------
async function processarWebhook(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const mensagem = value?.messages?.[0];

  if (!mensagem || mensagem.type !== "text") return;

  const de = mensagem.from;
  const pergunta = mensagem.text.body;
  console.log(`Pergunta de ${de}: ${pergunta}`);

  const memoria = lerMemoria(de);
  const { historico, obras: obrasContexto, termos: termosAnteriores } = memoria;

  let texto = "";                        // resposta final que sera enviada
  let obrasParaGuardar = obrasContexto;  // obras a manter no contexto
  let termosParaGuardar = termosAnteriores;
  let tipoParaGuardar = memoria.tipo;
  let falhasParaGuardar = memoria.falhas;
  let mostradasParaGuardar = memoria.mostradas;

  try {
    // Passo A: le a planilha (com cache).
    const obras = await getObras();

    // Estamos no modo obra focada? Sim, EXCETO quando a pessoa (sem digitar
    // "X") escreve algo que bate claramente com OUTRA obra da base - nesse caso
    // ela quer trocar de obra, entao saimos do foco e tratamos como busca nova.
    const focadaAtual =
      memoria.tipo === "obra_focada" && obrasContexto.length >= 1 ? obrasContexto[0] : null;
    const trocarDeObra =
      focadaAtual &&
      !ehSaidaFoco(pergunta) &&
      mensagemApontaOutraObra(pergunta, focadaAtual, obras);
    const emFoco = !!focadaAtual && !trocarDeObra;

    if (trocarDeObra) {
      console.log("DEBUG saida automatica do foco: a mensagem aponta outra obra");
      // Zera o foco; o fluxo normal abaixo trata esta mensagem como busca nova.
      tipoParaGuardar = "";
      termosParaGuardar = [];
    }

    if (obras.length === 0) {
      texto =
        "No momento não encontrei nenhuma obra cadastrada na base. Tente novamente mais tarde.";
    }

    // ------------------------------------------------------
    //  MODO OBRA FOCADA: depois que a pessoa escolheu uma obra da lista,
    //  ela fica "dentro" dessa obra. QUALQUER pergunta e respondida sobre
    //  essa obra pela IA (linguagem livre, sem padrao fixo), ate a pessoa
    //  enviar "X" para sair. Isso evita reabrir listas ou interpretar errado.
    // ------------------------------------------------------
    else if (emFoco) {
      const obraFocada = obrasContexto[0];

      // A pessoa quer sair explicitamente ("x", "sair", "menu").
      if (ehSaidaFoco(pergunta)) {
        console.log("DEBUG saindo do modo obra focada");
        texto =
          "Certo, saí dessa obra. 👍 Pode perguntar sobre qualquer outra — por bairro, " +
          "rua, tipo de obra ou nome.";
        tipoParaGuardar = "";
        obrasParaGuardar = [];
        termosParaGuardar = [];
        falhasParaGuardar = 0;
      }

      else {
        // Qualquer pergunta sobre a obra em foco: a IA responde livremente,
        // usando so os dados dessa obra + o historico da conversa.
        console.log("DEBUG pergunta dentro da obra focada:", campoNome(obraFocada));
        obrasParaGuardar = [obraFocada];
        tipoParaGuardar = "obra_focada";
        falhasParaGuardar = 0;

        // Se a pessoa apenas CONFIRMOU ("sim", "pode", "quero") logo apos o bot
        // ter oferecido algo ("quer saber o prazo ou a empresa?"), damos uma
        // dica para a IA RESPONDER o que foi oferecido, sem repetir a ficha.
        const ehConfirmacaoCurta = /^\s*(sim|isso|pode|pode ser|claro|quero|queria|manda|mostra|aham|ok|blz|beleza|por favor|pf|quero sim|pode sim)\s*[.!]*\s*$/i.test(
          pergunta || ""
        );
        let dica = "";
        if (ehConfirmacaoCurta) {
          dica =
            "A pessoa respondeu 'sim' confirmando a oferta que voce fez na sua ultima " +
            "mensagem. Responda AGORA o que voce ofereceu (por exemplo, o prazo e/ou a " +
            "empresa responsavel), de forma direta e curta. NAO repita a ficha inteira da " +
            "obra e NAO ofereca a mesma coisa de novo.";
        }

        try {
          texto = await redigirResposta(pergunta, [obraFocada], "completo", historico, "", dica);
        } catch (e) {
          console.error("IA de redacao (obra focada) falhou, usando local:", e.message);
          texto = formatarObra(obraFocada);
        }
        // Lembrete discreto de como sair (so de vez em quando, pra nao poluir).
        if (Math.random() < 0.34) {
          texto += "\n\n_(envie *X* para sair desta obra)_";
        }
      }
    }

    else {
      // Passo B: a IA interpreta a pergunta usando o historico da conversa.
      let interpretacao;
      try {
        interpretacao = await interpretarPergunta(pergunta, historico);
      } catch (e) {
        console.error("IA de interpretacao falhou, usando busca direta:", e.message);
        interpretacao = {
          tipo: "busca",
          termos: [],
          detalhe: "completo",
          operacao: "",
          filtro_status: "",
          falhou: true,
        };
      }

      // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
      console.log("DEBUG interpretacao:", JSON.stringify(interpretacao));
      tipoParaGuardar = interpretacao.tipo;
      if (interpretacao.termos.length > 0) termosParaGuardar = interpretacao.termos;

      // ------------------------------------------------------
      //  SELECAO DE OBRA: se na mensagem anterior o bot listou varias
      //  opcoes e pediu para escolher, e agora a pessoa respondeu "2",
      //  "a segunda" ou "a de pavimentacao", detalhamos SO aquela obra.
      //  Se respondeu algo que NAO e uma escolha clara, repetimos a lista.
      // ------------------------------------------------------
      const aguardandoEscolha = memoria.tipo === "aguardando_escolha";
      const escolha = aguardandoEscolha ? detectarEscolha(pergunta, obrasContexto) : null;
      const pediuMais = aguardandoEscolha && !escolha && ehVerMais(pergunta);

      // Mensagens curtas de confirmacao/continuacao ("sim", "isso", "pode",
      // "aham", "quero", "manda") NAO sao busca nova - a pessoa esta seguindo
      // com a obra que ja estava em pauta.
      const ehConfirmacao = /^\s*(sim|isso|isso mesmo|pode|pode ser|claro|quero|queria|manda|mostra|aham|ok|blz|beleza|por favor|pf|s)\s*[.!]*\s*$/i.test(
        pergunta || ""
      );

      if (pediuMais && memoria.mostradas < obrasContexto.length) {
        // "MAIS": mostra a proxima pagina de opcoes, mantendo a numeracao.
        console.log(
          `DEBUG ver mais opcoes: ${memoria.mostradas}/${obrasContexto.length} ja mostradas`
        );
        const pagina = montarPerguntaDeEscolha(obrasContexto, memoria.mostradas);
        texto = pagina.texto;
        obrasParaGuardar = obrasContexto;
        tipoParaGuardar = "aguardando_escolha";
        mostradasParaGuardar = pagina.mostradas;
      }

      else if (aguardandoEscolha && !escolha && obrasContexto.length >= 2) {
        // Estava esperando um numero e a pessoa respondeu algo vago -> repete
        // a mesma pagina de opcoes, sem sair procurando outras.
        console.log("DEBUG resposta vaga durante escolha - repetindo a pagina");
        const jaMostradas = Math.max(0, memoria.mostradas - PAGINA_ESCOLHA);
        const pagina = montarPerguntaDeEscolha(obrasContexto, jaMostradas);
        texto = "Só pra confirmar qual das obras. " + pagina.texto;
        obrasParaGuardar = obrasContexto;
        tipoParaGuardar = "aguardando_escolha";
        mostradasParaGuardar = memoria.mostradas;
      }

      else if (escolha) {
        console.log("DEBUG selecao de obra pelo contexto:", campoNome(escolha));
        obrasParaGuardar = [escolha];
        tipoParaGuardar = "obra_focada"; // entra no modo obra focada
        falhasParaGuardar = 0;
        try {
          texto = await redigirResposta(pergunta, [escolha], "completo", historico);
        } catch (e) {
          console.error("IA de redacao (selecao) falhou, usando local:", e.message);
          texto = formatarObra(escolha);
        }
        texto +=
          "\n\n_Você está vendo esta obra. Pergunte o que quiser sobre ela; " +
          "envie *X* para ver outras._";
      }

      // Confirmacao curta ("sim") logo apos detalhar UMA obra: segue NAQUELA
      // obra (mostra o que foi oferecido: prazo, empresa...), sem reabrir lista.
      else if (ehConfirmacao && !aguardandoEscolha && obrasContexto.length >= 1) {
        const obraAtual = obrasContexto[0];
        console.log("DEBUG confirmacao - seguindo na obra atual:", campoNome(obraAtual));
        obrasParaGuardar = [obraAtual];
        tipoParaGuardar = "busca";
        falhasParaGuardar = 0;
        try {
          texto = await redigirResposta(pergunta, [obraAtual], "completo", historico);
        } catch (e) {
          console.error("IA de redacao (confirmacao) falhou, usando local:", e.message);
          texto = formatarObra(obraAtual);
        }
      }

      // ------------------------------------------------------
      //  Passo C: SAUDACAO - resposta fixa do sistema (sem Groq).
      // ------------------------------------------------------
      else if (interpretacao.tipo === "saudacao") {
        texto = saudacaoAleatoria();
        falhasParaGuardar = 0;
      }

      // ------------------------------------------------------
      //  Passo D: AGREGACAO (MELHORIA 2)
      //  O SISTEMA faz a conta em JavaScript; a IA so redige o
      //  resultado ja calculado, sem refazer nenhum calculo.
      // ------------------------------------------------------
      else if (interpretacao.tipo === "agregacao") {
        // Se a pergunta tem recorte (ex.: "mais cara do Centro"), filtra antes.
        let base = obras;
        if (interpretacao.termos.length > 0) {
          const filtradas = buscarObrasPorTermos(interpretacao.termos, obras, obras.length);
          if (filtradas.length > 0) base = filtradas;
        }

        const resultado = executarAgregacao(interpretacao.operacao, base, {
          filtro_status: interpretacao.filtro_status,
        });

        console.log(
          `DEBUG agregacao: operacao=${interpretacao.operacao} base=${base.length} ` +
            `resultado=${resultado ? "ok" : "nao calculado"}`
        );

        if (!resultado) {
          logPerguntaSemResultado(pergunta, interpretacao.termos, "agregacao_sem_dados");
          texto =
            "Não consegui fazer esse cálculo porque a base não tem esse dado preenchido " +
            "para as obras. Posso te informar a situação, o valor ou o prazo de uma obra " +
            "específica — é só dizer o bairro ou o nome.";
          falhasParaGuardar = memoria.falhas + 1;
        } else {
          obrasParaGuardar = resultado.obras;
          falhasParaGuardar = 0;
          try {
            texto = await redigirResposta(
              pergunta,
              resultado.obras,
              interpretacao.detalhe,
              historico,
              resultado.fatos // fatos JA calculados pelo sistema
            );
          } catch (e) {
            console.error("IA de redacao (agregacao) falhou, usando local:", e.message);
            texto =
              resultado.fatos +
              (resultado.obras.length > 0
                ? `\n\n${formatarListaResumida(resultado.obras)}`
                : "");
          }
        }
      }

      // ------------------------------------------------------
      //  Passo E: LISTAGEM geral
      // ------------------------------------------------------
      else if (interpretacao.tipo === "listagem") {
        const resumido = interpretacao.detalhe === "resumido";
        const limite = resumido ? LIMITE_RESUMIDO : LIMITE_RESULTADOS;
        const lista = obras.slice(0, limite);
        const restante = obras.length - lista.length;
        obrasParaGuardar = lista;
        falhasParaGuardar = 0;

        let corpo;
        try {
          corpo = await redigirResposta(
            pergunta,
            lista,
            interpretacao.detalhe,
            historico,
            `A base tem ${obras.length} obra(s) cadastrada(s) no total. ` +
              `Estao sendo mostradas ${lista.length} delas.`
          );
        } catch (e) {
          console.error("IA de redacao (listagem) falhou, usando local:", e.message);
          corpo = resumido
            ? `Temos ${obras.length} obra(s) cadastrada(s):\n\n` + formatarListaResumida(lista)
            : `Temos ${obras.length} obra(s) cadastrada(s). Aqui estão as primeiras:\n\n` +
              formatarLista(lista);
        }

        const rodape =
          restante > 0
            ? `\n\n...e mais ${restante}. Pergunte por bairro, rua, tipo ou nome para ver detalhes.`
            : "";
        texto = corpo + rodape;
      }

      // ------------------------------------------------------
      //  Passo F: BUSCA especifica
      // ------------------------------------------------------
      else {
        // Busca TODAS as candidatas relevantes (nao so 3), para poder paginar
        // com "MAIS". O filtro de relevancia do search.js ja faz o nome exato
        // vencer sozinho; aqui so ampliamos o teto para casos com muitas obras.
        const TETO_CANDIDATAS = 30;

        let encontradas = buscarObrasPorTermos(interpretacao.termos, obras, TETO_CANDIDATAS);
        console.log(`DEBUG busca por termos da IA: ${encontradas.length} resultado(s)`);

        if (encontradas.length === 0) {
          encontradas = buscarObras(pergunta, obras, TETO_CANDIDATAS);
          console.log(`DEBUG busca direta pelo texto: ${encontradas.length} resultado(s)`);
        }

        // MELHORIA 5: refinamento - combina os termos anteriores com os novos.
        if (encontradas.length === 0 && termosAnteriores.length > 0) {
          const combinados = [...new Set([...termosAnteriores, ...interpretacao.termos])];
          encontradas = buscarObrasPorTermos(combinados, obras, TETO_CANDIDATAS);
          console.log(
            `DEBUG busca combinada com termos anteriores [${combinados.join(", ")}]: ` +
              `${encontradas.length} resultado(s)`
          );
          if (encontradas.length > 0) termosParaGuardar = combinados;
        }

        // Ultimo recurso: reusa a obra que ja estava em pauta (acompanhamento).
        if (encontradas.length === 0 && obrasContexto.length > 0) {
          console.log("DEBUG reusando obra(s) do contexto da conversa");
          encontradas = obrasContexto;
        }

        if (encontradas.length === 0) {
          // MELHORIA 3: em vez de despejar a listagem geral, o bot pede a
          // pista que falta. Listagem geral so quando o pedido FOI de listagem.
          falhasParaGuardar = memoria.falhas + 1;
          // So tratamos como pergunta vaga quando a IA REALMENTE entendeu e nao
          // achou pista. Se a IA falhou (erro na API), a pergunta pode ter sido
          // clara - nesse caso nao devolvemos "nao entendi", que soa errado.
          const semPista = interpretacao.termos.length === 0 && !interpretacao.falhou;

          logPerguntaSemResultado(
            pergunta,
            interpretacao.termos,
            interpretacao.falhou
              ? "ia_indisponivel"
              : semPista
              ? "pergunta_ambigua"
              : "termos_sem_correspondencia"
          );

          if (semPista) {
            texto =
              "Não entendi bem qual obra você quer saber. Pode me dizer o bairro, a rua " +
              "ou o nome da obra?";
          } else if (interpretacao.falhou) {
            texto =
              `Não encontrei nenhuma obra com esses termos. Temos ${obras.length} obra(s) ` +
              `cadastradas — tente pelo bairro, pela rua, pelo tipo (pavimentação, escola, ` +
              `UBS, praça) ou pela situação (em andamento, concluída, paralisada).`;
          } else {
            texto =
              `Não encontrei nenhuma obra relacionada a "${interpretacao.termos.join(", ")}" ` +
              `na base. Temos ${obras.length} obra(s) cadastradas — tente pelo bairro, pela ` +
              `rua ou pelo tipo de obra (pavimentação, escola, UBS, praça).`;
          }

          // Se a pessoa ja tentou algumas vezes sem sucesso, oferece o caminho humano.
          if (falhasParaGuardar >= 2) {
            texto += textoEscalada();
            falhasParaGuardar = 0;
          }
        } else if (encontradas.length === 1) {
          // Uma unica obra: detalha direto.
          obrasParaGuardar = encontradas;
          falhasParaGuardar = 0;
          try {
            texto = await redigirResposta(pergunta, encontradas, interpretacao.detalhe, historico);
          } catch (e) {
            console.error("IA de redacao falhou, usando formatador local:", e.message);
            texto = montarRespostaLocal(encontradas, interpretacao.detalhe);
          }
        } else {
          // Varias obras casaram: mostra a PRIMEIRA pagina de opcoes e guarda a
          // lista completa. "MAIS" mostra as proximas; o numero escolhe a obra.
          obrasParaGuardar = encontradas;
          tipoParaGuardar = "aguardando_escolha";
          falhasParaGuardar = 0;
          const pagina = montarPerguntaDeEscolha(encontradas, 0);
          texto = pagina.texto;
          mostradasParaGuardar = pagina.mostradas;
        }
      }
    }
  } catch (e) {
    console.error("Falha no processamento:", e);
    texto =
      "Tivemos um problema momentâneo ao consultar as obras. Tente novamente em instantes.";
  }

  if (!texto) return; // seguranca: nada a enviar

  // Atualiza a memoria: historico da conversa + recorte atual (obras e termos).
  const novoHistorico = [
    ...historico,
    { role: "user", content: pergunta },
    { role: "assistant", content: texto },
  ];
  salvarMemoria(de, {
    historico: novoHistorico,
    obras: obrasParaGuardar,
    termos: termosParaGuardar,
    tipo: tipoParaGuardar,
    falhas: falhasParaGuardar,
    mostradas: mostradasParaGuardar,
  });

  await enviarTexto(de, texto);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});