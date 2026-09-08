import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { abrirBanco } from "../db";
import { gravarProgresso } from "../progresso";
import { criarRotasPapel } from "./rotas";
import { NOME_COOKIE } from "./sessao";
import { montarEpub } from "./epub-teste";
import { hashParcialKoreader } from "./hash";
import type { LocalizadorIA } from "./ia";
import { salvarChaveApi } from "./dados";

const SALT = "salt-teste";
let db: ReturnType<typeof abrirBanco>;
let app: ReturnType<typeof criarRotasPapel>;
let dir: string;
const iaFalsa: LocalizadorIA = {
  localizar: async () => ({ status: "ok", transcricao: "t", paragrafo: 1, confianca: 0.95, candidatos: [1] }),
  testarChave: async (k) => (k === "boa" ? { ok: true } : { ok: false, mensagem: "Chave de API inválida. Confira em Configurações." }),
};
/** IA que responde com confiança abaixo de 0,7: a tela tem de perguntar em vez de afirmar. */
const iaDuvidosa: LocalizadorIA = {
  localizar: async () => ({ status: "ok", transcricao: "t", paragrafo: 0, confianca: 0.5, candidatos: [0, 1] }),
  testarChave: iaFalsa.testarChave,
};

beforeEach(async () => {
  db = abrirBanco(":memory:");
  const hash = await Bun.password.hash((await md5("senha")) + SALT);
  db.run("INSERT INTO users (username, password) VALUES ('eduardo', ?)", [hash]);
  dir = mkdtempSync(join(tmpdir(), "papel-"));
  app = criarRotasPapel({ db, salt: SALT, dirLivros: dir, ia: iaFalsa, logger: pino({ level: "silent" }) });
});

async function md5(s: string) {
  return new Bun.CryptoHasher("md5").update(s).digest("hex");
}

async function logar(): Promise<string> {
  const r = await app.request("/papel/login", { method: "POST", body: new URLSearchParams({ usuario: "eduardo", senha: "senha" }) });
  expect(r.status).toBe(302);
  const cookie = r.headers.get("set-cookie")!;
  expect(cookie).toContain(`${NOME_COOKIE}=`);
  return cookie.split(";")[0];
}

function comCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as any), cookie } };
}

function epubDeTeste() {
  return montarEpub([
    { nome: "c1.xhtml", titulo: "Um", corpo: "<p>Primeiro parágrafo do livro.</p><p>Segundo parágrafo, bem diferente.</p>" },
    { nome: "c2.xhtml", titulo: "Dois", corpo: "<p>Capítulo dois começa aqui.</p><p>E segue por aqui.</p>" },
  ]);
}

function epubComGemeos() {
  return montarEpub([
    { nome: "c1.xhtml", titulo: "Um", corpo: "<p>Gêmeo idêntico de parágrafo repetido.</p><p>Gêmeo idêntico de parágrafo repetido.</p><p>Outra coisa completamente diferente aqui.</p>" },
    { nome: "c2.xhtml", titulo: "Dois", corpo: "<p>Capítulo dois começa aqui.</p>" },
  ]);
}

async function enviarEpub(cookie: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append("epub", new File([bytes], "livro.epub", { type: "application/epub+zip" }));
  return app.request("/papel/livros", comCookie(cookie, { method: "POST", body: form }));
}

test("GET /papel sem sessão mostra o login; senha errada volta 401 com erro", async () => {
  const r = await app.request("/papel");
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('name="senha"');
  const errada = await app.request("/papel/login", { method: "POST", body: new URLSearchParams({ usuario: "eduardo", senha: "x" }) });
  expect(errada.status).toBe(401);
  expect(await errada.text()).toContain("Usuário ou senha incorretos");
});

test("rotas protegidas redirecionam sem sessão", async () => {
  const rotas: [string, RequestInit][] = [
    ["/papel/config", {}],
    ["/papel/livros/abc", {}],
    ["/papel/livros/abc/marcar", {}],
    ["/papel/sair", { method: "POST" }],
  ];
  for (const [rota, init] of rotas) {
    const r = await app.request(rota, init);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/papel?proximo=");
  }
});

test("login não sai do site: proximo externo cai em /papel, interno é respeitado", async () => {
  const fora = await app.request("/papel/login", { method: "POST", body: new URLSearchParams({ usuario: "eduardo", senha: "senha", proximo: "//evil.com" }) });
  expect(fora.status).toBe(302);
  expect(fora.headers.get("location")).toBe("/papel");

  const dentro = await app.request("/papel/login", { method: "POST", body: new URLSearchParams({ usuario: "eduardo", senha: "senha", proximo: "/papel/config" }) });
  expect(dentro.status).toBe(302);
  expect(dentro.headers.get("location")).toBe("/papel/config");
});

