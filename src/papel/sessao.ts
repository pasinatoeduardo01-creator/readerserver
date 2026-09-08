import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export const NOME_COOKIE = "papel_sessao";
export const VALIDADE_SEGUNDOS = 30 * 24 * 3600;

const codificador = new TextEncoder();

async function chaveHmac(salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", codificador.encode(`${salt}:papel-sessao`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function assinar(carga: string, salt: string): Promise<string> {
  const k = await chaveHmac(salt);
  const sig = await crypto.subtle.sign("HMAC", k, codificador.encode(carga));
  return Buffer.from(sig).toString("base64url");
}

export async function criarCookie(userId: number, salt: string, agora = Math.floor(Date.now() / 1000)): Promise<string> {
  const carga = Buffer.from(JSON.stringify({ u: userId, exp: agora + VALIDADE_SEGUNDOS })).toString("base64url");
  return `${carga}.${await assinar(carga, salt)}`;
}

export async function lerCookie(valor: string | undefined, salt: string, agora = Math.floor(Date.now() / 1000)): Promise<number | null> {
  if (!valor) return null;
  const [carga, assinatura] = valor.split(".");
  if (!carga || !assinatura) return null;
  const esperada = await assinar(carga, salt);
  if (esperada.length !== assinatura.length) return null;
  let diff = 0;
  for (let i = 0; i < esperada.length; i++) diff |= esperada.charCodeAt(i) ^ assinatura.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const dados = JSON.parse(Buffer.from(carga, "base64url").toString("utf8")) as { u?: number; exp?: number };
    if (typeof dados.u !== "number" || typeof dados.exp !== "number" || dados.exp <= agora) return null;
    return dados.u;
  } catch {
    return null;
  }
}

export function exigeSessao(salt: string): MiddlewareHandler<{ Variables: { userId: number } }> {
  return async (c, next) => {
    const userId = await lerCookie(getCookie(c, NOME_COOKIE), salt);
    if (userId === null) {
      const caminho = new URL(c.req.url).pathname;
      // Depois do login o navegador faz um GET; repetir um POST é impossível (o corpo
      // se perde) e cairia em 404 ou erro. Para POST, volta-se à tela que tem o
      // formulário: /papel/livros/abc/localizar → /papel/livros/abc, /papel/livros → /papel.
      const destino = c.req.method === "GET" ? caminho : caminho.slice(0, caminho.lastIndexOf("/")) || "/papel";
      return c.redirect(`/papel?proximo=${encodeURIComponent(destino)}`, 302);
    }
    c.set("userId", userId);
    await next();
  };
}

export function gravarCookieSessao(c: Context, valor: string): void {
  setCookie(c, NOME_COOKIE, valor, { httpOnly: true, secure: true, sameSite: "Lax", path: "/papel", maxAge: VALIDADE_SEGUNDOS });
}

export function apagarCookieSessao(c: Context): void {
  deleteCookie(c, NOME_COOKIE, { path: "/papel" });
}
