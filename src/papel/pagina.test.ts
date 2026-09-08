import { test, expect } from "bun:test";
import { estimarPagina, deslocamentoAtual } from "./pagina";
import { montarEpub } from "./epub-teste";
import { indexarEpub } from "./epub-index";

test("só com as âncoras, a metade do texto cai na metade do livro", () => {
  expect(estimarPagina(5000, 10000, 301, [])).toBe(151);
  expect(estimarPagina(0, 10000, 300, [])).toBe(1);
  expect(estimarPagina(10000, 10000, 300, [])).toBe(300);
});

test("uma marcação puxa a reta para o ponto informado", () => {
  // 40% do texto está na página 100 de 300 (livro com muita nota no fim)
  const marcas = [{ charOffset: 4000, paperPage: 100 }];
  expect(estimarPagina(4000, 10000, 300, marcas)).toBe(100);
  expect(estimarPagina(2000, 10000, 300, marcas)).toBe(51);      // entre (0,1) e (4000,100)
  expect(estimarPagina(7000, 10000, 300, marcas)).toBe(200);     // entre (4000,100) e (10000,300)
});

test("marcação incoerente (página menor mais à frente) é ignorada", () => {
  const marcas = [{ charOffset: 4000, paperPage: 100 }, { charOffset: 6000, paperPage: 80 }];
  expect(estimarPagina(6000, 10000, 300, marcas)).toBe(167);
});

test("resultado fica entre 1 e o total de páginas", () => {
  expect(estimarPagina(-5, 100, 10, [])).toBe(1);
  expect(estimarPagina(500, 100, 10, [])).toBe(10);
});

test("deslocamentoAtual usa o XPath quando existe e a porcentagem quando não", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", titulo: "A", corpo: "<p>abcde</p><p>fghij</p>" }]), "d");
  expect(deslocamentoAtual(idx, "/body/DocFragment/body/p[2]/text().0", 0.9)).toBe(5);
  expect(deslocamentoAtual(idx, "/body/DocFragment[7]/body/p", 0.5)).toBe(5);
});
