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
//  Tolerancia a erro de digitacao (ex.: cidadao escreve "Mariana
//  Costa" mas a base tem "Marina Costa"). Sem isso, um pequeno erro
//  de digitacao faz o sistema dizer "nao encontrei", quando na
//  verdade a obra existe.
// ------------------------------------------------------------
function distanciaEdicao(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let anterior = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const atual = [i];
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(
        atual[j - 1] + 1,      // insercao
        anterior[j] + 1,       // remocao
        anterior[j - 1] + custo // substituicao
      );
    }
    anterior = atual;
  }
  return anterior[n];
}

// Compara duas strings JA NORMALIZADAS tolerando pequenos erros de
// digitacao. Quanto maior o texto, mais erros tolera (2 letras erradas
// em "Mariana Costa" ainda deve casar com "Marina Costa").
function pareceMesmoTexto(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const maiorLen = Math.max(a.length, b.length);
  if (maiorLen < 4) return false; // texto curto demais: erro de 1 letra muda o sentido
  const tolerancia = maiorLen <= 8 ? 1 : maiorLen <= 14 ? 2 : 3;
  return distanciaEdicao(a, b) <= tolerancia;
}

// Compara nomes de PESSOA/EMPRESA que podem ter varias palavras (ex.:
// "Marina Costa" vs "Mariana Costa"): compara palavra a palavra, pois
// e mais preciso do que comparar a frase inteira.
function pareceMesmoNome(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const palavrasA = a.split(/\s+/).filter(Boolean);
  const palavrasB = b.split(/\s+/).filter(Boolean);
  if (palavrasA.length === 0 || palavrasB.length === 0) return false;
  // Toda palavra do lado menor precisa achar uma correspondente proxima
  // do outro lado (tolera "Mariana"~"Marina", mas nao "Carlos"~"Ricardo").
  const [menor, maior] = palavrasA.length <= palavrasB.length
    ? [palavrasA, palavrasB]
    : [palavrasB, palavrasA];
  return menor.every((p) => maior.some((q) => pareceMesmoTexto(p, q)));
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
      `O valor total é ${formatarMoeda(total)}` +
      (semValor > 0
        ? `, somando ${lista.length} obra(s) com valor informado (${semValor} sem valor cadastrado).`
        : `, somando ${lista.length} obra(s).`),
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
// Filtra as obras por um status pedido (ex.: "concluida"), tolerando sinonimos
// e acentos, reaproveitando a mesma logica do contar_por_status. Se o filtro
// nao casar com nenhum status, tenta casar com a ABA de origem. Se ainda assim
// nao achar nada, devolve a lista original (melhor somar tudo do que somar nada
// - e o caso raro de um filtro que nao corresponde a nada).
function filtrarPorStatus(obras, filtroStatus) {
  if (!filtroStatus) return obras;

  const alvo = normalize(filtroStatus);
  const sinonimos = {
    parada: "paralisada", parado: "paralisada", paradas: "paralisada",
    parados: "paralisada", pausada: "paralisada", suspensa: "paralisada",
    pronta: "concluida", prontas: "concluida", finalizada: "concluida",
    finalizado: "concluida", concluido: "concluida", concluidas: "concluida",
    concluidos: "concluida", terminada: "concluida", terminado: "concluida",
    entregue: "concluida", acabada: "concluida",
    andamento: "andamento", executando: "andamento", tocando: "andamento",
  };
  const alvos = new Set([alvo]);
  if (sinonimos[alvo]) alvos.add(sinonimos[alvo]);

  // 1) Tenta casar pelo campo STATUS de cada obra.
  //    Para tolerar genero (concluida/concluido) e plural, comparamos tambem
  //    pela RAIZ: cortamos as 2 ultimas letras de palavras longas (>=6), assim
  //    "conclu-ida" e "conclu-ido" viram a mesma raiz "conclu".
  const raiz = (t) => (t.length >= 6 ? t.slice(0, -2) : t);
  const alvosRaiz = new Set([...alvos].map(raiz));

  const porStatus = obras.filter((o) => {
    const campo = acharCampoStatus(o);
    const val = campo ? normalize(o[campo] || "") : "";
    if (!val) return false;
    for (const a of alvos) {
      if (val === a || val.startsWith(a) || val.includes(a) || a.includes(val)) {
        return true;
      }
    }
    // Casamento por raiz (ignora genero/plural): "concluido" ~ "concluida".
    const valRaiz = raiz(val);
    for (const ar of alvosRaiz) {
      if (ar.length >= 4 && (valRaiz.startsWith(ar) || val.startsWith(ar))) {
        return true;
      }
    }
    return false;
  });
  if (porStatus.length > 0) return porStatus;

  // 2) Nao casou por status: tenta pela ABA de origem (ex.: "licitacao").
  const limpaAba = (t) => normalize(t).replace(/[_\-]+/g, " ").trim();
  const alvoAba = limpaAba(filtroStatus);
  const porAba = obras.filter((o) => {
    const aba = limpaAba(o._aba || "");
    return aba && (aba.includes(alvoAba) || alvoAba.includes(aba));
  });
  if (porAba.length > 0) return porAba;

  // 3) Nao achou nada: devolve tudo (nao trava a operacao).
  return obras;
}

export function executarAgregacao(operacao, obras, opcoes = {}) {
  if (!Array.isArray(obras) || obras.length === 0) return null;

  const pista = opcoes.pista_valor || ""; // ex.: "inicial", "executado", "pago"
  const filtroStatus = opcoes.filtro_status || "";

  // CORRECAO: quando ha filtro_status, as operacoes de valor (soma, media,
  // maior, menor) devem incidir SO nas obras daquele status - nao na base
  // inteira. Antes, "valor das concluidas" somava as 66 obras porque o filtro
  // era ignorado aqui. Agora filtramos primeiro.
  const alvo = filtroStatus ? filtrarPorStatus(obras, filtroStatus) : obras;

  switch (operacao) {
    case "maior_valor":
      return agregarExtremo(alvo, true, pista);
    case "menor_valor":
      return agregarExtremo(alvo, false, pista);
    case "soma_valor":
      return agregarSoma(alvo, pista);
    case "media_valor":
      return agregarMedia(alvo, pista);
    case "contar_por_status":
      return agregarContarPorStatus(obras, filtroStatus);
    case "contar_total":
      return agregarContarTotal(alvo);
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

// Descreve os FILTROS aplicados em portugues natural, para o texto fixo
// ("Encontrei N obra(s)...") citar de fato o que a pessoa perguntou -
// engenheiro, status, bairro etc. - em vez de um texto generico igual pra
// qualquer pergunta.
function descreverFiltros(filtros) {
  if (!Array.isArray(filtros) || filtros.length === 0) return "";
  const partes = filtros.map((f) => {
    const campo = normalize(f.campo || "");
    const valorBruto = Array.isArray(f.valor) ? f.valor.join(" a ") : f.valor;
    if (campo.includes("engenheiro") || campo.includes("arquiteto") || campo.includes("responsavel")) {
      return `do engenheiro ${valorBruto}`;
    }
    if (campo.includes("status") || campo.includes("situa")) {
      return `com status ${valorBruto}`;
    }
    if (campo.includes("bairro")) {
      return `no bairro ${valorBruto}`;
    }
    if (campo.includes("empresa")) {
      return `da empresa ${valorBruto}`;
    }
    if (campo.includes("valor") || campo.includes("investimento") || campo.includes("custo")) {
      const op = normalize(f.operador || "");
      const n = parseNumero(valorBruto);
      if (n != null && op.includes("maior")) return `com valor acima de ${formatarMoeda(n)}`;
      if (n != null && op.includes("menor")) return `com valor abaixo de ${formatarMoeda(n)}`;
      return `com valor ${valorBruto}`;
    }
    return `com ${f.campo} ${valorBruto}`;
  });
  return " " + partes.join(" e ");
}

// Aplica UM filtro a uma obra. Retorna true se a obra passa.
function passaFiltro(obra, filtro) {
  const col = acharColuna(obra, filtro.campo);
  // Se a obra NAO tem essa coluna, ela nao pode satisfazer o filtro: nao passa.
  // (Ex.: filtrar por EMPRESA - obras de abas sem coluna de empresa ficam fora.)
  if (!col) return false;
  const bruto = (obra[col] || "").toString();
  // Celula vazia tambem nao satisfaz um filtro sobre aquele campo.
  if (!bruto.trim()) return false;
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
  if (op.includes("contem")) return vObra.includes(vAlvo) || pareceMesmoNome(vObra, vAlvo);
  // "igual" (padrao): tolera conter (bairro/status escritos com variacao) e
  // tolera pequeno erro de digitacao no nome (ex.: engenheiro, empresa).
  return vObra === vAlvo || vObra.includes(vAlvo) || vAlvo.includes(vObra) ||
    pareceMesmoNome(vObra, vAlvo);
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
  if (tipo.includes("contar") && !tipo.includes("contar_por") && !ag.campo) {
    return {
      fatos: `Encontrei ${filtradas.length} obra(s)${descreverFiltros(filtros)}.`,
      obras: filtradas,
      listaCompleta: true,
    };
  }
  if (tipo.includes("somar") || tipo.includes("soma")) {
    const lista = valoresNum();
    if (lista.length === 0) return null;
    const total = lista.reduce((a, x) => a + x.valor, 0);
    return {
      fatos: `O valor total é ${formatarMoeda(total)}, somando ${lista.length} obra(s).`,
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
  // "top N" / ranking: as N obras de maior (ou menor) valor. O N vem em ag.n.
  if (tipo.includes("top") || tipo.includes("ranking") || tipo.includes("maiores") || tipo.includes("menores")) {
    const n = Math.max(1, parseInt(ag.n, 10) || 3);
    const desc = !tipo.includes("menores");
    const lista = valoresNum().sort((a, b) => (desc ? b.valor - a.valor : a.valor - b.valor));
    if (lista.length === 0) return null;
    const topo = lista.slice(0, n);
    const linhas = topo.map((x, i) => {
      const nome = x.obra[acharColuna(x.obra, "nome")] || "Obra";
      return `${i + 1}. *${nome}* — ${formatarMoeda(x.valor)}`;
    });
    return {
      fatos: `As ${topo.length} obras de ${desc ? "maior" : "menor"} valor:`,
      obras: topo.map((x) => x.obra),
      listaCampo: linhas,
      listaCompleta: true,
    };
  }
  // Ordinal: "segunda maior", "terceira menor" - ag.posicao = 2, 3...
  if (tipo.includes("ordinal")) {
    const pos = Math.max(1, parseInt(ag.posicao, 10) || 2);
    const desc = !tipo.includes("menor");
    const lista = valoresNum().sort((a, b) => (desc ? b.valor - a.valor : a.valor - b.valor));
    if (lista.length < pos) return null;
    const alvo = lista[pos - 1];
    const nome = alvo.obra[acharColuna(alvo.obra, "nome")] || "Obra";
    return {
      fatos: `A ${pos}ª obra de ${desc ? "maior" : "menor"} valor e "${nome}", com ${formatarMoeda(alvo.valor)}.`,
      obras: [alvo.obra],
      listaCompleta: true,
    };
  }
  // Contar por GRUPO: "quantas obras por bairro", "por status". ag.campo = grupo.
  // Tambem cobre "qual X tem MAIS/MENOS obras" (ex.: "qual engenheiro tem mais
  // obras?") atraves de ag.top: como ENGENHEIRO/BAIRRO/EMPRESA nao sao numeros,
  // essa pergunta NAO e um "top" de valor - e uma contagem por grupo onde so
  // queremos o(s) primeiro(s) do ranking.
  if ((tipo.includes("contar_por") || tipo.includes("agrupar")) && ag.campo) {
    const grupos = new Map();
    for (const o of filtradas) {
      const col = acharColuna(o, ag.campo);
      const chave = (col && o[col] && o[col].toString().trim()) || "(não informado)";
      grupos.set(chave, (grupos.get(chave) || 0) + 1);
    }
    const desc = normalize(ag.ordem || "desc") !== "asc";
    const ordenado = [...grupos.entries()].sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));

    const topN = parseInt(ag.top, 10);
    if (topN > 0) {
      const topo = ordenado.slice(0, topN);
      const rotulo = desc ? "mais" : "menos";
      if (topo.length === 1) {
        const [nome, qtd] = topo[0];
        return {
          fatos: `Quem ${rotulo} aparece em *${ag.campo}* é "${nome}", com ${qtd} obra(s).`,
          obras: filtradas.filter((o) => {
            const col = acharColuna(o, ag.campo);
            return col && (o[col] || "").toString().trim() === nome;
          }),
          listaCompleta: true,
        };
      }
      const linhas = topo.map(([k, v], i) => `${i + 1}. *${k}* — ${v} obra(s)`);
      return {
        fatos: `Ranking (${rotulo} obras) por ${ag.campo}:`,
        obras: filtradas,
        listaCampo: linhas,
        listaCompleta: true,
      };
    }

    const linhas = ordenado.map(([k, v]) => `• *${k}*: ${v} obra(s)`);
    return {
      fatos: `Distribuicao por ${ag.campo}:`,
      obras: filtradas,
      listaCampo: linhas,
      listaCompleta: true,
    };
  }
  // "listar" com um CAMPO especifico: mostra o valor desse campo por obra.
  // Ex.: "nome dos engenheiros de cada obra" -> obra + engenheiro.
  if (tipo.includes("listar") && ag.campo) {
    const colCampoRef = filtradas.length ? acharColuna(filtradas[0], ag.campo) : null;
    const colNomeRef = filtradas.length ? acharColuna(filtradas[0], "nome") : null;

    // Se o campo pedido E o proprio nome da obra, nao faz sentido "obra: nome"
    // (ficaria repetido). Nesse caso, so lista os nomes das obras.
    const campoEhNome = colCampoRef && colCampoRef === colNomeRef;

    const linhas = [];
    for (const o of filtradas) {
      const colNome = acharColuna(o, "nome");
      const colCampo = acharColuna(o, ag.campo);
      const nomeObra = (colNome && o[colNome]) || "Obra";
      if (campoEhNome) {
        linhas.push(`• ${nomeObra}`);
      } else {
        const valorCampo = (colCampo && o[colCampo]) || "não informado";
        linhas.push(`• *${nomeObra}*: ${valorCampo}`);
      }
    }
    return {
      fatos: `Encontrei ${filtradas.length} obra(s):`,
      obras: filtradas,
      listaCampo: linhas,
      listaCompleta: true,
    };
  }

  // "listar" (padrao): so devolve as obras filtradas
  return {
    fatos: `Encontrei ${filtradas.length} obra(s)${descreverFiltros(filtros)}.`,
    obras: filtradas,
    listaCompleta: true,
  };
}