import { test, expect } from "bun:test";
import { cifrar, decifrar } from "./cifra";

test("ida e volta com o mesmo salt", async () => {
  const c = await cifrar("sk-ant-abc123", "salt-x");
  expect(c).not.toContain("sk-ant");
  expect(await decifrar(c, "salt-x")).toBe("sk-ant-abc123");
});

test("cada cifragem gera valor diferente (IV aleatório)", async () => {
  expect(await cifrar("a", "s")).not.toBe(await cifrar("a", "s"));
});

test("salt errado não decifra", async () => {
  const c = await cifrar("segredo", "salt-1");
  await expect(decifrar(c, "salt-2")).rejects.toThrow();
});
