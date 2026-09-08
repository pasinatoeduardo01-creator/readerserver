import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { hashParcialKoreader } from "./hash";

function buffer(n: number, f: (i: number) => number) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = f(i) & 255;
  return b;
}

test("arquivo pequeno (menos de 1 KB): hash = MD5 do arquivo inteiro", () => {
  expect(hashParcialKoreader(buffer(500, (i) => i * 13 + 1))).toBe("06a81ca0008524b590c83ee344e401d4");
});

test("arquivo de 300 000 bytes: bate com a referência calculada em Python", () => {
  expect(hashParcialKoreader(buffer(300000, (i) => i * 7 + 3))).toBe("7f79a1051a44620f9633d5a081d3f5b6");
});

const LIVRO_REAL = `${process.env.HOME}/Documents/Reading/Time Machine - H.G Wells .epub`;
test.skipIf(!existsSync(LIVRO_REAL))("The Time Machine real: mesmo hash que o Kindle gravou", async () => {
  const bytes = new Uint8Array(await Bun.file(LIVRO_REAL).arrayBuffer());
  expect(hashParcialKoreader(bytes)).toBe("a3151aa606c6367fd86a1443a4e701a7");
});
