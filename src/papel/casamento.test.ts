import { test, expect } from "bun:test";
import { montarEpub } from "./epub-teste";
import { indexarEpub } from "./epub-index";
import { normalizarTexto, similaridade, paragrafosDoCapitulo, casarTrecho } from "./casamento";

const idx = indexarEpub(
  montarEpub([
    { nome: "c1.xhtml", titulo: "Um", corpo: `<p>The Time Traveller (for so it will be convenient to speak of him) was expounding a recondite matter to us.</p>
      <p>His grey eyes shone and twinkled, and his usually pale face was flushed and animated.</p>
      <p>The fire burned brightly, and the soft radiance of the incandescent lights in the lilies of silver caught the bubbles.</p>` },
    { nome: "c2.xhtml", titulo: "Dois", corpo: `<p>Gêmeo idêntico de parágrafo repetido.</p><p>Gêmeo idêntico de parágrafo repetido.</p><p>Outra coisa completamente diferente aqui.</p>` },
  ]),
  "d"
);

test("normalizarTexto tira acento, pontuação, maiúsculas e hifenização de fim de linha", () => {
  expect(normalizarTexto("Cita-\nção, ÀS vezes!  (sim)")).toBe("citacao as vezes sim");
});

test("similaridade é 1 para texto igual e baixa para texto sem relação", () => {
  expect(similaridade("his grey eyes shone", "His grey eyes shone and twinkled")).toBeGreaterThan(0.9);
  expect(similaridade("banana esmagada", "His grey eyes shone and twinkled")).toBeLessThan(0.2);
});

test("paragrafosDoCapitulo devolve os índices do capítulo", () => {
  expect(paragrafosDoCapitulo(idx, 0)).toEqual([0, 1, 2]);
  expect(paragrafosDoCapitulo(idx, 1)).toEqual([3, 4, 5]);
});

test("primeiras palavras exatas: confiante no parágrafo certo", () => {
  const r = casarTrecho("His grey eyes shone and twinkled", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("confiante");
  expect(r.candidatos[0].paragraph).toBe(1);
});

test("frase do meio do parágrafo casa: confiante no parágrafo certo", () => {
  const r = casarTrecho("his usually pale face was flushed", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("confiante");
  expect(r.candidatos[0].paragraph).toBe(1);
});

test("erros de OCR e hifenização ainda casam", () => {
  const r = casarTrecho("The fire bumed brigthly, and the soft radi-\nance of the incandescent lig hts", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("confiante");
  expect(r.candidatos[0].paragraph).toBe(2);
});

test("trecho de outro lugar: nenhum", () => {
  const r = casarTrecho("uma frase que não existe neste livro de jeito nenhum", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("nenhum");
});

test("parágrafos gêmeos: duvidoso com os dois candidatos", () => {
  const r = casarTrecho("Gêmeo idêntico de parágrafo", idx, paragrafosDoCapitulo(idx, 1));
  expect(r.status).toBe("duvidoso");
  expect(r.candidatos.map((c) => c.paragraph).sort()).toEqual([3, 4]);
});

test("trecho vazio: nenhum, sem lançar", () => {
  expect(casarTrecho("   ", idx, [0, 1, 2]).status).toBe("nenhum");
});
