// ============================================================
//  agregacao.js
//  MELHORIA 2 - Perguntas de comparacao e agregacao.
//
//  REGRA DE OURO: todo calculo aqui e feito em JavaScript puro.
//  A IA NUNCA faz conta - ela so identifica QUE tipo de agregacao
//  o cidadao pediu ("qual a maior obra?", "quantas paralisadas?").
//  Quem soma, ordena e conta e o SISTEMA, para evitar erro de
//  "matematica alucinada" que modelos de linguagem cometem.
//
//  O resultado volta como um texto de FATOS ja calculado, que a IA
//  deve reproduzir exatamente, sem recalcular nada.
// ============================================================

// Remove acentos e deixa minusculo (mesma logica do search.js).
function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ------------------------------------------------------------
//  Leitura de numeros no formato brasileiro
//  Ex.: "R$ 1.234.567,89" -> 1234567.89
// ------------------------------------------------------------
export function parseNumero(valor) {
  if (valor == null) return null;
  let s = valor.toString().trim();
  if (!s) return null;

  // Mantem so digitos, ponto, virgula e sinal negativo.
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return null;

  // Formato BR: o ultimo separador decimal e a virgula.
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Sem virgula: pontos podem ser separador de milhar (1.234.567).
    const partes = s.split(".");
    if (partes.length > 2) s = partes.join("");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Formata em reais para exibir ao cidadao.
export function formatarMoeda(n) {
  try {
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 2,
    });
  } catch {
    return `R$ ${n.toFixed(2)}`;
  }
}

// ------------------------------------------------------------
//  Descoberta de colunas (a planilha pode ter nomes diferentes)
// ------------------------------------------------------------

// Acha a coluna que parece ser o VALOR da obra. Prefere "valor total".
function acharCampoValor(obra, pista = "") {
  const chaves = Object.keys(obra).filter((k) => k !== "_aba");
  const comValor = chaves.filter((k) => {
    const n = normalize(k);
    return n.includes("valor") || n.includes("investimento") || n.includes("custo");
  });
  if (comValor.length === 0) return null;

  const p = normalize(pista);
  // Se a pergunta deu uma pista ("inicial", "executado", "pago", "aditivo"),
  // tenta achar a coluna que corresponde a ela.
  if (p) {
    const alvo = comValor.find((k) => normalize(k).includes(p));
    if (alvo) return alvo;
  }
  // Padrao: prefere "valor total da obra" (o mais completo).
  const total = comValor.find((k) => normalize(k).includes("total"));
  return total || comValor[0];
}

// Acha a coluna de STATUS / SITUACAO.
function acharCampoStatus(obra) {
  const chaves = Object.keys(obra).filter((k) => k !== "_aba");
  return (
    chaves.find((k) => {
      const n = normalize(k);
      return n.includes("status") || n.includes("situa");
    }) || null
  );
}

// Acha a coluna que serve de nome/objeto da obra.
function acharCampoNome(obra) {
  const candidatos = ["OBJETO DA OBRA", "OBJETO", "NOME DA OBRA", "NOME", "OBRA", "RUA"];
  for (const c of candidatos) if (obra[c]) return c;
  const chaves = Object.keys(obra).filter((k) => k !== "_aba");
  return (
    chaves.find((k) => {
      const n = normalize(k);
      return n.includes("objeto") || n.includes("nome") || n.includes("obra") ||
             n.includes("rua") || n.includes("logradouro");
    }) || chaves[0] || null
  );
}

function nomeDaObra(obra) {
  const campo = acharCampoNome(obra);
  return (campo && obra[campo]) || "obra sem nome cadastrado";
}

// ------------------------------------------------------------
//  Operacoes de agregacao (JavaScript puro)
// ------------------------------------------------------------

// Monta a lista de obras que tem valor numerico legivel.
function obrasComValor(obras, pista = "") {
  const lista = [];
  for (const obra of obras) {
    const campo = acharCampoValor(obra, pista);
    if (!campo) continue;
    const n = parseNumero(obra[campo]);
    if (n == null) continue;
    lista.push({ obra, valor: n });
  }
  return lista;
}

function agregarExtremo(obras, maior, pista = "") {
  const lista = obrasComValor(obras, pista);
  if (lista.length === 0) return null;

  lista.sort((a, b) => (maior ? b.valor - a.valor : a.valor - b.valor));
  const topo = lista[0];
  const rotulo = maior ? "maior" : "menor";

  return {
    fatos:
      `A obra de ${rotulo} valor e "${nomeDaObra(topo.obra)}", ` +
      `no valor de ${formatarMoeda(topo.valor)}. ` +
      `(Calculo feito sobre ${lista.length} obra(s) com valor informado.)`,
    obras: lista.slice(0, 3).map((x) => x.obra),
  };
}