test("document que não é hash de documento não existe", async () => {
  const cookie = await logar();
  const r = await app.request("/papel/livros/nao-e-hash", comCookie(cookie));
  expect(r.status).toBe(404);
});

test("lista de livros mostra os do progresso e marca os sem EPUB", async () => {
  gravarProgresso(db, { userId: 1, document: "abc", progress: "/body/DocFragment[2]/body/p", percentage: 0.3, device: "KindleBasic3", deviceId: "k", title: "Livro X", authors: "Autor Y" });
  const cookie = await logar();
  const html = await (await app.request("/papel", comCookie(cookie))).text();
  expect(html).toContain("Livro X");
  expect(html).toContain("Enviar EPUB");
  expect(html).toContain("30%");
});

test("envio do EPUB: aceita cópia dos aparelhos, recusa cópia diferente do mesmo título, aceita livro novo com aviso", async () => {
  const bytes = epubDeTeste();
  const hash = hashParcialKoreader(bytes);
  gravarProgresso(db, { userId: 1, document: hash, progress: "/body/DocFragment[1]/body/p", percentage: 0.1, device: "KindleBasic3", deviceId: "k", title: "Livro de Teste", authors: "Autora Fictícia" });
  const cookie = await logar();
  const ok = await enviarEpub(cookie, bytes);
  expect(ok.status).toBe(302);
  expect(ok.headers.get("location")).toBe(`/papel/livros/${hash}`);
  expect(db.prepare("SELECT count(*) c FROM books").get()).toMatchObject({ c: 1 });

  db.run("DELETE FROM books");
  gravarProgresso(db, { userId: 1, document: "outrohash", progress: "/x", percentage: 0.1, device: "k", deviceId: "k", title: "Livro de Teste", authors: "Autora Fictícia" });
  db.run("DELETE FROM progress WHERE document = ?", [hash]);
  const recusa = await enviarEpub(cookie, bytes);
  expect(recusa.status).toBe(400);
  expect(await recusa.text()).toContain("não é a mesma que seus aparelhos usam");

  db.run("DELETE FROM progress");
  const novo = await enviarEpub(cookie, bytes);
  expect(novo.status).toBe(302);
  expect(novo.headers.get("location")).toContain("aviso=");
  const tela = await (await app.request(`/papel/livros/${hash}`, comCookie(cookie))).text();
  expect(tela).toContain("Nenhum aparelho sincronizou este arquivo ainda");

  const invalido = await enviarEpub(cookie, new TextEncoder().encode("nada"));
  expect(invalido.status).toBe(400);
});

test("índice sumido do disco: o livro volta a pedir o EPUB e nenhuma tela quebra", async () => {
  const bytes = epubDeTeste();
  const hash = hashParcialKoreader(bytes);
  gravarProgresso(db, { userId: 1, document: hash, progress: "/body/DocFragment[2]/body/p", percentage: 0.5, device: "KindleBasic3", deviceId: "k", title: "Livro de Teste" });
  const cookie = await logar();
  await enviarEpub(cookie, bytes);
  rmSync(join(dir, `${hash}.index.json`));

  const lista = await app.request("/papel", comCookie(cookie));
  expect(lista.status).toBe(200);
  expect(await lista.text()).toContain("Sem EPUB no servidor");

  const livro = await app.request(`/papel/livros/${hash}`, comCookie(cookie));
  expect(livro.status).toBe(200);
  expect(await livro.text()).toContain("O índice deste livro sumiu do servidor");
});

test("configurações: salva a chave cifrada, mostra só o fim, testa e remove", async () => {
  const cookie = await logar();
  const salvar = await app.request("/papel/config", comCookie(cookie, { method: "POST", body: new URLSearchParams({ acao: "salvar", chave: "sk-ant-1234567890" }) }));
  expect(salvar.status).toBe(302);
  const linha = db.prepare("SELECT api_key_enc FROM settings WHERE user_id = 1").get() as any;
  expect(linha.api_key_enc).not.toContain("sk-ant");
  const tela = await (await app.request("/papel/config", comCookie(cookie))).text();
  expect(tela).toContain("7890");
  expect(tela).not.toContain("sk-ant-1234567890");
  const teste = await app.request("/papel/config", comCookie(cookie, { method: "POST", body: new URLSearchParams({ acao: "testar", chave: "boa" }) }));
  expect(await teste.text()).toContain("Chave válida");
  const remover = await app.request("/papel/config", comCookie(cookie, { method: "POST", body: new URLSearchParams({ acao: "remover" }) }));
  expect(remover.status).toBe(302);
  expect((db.prepare("SELECT api_key_enc FROM settings WHERE user_id = 1").get() as any).api_key_enc).toBeNull();
});

