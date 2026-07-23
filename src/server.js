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

import { getObras } from "./sheets.js";
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
  return { historico: [], obras: [], termos: [], tipo: "", falhas: 0 };
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
  };
}

function salvarMemoria(de, dados) {
  memoriaPorUsuario.set(de, {
    historico: (dados.historico || []).slice(-MAX_HISTORICO),
    obras: dados.obras || [],
    termos: dados.termos || [],
    tipo: dados.tipo || "",
    falhas: dados.falhas || 0,
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
  const candidatos = ["OBJETO DA OBRA", "OBJETO", "NOME DA OBRA", "NOME", "OBRA"];
  for (const c of candidatos) {
    if (obra[c]) return obra[c];
  }
  const primeiro = Object.entries(obra).find(([k, v]) => k !== "_aba" && v);
  return primeiro ? primeiro[1] : "Obra sem nome cadastrado";
}

function campoStatus(obra) {
  return obra["STATUS"] || obra["Status"] || obra["SITUAÇÃO"] || obra["SITUACAO"] || "";
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

  try {
    // Passo A: le a planilha (com cache).
    const obras = await getObras();

    if (obras.length === 0) {
      texto =
        "No momento não encontrei nenhuma obra cadastrada na base. Tente novamente mais tarde.";
    } else {
      // Passo B: a IA interpreta a pergunta usando o historico da conversa.
      let interpretacao;
      try {
        interpretacao = await interpretarPergunta(pergunta, historico);
      } catch (e) {
        console.error("IA de interpretacao falhou, usando busca direta:", e.message);
        interpretacao = { tipo: "busca", termos: [], detalhe: "completo", operacao: "", filtro_status: "" };
      }

      // LOG TEMPORARIO DE DEBUG - remover depois de confirmar que esta ok
      console.log("DEBUG interpretacao:", JSON.stringify(interpretacao));
      tipoParaGuardar = interpretacao.tipo;
      if (interpretacao.termos.length > 0) termosParaGuardar = interpretacao.termos;

      // ------------------------------------------------------
      //  Passo C: SAUDACAO - resposta fixa do sistema (sem Groq).
      // ------------------------------------------------------
      if (interpretacao.tipo === "saudacao") {
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
        let encontradas = buscarObrasPorTermos(interpretacao.termos, obras, LIMITE_RESULTADOS);
        console.log(`DEBUG busca por termos da IA: ${encontradas.length} resultado(s)`);

        if (encontradas.length === 0) {
          encontradas = buscarObras(pergunta, obras, LIMITE_RESULTADOS);
          console.log(`DEBUG busca direta pelo texto: ${encontradas.length} resultado(s)`);
        }

        // MELHORIA 5: refinamento - combina os termos anteriores com os novos
        // ("e tem mais alguma por la?", "e sobre isso na Vila Nova?").
        if (encontradas.length === 0 && termosAnteriores.length > 0) {
          const combinados = [...new Set([...termosAnteriores, ...interpretacao.termos])];
          encontradas = buscarObrasPorTermos(combinados, obras, LIMITE_RESULTADOS);
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
          const semPista = interpretacao.termos.length === 0;

          logPerguntaSemResultado(
            pergunta,
            interpretacao.termos,
            semPista ? "pergunta_ambigua" : "termos_sem_correspondencia"
          );

          if (semPista) {
            texto =
              "Não entendi bem qual obra você quer saber. Pode me dizer o bairro, a rua " +
              "ou o nome da obra?";
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
        } else {
          obrasParaGuardar = encontradas;
          falhasParaGuardar = 0;
          try {
            texto = await redigirResposta(
              pergunta,
              encontradas,
              interpretacao.detalhe,
              historico
            );
          } catch (e) {
            console.error("IA de redacao falhou, usando formatador local:", e.message);
            texto = montarRespostaLocal(encontradas, interpretacao.detalhe);
          }
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
  });

  await enviarTexto(de, texto);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});