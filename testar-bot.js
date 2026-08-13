// ============================================================
//  testar-bot.js
//  Bateria de perguntas TIPICAS de cidadao. Testa a INTERPRETACAO
//  (groq.js) - a parte que decide o que o sistema vai fazer.
//
//  COMO USAR:
//    1. Coloque na RAIZ do projeto (junto do package.json).
//    2. .env com GEMINI_API_KEY e GROQ_API_KEY preenchidas.
//    3. Rode:  node testar-bot.js
//       (ou um grupo:  node testar-bot.js valor)
//
//  Para cada pergunta mostra:
//    - o que a IA classificou (tipo + operacao)
//    - [OK] se bateu com o esperado, [FALHOU] se nao
//    - qual IA respondeu (Gemini ou Groq)
//
//  No fim, um placar: quantas passaram de cada grupo.
//  Perguntas espacadas em 3s para nao estourar a cota gratuita.
// ============================================================

import "dotenv/config";
import { interpretarPergunta } from "./src/groq.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m", cyan: "\x1b[36m",
};

// Cada caso: pergunta + o que esperamos ver.
// "tipo" e o principal; "operacao" so quando relevante.
const GRUPOS = {
  saudacao: [
    { p: "oi", tipo: "saudacao" },
    { p: "bom dia, tudo bem?", tipo: "saudacao" },
    { p: "obrigado!", tipo: "saudacao" },
  ],

  listagem: [
    { p: "quais obras tem na cidade?", tipo: "listagem" },
    { p: "me mostra as obras", tipo: "listagem" },
    { p: "o que ta sendo feito ai?", tipo: "listagem" },
  ],

  // O CASO QUE VOCE VIU FALHAR - valor total, varias formas
  valor: [
    { p: "qual o valor investido nessas obras?", tipo: "agregacao", operacao: "soma_valor" },
    { p: "quais os valores investidos nessas obras?", tipo: "agregacao", operacao: "soma_valor" },
    { p: "quanto foi investido no total?", tipo: "agregacao", operacao: "soma_valor" },
    { p: "quanto custou tudo isso?", tipo: "agregacao", operacao: "soma_valor" },
    { p: "deu quanto no total?", tipo: "agregacao", operacao: "soma_valor" },
    { p: "soma o valor de todas", tipo: "agregacao", operacao: "soma_valor" },
  ],

  contagem: [
    { p: "quantas obras estao concluidas?", tipo: "agregacao", operacao: "contar_por_status" },
    { p: "quantas obras em andamento?", tipo: "agregacao", operacao: "contar_por_status" },
    { p: "quantas obras tem no total?", tipo: "agregacao", operacao: "contar_total" },
    { p: "quantas estao paradas?", tipo: "agregacao", operacao: "contar_por_status" },
  ],

  extremos: [
    { p: "qual a obra mais cara?", tipo: "agregacao", operacao: "maior_valor" },
    { p: "qual a mais barata?", tipo: "agregacao", operacao: "menor_valor" },
  ],

  busca: [
    { p: "como ta a creche do centro?", tipo: "busca" },
    { p: "tem obra no bairro bela vista?", tipo: "busca" },
    { p: "a UBS do cristo rei ta pronta?", tipo: "busca" },
    { p: "situacao do asfalto da rua nova", tipo: "busca" },
  ],

  engenheiro: [
    { p: "obras do engenheiro carlos", tipo: "engenheiro" },
    { p: "o que a fernanda lima toca?", tipo: "engenheiro" },
  ],

  nomes: [
    { p: "so os nomes dos engenheiros", tipo: "agregacao" },
    { p: "quais empresas tem obra?", tipo: "agregacao" },
  ],

  status_concluida: [
    // Testa sinonimos de "concluida"
    { p: "quais obras estao prontas?", tipo: "agregacao", operacao: "contar_por_status" },
    { p: "quais ja terminaram?", tipo: "agregacao", operacao: "contar_por_status" },
  ],
};

// Conversa com contexto (2 turnos)
const CONVERSA = [
  {
    p: "qual o valor dessas?",
    historico: [
      { role: "user", content: "quais obras concluidas?" },
      { role: "assistant", content: "Encontrei 9 obras concluidas: Terminal, Ginasio, Praca Salema..." },
    ],
    tipo: "agregacao", operacao: "soma_valor", contexto: true,
  },
];

