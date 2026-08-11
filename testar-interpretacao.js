// ============================================================
//  testar-interpretacao.js
//
//  Testa SO a etapa de interpretacao da pergunta (groq.js ->
//  interpretarPergunta), que e onde estavam os bugs de resposta
//  repetida / sem sentido. NAO testa busca nem redacao final.
//
//  COMO USAR:
//    1. Coloque este arquivo na RAIZ do projeto (mesma pasta do package.json).
//    2. Garanta que o .env tem GEMINI_API_KEY preenchida.
//    3. Rode:   node testar-interpretacao.js
//       (ou, para testar so um grupo:  node testar-interpretacao.js engenheiro)
//
//  O que ele mostra por pergunta:
//    - a pergunta
//    - o TIPO que a IA classificou
//    - os termos / operacao / receita relevantes
//    - um alerta [?] quando o resultado parece divergir do esperado
//
//  Serve para VOCE bater o olho e ver se a interpretacao esta coerente
//  antes de desconectar o n8n e apontar o WhatsApp para o Render.
// ============================================================

import "dotenv/config";
import { interpretarPergunta } from "./src/groq.js";

// ---- Cores simples para o terminal (sem dependencia externa) ----
const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", gray: "\x1b[90m",
};

// ============================================================
//  BATERIA DE PERGUNTAS
//  Cada item: { p: pergunta, espera: tipo_esperado, nota: dica }
//  'espera' e so uma referencia para o alerta [?] - nao e nota final.
//  Cobrimos: saudacao, listagem, busca, agregacao (varios), engenheiro,
//  os 3 casos parecidos do prompt (listar-campo x contar_por x filtro),
//  girias/erros de digitacao, e perguntas ambiguas.
// ============================================================
const GRUPOS = {
  saudacao: [
    { p: "oi", espera: "saudacao" },
    { p: "bom dia", espera: "saudacao" },
    { p: "obrigado, valeu", espera: "saudacao" },
    { p: "boa tarde, tudo bem?", espera: "saudacao" },
  ],

  listagem: [
    { p: "quais obras existem?", espera: "listagem" },
    { p: "me mostra as obras", espera: "listagem" },
    { p: "o que ta sendo feito na cidade?", espera: "listagem" },
    { p: "lista as obras ai", espera: "listagem" },
  ],

  busca: [
    { p: "como ta a obra da creche do centro?", espera: "busca", nota: "termos: creche + centro" },
    { p: "quanto custou o asfalto do bela vista?", espera: "busca", nota: "asfalto->pavimentacao" },
    { p: "tem obra no cristo rei?", espera: "busca", nota: "termo: cristo rei" },
    { p: "situacao do postinho da barra", espera: "busca", nota: "postinho->UBS/posto" },
    { p: "a pracinha de nova mamanguape ta pronta?", espera: "busca", nota: "pracinha->praca" },
    { p: "obras da construtora ativa", espera: "busca", nota: "empresa" },
  ],

  agregacao: [
    { p: "qual a obra mais cara?", espera: "agregacao", nota: "operacao maior_valor" },
    { p: "qual a obra mais barata?", espera: "agregacao", nota: "menor_valor" },
    { p: "quanto foi gasto no total?", espera: "agregacao", nota: "soma_valor" },
    { p: "quantas obras tem no total?", espera: "agregacao", nota: "contar_total" },
    { p: "quantas obras estao paralisadas?", espera: "agregacao", nota: "contar_por_status" },
    { p: "quanto foi investido no centro?", espera: "agregacao", nota: "soma com recorte centro" },
    { p: "media de valor das escolas", espera: "agregacao", nota: "media com recorte escola" },
    { p: "top 3 obras mais caras", espera: "agregacao", nota: "receita top n=3" },
    { p: "qual a segunda obra mais cara?", espera: "agregacao", nota: "receita ordinal posicao=2" },
    { p: "quantas obras por bairro?", espera: "agregacao", nota: "contar_por BAIRRO" },
    { p: "qual engenheiro tem mais obras?", espera: "agregacao", nota: "contar_por ENGENHEIRO top=1" },
  ],

  engenheiro: [
    { p: "obras do engenheiro Carlos", espera: "engenheiro", nota: "termos: [Carlos]" },
    { p: "o que o Paulo Nunes toca?", espera: "engenheiro", nota: "termos: [Paulo Nunes]" },
    { p: "quais obras a Fernanda Lima esta responsavel?", espera: "engenheiro" },
  ],

  // O CASO DO BUG: "so os nomes" deve virar contar_por, NAO repetir a ficha.
  so_os_nomes: [
    { p: "lista so os nomes dos engenheiros", espera: "agregacao", nota: "DEVE ser contar_por ENGENHEIRO" },
    { p: "so os nomes dos engenheiros", espera: "agregacao", nota: "DEVE ser contar_por ENGENHEIRO" },
    { p: "quais empresas estao tocando obras?", espera: "agregacao", nota: "contar_por EMPRESA" },
    { p: "quais bairros tem obra?", espera: "agregacao", nota: "contar_por BAIRRO" },
    { p: "lista os engenheiros sem repetir", espera: "agregacao", nota: "contar_por ENGENHEIRO" },
  ],

  girias_erros: [
    { p: "kd as obra?", espera: "listagem", nota: "erro de digitacao" },
    { p: "qnto custo a creche", espera: "busca", nota: "abreviacao" },
    { p: "tem obra parada?", espera: "agregacao", nota: "contar_por_status paralisada" },
    { p: "qual obra mais grande de dinheiro", espera: "agregacao", nota: "maior_valor informal" },
  ],
};

