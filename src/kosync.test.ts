import { test, expect } from "bun:test";

// Regressão do que os aparelhos usam (Kindle/KOReader, Readest, CrossPoint), pelo app
// de verdade: as rotas de sincronização não podem quebrar por causa da área do celular.
// O ambiente é definido antes do import porque o `src/index.tsx` lê tudo na avaliação.
process.env.DB_PATH = ":memory:";
process.env.PASSWORD_SALT = "salt-teste";
process.env.DISABLE_USER_REGISTRATION = "false";
process.env.LOG_LEVEL = "silent";
const { default: app } = await import("./index");

const USUARIO = "aparelho";
const CHAVE = "1a79a4d60de6718e8e5b326e338ae533"; // md5 da senha, como o KOReader envia
const DOCUMENTO = "a3151aa606c6367fd86a1443a4e701a7";
const autenticado = { "x-auth-user": USUARIO, "x-auth-key": CHAVE };

test("ciclo do aparelho: cria a conta, envia o progresso, lê de volta e lista o documento", async () => {
  const criar = await app.request("/users/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USUARIO, password: CHAVE }),
  });
  expect(criar.status).toBe(201);

  const enviar = await app.request("/syncs/progress", {
    method: "PUT",
    headers: { ...autenticado, "content-type": "application/json" },
    body: JSON.stringify({
      document: DOCUMENTO,
      progress: "/body/DocFragment[8]/body/div/p[4]/text().287",
      percentage: 0.2955,
      device: "KindleBasic3",
      device_id: "kindle-1",
      metadata: { title: "The Time Machine", authors: "H. G. Wells", filename: "time-machine.epub" },
    }),
  });
  expect(enviar.status).toBe(200);

  const ler = await app.request(`/syncs/progress/${DOCUMENTO}`, { headers: autenticado });
  expect(ler.status).toBe(200);
  expect(await ler.json()).toMatchObject({
    document: DOCUMENTO,
    progress: "/body/DocFragment[8]/body/div/p[4]/text().287",
    percentage: 0.2955,
    device: "KindleBasic3",
    device_id: "kindle-1",
  });

  const lista = await app.request("/syncs/documents", { headers: autenticado });
  expect(lista.status).toBe(200);
  const { documents } = (await lista.json()) as { documents: { document: string; title: string }[] };
  expect(documents.length).toBe(1);
  expect(documents[0]).toMatchObject({ document: DOCUMENTO, title: "The Time Machine" });
});

test("credencial errada não passa e não vaza progresso", async () => {
  const semCabecalho = await app.request(`/syncs/progress/${DOCUMENTO}`);
  expect(semCabecalho.status).toBe(401);
  const chaveErrada = await app.request(`/syncs/progress/${DOCUMENTO}`, { headers: { "x-auth-user": USUARIO, "x-auth-key": "outra" } });
  expect(chaveErrada.status).toBe(401);
});
