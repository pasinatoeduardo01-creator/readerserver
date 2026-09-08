import { test, expect } from "bun:test";
import { Dashboard } from "./dashboard";

const base = { document: "abc", percentage: 0.3, filename: null, authors: "A", timestamp: 1000, title: "T" };

test("mostra a página estimada no papel e o aparelho Livro físico", () => {
  const html = (<Dashboard rows={[{ ...base, device: "Livro físico", paperPage: 87 }]} now={2000} />).toString();
  expect(html).toContain("Livro físico");
  expect(html).toContain("≈ pág. 87 no papel");
});

test("sem total de páginas não mostra estimativa; tem link para marcar", () => {
  const html = (<Dashboard rows={[{ ...base, device: "KindleBasic3", paperPage: null }]} now={2000} />).toString();
  expect(html).not.toContain("no papel");
  expect(html).toContain('href="/papel"');
  expect(html).toContain("Guarda os EPUBs");
});
