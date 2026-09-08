import { paragrafoDoXpath, type IndiceLivro } from "./epub-index";

export interface PontoCalibracao { charOffset: number; paperPage: number }

export function estimarPagina(charOffset: number, totalChars: number, paperPages: number, marcas: PontoCalibracao[]): number {
  const pontos: PontoCalibracao[] = [{ charOffset: 0, paperPage: 1 }];
  const ordenadas = [...marcas].sort((a, b) => a.charOffset - b.charOffset);
  for (const m of ordenadas) {
    const anterior = pontos[pontos.length - 1];
    if (m.charOffset > anterior.charOffset && m.paperPage > anterior.paperPage && m.charOffset < totalChars && m.paperPage < paperPages) {
      pontos.push(m);
    }
  }
  pontos.push({ charOffset: totalChars, paperPage: paperPages });

  const x = Math.min(Math.max(charOffset, 0), totalChars);
  for (let i = 1; i < pontos.length; i++) {
    const a = pontos[i - 1], b = pontos[i];
    if (x <= b.charOffset) {
      const fracao = b.charOffset === a.charOffset ? 0 : (x - a.charOffset) / (b.charOffset - a.charOffset);
      const pagina = Math.round(a.paperPage + fracao * (b.paperPage - a.paperPage));
      return Math.min(Math.max(pagina, 1), paperPages);
    }
  }
  return paperPages;
}

/** Deslocamento em caracteres da posição digital: pelo XPath se o índice o conhece, senão pela porcentagem. */
export function deslocamentoAtual(indice: IndiceLivro, xpath: string, percentage: number): number {
  const p = paragrafoDoXpath(indice, xpath);
  if (p !== null) return indice.paragraphs[p].offset;
  return Math.round(Math.min(Math.max(percentage, 0), 1) * indice.totalChars);
}
