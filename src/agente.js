export const perguntas=[];
export async function responderPergunta(q,h,o){perguntas.push({q,h,o});return {resposta:'Resposta SQL de teste',sql:'SELECT COUNT(*) FROM public.obras',linhas:1,modoAgente:'sql',diagnostico:{trace:[]}};}
