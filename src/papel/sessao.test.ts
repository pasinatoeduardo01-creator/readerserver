import { test, expect } from "bun:test";
import { Hono } from "hono";
import { criarCookie, lerCookie, exigeSessao, NOME_COOKIE, VALIDADE_SEGUNDOS } from "./sessao";

test("cookie válido devolve o userId", async () => {
  const v = await criarCookie(7, "salt", 1000);
  expect(await lerCookie(v, "salt", 1000 + 60)).toBe(7);
});

test("cookie expirado, alterado, de outro salt ou ausente devolve null", async () => {
  const v = await criarCookie(7, "salt", 1000);
  expect(await lerCookie(v, "salt", 1000 + VALIDADE_SEGUNDOS + 1)).toBeNull();
  expect(await lerCookie(v.replace(/^./, (ch) => (ch === "A" ? "B" : "A")), "salt", 1000)).toBeNull();
  expect(await lerCookie(v, "outro", 1000)).toBeNull();
  expect(await lerCookie(undefined, "salt", 1000)).toBeNull();
  expect(await lerCookie("lixo", "salt", 1000)).toBeNull();
});

test("exigeSessao redireciona sem cookie e libera com cookie", async () => {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.use("/papel/*", exigeSessao("salt"));
  app.get("/papel/x", (c) => c.text(`user ${c.get("userId")}`));
  const sem = await app.request("/papel/x");
  expect(sem.status).toBe(302);
  expect(sem.headers.get("location")).toBe("/papel?proximo=%2Fpapel%2Fx");
  const v = await criarCookie(3, "salt");
  const com = await app.request("/papel/x", { headers: { cookie: `${NOME_COOKIE}=${v}` } });
  expect(await com.text()).toBe("user 3");
});

test("sem sessão, POST volta para a tela que tem o formulário, não para a rota do POST", async () => {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.use("/papel/*", exigeSessao("salt"));
  const localizar = await app.request("/papel/livros/abc/localizar", { method: "POST" });
  expect(localizar.status).toBe(302);
  expect(localizar.headers.get("location")).toBe("/papel?proximo=%2Fpapel%2Flivros%2Fabc");
  const enviar = await app.request("/papel/livros", { method: "POST" });
  expect(enviar.headers.get("location")).toBe("/papel?proximo=%2Fpapel");
});
