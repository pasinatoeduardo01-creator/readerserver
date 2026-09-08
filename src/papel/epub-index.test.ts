import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { montarEpub } from "./epub-teste";
import { indexarEpub, ErroEpub, capituloDoParagrafo, paragrafoDoXpath } from "./epub-index";

const DOIS = () =>
  montarEpub([
    {
      nome: "cap1.xhtml", titulo: "Um",
      corpo: `<h1>Um</h1><p>Primeiro parágrafo.</p><div><p>Dentro   de um div.</p></div>
              <blockquote><p>Citação.</p></blockquote><ul><li>Item A</li><li>Item B</li></ul><p>   </p><script>var x=1</script>`,
    },
    { nome: "cap2.xhtml", titulo: "Dois", ancora: "c2", corpo: `<p>Antes da âncora.</p><h1 id="c2">Dois</h1><p>Alfa</p><p>Beta</p>` },
  ]);

test("gera XPath do crengine (índice só quando há irmão do mesmo nome) para blocos folha com texto", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.paragraphs.map((p) => p.xpath)).toEqual([
    "/body/DocFragment[1]/body/h1",          // único h1 do body: sem índice
    "/body/DocFragment[1]/body/p[1]",        // há outro <p> irmão: índice desde o primeiro
    "/body/DocFragment[1]/body/div/p",       // div único; <p> único dentro dele
    "/body/DocFragment[1]/body/blockquote/p",
    "/body/DocFragment[1]/body/ul/li[1]",
    "/body/DocFragment[1]/body/ul/li[2]",
    "/body/DocFragment[2]/body/p[1]",
    "/body/DocFragment[2]/body/h1",
    "/body/DocFragment[2]/body/p[2]",
    "/body/DocFragment[2]/body/p[3]",
  ]);
  expect(idx.paragraphs[2].text).toBe("Dentro de um div.");
  expect(idx.spineCount).toBe(2);
  expect(idx.document).toBe("doc1");
  expect(idx.title).toBe("Livro de Teste");
  expect(idx.authors).toBe("Autora Fictícia");
});

test("deslocamentos acumulam e totalChars é a soma", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.paragraphs[0].offset).toBe(0);
  expect(idx.paragraphs[1].offset).toBe("Um".length);
  expect(idx.totalChars).toBe(idx.paragraphs.reduce((s, p) => s + p.text.length, 0));
});

test("sumário resolve arquivo e âncora para o parágrafo certo", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.chapters).toEqual([
    { title: "Um", spine: 1, paragraph: 0 },
    { title: "Dois", spine: 2, paragraph: 7 },
  ]);
  expect(capituloDoParagrafo(idx, 8)?.title).toBe("Dois");
  expect(capituloDoParagrafo(idx, 3)?.title).toBe("Um");
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[2]")).toBe(8);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[2]/text().15")).toBe(8);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[9]/body/p")).toBeNull();
});

test("paragrafoDoXpath casa as três escritas: com [1], sem [1], com /text().N e com .N", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  // Mesmo parágrafo (o 6: "Antes da âncora."), escrito como cada leitor escreve.
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[1]/text().0")).toBe(6);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[1].0")).toBe(6);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p")).toBe(6);
  // CrossPoint indexa todos os segmentos, inclusive os de irmão único (div[1]/p[1]).
  expect(paragrafoDoXpath(idx, "/body/DocFragment[1]/body/div[1]/p[1]")).toBe(2);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[1]/body/div[1]/p[1].0")).toBe(2);
});

test("sem sumário, cada item da espinha vira 'Seção N'", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", corpo: "<p>a</p>" }, { nome: "b.xhtml", corpo: "<p>b</p>" }], { semSumario: true }), "d");
  expect(idx.chapters).toEqual([{ title: "Seção 1", spine: 1, paragraph: 0 }, { title: "Seção 2", spine: 2, paragraph: 1 }]);
});

test("espinha única usa /body/DocFragment/body sem índice", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", titulo: "A", corpo: "<p>Só um.</p>" }]), "d");
  expect(idx.paragraphs[0].xpath).toBe("/body/DocFragment/body/p");
});

test("calcula o hash quando document é omitido", () => {
  const bytes = DOIS();
  expect(indexarEpub(bytes).document).toMatch(/^[0-9a-f]{32}$/);
});

test("arquivo que não é EPUB lança ErroEpub", () => {
  expect(() => indexarEpub(new TextEncoder().encode("isto não é um zip"), "d")).toThrow(ErroEpub);
});

const LIVRO_REAL = `${process.env.HOME}/Documents/Reading/Time Machine - H.G Wells .epub`;
test.skipIf(!existsSync(LIVRO_REAL))("The Time Machine real: XPath do Kindle existe e cai perto de 29%", async () => {
  const idx = indexarEpub(new Uint8Array(await Bun.file(LIVRO_REAL).arrayBuffer()));
  expect(idx.document).toBe("a3151aa606c6367fd86a1443a4e701a7");
  expect(idx.spineCount).toBe(20);
  const n = paragrafoDoXpath(idx, "/body/DocFragment[8]/body/div/p[4]/text().287");
  expect(n).not.toBeNull();
  const pct = idx.paragraphs[n!].offset / idx.totalChars;
  expect(pct).toBeGreaterThan(0.27);
  expect(pct).toBeLessThan(0.31);
  expect(idx.chapters.length).toBeGreaterThan(10);
  expect(idx.title).toBe("The Time Machine");
});
