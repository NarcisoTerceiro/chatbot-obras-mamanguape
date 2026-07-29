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

// Extrai o NOME/objeto da obra (o campo que melhor a identifica). Bater no
// nome vale muito mais do que bater em qualquer outra coluna.
function nomeDaObra(obra) {
  const candidatos = [
    "OBJETO DA OBRA", "OBJETO", "NOME DA OBRA", "NOME", "OBRA",
    "RUA", "LOGRADOURO", "ENDEREÇO", "ENDERECO",
  ];
  for (const c of candidatos) if (obra[c]) return normalize(obra[c]);
  for (const [k, v] of Object.entries(obra)) {
    if (k === "_aba" || !v) continue;
    const n = k.toLowerCase();
    if (n.includes("objeto") || n.includes("obra") || n.includes("rua") || n.includes("nome")) {
      return normalize(v);
    }
  }
  return "";
}

// Verifica se um termo aparece no texto da obra COMO PALAVRA (nao como pedaco
// de outra palavra). Sem o limite de palavra, "UBS" casaria com "pUBlico" e
// "ilUMinacao publica", trazendo obras que nao tem nada a ver. Usamos limites
// de palavra (\b) e toleramos plural/terminacao so em palavras mais longas.
function casaTermo(texto, termo) {
  if (!termo) return false;
  // Escapa caracteres especiais para montar a regex com seguranca.
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Casa o termo inteiro como palavra: \bTERMO\b
  if (new RegExp(`\\b${esc(termo)}\\b`).test(texto)) return true;

  // Tolerancia de terminacao SO para palavras longas (>= 5 letras), para nao
  // afrouxar siglas e termos curtos como "UBS", "rua", "led".
  if (termo.length >= 5) {
    // Plural simples: "paralisadas" -> casa "paralisada"
    if (termo.endsWith("s") && new RegExp(`\\b${esc(termo.slice(0, -1))}`).test(texto)) {
      return true;
    }
    // Variacao de genero/terminacao: "concluidos" -> casa "concluid..."
    if (termo.length >= 7 && new RegExp(`\\b${esc(termo.slice(0, -2))}`).test(texto)) {
      return true;
    }
  }
  return false;
}

// Peso extra quando o termo bate no NOME da obra (nao so em qualquer coluna).
const PESO_NOME = 3;
// Bonus decisivo quando TODAS as palavras da busca estao no nome da obra
// (a pessoa escreveu praticamente o nome exato).
const BONUS_NOME_COMPLETO = 50;
// So mostra junto do vencedor quem tiver pelo menos esta fracao da pontuacao
// dele. Assim, quando ha um nome que bate certinho, as correspondencias fracas
// (que so compartilham palavras genericas) sao descartadas e nao viram lista.
const FRACAO_RELEVANCIA = 0.6;

// Descobre palavras "onipresentes": as que aparecem em quase todas as obras
// (ex.: o nome da cidade, "prefeitura", "municipal"). Elas nao ajudam a
// distinguir uma obra da outra, entao sao ignoradas na busca - senao um termo
// desses faria a busca "casar" com a base inteira.
function palavrasOnipresentes(obras) {
  const total = obras.length;
  if (total < 5) return new Set(); // base pequena: nao vale filtrar
  const contagem = new Map();
  for (const obra of obras) {
    const vistas = new Set(textoDaObra(obra).split(/\s+/).filter((w) => w.length >= 3));
    for (const w of vistas) contagem.set(w, (contagem.get(w) || 0) + 1);
  }
  const limite = total * 0.6; // aparece em 60%+ das obras -> onipresente
  const set = new Set();
  for (const [w, n] of contagem) if (n >= limite) set.add(w);
  return set;
}

// Pontua e ordena as obras de acordo com uma lista de termos ja prontos.
function pontuarObras(termos, obras, limite) {
  if (!termos || termos.length === 0) return [];

  const onipresentes = palavrasOnipresentes(obras);

  let termosNormalizados = termos
    .flatMap((t) => keywords(t)) // cada termo pode ter mais de uma palavra
    .filter(Boolean);

  // Remove palavras onipresentes (nome da cidade etc.) - MAS so se ainda sobrar
  // algum termo util; se a pessoa buscou SO por uma dessas, mantemos.
  const semOnipresentes = termosNormalizados.filter((t) => !onipresentes.has(t));
  if (semOnipresentes.length > 0) termosNormalizados = semOnipresentes;

  if (termosNormalizados.length === 0) return [];
  const nPalavras = termosNormalizados.length;

  const pontuadas = obras
    .map((obra) => {
      const texto = textoDaObra(obra);
      const nome = nomeDaObra(obra);
      let base = 0; // quantos termos batem em qualquer coluna
      let emNome = 0; // quantos termos batem no NOME da obra
      for (const termo of termosNormalizados) {
        if (casaTermo(texto, termo)) base += 1;
        if (nome && casaTermo(nome, termo)) emNome += 1;
      }
      let pontos = base + emNome * PESO_NOME;
      // Se a busca tem 2+ palavras e TODAS estao no nome, essa e claramente
      // a obra certa: ganha um empurrao decisivo para vencer sozinha.
      if (nPalavras >= 2 && emNome === nPalavras) pontos += BONUS_NOME_COMPLETO;
      return { obra, pontos, base };
    })
    // Precisa bater em pelo menos um termo (em qualquer coluna) para entrar.
    .filter((x) => x.base > 0)
    .sort((a, b) => b.pontos - a.pontos);

  if (pontuadas.length === 0) return [];

  // Filtro de relevancia: descarta correspondencias muito mais fracas que a
  // melhor. Se uma obra domina (nome exato), so ela passa -> resposta direta.
  const topo = pontuadas[0].pontos;
  const relevantes = pontuadas.filter((x) => x.pontos >= topo * FRACAO_RELEVANCIA);

  return relevantes.slice(0, limite).map((x) => x.obra);
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
