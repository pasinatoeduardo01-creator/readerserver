import { test, expect } from "bun:test";

// O `bun test` compartilha o registro de módulos entre os arquivos de teste: o
// `src/index.tsx` seria avaliado uma única vez, com o ambiente de quem importasse
// primeiro. O sufixo de consulta dá a este arquivo a sua própria cópia do módulo
// (com o salt de fábrica), sem atrapalhar o `kosync.test.ts`, que importa a cópia
// normal com um salt de verdade.
const COM_SALT_PADRAO = "./index.tsx?salt=padrao";

test("com o salt de fábrica a área do celular não sobe: /papel responde 503", async () => {
  process.env.DB_PATH = ":memory:";
  process.env.LOG_LEVEL = "silent";
  process.env.PASSWORD_SALT = "default_salt_change_in_production";
  const { default: app } = await import(COM_SALT_PADRAO);

  const lista = await app.request("/papel");
  expect(lista.status).toBe(503);
  expect(await lista.text()).toBe("Área do celular desligada: defina PASSWORD_SALT.");

  const login = await app.request("/papel/login", { method: "POST", body: new URLSearchParams({ usuario: "eduardo", senha: "x" }) });
  expect(login.status).toBe(503);

  const marcar = await app.request("/papel/livros/abc/marcar");
  expect(marcar.status).toBe(503);

  // O resto do servidor (o que os aparelhos usam) continua no ar.
  expect((await app.request("/health")).status).toBe(200);
});