test("tela do livro: salva total de páginas e mostra página estimada", async () => {
  const bytes = epubDeTeste();
  const hash = hashParcialKoreader(bytes);
  gravarProgresso(db, { userId: 1, document: hash, progress: "/body/DocFragment[2]/body/p", percentage: 0.5, device: "KindleBasic3", deviceId: "k", title: "Livro de Teste" });
  const cookie = await logar();
  await enviarEpub(cookie, bytes);
  const r = await app.request(`/papel/livros/${hash}/paginas`, comCookie(cookie, { method: "POST", body: new URLSearchParams({ paginas: "200" }) }));
  expect(r.status).toBe(302);
  const tela = await (await app.request(`/papel/livros/${hash}`, comCookie(cookie))).text();
  expect(tela).toMatch(/≈ pág\. \d+/);
  expect(tela).toContain("Kindle");
});

async function livroPronto(bytes: Uint8Array = epubDeTeste()): Promise<{ cookie: string; hash: string }> {
  const hash = hashParcialKoreader(bytes);
  gravarProgresso(db, { userId: 1, document: hash, progress: "/body/DocFragment[1]/body/p", percentage: 0.05, device: "KindleBasic3", deviceId: "k", title: "Livro de Teste", authors: "Autora Fictícia", filename: "livro.epub" });
  const cookie = await logar();
  await enviarEpub(cookie, bytes);
  return { cookie, hash };
}

async function localizar(cookie: string, hash: string, campos: Record<string, string>, foto?: Uint8Array, tipoFoto = "image/jpeg") {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, v);
  // O Bun deduz o tipo do multipart pela extensão do nome, então o nome acompanha o tipo.
  if (foto) form.append("foto", new File([foto], `pagina.${tipoFoto.split("/")[1]}`, { type: tipoFoto }));
  return app.request(`/papel/livros/${hash}/localizar`, comCookie(cookie, { method: "POST", body: form }));
}

test("formulário de marcar lista os capítulos e pré-seleciona o da posição atual", async () => {
  const { cookie, hash } = await livroPronto();
  const html = await (await app.request(`/papel/livros/${hash}/marcar`, comCookie(cookie))).text();
  // O JSX do Hono serializa atributo booleano como `selected=""` (nunca como nome solto).
  expect(html).toContain('<option value="0" selected="">Um</option>');
  expect(html).toContain('<option value="1">Dois</option>');
  expect(html).toContain('name="foto"');
  expect(html).toContain('name="trecho"');
  // O CSS vai cru: escapado, `"Segoe UI"` virava `&quot;…&quot;` e todas as telas caíam em fonte serifada.
  expect(html).toContain('"Segoe UI"');
});

test("texto no mesmo idioma: casa localmente, mostra vizinhos e confirma gravando no progresso", async () => {
  const { cookie, hash } = await livroPronto();
  const r = await localizar(cookie, hash, { capitulo: "1", modo: "auto", trecho: "E segue por aqui", pagina: "42" });
  const html = await r.text();
  expect(r.status).toBe(200);
  expect(html).toContain("E segue por aqui.");
  expect(html).toContain('name="paragrafo" value="3"');
  expect(html).toContain('name="origem" value="local"');
  expect(html).toContain("Capítulo dois começa aqui.");   // vizinho de cima
  const conf = await app.request(`/papel/livros/${hash}/confirmar`, comCookie(cookie, { method: "POST", body: new URLSearchParams({ paragrafo: "3", pagina: "42", metodo: "texto", origem: "local", confianca: "0.9", texto_entrada: "E segue por aqui" }) }));
  expect(conf.status).toBe(302);
  const prog = db.prepare("SELECT * FROM progress WHERE document = ?").get(hash) as any;
  // O progresso vai com o sufixo `.0` (offset zero no elemento), que crengine, Readest e CrossPoint aceitam.
  expect(prog).toMatchObject({ device: "Livro físico", device_id: "papel", progress: "/body/DocFragment[2]/body/p[2].0", title: "Livro de Teste", filename: "livro.epub" });
  expect(prog.percentage).toBeGreaterThan(0.5);
  const marca = db.prepare("SELECT * FROM paper_marks WHERE document = ?").get(hash) as any;
  expect(marca).toMatchObject({ paragraph: 3, paper_page: 42, method: "texto", matched_by: "local" });
  const tela = await (await app.request(`/papel/livros/${hash}`, comCookie(cookie))).text();
  expect(tela).toContain("Livro físico");
});