function avalia(r, caso) {
  const tipoOk = r.tipo === caso.tipo || (caso.tipo === "agregacao" && r.receita);
  const opOk = !caso.operacao || r.operacao === caso.operacao ||
    (caso.operacao === "soma_valor" && r.operacao === "soma_valor");
  const ctxOk = caso.contexto === undefined || r.usar_contexto === caso.contexto;
  return tipoOk && opOk && ctxOk;
}

async function rodarGrupo(nome, casos) {
  console.log(`\n${c.bold}${c.yellow}━━━ ${nome.toUpperCase()} ━━━${c.reset}`);
  let ok = 0;
  for (const caso of casos) {
    try {
      const r = await interpretarPergunta(caso.p, caso.historico || []);
      const passou = avalia(r, caso);
      if (passou) ok++;
      const marca = passou ? `${c.green}[OK]${c.reset}` : `${c.red}[FALHOU]${c.reset}`;
      const detalhe = `tipo=${r.tipo}${r.operacao ? " op=" + r.operacao : ""}${r.receita ? " +receita" : ""}${r.usar_contexto ? " +ctx" : ""}`;
      console.log(`${marca} ${c.gray}"${caso.p}"${c.reset}`);
      console.log(`      ${c.dim}esperado: ${caso.tipo}${caso.operacao ? "/" + caso.operacao : ""} | recebido: ${detalhe}${c.reset}`);
      if (!passou) console.log(`      ${c.red}^ divergiu${c.reset}`);
    } catch (e) {
      console.log(`${c.red}[ERRO]${c.reset} "${caso.p}" -> ${e.message.slice(0, 80)}`);
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return { ok, total: casos.length };
}

async function main() {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    console.error(`${c.red}Configure GEMINI_API_KEY e/ou GROQ_API_KEY no .env${c.reset}`);
    process.exit(1);
  }
  const filtro = process.argv[2];
  console.log(`${c.bold}TESTE DO BOT — ${new Date().toLocaleString("pt-BR")}${c.reset}`);
  console.log(`${c.dim}Cada [OK] = a IA entendeu a pergunta certo. [FALHOU] = classificou errado.${c.reset}`);

  const grupos = filtro ? { [filtro]: GRUPOS[filtro] } : GRUPOS;
  if (filtro && !GRUPOS[filtro]) {
    console.error(`Grupo "${filtro}" nao existe. Opcoes: ${Object.keys(GRUPOS).join(", ")}, conversa`);
    process.exit(1);
  }

  const placar = [];
  for (const [nome, casos] of Object.entries(grupos)) {
    if (casos) placar.push([nome, await rodarGrupo(nome, casos)]);
  }

  if (!filtro || filtro === "conversa") {
    console.log(`\n${c.bold}${c.yellow}━━━ CONVERSA (contexto) ━━━${c.reset}`);
    for (const turno of CONVERSA) {
      try {
        const r = await interpretarPergunta(turno.p, turno.historico);
        const passou = avalia(r, turno);
        const marca = passou ? `${c.green}[OK]${c.reset}` : `${c.red}[FALHOU]${c.reset}`;
        console.log(`${marca} ${c.gray}"${turno.p}"${c.reset} (com histórico)`);
        console.log(`      ${c.dim}tipo=${r.tipo} op=${r.operacao} ctx=${r.usar_contexto}${c.reset}`);
      } catch (e) {
        console.log(`${c.red}[ERRO]${c.reset} ${e.message.slice(0, 80)}`);
      }
      await new Promise((s) => setTimeout(s, 3000));
    }
  }

  // Placar final
  console.log(`\n${c.bold}${c.cyan}━━━━━━━ PLACAR ━━━━━━━${c.reset}`);
  let totOk = 0, tot = 0;
  for (const [nome, { ok, total }] of placar) {
    totOk += ok; tot += total;
    const cor = ok === total ? c.green : ok === 0 ? c.red : c.yellow;
    console.log(`  ${cor}${ok}/${total}${c.reset}  ${nome}`);
  }
  console.log(`  ${c.bold}${totOk}/${tot} no total${c.reset}`);
  console.log(`\n${c.dim}Me mande este placar. Onde tiver [FALHOU], eu corrijo aquele caso específico.${c.reset}`);
}

main();
