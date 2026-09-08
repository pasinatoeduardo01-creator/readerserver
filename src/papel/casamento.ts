import type { IndiceLivro } from "./epub-index";

export interface Candidato { paragraph: number; score: number }
export interface ResultadoCasamento { status: "confiante" | "duvidoso" | "nenhum"; candidatos: Candidato[] }

const CONFIANTE = 0.6;
const VANTAGEM = 0.1;
const DUVIDOSO = 0.4;

export function normalizarTexto(s: string): string {
  return s
    .replace(/-\s*\n\s*/g, "")          // hifenização de fim de linha
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // acentos
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")    // pontuação e símbolos viram espaço
    .trim()
    .replace(/\s+/g, " ");
}

function trigramas(s: string): Set<string> {
  const t = new Set<string>();
  const texto = ` ${s} `;
  for (let i = 0; i + 3 <= texto.length; i++) t.add(texto.slice(i, i + 3));
  return t;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comum = 0;
  for (const x of a) if (b.has(x)) comum++;
  return (2 * comum) / (a.size + b.size);
}

/**
 * Maior similaridade entre o trecho e o parágrafo, comparando com o parágrafo
 * inteiro e com uma janela deslizante de 1,15× o tamanho do trecho. A janela
 * começa no início do parágrafo (o caso "primeiras palavras") e anda até o fim,
 * porque a frase digitada muitas vezes é do MEIO do parágrafo: aí o prefixo não
 * casa e o parágrafo inteiro dilui o Dice a ~0,2.
 */
export function similaridade(trecho: string, paragrafo: string): number {
  const q = normalizarTexto(trecho);
  const p = normalizarTexto(paragrafo);
  if (!q || !p) return 0;
  const tq = trigramas(q);
  let melhor = dice(tq, trigramas(p));
  const janela = Math.ceil(q.length * 1.15);
  const passo = Math.max(8, Math.floor(q.length / 4));
  for (let i = 0; ; i += passo) {
    melhor = Math.max(melhor, dice(tq, trigramas(p.slice(i, i + janela))));
    if (i + janela >= p.length) break;
  }
  return melhor;
}

export function paragrafosDoCapitulo(indice: IndiceLivro, capitulo: number): number[] {
  const atual = indice.chapters[capitulo];
  if (!atual) return [];
  const fim = indice.chapters[capitulo + 1]?.paragraph ?? indice.paragraphs.length;
  const saida: number[] = [];
  for (let i = atual.paragraph; i < fim; i++) saida.push(i);
  return saida;
}

export function casarTrecho(trecho: string, indice: IndiceLivro, escopo: number[]): ResultadoCasamento {
  if (!normalizarTexto(trecho)) return { status: "nenhum", candidatos: [] };
  const pontuados: Candidato[] = escopo
    .map((paragraph) => ({ paragraph, score: similaridade(trecho, indice.paragraphs[paragraph].text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const melhor = pontuados[0]?.score ?? 0;
  const segundo = pontuados[1]?.score ?? 0;
  if (melhor >= CONFIANTE && melhor - segundo >= VANTAGEM) return { status: "confiante", candidatos: pontuados };
  if (melhor >= DUVIDOSO) return { status: "duvidoso", candidatos: pontuados.filter((c) => c.score >= DUVIDOSO) };
  return { status: "nenhum", candidatos: [] };
}
