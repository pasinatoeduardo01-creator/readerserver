import { test, expect } from "bun:test";
import { Hono } from "hono";
import { rateLimiter } from "./limite";

function appDeTeste(max = 2) {
  const app = new Hono();
  app.use("*", rateLimiter({ windowMs: 60_000, max }));
  app.get("/", (c) => c.text("ok"));
  return app;
}

function pedir(app: Hono, encaminhado?: string) {
  return app.request("/", encaminhado ? { headers: { "x-forwarded-for": encaminhado } } : {});
}

test("conta pelo ÚLTIMO salto do x-forwarded-for, que o cliente não forja", async () => {
  const app = appDeTeste(2);

  expect((await pedir(app, "1.1.1.1, 2.2.2.2")).status).toBe(200);
  expect((await pedir(app, "1.1.1.1, 2.2.2.2")).status).toBe(200);
  expect((await pedir(app, "1.1.1.1, 2.2.2.2")).status).toBe(429);

  // Trocar o começo da lista não muda a identidade: o último salto é o mesmo.
  expect((await pedir(app, "9.9.9.9, 2.2.2.2")).status).toBe(429);

  // Outro último salto é outro cliente e tem a própria janela.
  expect((await pedir(app, "3.3.3.3")).status).toBe(200);
});

test("sem cabeçalhos de proxy e fora do servidor do Bun, cai em uma chave só", async () => {
  const app = appDeTeste(2);

  expect((await pedir(app)).status).toBe(200);
  expect((await pedir(app)).status).toBe(200);
  expect((await pedir(app)).status).toBe(429);
});

test("x-real-ip identifica o cliente quando não há x-forwarded-for", async () => {
  const app = appDeTeste(1);

  expect((await app.request("/", { headers: { "x-real-ip": "4.4.4.4" } })).status).toBe(200);
  expect((await app.request("/", { headers: { "x-real-ip": "4.4.4.4" } })).status).toBe(429);
  expect((await app.request("/", { headers: { "x-real-ip": "5.5.5.5" } })).status).toBe(200);
});