test("trecho de outro capítulo: acha no livro inteiro e o cabeçalho mostra o capítulo do parágrafo", async () => {
  const { cookie, hash } = await livroPronto();
  const html = await (await localizar(cookie, hash, { capitulo: "0", modo: "auto", trecho: "E segue por aqui" })).text();
  expect(html).toContain('name="paragrafo" value="3"');
  expect(html).toContain('<p class="muted">Dois</p>');
  expect(html).not.toContain('<p class="muted">Um</p>');
});

test("início do capítulo grava o primeiro parágrafo do capítulo", async () => {
  const { cookie, hash } = await livroPronto();
  const html = await (await localizar(cookie, hash, { capitulo: "1", modo: "inicio" })).text();
  expect(html).toContain('name="paragrafo" value="2"');
  expect(html).toContain('name="origem" value="manual"');
});

test("foto sem chave de API avisa; com chave usa a IA e mostra o parágrafo dela", async () => {
  const { cookie, hash } = await livroPronto();
  const sem = await localizar(cookie, hash, { capitulo: "0", modo: "auto" }, new Uint8Array([1, 2, 3]));
  expect(await sem.text()).toContain("Sem chave de API");
  await salvarChaveApi(db, 1, "k", SALT);
  const com = await localizar(cookie, hash, { capitulo: "0", modo: "auto" }, new Uint8Array([1, 2, 3]));
  const html = await com.text();
  expect(html).toContain('name="paragrafo" value="1"');    // iaFalsa devolve o parágrafo 1 do capítulo 0
  expect(html).toContain('name="origem" value="ia"');
  expect(html).toContain('name="metodo" value="foto"');
});

test("foto em formato que a API não aceita volta com o formato na mensagem", async () => {
  const { cookie, hash } = await livroPronto();
  await salvarChaveApi(db, 1, "k", SALT);
  const r = await localizar(cookie, hash, { capitulo: "0", modo: "auto" }, new Uint8Array([1, 2, 3]), "image/heic");
  expect(r.status).toBe(400);
  expect(await r.text()).toContain("Formato de foto não aceito");
});

test("texto que não casa e sem chave: mensagem com alternativas", async () => {
  const { cookie, hash } = await livroPronto();
  const nada = await (await localizar(cookie, hash, { capitulo: "0", modo: "auto", trecho: "frase inexistente neste livro" })).text();
  expect(nada).toContain("Não encontrei");
  expect(nada).toContain("início do capítulo");
});

test("parágrafos gêmeos: a tela pergunta e oferece um formulário para cada candidato", async () => {
  const { cookie, hash } = await livroPronto(epubComGemeos());
  const html = await (await localizar(cookie, hash, { capitulo: "0", modo: "auto", trecho: "Gêmeo idêntico de parágrafo" })).text();
  expect(html).toContain("Qual destes?");
  expect(html).toContain("Outras possibilidades");
  const confirmares = html.match(new RegExp(`action="/papel/livros/${hash}/confirmar"`, "g")) ?? [];
  expect(confirmares.length).toBeGreaterThanOrEqual(2);
});

test("texto que não casa, com chave cadastrada: cai na IA e a tela diz que veio dela", async () => {
  const { cookie, hash } = await livroPronto();
  await salvarChaveApi(db, 1, "k", SALT);
  const html = await (await localizar(cookie, hash, { capitulo: "0", modo: "auto", trecho: "frase inexistente neste livro" })).text();
  expect(html).toContain('name="origem" value="ia"');
  expect(html).toContain('name="metodo" value="texto"');
  expect(html).toContain("Localizado pela IA");
});

test("IA com confiança baixa: pergunta qual dos candidatos em vez de afirmar", async () => {
  const { cookie, hash } = await livroPronto();
  await salvarChaveApi(db, 1, "k", SALT);
  const app2 = criarRotasPapel({ db, salt: SALT, dirLivros: dir, ia: iaDuvidosa, logger: pino({ level: "silent" }) });
  const form = new FormData();
  for (const [k, v] of Object.entries({ capitulo: "0", modo: "auto", trecho: "frase inexistente neste livro" })) form.append(k, v);
  const html = await (await app2.request(`/papel/livros/${hash}/localizar`, comCookie(cookie, { method: "POST", body: form }))).text();
  expect(html).toContain("Qual destes?");
  expect(html).toContain("Outras possibilidades");
  expect(html).toContain('name="origem" value="ia"');
});

test("confirmar com parágrafo inválido devolve 400 e não grava", async () => {
  const { cookie, hash } = await livroPronto();
  const r = await app.request(`/papel/livros/${hash}/confirmar`, comCookie(cookie, { method: "POST", body: new URLSearchParams({ paragrafo: "999", metodo: "texto", origem: "local" }) }));
  expect(r.status).toBe(400);
  expect((db.prepare("SELECT device FROM progress WHERE document = ?").get(hash) as any).device).toBe("KindleBasic3");
});
