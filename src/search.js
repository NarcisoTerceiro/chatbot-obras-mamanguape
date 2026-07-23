// ============================================================
//  search.js
//  O SISTEMA (nao a IA) e quem busca na planilha. Duas formas:
//
//  1) buscarObrasPorTermos: usa uma lista de termos ja prontos
//     (normalmente vinda da interpretacao da IA em groq.js).
//  2) buscarObras: extrai palavras-chave direto do texto cru da
//     pergunta (respaldo, caso a IA falhe ou nao esteja disponivel).
// ============================================================

// Remove acentos e deixa minusculo, para comparar sem erro.
function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Palavras genericas que nao ajudam a identificar a obra.
const STOPWORDS = new Set([
  "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no",
  "na", "nos", "nas", "um", "uma", "que", "qual", "como", "esta", "estar",
  "para", "por", "com", "sobre", "favor", "quero", "saber", "me", "diz",
  "fala", "ai", "ta", "the", "obra", "obras",
  "gostaria", "poderia", "sabe", "algum", "alguma", "voce", "tem", "ha",
]);

// ATENCAO: palavras como "andamento", "paralisada", "concluida" e "situacao"
// NAO entram na lista acima de proposito - elas sao VALORES da coluna STATUS
// da planilha. Se virarem stopword, perguntas como "quais obras estao em
// andamento?" perdem justamente a palavra que identifica o que se procura.

// Quebra um texto em palavras-chave uteis (>= 3 letras, sem stopwords).
function keywords(texto) {
  return normalize(texto)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Junta todos os valores de uma obra num unico texto pesquisavel.
function textoDaObra(obra) {
  return normalize(Object.values(obra).join(" "));
}

// Verifica se um termo aparece no texto da obra, tolerando plural e pequenas
// variacoes de terminacao. Sem isso, "paralisadas" (plural, como o cidadao
// escreve) nao casaria com "Paralisada" (singular, como esta na planilha).
function casaTermo(texto, termo) {
  if (texto.includes(termo)) return true;
  // Plural simples: "paralisadas" -> "paralisada"
  if (termo.endsWith("s") && texto.includes(termo.slice(0, -1))) return true;
  // Variacao de genero/terminacao: "concluidos" -> "concluid"
  if (termo.length >= 7 && texto.includes(termo.slice(0, -2))) return true;
  return false;
}

// Pontua e ordena as obras de acordo com uma lista de termos ja prontos.
function pontuarObras(termos, obras, limite) {
  if (!termos || termos.length === 0) return [];

  const termosNormalizados = termos
    .flatMap((t) => keywords(t)) // cada termo pode ter mais de uma palavra
    .filter(Boolean);

  if (termosNormalizados.length === 0) return [];

  const pontuadas = obras
    .map((obra) => {
      const texto = textoDaObra(obra);
      let pontos = 0;
      for (const termo of termosNormalizados) {
        if (casaTermo(texto, termo)) pontos += 1;
      }
      return { obra, pontos };
    })
    .filter((x) => x.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos);

  return pontuadas.slice(0, limite).map((x) => x.obra);
}

// -------- 1) Busca usando termos ja prontos (vindos da IA) --------
export function buscarObrasPorTermos(termos, obras, limite = 5) {
  return pontuarObras(termos, obras, limite);
}

// -------- 2) Busca direto pelo texto cru da pergunta (respaldo) --------
export function buscarObras(pergunta, obras, limite = 5) {
  const termos = keywords(pergunta);
  return pontuarObras(termos, obras, limite);
}