// ============================================================
// validacao_filtros.js - Etapa 3 do fluxo: CONFERIR o pedido antes de buscar.
//
// A IA interpreta a pergunta e escreve a SQL, mas ela pode inventar ou
// escrever errado um valor de filtro ("Joao", "centro ", "Em Andamento").
// Este modulo compara cada valor de filtro com os valores que EXISTEM de
// verdade no banco (vindos da planilha):
//   - igual depois de tirar acento/caixa/espaco -> troca pelo valor exato;
//   - parecido com UM valor real              -> corrige e avisa o usuario;
//   - parecido com varios ou com nenhum        -> pergunta de volta, sem chutar.
// Tambem devolve a lista de filtros aplicados para a resposta mostrar
// "Considerei: ..." (etapa 5), assim o usuario percebe na hora se algo saiu errado.
// ============================================================

// Colunas categoricas cujos valores sao conferidos. Colunas livres (objeto,
// observacoes) ficam de fora: nelas a busca parcial e esperada.
export const CAMPOS_VALIDADOS = [
  "tipo_negocio", "subtipo_negocio", "status", "status_original", "bairro",
  "engenheiro", "arquiteto", "fiscal", "responsavel", "empresa", "recurso",
  "tipo_recurso", "aba_origem",
];

const LIMITE_VALORES_POR_CAMPO = 1000;
const SIMILARIDADE_MINIMA = 0.72;
const MARGEM_EMPATE = 0.06;