function agregarSoma(obras, pista = "") {
  const lista = obrasComValor(obras, pista);
  if (lista.length === 0) return null;

  const total = lista.reduce((acc, x) => acc + x.valor, 0);
  const semValor = obras.length - lista.length;

  return {
    fatos:
      `A soma dos valores e ${formatarMoeda(total)}, ` +
      `considerando ${lista.length} obra(s) com valor informado` +
      (semValor > 0 ? ` (${semValor} obra(s) estao sem valor na base).` : ".") ,
    // devolve TODAS as obras somadas (ordenadas por valor), para listar completo
    obras: lista.sort((a, b) => b.valor - a.valor).map((x) => x.obra),
    listaCompleta: true,
  };
}

function agregarMedia(obras, pista = "") {
  const lista = obrasComValor(obras, pista);
  if (lista.length === 0) return null;

  const total = lista.reduce((acc, x) => acc + x.valor, 0);
  const media = total / lista.length;

  return {
    fatos:
      `A media de valor e ${formatarMoeda(media)}, ` +
      `calculada sobre ${lista.length} obra(s) com valor informado ` +
      `(soma total de ${formatarMoeda(total)}).`,
    obras: lista.sort((a, b) => b.valor - a.valor).map((x) => x.obra),
    listaCompleta: true,
  };
}

function agregarContarPorStatus(obras, filtroStatus) {
  // Conta quantas obras existem em cada status.
  const contagem = new Map();
  let semStatus = 0;

  for (const obra of obras) {
    const campo = acharCampoStatus(obra);
    const valor = campo ? (obra[campo] || "").trim() : "";
    if (!valor) {
      semStatus += 1;
      continue;
    }
    contagem.set(valor, (contagem.get(valor) || 0) + 1);
  }

  if (contagem.size === 0) return null;

  // Se a pessoa perguntou por um status especifico, responde so ele.
  if (filtroStatus) {
    const alvo = normalize(filtroStatus);
    // Sinonimos comuns que o cidadao usa vs. o que costuma estar na planilha.
    const sinonimos = {
      parada: "paralisada", parado: "paralisada", paradas: "paralisada",
      parados: "paralisada", pausada: "paralisada", suspensa: "paralisada",
      pronta: "concluida", prontas: "concluida", finalizada: "concluida",
      terminada: "concluida", entregue: "concluida",
      andamento: "andamento", executando: "andamento", tocando: "andamento",
    };
    const alvos = new Set([alvo]);
    if (sinonimos[alvo]) alvos.add(sinonimos[alvo]);

    // Prioridade de casamento: 1) EXATO ("em andamento" == "Em andamento"),
    // 2) o status COMECA com o alvo, 3) o status CONTEM o alvo. Sem isso,
    // "em andamento" casaria com "Habilitacao em andamento" por vir primeiro.
    let achou = null;
    for (const nivel of ["exato", "comeca", "contem"]) {
      for (const [chave, qtd] of contagem) {
        const n = normalize(chave);
        for (const a of alvos) {
          const bate =
            nivel === "exato" ? n === a :
            nivel === "comeca" ? n.startsWith(a) :
            (n.includes(a) || a.includes(n));
          if (bate) {
            achou = { chave, qtd };
            break;
          }
        }
        if (achou) break;
      }
      if (achou) break;
    }
    if (achou) {
      // Devolve TODAS as obras daquele status (nao so 3), para que o sistema
      // possa listar por completo se a pessoa pedir.
      const doStatus = obras.filter((o) => {
        const campo = acharCampoStatus(o);
        return campo && (o[campo] || "").trim() === achou.chave;
      });
      return {
        fatos: `Existem ${achou.qtd} obra(s) com status "${achou.chave}".`,
        obras: doStatus,
        // marca que "obras" e a lista COMPLETA do filtro (nao apenas exemplos)
        listaCompleta: true,
      };
    }
    // O filtro nao casou com nenhum STATUS. Antes de dizer que nao existe,
    // tenta casar com a ABA de origem (_aba): "licitacao" -> EM_LICITACAO,
    // "projeto" -> EM_PROJETO, "pavimentacao" -> PAVIMENTACAO etc.
    // IMPORTANTE: nomes de aba usam underline ("EM_LICITACAO") e a pessoa fala
    // com espaco ("em licitacao") - normalizamos os dois para espacos.
    const limpaAba = (t) => normalize(t).replace(/[_\-]+/g, " ").trim();
    const alvoAba = limpaAba(filtroStatus);
    const daAba = obras.filter((o) => {
      const aba = limpaAba(o._aba || "");
      return aba.includes(alvoAba) || alvoAba.includes(aba);
    });
    if (daAba.length > 0) {
      return {
        fatos: `Existem ${daAba.length} obra(s) na aba "${daAba[0]._aba}".`,
        obras: daAba,
        listaCompleta: true,
      };
    }

    return {
      fatos:
        `Nao existe nenhuma obra com o status "${filtroStatus}" na base. ` +
        `Os status cadastrados sao: ` +
        [...contagem.entries()].map(([k, q]) => `${k} (${q})`).join(", ") + ".",
      obras: [],
    };
  }

  // Sem filtro: devolve a contagem completa por status.
  const linhas = [...contagem.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, q]) => `${k}: ${q}`)
    .join("; ");

  return {
    fatos:
      `Total de ${obras.length} obra(s). Contagem por status -> ${linhas}` +
      (semStatus > 0 ? `; sem status informado: ${semStatus}.` : "."),
    obras: [],
  };
}

