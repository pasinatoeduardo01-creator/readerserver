import { test, expect } from "bun:test";
import { abrirBanco } from "./db";
import { gravarProgresso } from "./progresso";

function bancoComUsuario() {
  const db = abrirBanco(":memory:");
  db.run("INSERT INTO users (username, password) VALUES ('u', 'x')");
  return db;
}

test("gravarProgresso insere e depois atualiza mantendo título quando o novo é nulo", () => {
  const db = bancoComUsuario();
  gravarProgresso(db, {
    userId: 1, document: "abc", progress: "/body/DocFragment[2]/body/p[3]", percentage: 0.1,
    device: "KindleBasic3", deviceId: "k1", title: "Livro", authors: "Autor", filename: "l.epub", timestamp: 100,
  });
  gravarProgresso(db, {
    userId: 1, document: "abc", progress: "/body/DocFragment[3]/body/p", percentage: 0.2,
    device: "Livro físico", deviceId: "papel", timestamp: 200,
  });
  const linhas = db.prepare("SELECT * FROM progress").all() as any[];
  expect(linhas).toHaveLength(1);
  expect(linhas[0]).toMatchObject({
    document: "abc", progress: "/body/DocFragment[3]/body/p", percentage: 0.2,
    device: "Livro físico", device_id: "papel", title: "Livro", authors: "Autor", filename: "l.epub", timestamp: 200,
  });
});

test("gravarProgresso usa o horário atual quando timestamp é omitido", () => {
  const db = bancoComUsuario();
  const antes = Math.floor(Date.now() / 1000);
  gravarProgresso(db, { userId: 1, document: "d", progress: "/body/DocFragment/body/p", percentage: 0, device: "x", deviceId: "y" });
  const t = (db.prepare("SELECT timestamp FROM progress").get() as any).timestamp;
  expect(t).toBeGreaterThanOrEqual(antes);
});

test("abrirBanco cria as tabelas novas", () => {
  const db = abrirBanco(":memory:");
  const nomes = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
  for (const t of ["users", "progress", "books", "paper_marks", "settings"]) expect(nomes).toContain(t);
});