export function normalizarValor(s = "") {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similaridade(a, b) {
  const max = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / max;
}

// Nota de 0 a 1 entre o termo digitado e um valor real. Considera o valor
// inteiro e tambem cada palavra/trecho, para "joao" casar com "João Silva".
export function notaParecido(termo, valorReal) {
  const t = normalizarValor(termo);
  const v = normalizarValor(valorReal);
  if (!t || !v) return 0;
  if (t === v) return 1;
  if (v.includes(t) && t.length >= 3) return 0.95;
  let melhor = similaridade(t, v);
  const palavrasV = v.split(" ");
  const n = t.split(" ").length;
  for (let i = 0; i + n <= palavrasV.length; i++) {
    melhor = Math.max(melhor, similaridade(t, palavrasV.slice(i, i + n).join(" ")) - 0.03);
  }
  return melhor;
}

// Carrega TODOS os valores distintos (ate o limite) de cada coluna categorica.
// Guarda no proprio contexto de schema, que ja tem cache no agente.
export async function carregarValoresReais(ctx, queryReadOnly) {
  if (ctx.valoresReais) return ctx.valoresReais;
  const nomes = new Set((ctx.colunas || []).map((c) => c.column_name));
  const valores = {};
  for (const campo of CAMPOS_VALIDADOS.filter((c) => nomes.has(c))) {
    try {
      const r = await queryReadOnly(
        `SELECT DISTINCT ${campo}::text AS valor FROM public.${ctx.relacao} ` +
        `WHERE ${campo} IS NOT NULL AND BTRIM(${campo}::text) <> '' ORDER BY valor LIMIT ${LIMITE_VALORES_POR_CAMPO}`
      );
      valores[campo] = (r.rows || []).map((x) => x.valor).filter(Boolean);
    } catch {
      // Sem a lista, o campo simplesmente nao e conferido.
    }
  }
  ctx.valoresReais = valores;
  return valores;
}

// Acha comparacoes literais simples sobre colunas categoricas:
//   campo = 'x' | campo ILIKE '%x%' | lower(campo) = 'x' | campo::text ILIKE 'x'
// Retorna as posicoes para permitir reescrever o literal.
export function extrairFiltros(sql = "", campos = CAMPOS_VALIDADOS) {
  const filtros = [];
  for (const campo of campos) {
    const rx = new RegExp(
      `(?<![\\w.>'"])((?:lower|upper|btrim|trim)\\s*\\(\\s*)?(?:[a-z_][\\w]*\\.)?"?${campo}"?(?:::text)?(\\s*\\))?(?:::text)?\\s*(=|<>|!=|not\\s+ilike|ilike|not\\s+like|like)\\s*'((?:[^']|'')*)'`,
      "gi"
    );
    let m;
    while ((m = rx.exec(sql))) {
      const literal = m[4].replace(/''/g, "'");
      const termo = literal.replace(/^%+|%+$/g, "").trim();
      if (!termo || /[%_]/.test(termo)) continue; // padrao complexo: nao mexe
      filtros.push({
        campo,
        operador: m[3].toLowerCase().replace(/\s+/g, " "),
        envolvido: !!m[1],
        literal,
        termo,
        inicioLiteral: m.index + m[0].lastIndexOf("'" + m[4] + "'"),
        tamanhoLiteral: m[4].length + 2,
      });
    }
  }
  return filtros.sort((a, b) => a.inicioLiteral - b.inicioLiteral);
}

function literalSQL(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function casaComBanco(filtro, lista) {
  const t = normalizarValor(filtro.termo);
  const parcial = filtro.operador.includes("like") && /^%|%$/.test(filtro.literal);
  return lista.some((v) => {
    const n = normalizarValor(v);
    return parcial ? n.includes(t) : n === t;
  });
}

// Confere cada filtro da SQL contra os valores reais.
// Retorna { sql, correcoes, duvida, filtros }.
export function conferirFiltros(sql = "", valoresReais = {}) {
  const campos = Object.keys(valoresReais).filter((c) => valoresReais[c]?.length);
  const filtros = extrairFiltros(sql, campos);
  const correcoes = [];
  const duvidas = [];
  const trocas = [];

  for (const f of filtros) {
    const lista = valoresReais[f.campo];
    const negativo = /^(<>|!=|not )/.test(f.operador);
    const t = normalizarValor(f.termo);

    // 1) Existe de fato (igual ignorando acento/caixa, ou contido se for busca parcial).
    if (casaComBanco(f, lista)) {
      // "=" exige texto identico no PostgreSQL: troca pelo valor gravado.
      if (f.operador === "=" && !f.envolvido) {
        const exato = lista.find((v) => normalizarValor(v) === t);
        if (exato && exato !== f.literal) trocas.push({ f, novo: literalSQL(exato) });
      } else if (f.operador.includes("like") && /[\u00c0-\u017f]/.test(f.termo) === false) {
        // ILIKE nao ignora acento: se o termo sem acento so existe com acento, usa o real.
        const real = lista.find((v) => normalizarValor(v).includes(t));
        const semAcentoExiste = lista.some((v) => v.toLowerCase().includes(f.termo.toLowerCase()));
        if (real && !semAcentoExiste) {
          const trecho = trechoOriginal(real, t);
          trocas.push({ f, novo: literalSQL(f.literal.replace(f.termo, trecho)) });
        }
      }
      continue;
    }

    // 2) Nao existe: procura parecidos.
    const candidatos = lista
      .map((v) => ({ v, nota: notaParecido(f.termo, v) }))
      .filter((c) => c.nota >= SIMILARIDADE_MINIMA)
      .sort((a, b) => b.nota - a.nota);

    const unico = candidatos.length === 1 ||
      (candidatos.length > 1 && candidatos[0].nota - candidatos[1].nota >= MARGEM_EMPATE);

    if (candidatos.length && unico && !negativo) {
      const real = candidatos[0].v;
      const novo = f.operador === "=" && !f.envolvido
        ? literalSQL(real)
        : literalSQL(f.literal.startsWith("%") || f.operador.includes("like") ? `%${real}%` : real);
      // lower(campo) = 'x' precisa continuar em minusculas.
      trocas.push({ f, novo: f.envolvido && f.operador === "=" ? literalSQL(real.toLowerCase()) : novo });
      correcoes.push({ campo: f.campo, de: f.termo, para: real });
      continue;
    }

    duvidas.push({
      campo: f.campo,
      termo: f.termo,
      opcoes: (candidatos.length ? candidatos.slice(0, 5).map((c) => c.v) : sugestoesProximas(f.termo, lista)),
      ambiguo: candidatos.length > 1,
    });
  }

  // Reescreve do fim para o comeco para nao deslocar posicoes.
  let novaSQL = sql;
  for (const { f, novo } of trocas.sort((a, b) => b.f.inicioLiteral - a.f.inicioLiteral)) {
    novaSQL = novaSQL.slice(0, f.inicioLiteral) + novo + novaSQL.slice(f.inicioLiteral + f.tamanhoLiteral);
  }

  return {
    sql: novaSQL,
    correcoes,
    duvida: duvidas.length ? duvidas : null,
    filtros: extrairFiltros(novaSQL, campos).map((f) => ({ campo: f.campo, operador: f.operador, valor: f.termo })),
  };
}

function trechoOriginal(real, termoNormalizado) {
  // Recupera o trecho com acento correspondente ao termo sem acento.
  const n = normalizarValor(real);
  const i = n.indexOf(termoNormalizado);
  if (i < 0) return real;
  // normalizarValor preserva o tamanho quando so remove acentos combinantes
  const base = real.normalize("NFC").replace(/\s+/g, " ").trim();
  return base.slice(i, i + termoNormalizado.length) || real;
}

function sugestoesProximas(termo, lista) {
  return lista
    .map((v) => ({ v, nota: notaParecido(termo, v) }))
    .sort((a, b) => b.nota - a.nota)
    .slice(0, 5)
    .filter((c) => c.nota > 0.4)
    .map((c) => c.v);
}

// Texto da pergunta de volta ao usuario (etapa 2: perguntar em vez de chutar).
export function textoDuvida(duvidas = [], rotulo = (c) => c) {
  const partes = duvidas.map((d) => {
    const nome = rotulo(d.campo).toLowerCase();
    if (d.ambiguo && d.opcoes.length) {
      return `Encontrei mais de um ${nome} parecido com "${d.termo}". Qual deles você quer dizer?\n` +
        d.opcoes.map((o) => `• ${o}`).join("\n");
    }
    if (d.opcoes.length) {
      return `Não encontrei ${nome} "${d.termo}" na planilha. Você quis dizer algum destes?\n` +
        d.opcoes.map((o) => `• ${o}`).join("\n");
    }
    return `Não encontrei ${nome} "${d.termo}" na planilha. Pode conferir como está escrito?`;
  });
  return partes.join("\n\n");
}

// Linha "Considerei: ..." mostrada no fim da resposta (etapa 5).
export function textoFiltrosUsados(filtros = [], correcoes = [], rotulo = (c) => c) {
  const vistos = new Set();
  const itens = [];
  for (const f of filtros) {
    const chave = `${f.campo}|${f.operador}|${normalizarValor(f.valor)}`;
    if (vistos.has(chave) || f.campo === "tipo_negocio" || f.campo === "aba_origem") continue;
    vistos.add(chave);
    const neg = /^(<>|!=|not )/.test(f.operador);
    const parcial = f.operador.includes("like");
    itens.push(`${rotulo(f.campo)} ${neg ? "diferente de" : parcial ? "contendo" : "="} ${f.valor}`);
  }
  const linhas = [];
  if (correcoes.length) {
    linhas.push("Entendi " + correcoes.map((c) => `"${c.de}" como "${c.para}"`).join("; "));
  }
  if (itens.length) linhas.push(`Considerei: ${itens.join("; ")}.`);
  return linhas.length ? `_${linhas.join(" · ")}_` : "";
}
