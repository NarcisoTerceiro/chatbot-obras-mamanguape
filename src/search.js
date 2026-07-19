// ============================================================
//  search.js
//  Encontra a(s) obra(s) que combinam com a pergunta do cidadao,
//  cruzando palavras-chave (bairro, rua, tipo, nome da obra).
//  Como os dados sao publicos, NAO filtramos por telefone -
//  filtramos pelo conteudo da pergunta (item 4.2 do documento).
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
  "fala", "ai", "ta", "the", "obra", "obras", "situacao", "andamento",
  "gostaria", "poderia", "sabe", "algum", "alguma", "voce", "tem", "ha",
]);

// Quebra a pergunta em palavras-chave uteis (>= 3 letras, sem stopwords).
function keywords(pergunta) {
  return normalize(pergunta)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Junta todos os valores de uma obra num unico texto pesquisavel.
function textoDaObra(obra) {
  return normalize(Object.values(obra).join(" "));
}

// Retorna as obras mais relevantes para a pergunta (ate `limite`).
export function buscarObras(pergunta, obras, limite = 3) {
  const termos = keywords(pergunta);
  if (termos.length === 0) return [];

  const pontuadas = obras
    .map((obra) => {
      const texto = textoDaObra(obra);
      let pontos = 0;
      for (const termo of termos) {
        if (texto.includes(termo)) pontos += 1;
      }
      return { obra, pontos };
    })
    .filter((x) => x.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos);

  return pontuadas.slice(0, limite).map((x) => x.obra);
}
