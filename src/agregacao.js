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
function acharCampoValor(obra) {
  const chaves = Object.keys(obra).filter((k) => k !== "_aba");
  const comValor = chaves.filter((k) => normalize(k).includes("valor"));
  if (comValor.length === 0) return null;
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
function obrasComValor(obras) {
  const lista = [];
  for (const obra of obras) {
    const campo = acharCampoValor(obra);
    if (!campo) continue;
    const n = parseNumero(obra[campo]);
    if (n == null) continue;
    lista.push({ obra, valor: n });
  }
  return lista;
}

function agregarExtremo(obras, maior) {
  const lista = obrasComValor(obras);
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

function agregarSoma(obras) {
  const lista = obrasComValor(obras);
  if (lista.length === 0) return null;

  const total = lista.reduce((acc, x) => acc + x.valor, 0);
  const semValor = obras.length - lista.length;

  return {
    fatos:
      `A soma dos valores e ${formatarMoeda(total)}, ` +
      `considerando ${lista.length} obra(s) com valor informado` +
      (semValor > 0 ? ` (${semValor} obra(s) estao sem valor na base).` : ".") ,
    obras: lista.slice(0, 3).map((x) => x.obra),
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

    let achou = null;
    for (const [chave, qtd] of contagem) {
      const n = normalize(chave);
      for (const a of alvos) {
        if (n.includes(a) || a.includes(n)) {
          achou = { chave, qtd };
          break;
        }
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

  switch (operacao) {
    case "maior_valor":
      return agregarExtremo(obras, true);
    case "menor_valor":
      return agregarExtremo(obras, false);
    case "soma_valor":
      return agregarSoma(obras);
    case "contar_por_status":
      return agregarContarPorStatus(obras, opcoes.filtro_status || "");
    case "contar_total":
      return agregarContarTotal(obras);
    default:
      return null;
  }
}