import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { rateLimiter } from "../limite";
import { getCookie } from "hono/cookie";
import { criarCookie, lerCookie, NOME_COOKIE, exigeSessao, gravarCookieSessao, apagarCookieSessao } from "./sessao";
import { indexarEpub, ErroEpub, capituloDoParagrafo, paragrafoDoXpath } from "./epub-index";
import { hashParcialKoreader } from "./hash";
import * as dados from "./dados";
import { TelaLogin, TelaLivros, TelaConfig, TelaLivro } from "./telas";
import type { LocalizadorIA } from "./ia";

export interface DepsPapel { db: Database; salt: string; dirLivros: string; ia: LocalizadorIA; logger: pino.Logger }
type Env = { Variables: { userId: number } };

/** Todo `document` nosso é o MD5 parcial do KOReader; nada além disso vira caminho nem cabeçalho. */
const HASH = /^[0-9a-f]{32}$/;

function md5(s: string): string {
  return new Bun.CryptoHasher("md5").update(s).digest("hex");
}

function caminhoSeguro(proximo: string | undefined): string {
  return proximo && proximo.startsWith("/papel") ? proximo : "/papel";
}

export function criarRotasPapel(deps: DepsPapel): Hono<Env> {
  const { db, salt, dirLivros, ia, logger } = deps;
  mkdirSync(dirLivros, { recursive: true });
  const app = new Hono<Env>();

  app.use("/papel/login", rateLimiter({ windowMs: 60_000, max: 10 }));

  app.get("/papel", async (c) => {
    const userId = await lerCookie(getCookie(c, NOME_COOKIE), salt);
    if (userId === null) return c.html(<TelaLogin proximo={c.req.query("proximo")} />);
    const livros = dados.listarLivros(db, userId);
    const paginas = new Map<string, number | null>();
    const semIndice = new Set<string>();
    for (const l of livros) {
      if (!l.temEpub) continue;
      const livro = dados.obterLivro(db, userId, l.document);
      if (!livro) { semIndice.add(l.document); continue; }
      try {
        const indice = await dados.carregarIndice(livro.index_path);
        if (livro.paper_pages) paginas.set(l.document, dados.paginaEstimada(db, userId, livro, indice));
      } catch (e) {
        // Índice sumido ou ilegível: o livro vale como "sem EPUB" e o cartão pede o reenvio.
        logger.warn({ userId, document: l.document, err: e }, "Índice do livro ilegível");
        semIndice.add(l.document);
      }
    }
    const lista = semIndice.size === 0 ? livros : livros.map((l) => (semIndice.has(l.document) ? { ...l, temEpub: false } : l));
    return c.html(<TelaLivros livros={lista} paginas={paginas} aviso={c.req.query("aviso")} />);
  });

  app.post("/papel/login", async (c) => {
    const form = await c.req.parseBody();
    const usuario = String(form["usuario"] ?? "");
    const senha = String(form["senha"] ?? "");
    const proximo = caminhoSeguro(String(form["proximo"] ?? ""));
    const user = db.prepare("SELECT id, password FROM users WHERE username = ?").get(usuario) as { id: number; password: string } | null;
    const ok = user && (await Bun.password.verify(md5(senha) + salt, user.password));
    if (!ok) {
      logger.warn({ usuario }, "Login do papel falhou");
      return c.html(<TelaLogin erro="Usuário ou senha incorretos." proximo={proximo} />, 401);
    }
    gravarCookieSessao(c, await criarCookie(user.id, salt));
    return c.redirect(proximo, 302);
  });

  app.use("/papel/*", exigeSessao(salt));

  app.post("/papel/sair", (c) => {
    apagarCookieSessao(c);
    return c.redirect("/papel", 302);
  });

  app.get("/papel/config", async (c) => {
    const chave = await dados.lerChaveApi(db, c.get("userId"), salt);
    return c.html(<TelaConfig fimDaChave={chave ? chave.slice(-4) : null} mensagem={c.req.query("msg")} />);
  });

  app.post("/papel/config", async (c) => {
    const userId = c.get("userId");
    const form = await c.req.parseBody();
    const acao = String(form["acao"] ?? "salvar");
    const chave = String(form["chave"] ?? "").trim();
    if (acao === "remover") {
      await dados.salvarChaveApi(db, userId, null, salt);
      return c.redirect("/papel/config?msg=" + encodeURIComponent("Chave removida."), 302);
    }
    if (acao === "testar") {
      const alvo = chave || (await dados.lerChaveApi(db, userId, salt)) || "";
      const r = await ia.testarChave(alvo);
      const atual = await dados.lerChaveApi(db, userId, salt);
      return c.html(<TelaConfig fimDaChave={atual ? atual.slice(-4) : null} mensagem={r.ok ? "Chave válida." : undefined} erro={r.ok ? undefined : r.mensagem} />);
    }
    if (!chave) return c.html(<TelaConfig fimDaChave={null} erro="Cole a chave antes de salvar." />, 400);
    await dados.salvarChaveApi(db, userId, chave, salt);
    return c.redirect("/papel/config?msg=" + encodeURIComponent("Chave salva."), 302);
  });

  app.post("/papel/livros", async (c) => {
    const userId = c.get("userId");
    const form = await c.req.parseBody();
    const arquivo = form["epub"];
    if (!(arquivo instanceof File)) return c.html(<TelaLivros livros={dados.listarLivros(db, userId)} paginas={new Map()} aviso="Escolha um arquivo .epub." />, 400);
    if (arquivo.size > 30 * 1024 * 1024) return c.html(<TelaLivros livros={dados.listarLivros(db, userId)} paginas={new Map()} aviso="Arquivo maior que 30 MB." />, 400);
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    const document = hashParcialKoreader(bytes);
    let indice;
    try {
      indice = indexarEpub(bytes, document);
    } catch (e) {
      const msg = e instanceof ErroEpub ? `EPUB inválido: ${e.message}.` : "Não consegui ler este EPUB.";
      return c.html(<TelaLivros livros={dados.listarLivros(db, userId)} paginas={new Map()} aviso={msg} />, 400);
    }
    const mesmoHash = dados.progressoDoLivro(db, userId, document);
    let aviso: string | undefined;
    if (!mesmoHash) {
      if (indice.title) {
        const outro = db.prepare(`SELECT document FROM progress WHERE user_id = ? AND document != ? AND lower(title) = lower(?) AND COALESCE(lower(authors), '') = COALESCE(lower(?), '')`)
          .get(userId, document, indice.title, indice.authors) as { document: string } | null;
        if (outro) {
          return c.html(<TelaLivros livros={dados.listarLivros(db, userId)} paginas={new Map()} aviso="Esta cópia não é a mesma que seus aparelhos usam (hash diferente). Envie o arquivo que está no Kindle/Readest." />, 400);
        }
      }
      aviso = "Nenhum aparelho sincronizou este arquivo ainda; use exatamente esta cópia neles.";
    }
    const epubPath = join(dirLivros, `${document}.epub`);
    const indexPath = join(dirLivros, `${document}.index.json`);
    await Bun.write(epubPath, bytes);
    await Bun.write(indexPath, JSON.stringify(indice));
    dados.salvarLivro(db, userId, indice, epubPath, indexPath);
    logger.info({ userId, document, paragrafos: indice.paragraphs.length }, "EPUB indexado");
    return c.redirect(`/papel/livros/${document}${aviso ? "?aviso=" + encodeURIComponent(aviso) : ""}`, 302);
  });

  app.get("/papel/livros/:document", async (c) => {
    const userId = c.get("userId");
    const document = c.req.param("document");
    if (!HASH.test(document)) return c.notFound();
    const livro = dados.obterLivro(db, userId, document);
    if (!livro) return c.redirect("/papel?aviso=" + encodeURIComponent("Envie o EPUB deste livro primeiro."), 302);
    const progresso = dados.progressoDoLivro(db, userId, livro.document);
    const marcas = dados.listarMarcas(db, userId, livro.document);
    let indice;
    try {
      indice = await dados.carregarIndice(livro.index_path);
    } catch (e) {
      // Sem o índice não há capítulo nem página no papel; a porcentagem vem do banco e continua valendo.
      logger.warn({ userId, document, err: e }, "Índice do livro ilegível");
      return c.html(<TelaLivro livro={livro} progresso={progresso} capitulo={null} pagina={null} marcas={marcas} aviso="O índice deste livro sumiu do servidor. Reenvie o EPUB." />);
    }
    const p = progresso ? paragrafoDoXpath(indice, progresso.progress) : null;
    const capitulo = p !== null ? capituloDoParagrafo(indice, p)?.title ?? null : null;
    return c.html(<TelaLivro livro={livro} progresso={progresso} capitulo={capitulo} pagina={dados.paginaEstimada(db, userId, livro, indice)} marcas={marcas} aviso={c.req.query("aviso")} mensagem={c.req.query("msg")} />);
  });

  app.post("/papel/livros/:document/paginas", async (c) => {
    const userId = c.get("userId");
    const document = c.req.param("document");
    if (!HASH.test(document)) return c.notFound();
    const form = await c.req.parseBody();
    const n = parseInt(String(form["paginas"] ?? ""), 10);
    dados.salvarPaginas(db, userId, document, Number.isFinite(n) && n > 0 ? n : null);
    return c.redirect(`/papel/livros/${document}?msg=${encodeURIComponent("Total de páginas salvo.")}`, 302);
  });

  return app;
}