function agregarContarTotal(obras) {
  return {
    fatos: `Existem ${obras.length} obra(s) cadastrada(s) na base.`,
    obras: [],
  };
}

// ------------------------------------------------------------
//  Ponto de entrada: executa a operacao pedida.
//  Retorna { fatos, obras } ou null se nao for possivel calcular.
// ------------------------------------------------------------
export function executarAgregacao(operacao, obras, opcoes = {}) {
  if (!Array.isArray(obras) || obras.length === 0) return null;

  const pista = opcoes.pista_valor || ""; // ex.: "inicial", "executado", "pago"

  switch (operacao) {
    case "maior_valor":
      return agregarExtremo(obras, true, pista);
    case "menor_valor":
      return agregarExtremo(obras, false, pista);
    case "soma_valor":
      return agregarSoma(obras, pista);
    case "media_valor":
      return agregarMedia(obras, pista);
    case "contar_por_status":
      return agregarContarPorStatus(obras, opcoes.filtro_status || "");
    case "contar_total":
      return agregarContarTotal(obras);
    default:
      return null;
  }
}


// ============================================================
//  DSL GENERICO (Opcao A do guia)
//  A IA descreve uma "receita": { filtros: [...], agregacao: {...} }.
//  Aqui o SISTEMA executa essa receita sobre qualquer coluna, de forma
//  determinista. A IA nunca calcula - so descreve o que quer.
// ============================================================

// Acha o nome REAL da coluna na obra a partir de um nome aproximado que a IA
// mandou (tolera acento, maiuscula, e nome parcial). Ex.: "bairro" -> "BAIRRO";
// "valor" -> "VALOR TOTAL DA OBRA".
function acharColuna(obra, nomeAprox) {
  const alvo = normalize(nomeAprox);
  if (!alvo) return null;
  const chaves = Object.keys(obra).filter((k) => k !== "_aba");
  // 1) match exato normalizado
  let c = chaves.find((k) => normalize(k) === alvo);
  if (c) return c;
  // 2) a coluna contem o alvo (ou vice-versa)
  c = chaves.find((k) => {
    const n = normalize(k);
    return n.includes(alvo) || alvo.includes(n);
  });
  if (c) return c;
  // 3) apelidos comuns
  const apelidos = {
    valor: ["valor total da obra", "valor"],
    bairro: ["bairro"],
    status: ["status", "situacao"],
    empresa: ["empresa"],
    engenheiro: ["engenheiro", "arquiteto", "responsavel"],
    nome: ["objeto da obra", "objeto", "rua"],
  };
  for (const [ap, nomes] of Object.entries(apelidos)) {
    if (alvo.includes(ap)) {
      for (const nm of nomes) {
        c = chaves.find((k) => normalize(k).includes(nm));
        if (c) return c;
      }
    }
  }
  return null;
}

// Aplica UM filtro a uma obra. Retorna true se a obra passa.
function passaFiltro(obra, filtro) {
  const col = acharColuna(obra, filtro.campo);
  if (!col) return true; // campo inexistente -> filtro ignorado (nao quebra)
  const bruto = (obra[col] || "").toString();
  const op = normalize(filtro.operador || "igual");

  // Comparacoes numericas
  const nums = ["maior_que", "menor_que", "entre", "maior que", "menor que"];
  if (nums.some((x) => op.includes(x.replace(" ", "_")) || op.includes(x))) {
    const nObra = parseNumero(bruto);
    if (nObra == null) return false;
    if (op.includes("maior")) return nObra > parseNumero(filtro.valor);
    if (op.includes("menor")) return nObra < parseNumero(filtro.valor);
    if (op.includes("entre") && Array.isArray(filtro.valor)) {
      return nObra >= parseNumero(filtro.valor[0]) && nObra <= parseNumero(filtro.valor[1]);
    }
    return false;
  }

  // Comparacoes de texto
  const vObra = normalize(bruto);
  const vAlvo = normalize(Array.isArray(filtro.valor) ? filtro.valor[0] : filtro.valor);
  if (op.includes("diferente")) return vObra !== vAlvo && !vObra.includes(vAlvo);
  if (op.includes("contem")) return vObra.includes(vAlvo);
  // "igual" (padrao): tolera conter, para bairro/status escritos com variacao
  return vObra === vAlvo || vObra.includes(vAlvo) || vAlvo.includes(vObra);
}

