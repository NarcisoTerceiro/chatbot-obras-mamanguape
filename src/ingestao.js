// ============================================================
//  ingestao.js
//  Le a planilha (via sheets.js / conta de servico), LIMPA e
//  padroniza os dados, e popula a tabela "obras" no Supabase.
//
//  FLEXIVEL: acha as colunas pelo NOME e aceita abas auxiliares/genéricas.
//  Linhas de abas novas são preservadas no banco sem exigir código novo.
//
//  Estrategia de atualizacao: substitui tudo (DELETE + INSERT).
//  Assim o banco fica sempre IGUAL a planilha - simples e seguro.
// ============================================================

import { getObras, limparCache, getDiagnostico } from "./sheets.js";
import { createHash } from "node:crypto";
import { decimalMoeda } from "./sqlUtils.js";
import { withAdminTransaction } from "./db.js";

const controle = k => ["_aba","_linha","_avisos"].includes(k);

// --- utilidades de limpeza ---
function norm(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, " ");
}

// Cada campo do banco -> nomes possiveis na planilha (sinonimos).
// Para suportar uma planilha nova, e so acrescentar nomes aqui.
const MAPA = {
  objeto: [
    "objeto da obra", "objeto", "obra", "rua", "descricao", "descrição",
    "nome da obra", "nome", "item", "assunto", "pendencia", "pendência",
    "pendencias para inicio/continuidade de obra",
    "pendências para início/continuidade de obra"
  ],
  bairro: ["bairro", "localizacao", "local", "distrito"],
  status: ["status", "situacao", "situacao atual", "fase"],
  valor_total: ["valor total da obra", "valor (r$)", "valor", "valor da obra", "valor contratado"],
  valor_executado: ["valor executado", "executado"],
  valor_pago: ["valor pago", "total pago"],
  percentual_executado: ["% executada", "% executado", "percentual executado", "percentual"],
  engenheiro: ["engenheiro", "engenheiro responsavel", "engenheiro/arquiteto responsavel",
               "engenheiro/arquiteto", "responsavel tecnico", "responsavel"],
  empresa: ["empresa", "empresa responsavel", "empresa executora", "construtora", "contratada"],
};

// Dado um objeto-obra (com chaves = nomes de coluna da planilha),
// acha o valor de um campo do banco procurando pelos sinonimos.
function pegar(obra, campo) {
  const chaves = Object.keys(obra);
  for (const sin of MAPA[campo]) {
    const achou = chaves.find((k) => norm(k) === sin);
    if (achou !== undefined && obra[achou] !== null && obra[achou] !== undefined && String(obra[achou]).trim() !== "") return obra[achou];
  }
  return null;
}

export function padronizarStatus(txt) {
  const s = norm(txt);
  if (!s) return null;
  // Apenas situações explícitas. Frases desconhecidas ficam preservadas.
  const grupos = [
    ['Concluída', /^(concluid[ao]s?|finalizad[ao]s?|concluida e entregue)$/],
    ['Em andamento', /^(em andamento|em execucao|em obra|execucao)$/],
    ['A iniciar', /^(a iniciar|nao iniciad[ao]|aguardando inicio|nao iniciado)$/],
    ['Paralisada', /^(paralisad[ao]|suspens[ao]|parad[ao])$/],
    ['Em projeto', /^(em projeto|em elaboracao|projeto em elaboracao)$/],
    ['Em licitação', /^(em licitacao|licitacao|habilitacao em andamento)$/],
    ['Homologada', /^homologad[ao]$/],
  ];
  for (const [nome, regex] of grupos) if (regex.test(s)) return nome;
  return String(txt).trim();
}

