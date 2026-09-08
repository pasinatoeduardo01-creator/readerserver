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

// Guarda contra o reenvio cego: o KOReader grava ao dormir/fechar sem consultar o servidor.
// Se um aparelho manda de novo exatamente a última posição que ele mesmo já tinha mandado,
// e outro aparelho avançou depois, o reenvio é ignorado (caso real de 08/09/2026).
const KINDLE = { device: "KindleBasic3", deviceId: "kindle" };
const X3 = { device: "CrossPoint", deviceId: "crosspoint-reader" };
const POS_KINDLE = { progress: "/body/DocFragment[8]/body/div/p[4]/text().287", percentage: 0.2955 };
const POS_X3 = { progress: "/body/DocFragment[9]/body", percentage: 0.333462 };

function ultimo(db: any) {
  return db.prepare("SELECT progress, percentage, device_id, timestamp FROM progress WHERE document = 'tm'").get();
}

test("reenvio da mesma posição antiga de um aparelho não apaga o avanço de outro", () => {
  const db = bancoComUsuario();
  gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 100 });
  gravarProgresso(db, { userId: 1, document: "tm", ...X3, ...POS_X3, timestamp: 200 });
  const r = gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 300 });
  expect(r.ignorado).toBe(true);
  expect(ultimo(db)).toMatchObject({ ...POS_X3, device_id: "crosspoint-reader", timestamp: 200 });
});

test("posição nova do mesmo aparelho é aceita mesmo estando atrás da de outro", () => {
  const db = bancoComUsuario();
  gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 100 });
  gravarProgresso(db, { userId: 1, document: "tm", ...X3, ...POS_X3, timestamp: 200 });
  const voltou = { progress: "/body/DocFragment[7]/body/div/p[2]/text().0", percentage: 0.25 };
  const r = gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...voltou, timestamp: 300 });
  expect(r.ignorado).toBe(false);
  expect(ultimo(db)).toMatchObject({ ...voltou, device_id: "kindle", timestamp: 300 });
});

test("aparelho que já é o último pode reenviar a própria posição", () => {
  const db = bancoComUsuario();
  gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 100 });
  const r = gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 150 });
  expect(r.ignorado).toBe(false);
  expect(ultimo(db)).toMatchObject({ ...POS_KINDLE, device_id: "kindle", timestamp: 150 });
});

test("banco antigo: a posição atual de cada livro vale como último envio daquele aparelho", () => {
  const caminho = `${process.env.TMPDIR || "/tmp"}/progresso-antigo-${Date.now()}.db`;
  const antigo = abrirBanco(caminho);
  antigo.run("INSERT INTO users (username, password) VALUES ('u', 'x')");
  antigo.run("DROP TABLE IF EXISTS device_progress");
  antigo.run(
    "INSERT INTO progress (user_id, document, progress, percentage, device, device_id, timestamp) VALUES (1, 'tm', ?, ?, ?, ?, 100)",
    [POS_KINDLE.progress, POS_KINDLE.percentage, KINDLE.device, KINDLE.deviceId]
  );
  antigo.close();

  const db = abrirBanco(caminho);
  gravarProgresso(db, { userId: 1, document: "tm", ...X3, ...POS_X3, timestamp: 200 });
  const r = gravarProgresso(db, { userId: 1, document: "tm", ...KINDLE, ...POS_KINDLE, timestamp: 300 });
  expect(r.ignorado).toBe(true);
  expect(ultimo(db)).toMatchObject({ ...POS_X3, device_id: "crosspoint-reader" });
});