// Executa uma RECEITA { filtros, agregacao } sobre a lista de obras.
// Retorna { fatos, obras, listaCompleta } ou null se nao der para calcular.
export function executarReceita(receita, obras) {
  if (!receita || !Array.isArray(obras) || obras.length === 0) return null;

  // 1) aplica todos os filtros
  const filtros = Array.isArray(receita.filtros) ? receita.filtros : [];
  let filtradas = obras.filter((o) => filtros.every((f) => passaFiltro(o, f)));

  const ag = receita.agregacao || { tipo: "listar" };
  const tipo = normalize(ag.tipo || "listar");
  const campo = ag.campo || "VALOR TOTAL DA OBRA";

  // helper: valores numericos de um campo
  const valoresNum = () => {
    const out = [];
    for (const o of filtradas) {
      const col = acharColuna(o, campo);
      const n = col ? parseNumero(o[col]) : null;
      if (n != null) out.push({ obra: o, valor: n });
    }
    return out;
  };

  // 2) aplica a agregacao pedida
  if (tipo.includes("contar")) {
    return {
      fatos: `Encontrei ${filtradas.length} obra(s) com esse criterio.`,
      obras: filtradas,
      listaCompleta: true,
    };
  }
  if (tipo.includes("somar") || tipo.includes("soma")) {
    const lista = valoresNum();
    if (lista.length === 0) return null;
    const total = lista.reduce((a, x) => a + x.valor, 0);
    return {
      fatos: `A soma e ${formatarMoeda(total)}, considerando ${lista.length} obra(s) com valor informado.`,
      obras: lista.sort((a, b) => b.valor - a.valor).map((x) => x.obra),
      listaCompleta: true,
    };
  }
  if (tipo.includes("media")) {
    const lista = valoresNum();
    if (lista.length === 0) return null;
    const total = lista.reduce((a, x) => a + x.valor, 0);
    return {
      fatos: `A media e ${formatarMoeda(total / lista.length)}, sobre ${lista.length} obra(s) com valor informado.`,
      obras: lista.sort((a, b) => b.valor - a.valor).map((x) => x.obra),
      listaCompleta: true,
    };
  }
  if (tipo.includes("maior")) {
    const lista = valoresNum().sort((a, b) => b.valor - a.valor);
    if (lista.length === 0) return null;
    return {
      fatos: `A de maior valor e "${lista[0].obra[acharColuna(lista[0].obra, "nome")] || "obra"}", com ${formatarMoeda(lista[0].valor)}.`,
      obras: lista.map((x) => x.obra),
      listaCompleta: true,
    };
  }
  if (tipo.includes("menor")) {
    const lista = valoresNum().sort((a, b) => a.valor - b.valor);
    if (lista.length === 0) return null;
    return {
      fatos: `A de menor valor e "${lista[0].obra[acharColuna(lista[0].obra, "nome")] || "obra"}", com ${formatarMoeda(lista[0].valor)}.`,
      obras: lista.map((x) => x.obra),
      listaCompleta: true,
    };
  }
  // "listar" com um CAMPO especifico: mostra o valor desse campo por obra.
  // Ex.: "nome dos engenheiros de cada obra" -> obra + engenheiro.
  if (tipo.includes("listar") && ag.campo) {
    const linhas = [];
    for (const o of filtradas) {
      const colNome = acharColuna(o, "nome");
      const colCampo = acharColuna(o, ag.campo);
      const nomeObra = (colNome && o[colNome]) || "Obra";
      const valorCampo = (colCampo && o[colCampo]) || "nao informado";
      linhas.push(`• *${nomeObra}*: ${valorCampo}`);
    }
    return {
      fatos: `Aqui esta o que voce pediu, para ${filtradas.length} obra(s):`,
      obras: filtradas,
      listaCampo: linhas, // linhas ja formatadas (obra: valor do campo)
      listaCompleta: true,
    };
  }

  // "listar" (padrao): so devolve as obras filtradas
  return {
    fatos: `Encontrei ${filtradas.length} obra(s) com esse criterio.`,
    obras: filtradas,
    listaCompleta: true,
  };
}