// Converte numeros vindos do Google Sheets sem depender do formato visual.
// Aceita, por exemplo:
//   3,020,000.00   (formato EN/US)
//   3.020.000,00   (formato PT/BR)
//   3020000.00     (valor cru/unformatted)
//   R$ 3.020.000,00
// Tambem preserva negativos e ignora simbolos de moeda/texto residual.
function parseNumeroFlexivel(v, { separadorUnicoDecimal = false } = {}) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  let bruto = String(v).trim();
  if (!bruto || bruto === "-") return null;

  const negativoPorParenteses = /^\s*\(.*\)\s*$/.test(bruto);
  let s = bruto
    .replace(/\u00a0/g, "")
    .replace(/r\$/gi, "")
    .replace(/\s+/g, "")
    .replace(/[^0-9,\.\-+]/g, "");

  if (!s || s === "-" || s === "+") return null;

  let negativo = negativoPorParenteses || s.includes("-");
  s = s.replace(/[+-]/g, "");
  if (!s) return null;

  const ultimaVirgula = s.lastIndexOf(",");
  const ultimoPonto = s.lastIndexOf(".");
  let normalizado = s;

  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    // Se existem os dois separadores, o ULTIMO e o separador decimal.
    // 3,020,000.00 -> 3020000.00
    // 3.020.000,00 -> 3020000.00
    if (ultimaVirgula > ultimoPonto) {
      normalizado = s.replace(/\./g, "").replace(/,/g, ".");
    } else {
      normalizado = s.replace(/,/g, "");
    }
  } else if (ultimaVirgula >= 0 || ultimoPonto >= 0) {
    const sep = ultimaVirgula >= 0 ? "," : ".";
    const partes = s.split(sep);

    if (partes.length > 2) {
      const ultima = partes[partes.length - 1];
      const anteriores = partes.slice(0, -1).join("");
      // Varios separadores: se o ultimo grupo tem 1-2 casas, tratamos como
      // decimal; senao, todos sao separadores de milhar.
      normalizado = (ultima.length >= 1 && ultima.length <= 2)
        ? `${anteriores}.${ultima}`
        : `${anteriores}${ultima}`;
    } else {
      const [inteiro, fracao = ""] = partes;
      // Para dinheiro, um unico grupo de 3 digitos costuma ser milhar
      // (1.234 ou 1,234). Para percentuais, permitimos forcar decimal.
      const ehMilhar = !separadorUnicoDecimal && fracao.length === 3 && inteiro.length >= 1;
      normalizado = ehMilhar ? `${inteiro}${fracao}` : `${inteiro}.${fracao}`;
    }
  }

  const n = Number(normalizado);
  if (!Number.isFinite(n)) return null;
  return negativo ? -Math.abs(n) : n;
}

function parseValor(v) {
  return decimalMoeda(v);
}

// No banco, percentual_executado fica em PONTOS PERCENTUAIS para combinar
// com a exibicao do agente: 75,51% -> 75.51; 107,21% -> 107.21.
// Quando o Sheets entrega UNFORMATTED_VALUE, uma celula 75,51% vem como 0.7551;
// nesse caso convertemos a fracao para pontos percentuais.
function parsePercentual(v) {
  if (v === null || v === undefined || v === "") return null;

  const texto = String(v).trim();
  const tinhaPercentual = texto.includes("%");
  const n = parseNumeroFlexivel(v, { separadorUnicoDecimal: true });
  if (n === null) return null;

  if (tinhaPercentual) return n;

  // Heuristica para valores crus do Google Sheets: percentuais formatados sao
  // armazenados como fracao (0.7551 = 75.51%, 1.0721 = 107.21%).
  // Acima de 5, assumimos que a planilha ja esta em pontos percentuais.
  if (Math.abs(n) <= 5) return n * 100;
  return n;
}

function categoriaDaAba(aba) {
  const n = norm(aba);
  if (n.includes("andamento")) return "Em andamento";
  if (n.includes("licita")) return "Em licitação";
  if (n.includes("projeto")) return "Em projeto";
  if (n.includes("paviment")) return "Pavimentação";
  if (n.includes("pendenc")) return "Pendência";
  // Qualquer aba nova continua identificável no banco pelo próprio nome.
  return (aba || "").toString().trim() || "Outro";
}

// Em abas auxiliares pode não existir OBJETO/OBRA/RUA.
// Nesse caso escolhemos um valor textual representativo sem descartar a linha.
// A linha inteira continua preservada em dados_extras.
function objetoGenericoDaLinha(obra) {
  if (!obra || typeof obra !== "object") return null;

  const preferidas = [
    "obra", "objeto", "descricao", "descrição", "nome", "item", "assunto",
    "pendencia", "pendência", "contrato", "titulo", "título"
  ];

  const entradas = Object.entries(obra)
    .filter(([k, v]) => !controle(k) && v !== null && v !== undefined && String(v).trim() !== "");

  for (const termo of preferidas) {
    const achou = entradas.find(([k]) => norm(k).includes(norm(termo)));
    if (achou) return String(achou[1]).trim();
  }

  // Último recurso: primeiro valor realmente preenchido da linha.
  return entradas.length ? String(entradas[0][1]).trim() : null;
}