// ============================================================
//  Teste de CONTEXTO (memoria) - simula uma conversa de 2 turnos
//  para ver se a IA entende "e o valor de cada uma?" referindo-se
//  ao resultado anterior. Este e um dos pontos delicados.
// ============================================================
const CONVERSA = [
  { p: "quais obras estao em andamento?", historico: [] },
  {
    p: "e o valor de cada uma?",
    historico: [
      { role: "user", content: "quais obras estao em andamento?" },
      { role: "assistant", content: "Encontrei 15 obras em andamento: Creche, Pavimentacao Bela Vista, UBS Cristo Rei..." },
    ],
    nota: "DEVE usar_contexto:true",
  },
  {
    p: "lista so os nomes dos engenheiros dessas",
    historico: [
      { role: "user", content: "quais obras estao em andamento?" },
      { role: "assistant", content: "Encontrei 15 obras..." },
      { role: "user", content: "e o valor de cada uma?" },
      { role: "assistant", content: "Creche R$ 1.408.500; Bela Vista R$ 2.540.000..." },
    ],
    nota: "DEVE usar_contexto:true + contar_por ENGENHEIRO",
  },
];

// ---- Formata uma linha de resultado ----
function resumoInterpretacao(r) {
  const partes = [`tipo=${c.bold}${r.tipo}${c.reset}`];
  if (r.termos && r.termos.length) partes.push(`termos=[${r.termos.join(", ")}]`);
  if (r.operacao) partes.push(`op=${r.operacao}`);
  if (r.filtro_status) partes.push(`status=${r.filtro_status}`);
  if (r.pista_valor) partes.push(`pista=${r.pista_valor}`);
  if (r.usar_contexto) partes.push(`${c.cyan}usar_contexto=true${c.reset}`);
  if (r.receita) {
    const ag = r.receita.agregacao || {};
    const f = (r.receita.filtros || []).length;
    partes.push(`${c.cyan}receita{ag=${ag.tipo || "?"}${ag.campo ? ":" + ag.campo : ""}, filtros=${f}}${c.reset}`);
  }
  if (r.falhou) partes.push(`${c.red}FALHOU=true${c.reset}`);
  return partes.join("  ");
}

// ---- Roda um grupo ----
async function rodarGrupo(nome, itens) {
  console.log(`\n${c.bold}${c.yellow}=== ${nome.toUpperCase()} ===${c.reset}`);
  for (const item of itens) {
    process.stdout.write(`${c.gray}"${item.p}"${c.reset}\n   `);
    try {
      const r = await interpretarPergunta(item.p, item.historico || []);
      const alerta =
        item.espera && r.tipo !== item.espera && !(item.espera === "agregacao" && r.receita)
          ? `  ${c.red}[? esperava ${item.espera}]${c.reset}`
          : "";
      console.log(resumoInterpretacao(r) + alerta);
      if (item.nota) console.log(`   ${c.dim}nota: ${item.nota}${c.reset}`);
    } catch (e) {
      console.log(`${c.red}ERRO: ${e.message}${c.reset}`);
    }
    // pausa curta para nao estourar limite de requisicoes por minuto
    await new Promise((s) => setTimeout(s, 400));
  }
}

// ---- Main ----
async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(`${c.red}FALTA GEMINI_API_KEY no .env. Preencha e rode de novo.${c.reset}`);
    process.exit(1);
  }

  const filtro = process.argv[2]; // opcional: roda so um grupo
  console.log(`${c.bold}Teste de interpretacao — ${new Date().toLocaleString("pt-BR")}${c.reset}`);
  console.log(`${c.dim}Modelo: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}${c.reset}`);

  const grupos = filtro ? { [filtro]: GRUPOS[filtro] } : GRUPOS;
  if (filtro && !GRUPOS[filtro]) {
    console.error(`Grupo "${filtro}" nao existe. Opcoes: ${Object.keys(GRUPOS).join(", ")}, conversa`);
    process.exit(1);
  }

  for (const [nome, itens] of Object.entries(grupos)) {
    if (itens) await rodarGrupo(nome, itens);
  }

  // Conversa (contexto) - so roda no modo completo ou se pedir "conversa"
  if (!filtro || filtro === "conversa") {
    console.log(`\n${c.bold}${c.yellow}=== CONVERSA (teste de memoria/contexto) ===${c.reset}`);
    for (const turno of CONVERSA) {
      process.stdout.write(`${c.gray}"${turno.p}"${c.reset}\n   `);
      try {
        const r = await interpretarPergunta(turno.p, turno.historico || []);
        console.log(resumoInterpretacao(r));
        if (turno.nota) console.log(`   ${c.dim}nota: ${turno.nota}${c.reset}`);
      } catch (e) {
        console.log(`${c.red}ERRO: ${e.message}${c.reset}`);
      }
      await new Promise((s) => setTimeout(s, 400));
    }
  }

  console.log(`\n${c.green}${c.bold}Fim.${c.reset} Confira os [?] em vermelho e os blocos "so_os_nomes" e "conversa".`);
  console.log(`${c.dim}Dica: rode um grupo isolado com  node testar-interpretacao.js so_os_nomes${c.reset}`);
}

main();
