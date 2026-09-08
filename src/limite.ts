import { HTTPException } from "hono/http-exception";
import { getConnInfo } from "hono/bun";
import type { Context, Next } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Chamado a cada requisição com a chave usada na contagem. Este arquivo não tem
   * logger próprio (é usado antes de o servidor montar o seu), então quem monta o
   * limitador decide o que fazer com a chave — sem isso, um limite disparando por
   * causa de um proxy mal configurado não deixa rastro nenhum.
   */
  aoContar?: (chave: string) => void;
}

/**
 * Identifica o cliente para a contagem. O `x-forwarded-for` é uma lista em que
 * cada proxy acrescenta um salto ao FIM: o último item é o único que o cliente
 * não consegue forjar, por isso é ele que conta (pegar o primeiro deixaria
 * qualquer um trocar de identidade e furar o limite).
 */
function chaveDoCliente(c: Context): string {
  const ultimoSalto = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  if (ultimoSalto) return ultimoSalto;

  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;

  try {
    const endereco = getConnInfo(c).remote.address;
    if (endereco) return endereco;
  } catch {
    // Fora do servidor do Bun (testes, por exemplo) não há endereço de conexão.
  }

  return "unknown";
}

export function rateLimiter({ windowMs, max, aoContar }: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, windowMs).unref();

  return async (c: Context, next: Next) => {
    const key = chaveDoCliente(c);
    aoContar?.(key);
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > max) {
        throw new HTTPException(429, { message: "Too many requests" });
      }
    }

    await next();
  };
}