// Tenta extrair o bairro do NOME da obra quando a coluna bairro esta vazia.
// Muitas obras vem como "Rua do Cruzeiro - Centro" ou "Avenida X - Bela Vista",
// onde o bairro esta depois do traco. Sem isso, buscas por bairro perdem
// essas obras (elas nao tem a coluna bairro preenchida).
function bairroDoNome(nome) {
  if (!nome) return null;
  const partes = nome.toString().split(/\s+[-\u2013\u2014]\s+/); // separa por " - "
  if (partes.length >= 2) {
    const ultima = partes[partes.length - 1].trim();
    // so aceita se parecer um bairro (curto, sem numeros de contrato etc.)
    if (ultima.length >= 3 && ultima.length <= 40 && !/^\d+$/.test(ultima)) {
      return ultima;
    }
  }
  return null;
}

function coletarExtras(obra) {
  // Todas as células, inclusive vazias e zeros, com nomes e tipos originais.
  return Object.fromEntries(Object.entries(obra || {}).filter(([k]) => !controle(k)));
}

// Transforma uma obra crua (da planilha) numa linha limpa pro banco.
export function limpar(obra) {
  if (!obra || typeof obra !== "object" || Array.isArray(obra) || !Object.entries(obra).some(([k,v]) => !controle(k) && v != null && String(v).trim() !== "")) return null;
  // Abas tradicionais usam OBJETO/OBRA/RUA. Abas auxiliares ou futuras
  // podem ter outros cabeçalhos; não descartamos mais a linha só por isso.
  const objeto = pegar(obra, "objeto") || objetoGenericoDaLinha(obra);
  if (!objeto) return null; // só ignora linha realmente sem conteúdo útil
  const categoria = categoriaDaAba(obra._aba);
  const statusOriginal = (pegar(obra, "status") || "").toString().trim();
  const statusNormalizado = padronizarStatus(statusOriginal) || null;

  // bairro: primeiro tenta a coluna; se vazia, tenta extrair do nome.
  let bairro = (pegar(obra, "bairro") || "").toString().trim();
  if (!bairro) {
    if (norm(obra._aba).includes("paviment")) bairro = bairroDoNome(objeto) || "";
  }

  // Mantemos tambem o texto ORIGINAL do status dentro de dados_extras.
  // Isso permite respostas detalhadas como "Habilitacao em andamento" sem
  // confundir essa etapa com uma obra fisicamente em andamento.
  const extras = coletarExtras(obra) || {};
  if (statusOriginal) extras["STATUS ORIGINAL"] = statusOriginal;
  const avisos = [...(Array.isArray(obra._avisos) ? obra._avisos : [])];
  const anos = Object.entries(obra).filter(([k]) => /^valor pago \d{4}$/.test(norm(k)));
  const pagamentos = anos.map(([,v]) => parseValor(v));
  const pagoDireto = parseValor(pegar(obra, "valor_pago"));
  const somar = vals => {
    const presentes = vals.filter(v => v !== null);
    if (!presentes.length) return null;
    const cents = presentes.reduce((acc,v) => acc + BigInt(v.replace('.', '')), 0n);
    const abs = cents < 0n ? -cents : cents;
    return `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  };
  if (anos.length && pagamentos.some(v => v === null)) avisos.push('Pagamentos anuais incompletos: a soma disponível é parcial.');
  for (const c of ['valor_total', 'valor_executado', 'valor_pago']) {
    const bruto = pegar(obra,c);
    if (bruto != null && parseValor(bruto) === null) avisos.push(`${c}: valor inválido; original preservado.`);
  }
  const componentes = ['valor inicial do contrato','valor total dos aditivos','valor total dos reajustes'].map(nome => {
    const key = Object.keys(obra).find(k => norm(k) === nome);
    return parseValor(key === undefined ? null : obra[key]);
  });
  const calculado = componentes.every(v => v !== null) ? somar(componentes) : null;
  const total = parseValor(pegar(obra, 'valor_total'));
  if (calculado !== null && total !== null && calculado !== total) avisos.push('Valor total diverge de inicial + aditivos + reajustes.');
  const n = norm(obra._aba);
  const tipo = n.includes('projeto') ? 'projeto' : n.includes('licit') ? 'licitacao' : n.includes('pendenc') ? 'pendencia' : n.includes('paviment') ? 'pavimentacao' : 'outro';

  return {
    objeto: objeto.toString().trim(),
    bairro: bairro || null,
    status: statusNormalizado,
    categoria,
    valor_total: total,
    valor_contratado: total ?? calculado,
    valor_contratado_calculado: calculado,
    valor_pago: pagoDireto ?? somar(pagamentos),
    tipo_registro: tipo === "outro" && pegar(obra,"objeto") && Object.keys(obra).some(k => norm(k) === "objeto da obra") ? "obra" : tipo,
    linha_origem: Number.isInteger(Number(obra._linha)) ? Number(obra._linha) : null,
    status_original: statusOriginal || null,
    avisos_fonte: avisos,
    valor_executado: parseValor(pegar(obra, "valor_executado")),
    percentual_executado: parsePercentual(pegar(obra, "percentual_executado")),
    engenheiro: (pegar(obra, "engenheiro") || "").toString().trim() || null,
    empresa: (pegar(obra, "empresa") || "").toString().trim() || null,
    aba_origem: obra._aba || null,
    dados_extras: Object.keys(extras).length ? extras : null,
  };
}

// Roda a ingestao completa: le planilha -> limpa -> substitui no banco.
export async function sincronizar({ lerDados = getObras, diagnostico = getDiagnostico, transacao = withAdminTransaction, planilhaId = process.env.GOOGLE_SHEETS_ID } = {}) {
  if (!planilhaId) throw new Error("GOOGLE_SHEETS_ID não configurado.");
  console.log("INGESTAO: lendo planilha...");
  limparCache(); // forca releitura da planilha fresca (ignora cache velho)
  const cruas = await lerDados({force:true});
  if (!Array.isArray(cruas)) throw new Error("Leitura da planilha inválida; banco preservado.");
  const limpas = cruas.map(limpar).filter(Boolean).map(r => ({...r,planilha_id:planilhaId}));
  const relatorio = diagnostico()?.abas || [];
  const abas = [...new Set([...cruas.map(r=>r._aba).filter(Boolean),...relatorio.map(a=>a.aba)])];
  const catalogos = abas.map(aba => {
    const rows = cruas.filter(r=>r._aba===aba), report=relatorio.find(r=>r.aba===aba);
    const keys = [...new Set([...(report?.cabecalho||[]),...rows.flatMap(r=>Object.keys(r).filter(k=>!controle(k)))])];
    const colunas=keys.map(chave=>{
      const values=rows.map(r=>r[chave]).filter(v=>v!==null&&v!==undefined&&v!=='');
      const types=[...new Set(values.map(v=>typeof v))];
      return {chave,tipo:types.length===1&&types[0]==='number'?'numeric':types.length===1&&types[0]==='boolean'?'boolean':'text'};
    });
    const slug=norm(aba).replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,36)||'aba';
    const hash=createHash('sha256').update(planilhaId+'|'+aba).digest('hex').slice(0,10);
    return {aba,rows,report,colunas,view:'aba_'+slug+'_'+hash};
  });
  console.log(`INGESTAO: ${cruas.length} linhas lidas, ${limpas.length} obras limpas.`);

  if (limpas.length === 0) {
    console.log("INGESTAO: nenhuma obra para inserir. Abortando (nao apaga o banco).");
    throw new Error("Planilha sem registros úteis; banco anterior preservado.");
  }

  // Insere em lote.
  const campos = ["objeto","bairro","status","categoria","valor_total",
    "valor_executado","percentual_executado","engenheiro","empresa","aba_origem",
    "dados_extras", "tipo_registro", "linha_origem", "status_original", "valor_pago",
    "valor_contratado", "valor_contratado_calculado", "avisos_fonte", "planilha_id"];

  // INSERCAO EM LOTE: junta varias obras numa unica query, em blocos.
  // Antes era uma query por obra (2000 obras = 2000 idas ao banco = timeout).
  // Agora insere ~100 por vez, o que aguenta milhares de obras em segundos.
  // Postgres limita ~65535 parametros por query; com 11 campos, 100 obras =
  // 1100 parametros, bem dentro do limite e com folga.
  const TAMANHO_LOTE = 100;
  let inseridas = 0;

  function valoresDaObra(o) {
    return campos.map((c) => {
      if (c === "dados_extras" || c === "avisos_fonte") return o[c] ? JSON.stringify(o[c]) : null;
      return o[c];
    });
  }

  // DELETE + TODOS os lotes ficam na mesma transacao. O PostgreSQL torna a
  // substituição transacional: se um INSERT falhar, o banco volta integralmente ao
  // estado anterior, sem ficar vazio ou pela metade.
  await transacao(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(124783991)");
    await client.query("UPDATE public.planilha_abas SET ativa=false WHERE ativa=true");
    const quote = v => "'"+String(v).replace(/'/g,"''")+"'";
    const identifier = v => '"'+String(v).replace(/"/g,'""')+'"';
    for (const tab of catalogos) {
      await client.query(`INSERT INTO public.planilha_abas(planilha_id,aba,view_nome,colunas,celulas,linhas_lidas,registros,avisos,ativa,atualizada_em)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,true,now())
        ON CONFLICT(planilha_id,aba) DO UPDATE SET view_nome=EXCLUDED.view_nome,colunas=EXCLUDED.colunas,
        celulas=EXCLUDED.celulas,linhas_lidas=EXCLUDED.linhas_lidas,registros=EXCLUDED.registros,
        avisos=EXCLUDED.avisos,ativa=true,atualizada_em=now()`,
        [planilhaId,tab.aba,tab.view,JSON.stringify(tab.colunas),JSON.stringify(tab.report?.celulas||[]),tab.report?.linhas_lidas??tab.rows.length,
          limpas.filter(r=>r.aba_origem===tab.aba).length,JSON.stringify(tab.report?.avisos||[])]);
      const projection=tab.colunas.map(c=>{
        const expr='o.dados_extras ->> '+quote(c.chave);
        return (c.tipo==='text'?expr:'('+expr+')::'+c.tipo)+' AS '+identifier(c.chave);
      });
      const definition=`SELECT o.id AS __registro_id,o.aba_origem AS __aba,o.linha_origem AS __linha,o.dados_extras AS __dados_originais
        ${projection.length?', '+projection.join(', '):''} FROM public.obras o
        WHERE o.planilha_id=${quote(planilhaId)} AND o.aba_origem=${quote(tab.aba)}`;
      // Views de fonte versionadas pelo contrato de colunas evitam DROP/CASCADE quando o cabeçalho muda.
      const version=createHash('sha256').update(JSON.stringify(tab.colunas)).digest('hex').slice(0,6);
      const viewNome=tab.view+'_'+version;
      await client.query('CREATE OR REPLACE VIEW planilha.'+identifier(viewNome)+' AS '+definition);
      await client.query('GRANT SELECT ON planilha.'+identifier(viewNome)+' TO obras_chatbot_leitura');
      await client.query('UPDATE public.planilha_abas SET view_nome=$1 WHERE planilha_id=$2 AND aba=$3',[viewNome,planilhaId,tab.aba]);
    }
    await client.query("DELETE FROM public.obras;");

    for (let inicio = 0; inicio < limpas.length; inicio += TAMANHO_LOTE) {
      const bloco = limpas.slice(inicio, inicio + TAMANHO_LOTE);
      const todosValores = [];
      const gruposMarcadores = [];

      bloco.forEach((o, idxObra) => {
        const vals = valoresDaObra(o);
        const marcadores = vals.map((_, idxCampo) => {
          const posicao = idxObra * campos.length + idxCampo + 1;
          return `$${posicao}`;
        });
        gruposMarcadores.push(`(${marcadores.join(",")})`);
        todosValores.push(...vals);
      });

      await client.query(
        `INSERT INTO public.obras (${campos.join(",")}) VALUES ${gruposMarcadores.join(",")}`,
        todosValores
      );
      inseridas += bloco.length;
      console.log(`INGESTAO: lote inserido (${inseridas}/${limpas.length}).`);
    }
    const conferido=await client.query('SELECT aba_origem, COUNT(*)::int AS registros FROM public.obras GROUP BY aba_origem');
    for(const tab of catalogos) {
      const expected=limpas.filter(r=>r.aba_origem===tab.aba).length;
      const found=Number(conferido.rows.find(r=>r.aba_origem===tab.aba)?.registros||0);
      if(expected!==found)throw new Error(`Conferência falhou na aba ${tab.aba}: esperado ${expected}, gravado ${found}.`);
    }
    await client.query(`INSERT INTO public.obras_sync (id, atualizada_em, registros)
      VALUES (1, now(), $1) ON CONFLICT (id) DO UPDATE SET atualizada_em = EXCLUDED.atualizada_em, registros = EXCLUDED.registros`, [inseridas]);
  });

  console.log(`INGESTAO: ${inseridas} obras inseridas no banco.`);
  return { inseridas, abas:catalogos.map(t=>({aba:t.aba,registros:limpas.filter(r=>r.aba_origem===t.aba).length})),planilha_id:planilhaId };
}
