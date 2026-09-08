# Livro físico no Reader Server — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que Eduardo marque, pelo celular (foto ou texto), onde parou num livro de papel, e que o servidor grave isso como progresso KOSync no mesmo hash do livro, para Kindle, Readest e X3 abrirem no parágrafo certo; e estimar, no painel, a página do papel correspondente à leitura digital.

**Architecture:** Tudo no serviço Hono/Bun existente (`src/index.tsx`). Área nova `/papel/*` com sessão por cookie assinado; EPUB enviado uma vez e indexado em JSON (parágrafos com XPath no formato do KOReader + deslocamento de caracteres); casamento local por trigramas e, para foto ou tradução, uma chamada à API da Anthropic com saída estruturada; gravação na tabela `progress` pela mesma função que o `PUT /syncs/progress` usa. Estimativa inversa por interpolação entre marcações.

**Tech Stack:** Bun 1.x, Hono 4 (JSX do Hono), `bun:sqlite`, `fflate`, `htmlparser2` + `domhandler` + `domutils`, `@anthropic-ai/sdk` + `zod`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-08-livro-fisico-design.md`

## Global Constraints

- Rotas KOSync existentes (`/users/auth`, `PUT /syncs/progress`, `GET /syncs/progress/:document`, `GET /syncs/documents`) não mudam de comportamento; o teste de regressão da Tarefa 1 garante.
- XPath sempre no formato `/body/DocFragment[N]/body/...` sem `[1]`; livro de espinha única usa `/body/DocFragment/body/...`.
- Chave de API só no banco (`settings.api_key_enc`, AES-GCM); nenhuma variável de ambiente nova. A foto nunca é gravada em disco.
- Toda rota `/papel/*` exige sessão, exceto `GET /papel` (login) e `POST /papel/login`.
- Textos de interface em português; paleta preto/branco/azul, vermelho só para alerta; sem rolagem horizontal; botões com altura mínima de 48 px.
- Commits pequenos, um por tarefa, mensagem em português no imperativo, terminando com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Nunca `git add -A`: sempre nomear os arquivos. **Não fazer push nem deploy sem o Eduardo pedir.**
- Rodar `bun test` antes de cada commit; tudo verde.

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/db.ts` (novo) | Abre o SQLite (caminho por `DB_PATH`, padrão `data/koreader-sync.db`) e cria todas as tabelas. |
| `src/progresso.ts` (novo) | `gravarProgresso()`: o UPSERT em `progress`, usado pelos aparelhos e pelo papel. |
| `src/index.tsx` (modificar) | Passa a usar `db.ts` e `progresso.ts`; monta `/papel`. |
| `src/papel/hash.ts` (novo) | Hash parcial MD5 do KOReader. |
| `src/papel/epub-index.ts` (novo) | Indexador do EPUB. |
| `src/papel/casamento.ts` (novo) | Casamento local por trigramas. |
| `src/papel/pagina.ts` (novo) | Estimativa da página no papel. |
| `src/papel/cifra.ts` (novo) | Cifra/decifra a chave de API. |
| `src/papel/sessao.ts` (novo) | Cookie assinado e middleware. |
| `src/papel/ia.ts` (novo) | Chamada à API da Anthropic. |
| `src/papel/telas.tsx` (novo) | JSX das telas de `/papel`. |
| `src/papel/rotas.tsx` (novo) | Rotas `/papel/*`. |
| `src/dashboard.tsx` (modificar) | Livro físico, página estimada, link. |
| `public/papel.js` (novo) | Reduz a foto no celular antes do envio. |
| `README.md` (modificar) | Seção "Marcar no papel". |

---

### Task 0: Ambiente local (Bun) e dependências

**Files:**
- Modify: `package.json`
- Modify: `bun.lock` (gerado)

**Interfaces:**
- Produces: `bun test` funcionando no Mac; dependências instaladas.

- [ ] **Step 1: Instalar o Bun no Mac** (pedir confirmação ao Eduardo antes, é instalação de sistema)

```bash
brew install oven-sh/bun/bun
bun --version   # esperado: 1.x
```

- [ ] **Step 2: Acrescentar dependências e o script de teste**

Em `package.json`, deixar assim (mantendo o resto):

```json
{
  "scripts": {
    "dev": "bun run --hot src/index.tsx",
    "build": "bun build ./src/index.tsx --target=bun --outfile server.js",
    "test": "bun test",
    "release": "bumpp && gh release create v$(bun -e \"const p = require('./package.json'); process.stdout.write(p.version)\") --generate-notes"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.90.0",
    "domhandler": "^5.0.3",
    "domutils": "^3.2.2",
    "fflate": "^0.8.2",
    "hono": "4.13.5",
    "htmlparser2": "^10.0.0",
    "pino": "10.3.1",
    "pino-pretty": "13.1.3",
    "zod": "^3.24.0"
  }
}
```

Depois:

```bash
cd ~/kosync-server/app && bun install
```

Se alguma versão acima não existir, usar a mais recente estável (`bun add fflate htmlparser2 domhandler domutils @anthropic-ai/sdk zod`) e conferir que `@anthropic-ai/sdk` exporta `zodOutputFormat` em `@anthropic-ai/sdk/helpers/zod` (`grep -r zodOutputFormat node_modules/@anthropic-ai/sdk/helpers/zod/`).

- [ ] **Step 3: Conferir que o build atual continua passando**

```bash
bun run build && ls -la server.js && rm server.js
```

Esperado: `server.js` gerado sem erro (ele está no `.gitignore`).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "Adiciona dependências do livro físico e script de teste

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Banco por caminho configurável e `gravarProgresso()` extraído (regressão dos aparelhos)

**Files:**
- Create: `src/db.ts`
- Create: `src/progresso.ts`
- Create: `src/progresso.test.ts`
- Modify: `src/index.tsx` (linhas 130–179: criação do banco; linhas 461–571: handler `PUT /syncs/progress`; linha 193: `setInterval` do rate limiter)

**Interfaces:**
- Produces: `abrirBanco(caminho?: string): Database` em `src/db.ts` (cria as tabelas `users`, `progress`, `books`, `paper_marks`, `settings`).
- Produces: `gravarProgresso(db: Database, p: NovoProgresso): void` em `src/progresso.ts`, com
  ```ts
  export interface NovoProgresso {
    userId: number; document: string; progress: string; percentage: number;
    device: string; deviceId: string;
    filename?: string | null; title?: string | null; authors?: string | null;
    timestamp?: number; // segundos; padrão = agora
  }
  ```

- [ ] **Step 1: Escrever o teste que falha**

`src/progresso.test.ts`:

```ts
import { test, expect } from "bun:test";
import { abrirBanco } from "./db";
import { gravarProgresso } from "./progresso";

function bancoComUsuario() {
  const db = abrirBanco(":memory:");
  db.run("INSERT INTO users (username, password) VALUES ('u', 'x')");
  return db;
}

test("gravarProgresso insere e depois atualiza mantendo título quando o novo é nulo", () => {
  const db = bancoComUsuario();
  gravarProgresso(db, {
    userId: 1, document: "abc", progress: "/body/DocFragment[2]/body/p[3]", percentage: 0.1,
    device: "KindleBasic3", deviceId: "k1", title: "Livro", authors: "Autor", filename: "l.epub", timestamp: 100,
  });
  gravarProgresso(db, {
    userId: 1, document: "abc", progress: "/body/DocFragment[3]/body/p", percentage: 0.2,
    device: "Livro físico", deviceId: "papel", timestamp: 200,
  });
  const linhas = db.prepare("SELECT * FROM progress").all() as any[];
  expect(linhas).toHaveLength(1);
  expect(linhas[0]).toMatchObject({
    document: "abc", progress: "/body/DocFragment[3]/body/p", percentage: 0.2,
    device: "Livro físico", device_id: "papel", title: "Livro", authors: "Autor", filename: "l.epub", timestamp: 200,
  });
});

test("gravarProgresso usa o horário atual quando timestamp é omitido", () => {
  const db = bancoComUsuario();
  const antes = Math.floor(Date.now() / 1000);
  gravarProgresso(db, { userId: 1, document: "d", progress: "/body/DocFragment/body/p", percentage: 0, device: "x", deviceId: "y" });
  const t = (db.prepare("SELECT timestamp FROM progress").get() as any).timestamp;
  expect(t).toBeGreaterThanOrEqual(antes);
});

test("abrirBanco cria as tabelas novas", () => {
  const db = abrirBanco(":memory:");
  const nomes = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
  for (const t of ["users", "progress", "books", "paper_marks", "settings"]) expect(nomes).toContain(t);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/progresso.test.ts
```

Esperado: erro de módulo não encontrado (`./db`, `./progresso`).

- [ ] **Step 3: Criar `src/db.ts`**

```ts
import { Database } from "bun:sqlite";

export function abrirBanco(caminho = process.env.DB_PATH || "data/koreader-sync.db"): Database {
  const db = new Database(caminho, { create: true });

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      document TEXT NOT NULL,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL,
      device TEXT NOT NULL,
      device_id TEXT NOT NULL,
      filename TEXT,
      title TEXT,
      authors TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(user_id, document)
    )
  `);

  // Bancos antigos: garante as colunas de metadados
  const colunas = new Set((db.prepare(`PRAGMA table_info(progress)`).all() as { name: string }[]).map((c) => c.name));
  for (const coluna of ["filename", "title", "authors"]) {
    if (!colunas.has(coluna)) db.run(`ALTER TABLE progress ADD COLUMN ${coluna} TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_progress_document ON progress(document)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_progress_user_id ON progress(user_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS books (
      document TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT,
      authors TEXT,
      epub_path TEXT NOT NULL,
      index_path TEXT NOT NULL,
      total_chars INTEGER NOT NULL,
      spine_count INTEGER NOT NULL,
      paper_pages INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      paragraph INTEGER NOT NULL,
      xpath TEXT NOT NULL,
      char_offset INTEGER NOT NULL,
      percentage REAL NOT NULL,
      paper_page INTEGER,
      method TEXT NOT NULL,
      matched_by TEXT NOT NULL,
      confidence REAL,
      input_text TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_paper_marks_document ON paper_marks(document, char_offset)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      api_key_enc TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  return db;
}
```

- [ ] **Step 4: Criar `src/progresso.ts`**

```ts
import type { Database } from "bun:sqlite";

export interface NovoProgresso {
  userId: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  deviceId: string;
  filename?: string | null;
  title?: string | null;
  authors?: string | null;
  timestamp?: number;
}

export function gravarProgresso(db: Database, p: NovoProgresso): void {
  const timestamp = p.timestamp ?? Math.floor(Date.now() / 1000);
  db.prepare(
    `
    INSERT INTO progress (user_id, document, progress, percentage, device, device_id, filename, title, authors, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, document) DO UPDATE SET
      progress = excluded.progress,
      percentage = excluded.percentage,
      device = excluded.device,
      device_id = excluded.device_id,
      filename = COALESCE(excluded.filename, progress.filename),
      title = COALESCE(excluded.title, progress.title),
      authors = COALESCE(excluded.authors, progress.authors),
      timestamp = excluded.timestamp
  `
  ).run(p.userId, p.document, p.progress, p.percentage, p.device, p.deviceId,
        p.filename ?? null, p.title ?? null, p.authors ?? null, timestamp);
}
```

- [ ] **Step 5: Usar os dois em `src/index.tsx`**

Trocar o bloco `// Database` (da linha `const db = new Database(...)` até o `CREATE INDEX ... idx_progress_user_id`) por:

```ts
import { abrirBanco } from "./db";
import { gravarProgresso } from "./progresso";
// ...
const db = abrirBanco();
export { db };
```

(remover o `import { Database } from "bun:sqlite"` se ficar sem uso). No `rateLimiter`, trocar `setInterval(() => {...}, windowMs);` por `setInterval(() => {...}, windowMs).unref();` para os testes encerrarem.

No handler `app.put("/syncs/progress", ...)`, substituir o bloco `try { db.prepare(\`INSERT INTO progress ... \`).run(...) ; logger.info(...); return c.json(...) } catch ...` por:

```ts
  try {
    gravarProgresso(db, {
      userId: userId as number,
      document,
      progress,
      percentage,
      device,
      deviceId: device_id,
      filename: metadata?.filename ?? null,
      title: metadata?.title ?? null,
      authors: metadata?.authors ?? null,
    });

    logger.info({ requestId, userId, document, percentage, device, device_id, metadata }, "Progress updated successfully");
    return c.json({ status: "success" }, 200);
  } catch (error) {
    logger.error({ requestId, userId, document, error: error instanceof Error ? error.message : String(error) }, "Failed to update progress");
    throw error;
  }
```

As constantes `timestamp`, `filename`, `title`, `authors` que existiam antes do `try` saem.

- [ ] **Step 6: Rodar os testes e o build**

```bash
bun test src/progresso.test.ts && bun run build && rm server.js
```

Esperado: 3 testes passando; build OK.

- [ ] **Step 7: Teste de fumaça das rotas dos aparelhos (regressão)**

```bash
DB_PATH=/tmp/kosync-teste.db PASSWORD_SALT=s DISABLE_USER_REGISTRATION=false PORT=3999 bun run src/index.tsx &
sleep 1
curl -s -X POST localhost:3999/users/create -H 'content-type: application/json' -d '{"username":"t","password":"p"}'
K=$(printf p | md5)
curl -s -X PUT localhost:3999/syncs/progress -H "x-auth-user: t" -H "x-auth-key: $K" -H 'content-type: application/json' \
  -d '{"document":"d1","progress":"/body/DocFragment[2]/body/p","percentage":0.5,"device":"X","device_id":"y","metadata":{"title":"T"}}'
curl -s localhost:3999/syncs/progress/d1 -H "x-auth-user: t" -H "x-auth-key: $K"
kill %1; rm -f /tmp/kosync-teste.db
```

Esperado: `{"username":"t"}`, `{"status":"success"}` e o JSON com `"percentage":0.5,"device":"X"`.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/progresso.ts src/progresso.test.ts src/index.tsx
git commit -m "Extrai banco e gravação de progresso para módulos próprios

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Hash parcial MD5 do KOReader

**Files:**
- Create: `src/papel/hash.ts`
- Create: `src/papel/hash.test.ts`

**Interfaces:**
- Produces: `hashParcialKoreader(bytes: Uint8Array): string` (32 hex minúsculos). Mesmo algoritmo do KOReader/CrossPoint/Readest: MD5 de blocos de 1024 bytes lidos nos deslocamentos 0 e `1024 << (2*i)` para i = 0..10, pulando os que passam do fim do arquivo.

- [ ] **Step 1: Escrever o teste que falha**

`src/papel/hash.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/hash.test.ts
```

Esperado: módulo `./hash` não encontrado.

- [ ] **Step 3: Implementar `src/papel/hash.ts`**

```ts
const BLOCO = 1024;

/** Hash de documento do KOReader ("Binary"): MD5 parcial do conteúdo. */
export function hashParcialKoreader(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("md5");
  const tamanho = bytes.byteLength;
  for (let i = -1; i <= 10; i++) {
    const inicio = i < 0 ? 0 : BLOCO << (2 * i);
    if (inicio >= tamanho) continue;
    h.update(bytes.subarray(inicio, Math.min(inicio + BLOCO, tamanho)));
  }
  return h.digest("hex");
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun test src/papel/hash.test.ts
```

Esperado: 3 passando (o terceiro roda porque o arquivo existe no Mac do Eduardo).

- [ ] **Step 5: Commit**

```bash
git add src/papel/hash.ts src/papel/hash.test.ts
git commit -m "Adiciona hash parcial MD5 no formato do KOReader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Indexador do EPUB (espinha, sumário, parágrafos com XPath)

**Files:**
- Create: `src/papel/epub-index.ts`
- Create: `src/papel/epub-index.test.ts`
- Create: `src/papel/epub-teste.ts` (montador de EPUB sintético, usado só por testes)

**Interfaces:**
- Consumes: `hashParcialKoreader` (Task 2).
- Produces, em `src/papel/epub-index.ts`:
  ```ts
  export interface Paragrafo { spine: number; xpath: string; text: string; offset: number }
  export interface Capitulo { title: string; spine: number; paragraph: number }
  export interface IndiceLivro {
    document: string; title: string | null; authors: string | null;
    spineCount: number; totalChars: number; chapters: Capitulo[]; paragraphs: Paragrafo[];
  }
  export class ErroEpub extends Error {}
  export function indexarEpub(bytes: Uint8Array, document?: string): IndiceLivro  // lança ErroEpub
  export function capituloDoParagrafo(indice: IndiceLivro, paragrafo: number): Capitulo | null
  export function paragrafoDoXpath(indice: IndiceLivro, xpath: string): number | null
  ```
- Produces, em `src/papel/epub-teste.ts`: `montarEpub(capitulos: { nome: string; corpo: string; titulo?: string; ancora?: string }[], opcoes?: { semSumario?: boolean }): Uint8Array`.

- [ ] **Step 1: Criar o montador de EPUB sintético `src/papel/epub-teste.ts`**

```ts
import { zipSync, strToU8 } from "fflate";

export interface CapituloTeste {
  nome: string;          // ex.: "cap1.xhtml"
  corpo: string;         // conteúdo dentro de <body>
  titulo?: string;       // entrada no sumário (omitido = fora do sumário)
  ancora?: string;       // id dentro do capítulo para o href do sumário ("cap2.xhtml#c2")
}

export function montarEpub(capitulos: CapituloTeste[], opcoes: { semSumario?: boolean } = {}): Uint8Array {
  const xhtml = (corpo: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title><style>p{}</style></head><body>${corpo}</body></html>`;
  const itens = capitulos.map((c, i) => `<item id="c${i}" href="${c.nome}" media-type="application/xhtml+xml"/>`).join("");
  const refs = capitulos.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const nav = opcoes.semSumario ? "" : `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">x</dc:identifier><dc:title>Livro de Teste</dc:title><dc:creator>Autora Fictícia</dc:creator></metadata>
    <manifest>${itens}${nav}</manifest><spine>${refs}</spine></package>`;
  const lis = capitulos.filter((c) => c.titulo).map((c) => `<li><a href="${c.nome}${c.ancora ? "#" + c.ancora : ""}">${c.titulo}</a></li>`).join("");
  const navDoc = xhtml(`<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>${lis}</ol></nav>`);
  const arquivos: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(opf),
  };
  if (!opcoes.semSumario) arquivos["OEBPS/nav.xhtml"] = strToU8(navDoc);
  for (const c of capitulos) arquivos[`OEBPS/${c.nome}`] = strToU8(xhtml(c.corpo));
  return zipSync(arquivos, { level: 0 });
}
```

- [ ] **Step 2: Escrever os testes que falham**

`src/papel/epub-index.test.ts`:

```ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { montarEpub } from "./epub-teste";
import { indexarEpub, ErroEpub, capituloDoParagrafo, paragrafoDoXpath } from "./epub-index";

const DOIS = () =>
  montarEpub([
    {
      nome: "cap1.xhtml", titulo: "Um",
      corpo: `<h1>Um</h1><p>Primeiro parágrafo.</p><div><p>Dentro   de um div.</p></div>
              <blockquote><p>Citação.</p></blockquote><ul><li>Item A</li><li>Item B</li></ul><p>   </p><script>var x=1</script>`,
    },
    { nome: "cap2.xhtml", titulo: "Dois", ancora: "c2", corpo: `<p>Antes da âncora.</p><h1 id="c2">Dois</h1><p>Alfa</p><p>Beta</p>` },
  ]);

test("gera XPath no formato do KOReader, sem [1], só para blocos folha com texto", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.paragraphs.map((p) => p.xpath)).toEqual([
    "/body/DocFragment[1]/body/h1",
    "/body/DocFragment[1]/body/p",
    "/body/DocFragment[1]/body/div/p",
    "/body/DocFragment[1]/body/blockquote/p",
    "/body/DocFragment[1]/body/ul/li",
    "/body/DocFragment[1]/body/ul/li[2]",
    "/body/DocFragment[2]/body/p",
    "/body/DocFragment[2]/body/h1",
    "/body/DocFragment[2]/body/p[2]",
    "/body/DocFragment[2]/body/p[3]",
  ]);
  expect(idx.paragraphs[2].text).toBe("Dentro de um div.");
  expect(idx.spineCount).toBe(2);
  expect(idx.document).toBe("doc1");
  expect(idx.title).toBe("Livro de Teste");
  expect(idx.authors).toBe("Autora Fictícia");
});

test("deslocamentos acumulam e totalChars é a soma", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.paragraphs[0].offset).toBe(0);
  expect(idx.paragraphs[1].offset).toBe("Um".length);
  expect(idx.totalChars).toBe(idx.paragraphs.reduce((s, p) => s + p.text.length, 0));
});

test("sumário resolve arquivo e âncora para o parágrafo certo", () => {
  const idx = indexarEpub(DOIS(), "doc1");
  expect(idx.chapters).toEqual([
    { title: "Um", spine: 1, paragraph: 0 },
    { title: "Dois", spine: 2, paragraph: 7 },
  ]);
  expect(capituloDoParagrafo(idx, 8)?.title).toBe("Dois");
  expect(capituloDoParagrafo(idx, 3)?.title).toBe("Um");
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[2]")).toBe(8);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[2]/body/p[2]/text().15")).toBe(8);
  expect(paragrafoDoXpath(idx, "/body/DocFragment[9]/body/p")).toBeNull();
});

test("sem sumário, cada item da espinha vira 'Seção N'", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", corpo: "<p>a</p>" }, { nome: "b.xhtml", corpo: "<p>b</p>" }], { semSumario: true }), "d");
  expect(idx.chapters).toEqual([{ title: "Seção 1", spine: 1, paragraph: 0 }, { title: "Seção 2", spine: 2, paragraph: 1 }]);
});

test("espinha única usa /body/DocFragment/body sem índice", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", titulo: "A", corpo: "<p>Só um.</p>" }]), "d");
  expect(idx.paragraphs[0].xpath).toBe("/body/DocFragment/body/p");
});

test("calcula o hash quando document é omitido", () => {
  const bytes = DOIS();
  expect(indexarEpub(bytes).document).toMatch(/^[0-9a-f]{32}$/);
});

test("arquivo que não é EPUB lança ErroEpub", () => {
  expect(() => indexarEpub(new TextEncoder().encode("isto não é um zip"), "d")).toThrow(ErroEpub);
});

const LIVRO_REAL = `${process.env.HOME}/Documents/Reading/Time Machine - H.G Wells .epub`;
test.skipIf(!existsSync(LIVRO_REAL))("The Time Machine real: XPath do Kindle existe e cai perto de 29%", async () => {
  const idx = indexarEpub(new Uint8Array(await Bun.file(LIVRO_REAL).arrayBuffer()));
  expect(idx.document).toBe("a3151aa606c6367fd86a1443a4e701a7");
  expect(idx.spineCount).toBe(20);
  const n = paragrafoDoXpath(idx, "/body/DocFragment[8]/body/div/p[4]/text().287");
  expect(n).not.toBeNull();
  const pct = idx.paragraphs[n!].offset / idx.totalChars;
  expect(pct).toBeGreaterThan(0.27);
  expect(pct).toBeLessThan(0.31);
  expect(idx.chapters.length).toBeGreaterThan(10);
  expect(idx.title).toBe("The Time Machine");
});
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
bun test src/papel/epub-index.test.ts
```

Esperado: módulo `./epub-index` não encontrado.

- [ ] **Step 4: Implementar `src/papel/epub-index.ts`**

```ts
import { unzipSync, strFromU8 } from "fflate";
import { parseDocument } from "htmlparser2";
import { Element, Text, type AnyNode, type Document } from "domhandler";
import { findOne, getAttributeValue } from "domutils";
import { hashParcialKoreader } from "./hash";

export interface Paragrafo { spine: number; xpath: string; text: string; offset: number }
export interface Capitulo { title: string; spine: number; paragraph: number }
export interface IndiceLivro {
  document: string;
  title: string | null;
  authors: string | null;
  spineCount: number;
  totalChars: number;
  chapters: Capitulo[];
  paragraphs: Paragrafo[];
}

export class ErroEpub extends Error {}

const BLOCOS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt", "td", "th", "figcaption"]);

function nomeLocal(n: string): string {
  const i = n.indexOf(":");
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

function elemento(no: AnyNode, nome: string): Element | null {
  if (no instanceof Element && nomeLocal(no.name) === nome) return no;
  const filhos = "children" in no ? (no as Element | Document).children : [];
  return findOne((e) => nomeLocal(e.name) === nome, filhos, true);
}

function textoDe(no: AnyNode): string {
  if (no instanceof Text) return no.data;
  if (no instanceof Element) {
    if (no.type === "script" || no.type === "style") return "";
    return no.children.map(textoDe).join("");
  }
  return "";
}

function contemBloco(el: Element): boolean {
  return el.children.some((f) => f instanceof Element && f.type === "tag" && (BLOCOS.has(nomeLocal(f.name)) || contemBloco(f)));
}

function normalizar(caminho: string): string {
  const partes: string[] = [];
  for (const p of caminho.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") partes.pop(); else partes.push(p);
  }
  return partes.join("/");
}

function juntar(base: string, href: string): string {
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  return normalizar(dir + decodeURIComponent(href));
}

function ler(arquivos: Record<string, Uint8Array>, caminho: string): string {
  const b = arquivos[caminho];
  if (!b) throw new ErroEpub(`arquivo ausente no EPUB: ${caminho}`);
  return strFromU8(b);
}

function xml(texto: string): Document {
  return parseDocument(texto, { xmlMode: true, decodeEntities: true });
}

/** Percorre o <body> de um item da espinha emitindo parágrafos e registrando âncoras (id → próximo parágrafo). */
function percorrer(el: Element, caminho: string, spine: number, saida: Paragrafo[], ancoras: Map<string, number>, estado: { total: number }) {
  const contagem = new Map<string, number>();
  for (const filho of el.children) {
    if (!(filho instanceof Element) || filho.type !== "tag") continue;
    const nome = nomeLocal(filho.name);
    const n = (contagem.get(nome) ?? 0) + 1;
    contagem.set(nome, n);
    const sub = `${caminho}/${n === 1 ? nome : `${nome}[${n}]`}`;
    const id = getAttributeValue(filho, "id");
    if (id && !ancoras.has(id)) ancoras.set(id, saida.length);
    if (BLOCOS.has(nome) && !contemBloco(filho)) {
      // ids de elementos internos ao bloco apontam para o próprio bloco
      for (const interno of filho.children) registrarIdsInternos(interno, ancoras, saida.length);
      const texto = textoDe(filho).replace(/\s+/g, " ").trim();
      if (texto) {
        saida.push({ spine, xpath: sub, text: texto, offset: estado.total });
        estado.total += texto.length;
      }
    } else {
      percorrer(filho, sub, spine, saida, ancoras, estado);
    }
  }
}

function registrarIdsInternos(no: AnyNode, ancoras: Map<string, number>, paragrafo: number) {
  if (!(no instanceof Element)) return;
  const id = getAttributeValue(no, "id");
  if (id && !ancoras.has(id)) ancoras.set(id, paragrafo);
  for (const f of no.children) registrarIdsInternos(f, ancoras, paragrafo);
}

export function indexarEpub(bytes: Uint8Array, document?: string): IndiceLivro {
  let arquivos: Record<string, Uint8Array>;
  try {
    arquivos = unzipSync(bytes);
  } catch {
    throw new ErroEpub("o arquivo não é um EPUB (zip inválido)");
  }
  const container = xml(ler(arquivos, "META-INF/container.xml"));
  const rootfile = elemento(container, "rootfile");
  const opfPath = rootfile ? getAttributeValue(rootfile, "full-path") : undefined;
  if (!opfPath) throw new ErroEpub("EPUB sem container.xml válido");
  const opf = xml(ler(arquivos, opfPath));

  const manifesto = new Map<string, { href: string; tipo: string; props: string }>();
  const manifest = elemento(opf, "manifest");
  const spineEl = elemento(opf, "spine");
  if (!manifest || !spineEl) throw new ErroEpub("EPUB sem manifest ou spine");
  for (const item of manifest.children) {
    if (item instanceof Element && nomeLocal(item.name) === "item") {
      manifesto.set(getAttributeValue(item, "id") ?? "", {
        href: juntar(opfPath, getAttributeValue(item, "href") ?? ""),
        tipo: getAttributeValue(item, "media-type") ?? "",
        props: getAttributeValue(item, "properties") ?? "",
      });
    }
  }
  const espinha: string[] = [];
  for (const ref of spineEl.children) {
    if (ref instanceof Element && nomeLocal(ref.name) === "itemref") {
      const it = manifesto.get(getAttributeValue(ref, "idref") ?? "");
      if (it) espinha.push(it.href);
    }
  }
  if (espinha.length === 0) throw new ErroEpub("EPUB sem itens na espinha");

  const meta = (nome: string) => {
    const e = elemento(opf, nome);
    const t = e ? textoDe(e).replace(/\s+/g, " ").trim() : "";
    return t || null;
  };

  const paragraphs: Paragrafo[] = [];
  const ancorasPorArquivo = new Map<string, Map<string, number>>();
  const primeiroParagrafoDoItem: number[] = [];
  const estado = { total: 0 };
  espinha.forEach((href, i) => {
    const spine = i + 1;
    const prefixo = espinha.length === 1 ? "/body/DocFragment/body" : `/body/DocFragment[${spine}]/body`;
    primeiroParagrafoDoItem.push(paragraphs.length);
    const ancoras = new Map<string, number>();
    ancorasPorArquivo.set(href, ancoras);
    const doc = xml(ler(arquivos, href));
    const body = elemento(doc, "body");
    if (body) percorrer(body, prefixo, spine, paragraphs, ancoras, estado);
  });

  const chapters = lerSumario(arquivos, manifesto, opfPath, espinha, ancorasPorArquivo, primeiroParagrafoDoItem, paragraphs.length);

  return {
    document: document ?? hashParcialKoreader(bytes),
    title: meta("title"),
    authors: meta("creator"),
    spineCount: espinha.length,
    totalChars: estado.total,
    chapters,
    paragraphs,
  };
}

function lerSumario(
  arquivos: Record<string, Uint8Array>,
  manifesto: Map<string, { href: string; tipo: string; props: string }>,
  opfPath: string,
  espinha: string[],
  ancorasPorArquivo: Map<string, Map<string, number>>,
  primeiroParagrafoDoItem: number[],
  totalParagrafos: number
): Capitulo[] {
  const entradas: { title: string; href: string }[] = [];
  const nav = [...manifesto.values()].find((m) => m.props.split(" ").includes("nav"));
  const ncx = [...manifesto.values()].find((m) => m.tipo === "application/x-dtbncx+xml");
  if (nav && arquivos[nav.href]) {
    const doc = xml(ler(arquivos, nav.href));
    const toc = findOne((e) => nomeLocal(e.name) === "nav" && (getAttributeValue(e, "epub:type") ?? "").includes("toc"), [doc], true) ?? elemento(doc, "nav");
    if (toc) {
      const links = coletar(toc, "a");
      for (const a of links) {
        const href = getAttributeValue(a, "href");
        const title = textoDe(a).replace(/\s+/g, " ").trim();
        if (href && title) entradas.push({ title, href: juntar(nav.href, href) });
      }
    }
  } else if (ncx && arquivos[ncx.href]) {
    const doc = xml(ler(arquivos, ncx.href));
    for (const ponto of coletar(doc, "navpoint")) {
      const conteudo = elemento(ponto, "content");
      const rotulo = elemento(ponto, "text");
      const src = conteudo ? getAttributeValue(conteudo, "src") : undefined;
      const title = rotulo ? textoDe(rotulo).replace(/\s+/g, " ").trim() : "";
      if (src && title) entradas.push({ title, href: juntar(ncx.href, src) });
    }
  }

  const capitulos: Capitulo[] = [];
  for (const e of entradas) {
    const [arquivo, fragmento] = e.href.split("#");
    const i = espinha.indexOf(arquivo);
    if (i < 0) continue;
    let paragrafo: number | undefined;
    if (fragmento) paragrafo = ancorasPorArquivo.get(arquivo)?.get(fragmento);
    if (paragrafo === undefined) paragrafo = primeiroParagrafoDoItem[i];
    if (paragrafo >= totalParagrafos) continue;
    if (capitulos.some((c) => c.paragraph === paragrafo)) continue;
    capitulos.push({ title: e.title, spine: i + 1, paragraph: paragrafo });
  }
  capitulos.sort((a, b) => a.paragraph - b.paragraph);
  if (capitulos.length > 0) return capitulos;

  // Sem sumário utilizável: uma seção por item da espinha que tenha texto
  const secoes: Capitulo[] = [];
  primeiroParagrafoDoItem.forEach((p, i) => {
    const proximo = primeiroParagrafoDoItem[i + 1] ?? totalParagrafos;
    if (p < proximo) secoes.push({ title: `Seção ${i + 1}`, spine: i + 1, paragraph: p });
  });
  return secoes;
}

function coletar(raiz: AnyNode, nome: string): Element[] {
  const saida: Element[] = [];
  const visitar = (no: AnyNode) => {
    if (no instanceof Element) {
      if (nomeLocal(no.name) === nome) saida.push(no);
      for (const f of no.children) visitar(f);
    } else if ("children" in no) {
      for (const f of (no as Document).children) visitar(f);
    }
  };
  visitar(raiz);
  return saida;
}

/** Capítulo que contém o parágrafo (o último cujo início é <= paragrafo). */
export function capituloDoParagrafo(indice: IndiceLivro, paragrafo: number): Capitulo | null {
  let atual: Capitulo | null = null;
  for (const c of indice.chapters) {
    if (c.paragraph <= paragrafo) atual = c; else break;
  }
  return atual;
}

/** Índice do parágrafo cujo XPath é igual ao dado (ignorando o sufixo /text().N). */
export function paragrafoDoXpath(indice: IndiceLivro, xpath: string): number | null {
  const semTexto = xpath.replace(/\/text\(\)(\[\d+\])?\.\d+$/, "").replace(/\.\d+$/, "");
  const i = indice.paragraphs.findIndex((p) => p.xpath === semTexto);
  return i >= 0 ? i : null;
}
```

- [ ] **Step 5: Rodar e ver passar**

```bash
bun test src/papel/epub-index.test.ts
```

Esperado: 8 passando (o último com o livro real). Se o teste do livro real falhar no XPath, imprimir `idx.paragraphs.filter(p => p.spine === 8).map(p => p.xpath)` e comparar com `/body/DocFragment[8]/body/div/p[4]`: a diferença mais provável é um elemento `div` ou `section` a mais no caminho; ajustar `BLOCOS`/`contemBloco` e nunca o teste.

- [ ] **Step 6: Commit**

```bash
git add src/papel/epub-index.ts src/papel/epub-index.test.ts src/papel/epub-teste.ts
git commit -m "Adiciona indexador de EPUB com XPath no formato do KOReader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Casamento local por trigramas

**Files:**
- Create: `src/papel/casamento.ts`
- Create: `src/papel/casamento.test.ts`

**Interfaces:**
- Consumes: `IndiceLivro` (Task 3).
- Produces:
  ```ts
  export interface Candidato { paragraph: number; score: number }
  export interface ResultadoCasamento { status: "confiante" | "duvidoso" | "nenhum"; candidatos: Candidato[] } // até 3, melhor primeiro
  export function normalizarTexto(s: string): string
  export function similaridade(trecho: string, paragrafo: string): number   // 0..1
  export function paragrafosDoCapitulo(indice: IndiceLivro, capitulo: number): number[]  // capitulo = posição em indice.chapters
  export function casarTrecho(trecho: string, indice: IndiceLivro, escopo: number[]): ResultadoCasamento
  ```
- Limiares (da spec 6.2): confiante = melhor ≥ 0,60 e vantagem ≥ 0,10 sobre o segundo; duvidoso = melhor ≥ 0,40; senão nenhum.

- [ ] **Step 1: Escrever os testes que falham**

`src/papel/casamento.test.ts`:

```ts
import { test, expect } from "bun:test";
import { montarEpub } from "./epub-teste";
import { indexarEpub } from "./epub-index";
import { normalizarTexto, similaridade, paragrafosDoCapitulo, casarTrecho } from "./casamento";

const idx = indexarEpub(
  montarEpub([
    { nome: "c1.xhtml", titulo: "Um", corpo: `<p>The Time Traveller (for so it will be convenient to speak of him) was expounding a recondite matter to us.</p>
      <p>His grey eyes shone and twinkled, and his usually pale face was flushed and animated.</p>
      <p>The fire burned brightly, and the soft radiance of the incandescent lights in the lilies of silver caught the bubbles.</p>` },
    { nome: "c2.xhtml", titulo: "Dois", corpo: `<p>Gêmeo idêntico de parágrafo repetido.</p><p>Gêmeo idêntico de parágrafo repetido.</p><p>Outra coisa completamente diferente aqui.</p>` },
  ]),
  "d"
);

test("normalizarTexto tira acento, pontuação, maiúsculas e hifenização de fim de linha", () => {
  expect(normalizarTexto("Cita-\nção, ÀS vezes!  (sim)")).toBe("citacao as vezes sim");
});

test("similaridade é 1 para texto igual e baixa para texto sem relação", () => {
  expect(similaridade("his grey eyes shone", "His grey eyes shone and twinkled")).toBeGreaterThan(0.9);
  expect(similaridade("banana esmagada", "His grey eyes shone and twinkled")).toBeLessThan(0.2);
});

test("paragrafosDoCapitulo devolve os índices do capítulo", () => {
  expect(paragrafosDoCapitulo(idx, 0)).toEqual([0, 1, 2]);
  expect(paragrafosDoCapitulo(idx, 1)).toEqual([3, 4, 5]);
});

test("primeiras palavras exatas: confiante no parágrafo certo", () => {
  const r = casarTrecho("His grey eyes shone and twinkled", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("confiante");
  expect(r.candidatos[0].paragraph).toBe(1);
});

test("erros de OCR e hifenização ainda casam", () => {
  const r = casarTrecho("The fire bumed brigthly, and the soft radi-\nance of the incandescent lig hts", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("confiante");
  expect(r.candidatos[0].paragraph).toBe(2);
});

test("trecho de outro lugar: nenhum", () => {
  const r = casarTrecho("uma frase que não existe neste livro de jeito nenhum", idx, paragrafosDoCapitulo(idx, 0));
  expect(r.status).toBe("nenhum");
});

test("parágrafos gêmeos: duvidoso com os dois candidatos", () => {
  const r = casarTrecho("Gêmeo idêntico de parágrafo", idx, paragrafosDoCapitulo(idx, 1));
  expect(r.status).toBe("duvidoso");
  expect(r.candidatos.map((c) => c.paragraph).sort()).toEqual([3, 4]);
});

test("trecho vazio: nenhum, sem lançar", () => {
  expect(casarTrecho("   ", idx, [0, 1, 2]).status).toBe("nenhum");
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/casamento.test.ts
```

- [ ] **Step 3: Implementar `src/papel/casamento.ts`**

```ts
import type { IndiceLivro } from "./epub-index";

export interface Candidato { paragraph: number; score: number }
export interface ResultadoCasamento { status: "confiante" | "duvidoso" | "nenhum"; candidatos: Candidato[] }

const CONFIANTE = 0.6;
const VANTAGEM = 0.1;
const DUVIDOSO = 0.4;

export function normalizarTexto(s: string): string {
  return s
    .replace(/-\s*\n\s*/g, "")          // hifenização de fim de linha
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // acentos
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")    // pontuação e símbolos viram espaço
    .trim()
    .replace(/\s+/g, " ");
}

function trigramas(s: string): Set<string> {
  const t = new Set<string>();
  const texto = ` ${s} `;
  for (let i = 0; i + 3 <= texto.length; i++) t.add(texto.slice(i, i + 3));
  return t;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comum = 0;
  for (const x of a) if (b.has(x)) comum++;
  return (2 * comum) / (a.size + b.size);
}

/** Maior entre a similaridade com o início do parágrafo (1,5× o tamanho do trecho) e com o parágrafo inteiro. */
export function similaridade(trecho: string, paragrafo: string): number {
  const q = normalizarTexto(trecho);
  const p = normalizarTexto(paragrafo);
  if (!q || !p) return 0;
  const tq = trigramas(q);
  const inicio = p.slice(0, Math.ceil(q.length * 1.5));
  return Math.max(dice(tq, trigramas(inicio)), dice(tq, trigramas(p)));
}

export function paragrafosDoCapitulo(indice: IndiceLivro, capitulo: number): number[] {
  const atual = indice.chapters[capitulo];
  if (!atual) return [];
  const fim = indice.chapters[capitulo + 1]?.paragraph ?? indice.paragraphs.length;
  const saida: number[] = [];
  for (let i = atual.paragraph; i < fim; i++) saida.push(i);
  return saida;
}

export function casarTrecho(trecho: string, indice: IndiceLivro, escopo: number[]): ResultadoCasamento {
  if (!normalizarTexto(trecho)) return { status: "nenhum", candidatos: [] };
  const pontuados: Candidato[] = escopo
    .map((paragraph) => ({ paragraph, score: similaridade(trecho, indice.paragraphs[paragraph].text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const melhor = pontuados[0]?.score ?? 0;
  const segundo = pontuados[1]?.score ?? 0;
  if (melhor >= CONFIANTE && melhor - segundo >= VANTAGEM) return { status: "confiante", candidatos: pontuados };
  if (melhor >= DUVIDOSO) return { status: "duvidoso", candidatos: pontuados.filter((c) => c.score >= DUVIDOSO) };
  return { status: "nenhum", candidatos: [] };
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun test src/papel/casamento.test.ts
```

Esperado: 8 passando. Se "erros de OCR" ficar em `duvidoso`, medir `similaridade(...)` do caso e ajustar só o fator do prefixo (1,5×) ou o corte, nunca abaixo de 0,55 para confiante.

- [ ] **Step 5: Commit**

```bash
git add src/papel/casamento.ts src/papel/casamento.test.ts
git commit -m "Adiciona casamento local de trecho por trigramas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Estimativa da página no papel

**Files:**
- Create: `src/papel/pagina.ts`
- Create: `src/papel/pagina.test.ts`

**Interfaces:**
- Consumes: `IndiceLivro`, `paragrafoDoXpath` (Task 3).
- Produces:
  ```ts
  export interface PontoCalibracao { charOffset: number; paperPage: number }
  export function estimarPagina(charOffset: number, totalChars: number, paperPages: number, marcas: PontoCalibracao[]): number
  export function deslocamentoAtual(indice: IndiceLivro, xpath: string, percentage: number): number
  ```

- [ ] **Step 1: Escrever os testes que falham**

`src/papel/pagina.test.ts`:

```ts
import { test, expect } from "bun:test";
import { estimarPagina, deslocamentoAtual } from "./pagina";
import { montarEpub } from "./epub-teste";
import { indexarEpub } from "./epub-index";

test("só com as âncoras, a metade do texto cai na metade do livro", () => {
  expect(estimarPagina(5000, 10000, 301, [])).toBe(151);
  expect(estimarPagina(0, 10000, 300, [])).toBe(1);
  expect(estimarPagina(10000, 10000, 300, [])).toBe(300);
});

test("uma marcação puxa a reta para o ponto informado", () => {
  // 40% do texto está na página 100 de 300 (livro com muita nota no fim)
  const marcas = [{ charOffset: 4000, paperPage: 100 }];
  expect(estimarPagina(4000, 10000, 300, marcas)).toBe(100);
  expect(estimarPagina(2000, 10000, 300, marcas)).toBe(50);      // entre (0,1) e (4000,100)
  expect(estimarPagina(7000, 10000, 300, marcas)).toBe(200);     // entre (4000,100) e (10000,300)
});

test("marcação incoerente (página menor mais à frente) é ignorada", () => {
  const marcas = [{ charOffset: 4000, paperPage: 100 }, { charOffset: 6000, paperPage: 80 }];
  expect(estimarPagina(6000, 10000, 300, marcas)).toBe(167);
});

test("resultado fica entre 1 e o total de páginas", () => {
  expect(estimarPagina(-5, 100, 10, [])).toBe(1);
  expect(estimarPagina(500, 100, 10, [])).toBe(10);
});

test("deslocamentoAtual usa o XPath quando existe e a porcentagem quando não", () => {
  const idx = indexarEpub(montarEpub([{ nome: "a.xhtml", titulo: "A", corpo: "<p>abcde</p><p>fghij</p>" }]), "d");
  expect(deslocamentoAtual(idx, "/body/DocFragment/body/p[2]/text().0", 0.9)).toBe(5);
  expect(deslocamentoAtual(idx, "/body/DocFragment[7]/body/p", 0.5)).toBe(5);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/pagina.test.ts
```

- [ ] **Step 3: Implementar `src/papel/pagina.ts`**

```ts
import { paragrafoDoXpath, type IndiceLivro } from "./epub-index";

export interface PontoCalibracao { charOffset: number; paperPage: number }

export function estimarPagina(charOffset: number, totalChars: number, paperPages: number, marcas: PontoCalibracao[]): number {
  const pontos: PontoCalibracao[] = [{ charOffset: 0, paperPage: 1 }];
  const ordenadas = [...marcas].sort((a, b) => a.charOffset - b.charOffset);
  for (const m of ordenadas) {
    const anterior = pontos[pontos.length - 1];
    if (m.charOffset > anterior.charOffset && m.paperPage > anterior.paperPage && m.charOffset < totalChars && m.paperPage < paperPages) {
      pontos.push(m);
    }
  }
  pontos.push({ charOffset: totalChars, paperPage: paperPages });

  const x = Math.min(Math.max(charOffset, 0), totalChars);
  for (let i = 1; i < pontos.length; i++) {
    const a = pontos[i - 1], b = pontos[i];
    if (x <= b.charOffset) {
      const fracao = b.charOffset === a.charOffset ? 0 : (x - a.charOffset) / (b.charOffset - a.charOffset);
      const pagina = Math.round(a.paperPage + fracao * (b.paperPage - a.paperPage));
      return Math.min(Math.max(pagina, 1), paperPages);
    }
  }
  return paperPages;
}

/** Deslocamento em caracteres da posição digital: pelo XPath se o índice o conhece, senão pela porcentagem. */
export function deslocamentoAtual(indice: IndiceLivro, xpath: string, percentage: number): number {
  const p = paragrafoDoXpath(indice, xpath);
  if (p !== null) return indice.paragraphs[p].offset;
  return Math.round(Math.min(Math.max(percentage, 0), 1) * indice.totalChars);
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun test src/papel/pagina.test.ts
```

Esperado: 5 passando.

- [ ] **Step 5: Commit**

```bash
git add src/papel/pagina.ts src/papel/pagina.test.ts
git commit -m "Adiciona estimativa da página no papel por interpolação

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Cifra da chave de API e sessão por cookie assinado

**Files:**
- Create: `src/papel/cifra.ts`
- Create: `src/papel/cifra.test.ts`
- Create: `src/papel/sessao.ts`
- Create: `src/papel/sessao.test.ts`

**Interfaces:**
- Produces, em `cifra.ts`:
  ```ts
  export function cifrar(texto: string, salt: string): Promise<string>     // base64url(iv ‖ cifrado)
  export function decifrar(valor: string, salt: string): Promise<string>   // lança se a assinatura não bater
  ```
- Produces, em `sessao.ts`:
  ```ts
  export const NOME_COOKIE = "papel_sessao";
  export const VALIDADE_SEGUNDOS = 30 * 24 * 3600;
  export function criarCookie(userId: number, salt: string, agora?: number): Promise<string>
  export function lerCookie(valor: string | undefined, salt: string, agora?: number): Promise<number | null>
  export function exigeSessao(salt: string): MiddlewareHandler   // Hono; põe c.set("userId", n) ou redireciona 302 para /papel?proximo=<caminho>
  export function gravarCookieSessao(c: Context, valor: string): void
  export function apagarCookieSessao(c: Context): void
  ```

- [ ] **Step 1: Escrever os testes que falham**

`src/papel/cifra.test.ts`:

```ts
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
```

`src/papel/sessao.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/cifra.test.ts src/papel/sessao.test.ts
```

- [ ] **Step 3: Implementar `src/papel/cifra.ts`**

```ts
const codificador = new TextEncoder();
const decodificador = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function deBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function chave(salt: string, uso: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", codificador.encode(`${salt}:${uso}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function cifrar(texto: string, salt: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await chave(salt, "papel-chave-api");
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, codificador.encode(texto)));
  const junto = new Uint8Array(iv.length + cifrado.length);
  junto.set(iv, 0);
  junto.set(cifrado, iv.length);
  return base64url(junto);
}

export async function decifrar(valor: string, salt: string): Promise<string> {
  const junto = deBase64url(valor);
  const iv = junto.subarray(0, 12);
  const k = await chave(salt, "papel-chave-api");
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, junto.subarray(12));
  return decodificador.decode(claro);
}
```

- [ ] **Step 4: Implementar `src/papel/sessao.ts`**

```ts
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
      return c.redirect(`/papel?proximo=${encodeURIComponent(caminho)}`, 302);
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
```

- [ ] **Step 5: Rodar e ver passar**

```bash
bun test src/papel/cifra.test.ts src/papel/sessao.test.ts
```

Esperado: 6 passando.

- [ ] **Step 6: Commit**

```bash
git add src/papel/cifra.ts src/papel/cifra.test.ts src/papel/sessao.ts src/papel/sessao.test.ts
git commit -m "Adiciona cifra da chave de API e sessão por cookie assinado

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Localização por IA (API da Anthropic, saída estruturada)

**Files:**
- Create: `src/papel/ia.ts`
- Create: `src/papel/ia.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MODELO_IA = "claude-opus-5";
  export interface ParagrafoNumerado { texto: string }              // posição no array = número - 1
  export interface EntradaIA {
    chave: string;
    paragrafos: ParagrafoNumerado[];                                // parágrafos do capítulo, em ordem
    imagem?: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
    trecho?: string;                                                // texto digitado (alternativa à imagem)
    idiomaLivro?: string | null;                                    // só informativo no prompt
  }
  export type ResultadoIA =
    | { status: "ok"; transcricao: string; paragrafo: number | null; confianca: number; candidatos: number[] }  // índices 0-based no array de entrada
    | { status: "erro"; mensagem: string };
  export interface LocalizadorIA {
    localizar(entrada: EntradaIA): Promise<ResultadoIA>;
    testarChave(chave: string): Promise<{ ok: true } | { ok: false; mensagem: string }>;
  }
  export type FabricaCliente = (chave: string) => Pick<Anthropic, "messages" | "models">;
  export function criarLocalizadorIA(fabrica?: FabricaCliente): LocalizadorIA   // padrão: new Anthropic({ apiKey: chave })
  ```
- Convenção: para foto, o parágrafo devolvido é o **primeiro parágrafo completo da página fotografada**; para trecho digitado, o parágrafo que o contém.

- [ ] **Step 1: Escrever os testes que falham**

`src/papel/ia.test.ts`:

```ts
import { test, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { criarLocalizadorIA, MODELO_IA, type FabricaCliente } from "./ia";

function fabricaFalsa(resposta: any, capturar: { req?: any } = {}, erro?: Error): FabricaCliente {
  return () =>
    ({
      messages: {
        parse: async (req: any) => {
          capturar.req = req;
          if (erro) throw erro;
          return resposta;
        },
      },
      models: { retrieve: async () => { if (erro) throw erro; return { id: MODELO_IA }; } },
    }) as any;
}

const paragrafos = [{ texto: "Primeiro." }, { texto: "Segundo parágrafo." }, { texto: "Terceiro." }];

test("monta a requisição com imagem, parágrafos numerados e esquema, e converte o número para índice", async () => {
  const cap: { req?: any } = {};
  const ia = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "Segundo par", paragrafo: 2, confianca: 0.9, candidatos: [2, 3] } }, cap));
  const r = await ia.localizar({ chave: "k", paragrafos, imagem: { base64: "AAAA", mediaType: "image/jpeg" } });
  expect(r).toEqual({ status: "ok", transcricao: "Segundo par", paragrafo: 1, confianca: 0.9, candidatos: [1, 2] });
  expect(cap.req.model).toBe(MODELO_IA);
  expect(cap.req.output_config.format).toBeDefined();
  const blocos = cap.req.messages[0].content;
  expect(blocos[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  expect(blocos[1].text).toContain("[2] Segundo parágrafo.");
});

test("trecho digitado vai como texto, sem bloco de imagem", async () => {
  const cap: { req?: any } = {};
  const ia = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "x", paragrafo: 3, confianca: 0.8, candidatos: [] } }, cap));
  await ia.localizar({ chave: "k", paragrafos, trecho: "Terceiro" });
  expect(cap.req.messages[0].content[0].type).toBe("text");
  expect(cap.req.messages[0].content[0].text).toContain("Terceiro");
});

test("paragrafo null, número fora da faixa ou recusa viram resultado sem parágrafo ou erro", async () => {
  const ia1 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "", paragrafo: null, confianca: 0, candidatos: [] } }));
  expect(await ia1.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "ok", paragrafo: null });
  const ia2 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "end_turn", parsed_output: { transcricao: "", paragrafo: 99, confianca: 1, candidatos: [0, 99] } }));
  expect(await ia2.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "ok", paragrafo: null, candidatos: [] });
  const ia3 = criarLocalizadorIA(fabricaFalsa({ stop_reason: "refusal", parsed_output: null }));
  expect(await ia3.localizar({ chave: "k", paragrafos, trecho: "?" })).toMatchObject({ status: "erro" });
});

test("erros da API viram mensagens em português", async () => {
  const auth = new Anthropic.AuthenticationError(401, {}, "bad key", new Headers());
  const ia = criarLocalizadorIA(fabricaFalsa(null, {}, auth));
  expect(await ia.localizar({ chave: "k", paragrafos, trecho: "x" })).toEqual({ status: "erro", mensagem: "Chave de API inválida. Confira em Configurações." });
  expect(await ia.testarChave("k")).toEqual({ ok: false, mensagem: "Chave de API inválida. Confira em Configurações." });
});

test("sem chave, nem imagem nem trecho: erro sem chamar a rede", async () => {
  let chamou = false;
  const ia = criarLocalizadorIA(() => { chamou = true; return {} as any; });
  expect(await ia.localizar({ chave: "", paragrafos, trecho: "x" })).toMatchObject({ status: "erro" });
  expect(await ia.localizar({ chave: "k", paragrafos })).toMatchObject({ status: "erro" });
  expect(chamou).toBe(false);
});

test("testarChave devolve ok quando o modelo é encontrado", async () => {
  const ia = criarLocalizadorIA(fabricaFalsa(null));
  expect(await ia.testarChave("k")).toEqual({ ok: true });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/ia.test.ts
```

- [ ] **Step 3: Implementar `src/papel/ia.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const MODELO_IA = "claude-opus-5";

export interface ParagrafoNumerado { texto: string }
export interface EntradaIA {
  chave: string;
  paragrafos: ParagrafoNumerado[];
  imagem?: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  trecho?: string;
  idiomaLivro?: string | null;
}
export type ResultadoIA =
  | { status: "ok"; transcricao: string; paragrafo: number | null; confianca: number; candidatos: number[] }
  | { status: "erro"; mensagem: string };
export interface LocalizadorIA {
  localizar(entrada: EntradaIA): Promise<ResultadoIA>;
  testarChave(chave: string): Promise<{ ok: true } | { ok: false; mensagem: string }>;
}
export type FabricaCliente = (chave: string) => Pick<Anthropic, "messages" | "models">;

const Saida = z.object({
  transcricao: z.string(),
  paragrafo: z.number().int().nullable(),
  confianca: z.number().min(0).max(1),
  candidatos: z.array(z.number().int()),
});

const SISTEMA =
  "Você ajuda um leitor a sincronizar a leitura entre um livro de papel e o mesmo livro em EPUB. " +
  "Recebe uma foto de página ou um trecho digitado do livro de papel, que pode ser uma tradução para o português, " +
  "e a lista numerada dos parágrafos de um capítulo do EPUB. Responda só no formato pedido.";

function instrucao(entrada: EntradaIA): string {
  const alvo = entrada.imagem
    ? "Transcreva o texto legível da foto e identifique o parágrafo do EPUB em que a página fotografada COMEÇA (o primeiro parágrafo completo da página)."
    : `Trecho digitado pelo leitor: «${entrada.trecho}». Identifique o parágrafo do EPUB que contém esse trecho (ou a sua tradução).`;
  const lista = entrada.paragrafos.map((p, i) => `[${i + 1}] ${p.texto}`).join("\n");
  return (
    `${alvo}\n` +
    `Considere que o papel pode ser tradução (por exemplo, português) do EPUB${entrada.idiomaLivro ? ` (idioma do EPUB: ${entrada.idiomaLivro})` : ""}: compare pelo sentido, nomes próprios e números.\n` +
    `Devolva: "transcricao" (texto lido ou o trecho normalizado), "paragrafo" (número entre colchetes, ou null se não estiver neste capítulo), ` +
    `"confianca" (0 a 1) e "candidatos" (até 3 números possíveis, incluindo o escolhido, do mais provável ao menos).\n\n` +
    `Parágrafos do capítulo:\n${lista}`
  );
}

function mensagemDeErro(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Chave de API inválida. Confira em Configurações.";
  if (e instanceof Anthropic.RateLimitError) return "Limite de uso da API atingido. Tente de novo em alguns instantes.";
  if (e instanceof Anthropic.APIError && (e.status === 402 || /credit|billing/i.test(e.message))) return "A conta da API está sem crédito.";
  if (e instanceof Anthropic.APIConnectionError) return "Não foi possível falar com a API. Verifique a conexão do servidor.";
  if (e instanceof Anthropic.APIError) return `A API respondeu com erro ${e.status ?? ""}: ${e.message}`;
  return "Erro inesperado ao chamar a IA.";
}

export function criarLocalizadorIA(fabrica: FabricaCliente = (chave) => new Anthropic({ apiKey: chave })): LocalizadorIA {
  return {
    async localizar(entrada) {
      if (!entrada.chave) return { status: "erro", mensagem: "Sem chave de API. Cadastre em Configurações." };
      if (!entrada.imagem && !entrada.trecho?.trim()) return { status: "erro", mensagem: "Envie uma foto ou digite um trecho." };
      if (entrada.paragrafos.length === 0) return { status: "erro", mensagem: "Este capítulo não tem texto." };
      const blocos: Anthropic.ContentBlockParam[] = [];
      if (entrada.imagem) {
        blocos.push({ type: "image", source: { type: "base64", media_type: entrada.imagem.mediaType, data: entrada.imagem.base64 } });
      }
      blocos.push({ type: "text", text: instrucao(entrada) });
      try {
        const cliente = fabrica(entrada.chave);
        const resposta = await cliente.messages.parse({
          model: MODELO_IA,
          max_tokens: 2048,
          system: SISTEMA,
          output_config: { format: zodOutputFormat(Saida), effort: "medium" },
          messages: [{ role: "user", content: blocos }],
        });
        if (resposta.stop_reason === "refusal" || !resposta.parsed_output) {
          return { status: "erro", mensagem: "A IA não conseguiu localizar o trecho. Tente por texto ou marque o início do capítulo." };
        }
        const n = entrada.paragrafos.length;
        const valido = (x: number | null) => x !== null && Number.isInteger(x) && x >= 1 && x <= n;
        const saida = resposta.parsed_output;
        return {
          status: "ok",
          transcricao: saida.transcricao,
          paragrafo: valido(saida.paragrafo) ? (saida.paragrafo as number) - 1 : null,
          confianca: saida.confianca,
          candidatos: saida.candidatos.filter(valido).map((x) => x - 1).slice(0, 3),
        };
      } catch (e) {
        return { status: "erro", mensagem: mensagemDeErro(e) };
      }
    },
    async testarChave(chave) {
      if (!chave) return { ok: false, mensagem: "Informe a chave." };
      try {
        await fabrica(chave).models.retrieve(MODELO_IA);
        return { ok: true };
      } catch (e) {
        return { ok: false, mensagem: mensagemDeErro(e) };
      }
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun test src/papel/ia.test.ts
```

Esperado: 6 passando. Se o construtor de `Anthropic.AuthenticationError` no teste não aceitar esses argumentos, abrir `node_modules/@anthropic-ai/sdk/core/error.d.ts` (ou `error.d.ts` na raiz do pacote) e ajustar a chamada do teste à assinatura real; a implementação não muda.

- [ ] **Step 5: Commit**

```bash
git add src/papel/ia.ts src/papel/ia.test.ts
git commit -m "Adiciona localização de parágrafo por IA com saída estruturada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Dados do papel, telas e rotas de login, livros, configurações e envio do EPUB

**Files:**
- Create: `src/limite.ts` (rate limiter extraído de `src/index.tsx` linhas 185–219)
- Create: `src/papel/dados.ts`
- Create: `src/papel/telas.tsx`
- Create: `src/papel/rotas.tsx`
- Create: `src/papel/rotas.test.ts`
- Modify: `src/index.tsx` (usar `limite.ts`; montar `/papel`)

**Interfaces:**
- Consumes: `abrirBanco`, `gravarProgresso` (Task 1), `hashParcialKoreader` (2), `indexarEpub`, `IndiceLivro`, `capituloDoParagrafo` (3), `estimarPagina`, `deslocamentoAtual` (5), `cifrar`/`decifrar`, sessão (6), `LocalizadorIA` (7).
- Produces, em `src/limite.ts`: `rateLimiter({ windowMs, max }): MiddlewareHandler` (mesmo código de hoje, com `.unref()`).
- Produces, em `src/papel/dados.ts`:
  ```ts
  export interface Livro { document: string; title: string | null; authors: string | null; epub_path: string; index_path: string; total_chars: number; spine_count: number; paper_pages: number | null }
  export interface LivroNaLista { document: string; title: string | null; authors: string | null; percentage: number | null; device: string | null; progressXpath: string | null; timestamp: number | null; temEpub: boolean; paperPages: number | null }
  export interface Marca { id: number; paragraph: number; xpath: string; char_offset: number; percentage: number; paper_page: number | null; method: string; matched_by: string; confidence: number | null; input_text: string | null; created_at: number }
  export function listarLivros(db, userId): LivroNaLista[]
  export function obterLivro(db, userId, document): Livro | null
  export function progressoDoLivro(db, userId, document): { progress: string; percentage: number; device: string; timestamp: number } | null
  export function salvarLivro(db, userId, indice: IndiceLivro, epubPath, indexPath): void
  export function salvarPaginas(db, userId, document, paperPages: number | null): void
  export function listarMarcas(db, userId, document, limite?): Marca[]
  export function gravarMarca(db, m: { userId; document; paragraph; xpath; charOffset; percentage; paperPage; method; matchedBy; confidence; inputText }): void
  export function lerChaveApi(db, userId, salt): Promise<string | null>
  export function salvarChaveApi(db, userId, chave: string | null, salt): Promise<void>
  export function carregarIndice(indexPath): Promise<IndiceLivro>
  export function paginaEstimada(db, userId, livro: Livro, indice: IndiceLivro): number | null
  ```
- Produces, em `src/papel/rotas.tsx`: `criarRotasPapel(deps: { db: Database; salt: string; dirLivros: string; ia: LocalizadorIA; logger: pino.Logger }): Hono` montado em `/papel`.
- Regras de aceitação do EPUB (spec 7.1): mesmo hash de um `progress` existente → aceita; título+autor iguais a um `progress` de outro hash → recusa 400 com a mensagem; nenhum `progress` → aceita com aviso; inválido → 400.

- [ ] **Step 1: Extrair `src/limite.ts`**

Mover a função `rateLimiter` (com a interface `RateLimitOptions`) de `src/index.tsx` para `src/limite.ts` com `export`, acrescentando `.unref()` no `setInterval`, e em `index.tsx` trocar por `import { rateLimiter } from "./limite";`. Rodar `bun run build && rm server.js` para conferir.

- [ ] **Step 2: Escrever os testes de rotas que falham**

`src/papel/rotas.test.ts`:

```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
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

const SALT = "salt-teste";
let db: ReturnType<typeof abrirBanco>;
let app: ReturnType<typeof criarRotasPapel>;
let dir: string;
const iaFalsa: LocalizadorIA = {
  localizar: async () => ({ status: "ok", transcricao: "t", paragrafo: 1, confianca: 0.95, candidatos: [1] }),
  testarChave: async (k) => (k === "boa" ? { ok: true } : { ok: false, mensagem: "Chave de API inválida. Confira em Configurações." }),
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
  for (const rota of ["/papel/config", "/papel/livros/abc", "/papel/livros/abc/marcar"]) {
    const r = await app.request(rota);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/papel?proximo=");
  }
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
  const tela = await (await app.request(`/papel/livros/${hash}`, comCookie(cookie))).text();
  expect(tela).toContain("Nenhum aparelho sincronizou este arquivo ainda");

  const invalido = await enviarEpub(cookie, new TextEncoder().encode("nada"));
  expect(invalido.status).toBe(400);
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
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
bun test src/papel/rotas.test.ts
```

- [ ] **Step 4: Implementar `src/papel/dados.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { IndiceLivro } from "./epub-index";
import { cifrar, decifrar } from "./cifra";
import { estimarPagina, deslocamentoAtual } from "./pagina";

export interface Livro { document: string; title: string | null; authors: string | null; epub_path: string; index_path: string; total_chars: number; spine_count: number; paper_pages: number | null }
export interface LivroNaLista { document: string; title: string | null; authors: string | null; percentage: number | null; device: string | null; progressXpath: string | null; timestamp: number | null; temEpub: boolean; paperPages: number | null }
export interface Marca { id: number; paragraph: number; xpath: string; char_offset: number; percentage: number; paper_page: number | null; method: string; matched_by: string; confidence: number | null; input_text: string | null; created_at: number }

export function listarLivros(db: Database, userId: number): LivroNaLista[] {
  return db.prepare(`
    SELECT COALESCE(p.document, b.document) AS document,
           COALESCE(b.title, p.title) AS title, COALESCE(b.authors, p.authors) AS authors,
           p.percentage, p.device, p.progress AS progressXpath, p.timestamp,
           (b.document IS NOT NULL) AS temEpub, b.paper_pages AS paperPages
    FROM progress p
    FULL OUTER JOIN books b ON b.document = p.document AND b.user_id = p.user_id
    WHERE COALESCE(p.user_id, b.user_id) = ?
    ORDER BY COALESCE(p.timestamp, b.created_at) DESC
  `).all(userId).map((r: any) => ({ ...r, temEpub: !!r.temEpub })) as LivroNaLista[];
}

export function obterLivro(db: Database, userId: number, document: string): Livro | null {
  return (db.prepare(`SELECT document, title, authors, epub_path, index_path, total_chars, spine_count, paper_pages FROM books WHERE user_id = ? AND document = ?`).get(userId, document) as Livro) ?? null;
}

export function progressoDoLivro(db: Database, userId: number, document: string) {
  return (db.prepare(`SELECT progress, percentage, device, timestamp FROM progress WHERE user_id = ? AND document = ?`).get(userId, document) as { progress: string; percentage: number; device: string; timestamp: number }) ?? null;
}

export function salvarLivro(db: Database, userId: number, indice: IndiceLivro, epubPath: string, indexPath: string): void {
  db.prepare(`
    INSERT INTO books (document, user_id, title, authors, epub_path, index_path, total_chars, spine_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document) DO UPDATE SET title = excluded.title, authors = excluded.authors, epub_path = excluded.epub_path,
      index_path = excluded.index_path, total_chars = excluded.total_chars, spine_count = excluded.spine_count
  `).run(indice.document, userId, indice.title, indice.authors, epubPath, indexPath, indice.totalChars, indice.spineCount, Math.floor(Date.now() / 1000));
}

export function salvarPaginas(db: Database, userId: number, document: string, paperPages: number | null): void {
  db.prepare(`UPDATE books SET paper_pages = ? WHERE user_id = ? AND document = ?`).run(paperPages, userId, document);
}

export function listarMarcas(db: Database, userId: number, document: string, limite = 5): Marca[] {
  return db.prepare(`SELECT * FROM paper_marks WHERE user_id = ? AND document = ? ORDER BY created_at DESC LIMIT ?`).all(userId, document, limite) as Marca[];
}

export function gravarMarca(db: Database, m: { userId: number; document: string; paragraph: number; xpath: string; charOffset: number; percentage: number; paperPage: number | null; method: string; matchedBy: string; confidence: number | null; inputText: string | null }): void {
  db.prepare(`
    INSERT INTO paper_marks (document, user_id, paragraph, xpath, char_offset, percentage, paper_page, method, matched_by, confidence, input_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.document, m.userId, m.paragraph, m.xpath, m.charOffset, m.percentage, m.paperPage, m.method, m.matchedBy, m.confidence, m.inputText, Math.floor(Date.now() / 1000));
}

export async function lerChaveApi(db: Database, userId: number, salt: string): Promise<string | null> {
  const linha = db.prepare(`SELECT api_key_enc FROM settings WHERE user_id = ?`).get(userId) as { api_key_enc: string | null } | null;
  if (!linha?.api_key_enc) return null;
  try { return await decifrar(linha.api_key_enc, salt); } catch { return null; }
}

export async function salvarChaveApi(db: Database, userId: number, chave: string | null, salt: string): Promise<void> {
  const enc = chave ? await cifrar(chave, salt) : null;
  db.prepare(`INSERT INTO settings (user_id, api_key_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, updated_at = excluded.updated_at`)
    .run(userId, enc, Math.floor(Date.now() / 1000));
}

export async function carregarIndice(indexPath: string): Promise<IndiceLivro> {
  return (await Bun.file(indexPath).json()) as IndiceLivro;
}

/** Página estimada no papel para a posição digital atual; null sem total de páginas ou sem progresso. */
export function paginaEstimada(db: Database, userId: number, livro: Livro, indice: IndiceLivro): number | null {
  if (!livro.paper_pages) return null;
  const prog = progressoDoLivro(db, userId, livro.document);
  if (!prog) return null;
  const marcas = (db.prepare(`SELECT char_offset AS charOffset, paper_page AS paperPage FROM paper_marks WHERE user_id = ? AND document = ? AND paper_page IS NOT NULL`).all(userId, livro.document) as { charOffset: number; paperPage: number }[]);
  return estimarPagina(deslocamentoAtual(indice, prog.progress, prog.percentage), indice.totalChars, livro.paper_pages, marcas);
}
```

Observação: se a versão do SQLite do Bun não aceitar `FULL OUTER JOIN` (precisa de SQLite ≥ 3.39), trocar `listarLivros` por duas consultas (progress do usuário + books sem progress) unidas em código; o teste cobre o resultado, não o SQL.

- [ ] **Step 5: Implementar as telas desta tarefa em `src/papel/telas.tsx`**

```tsx
import type { LivroNaLista, Livro, Marca } from "./dados";

const css = `
  :root { --bg:#fff; --fg:#111; --muted:#5b5b5b; --line:#e4e4e4; --accent:#0a5bff; --alert:#c8102e; --track:#ececec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f10; --fg:#f2f2f2; --muted:#a3a3a3; --line:#2a2a2c; --accent:#4d8dff; --alert:#ff5c6c; --track:#2a2a2c; } }
  * { box-sizing: border-box; } html, body { margin:0; background:var(--bg); color:var(--fg); }
  body { font-family:-apple-system, system-ui, "Segoe UI", Roboto, sans-serif; line-height:1.45; overflow-x:hidden; }
  main { max-width:720px; margin:0 auto; padding:1.5rem 1.25rem 3rem; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; } h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:1.5rem 0 .5rem; }
  a { color:var(--accent); } .muted { color:var(--muted); font-size:.9rem; }
  .topo { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; flex-wrap:wrap; }
  label { display:block; font-weight:600; margin:.9rem 0 .3rem; }
  input[type=text], input[type=password], input[type=number], select, textarea { width:100%; font-size:1rem; padding:.7rem .8rem; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  textarea { min-height:6rem; }
  .btn { display:inline-block; min-height:48px; padding:.8rem 1.2rem; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:1rem; font-weight:600; text-decoration:none; cursor:pointer; text-align:center; }
  .btn.sec { background:transparent; color:var(--accent); } .btn.bloco { display:block; width:100%; margin-top:1rem; }
  .erro { color:var(--alert); font-weight:600; } .aviso { border:1px solid var(--line); border-radius:8px; padding:.8rem 1rem; margin:1rem 0; font-size:.9rem; color:var(--muted); }
  .cartao { border-top:1px solid var(--line); padding:1rem 0; } .cartao:last-child { border-bottom:1px solid var(--line); }
  .nome { font-weight:600; margin:0; overflow-wrap:anywhere; } .bar { height:6px; background:var(--track); border-radius:3px; margin:.4rem 0; overflow:hidden; } .bar i { display:block; height:100%; background:var(--accent); }
  .par { padding:.8rem 1rem; border-left:3px solid var(--line); margin:.6rem 0; overflow-wrap:anywhere; } .par.alvo { border-left-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  .acoes { display:grid; gap:.6rem; margin-top:1rem; } .acoes .btn { width:100%; }
  ul { list-style:none; margin:0; padding:0; }
`;

export function Pagina(props: { titulo: string; children: any; script?: boolean }) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" /><meta name="robots" content="noindex, nofollow" />
        <title>{props.titulo} · Reader Server</title><style>{css}</style>
        {props.script ? <script src="/public/papel.js" defer></script> : null}
      </head>
      <body><main>{props.children}</main></body>
    </html>
  );
}

export function TelaLogin(props: { erro?: string; proximo?: string }) {
  return (
    <Pagina titulo="Entrar">
      <h1>Marcar no papel</h1>
      <p class="muted">Use o mesmo usuário e senha dos aparelhos.</p>
      {props.erro ? <p class="erro">{props.erro}</p> : null}
      <form method="post" action="/papel/login">
        <input type="hidden" name="proximo" value={props.proximo ?? ""} />
        <label for="usuario">Usuário</label><input id="usuario" name="usuario" type="text" autocomplete="username" required />
        <label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required />
        <button class="btn bloco" type="submit">Entrar</button>
      </form>
    </Pagina>
  );
}

export function rotuloAparelho(device: string | null): string {
  if (!device) return "";
  const d = device.toLowerCase();
  if (d.includes("kindle")) return "Kindle";
  if (d.includes("readest")) return device.replace(/\s*\((.*)\)/, " · $1");
  if (d.includes("crosspoint") || d.includes("xteink")) return "Xteink X3";
  return device;
}

export function TelaLivros(props: { livros: LivroNaLista[]; paginas: Map<string, number | null>; aviso?: string }) {
  return (
    <Pagina titulo="Livros">
      <div class="topo"><h1>Marcar no papel</h1><p class="muted"><a href="/papel/config">Configurações</a> · <a href="/">Painel</a></p></div>
      {props.aviso ? <p class="aviso">{props.aviso}</p> : null}
      {props.livros.length === 0 ? <p class="muted">Nenhum livro ainda. Envie um EPUB abaixo.</p> : null}
      <ul>
        {props.livros.map((l) => {
          const pct = l.percentage === null ? null : Math.round(l.percentage * 100);
          const pag = props.paginas.get(l.document);
          return (
            <li class="cartao">
              <p class="nome">{l.title ?? `Livro ${l.document.slice(0, 8)}`}</p>
              {l.authors ? <p class="muted">{l.authors}</p> : null}
              {pct !== null ? <><div class="bar"><i style={`width:${Math.max(1, pct)}%`} /></div><p class="muted">{pct}% · {rotuloAparelho(l.device)}{pag ? ` · ≈ pág. ${pag} no papel` : ""}</p></> : null}
              {l.temEpub ? <a class="btn bloco" href={`/papel/livros/${l.document}/marcar`}>Marcar onde parei</a> : <p class="muted">Sem EPUB no servidor: envie abaixo para poder marcar.</p>}
              {l.temEpub ? <p class="muted"><a href={`/papel/livros/${l.document}`}>Detalhes e páginas do papel</a></p> : null}
            </li>
          );
        })}
      </ul>
      <h2>Enviar EPUB</h2>
      <p class="muted">Tem de ser a mesma cópia que está no Kindle, no Readest e no X3.</p>
      <form method="post" action="/papel/livros" enctype="multipart/form-data">
        <input type="file" name="epub" accept=".epub,application/epub+zip" required />
        <button class="btn sec bloco" type="submit">Enviar EPUB</button>
      </form>
      <form method="post" action="/papel/sair"><button class="btn sec bloco" type="submit">Sair</button></form>
    </Pagina>
  );
}

export function TelaConfig(props: { fimDaChave: string | null; mensagem?: string; erro?: string }) {
  return (
    <Pagina titulo="Configurações">
      <div class="topo"><h1>Configurações</h1><p class="muted"><a href="/papel">Livros</a></p></div>
      <p class="muted">A chave de API serve para ler a foto da página e para localizar trechos de livros traduzidos. Sem ela, só o texto digitado em livro do mesmo idioma funciona.</p>
      {props.mensagem ? <p class="aviso">{props.mensagem}</p> : null}
      {props.erro ? <p class="erro">{props.erro}</p> : null}
      <form method="post" action="/papel/config">
        <label for="chave">Chave de API</label>
        <input id="chave" name="chave" type="password" autocomplete="off" placeholder={props.fimDaChave ? `Cadastrada (termina em ${props.fimDaChave})` : "Cole a chave"} />
        <div class="acoes">
          <button class="btn" type="submit" name="acao" value="salvar">Salvar</button>
          <button class="btn sec" type="submit" name="acao" value="testar">Testar chave</button>
          {props.fimDaChave ? <button class="btn sec" type="submit" name="acao" value="remover">Remover</button> : null}
        </div>
      </form>
    </Pagina>
  );
}

export function TelaLivro(props: { livro: Livro; progresso: { percentage: number; device: string; timestamp: number } | null; capitulo: string | null; pagina: number | null; marcas: Marca[]; aviso?: string; mensagem?: string }) {
  const { livro } = props;
  return (
    <Pagina titulo={livro.title ?? "Livro"}>
      <div class="topo"><h1>{livro.title ?? `Livro ${livro.document.slice(0, 8)}`}</h1><p class="muted"><a href="/papel">Livros</a></p></div>
      {livro.authors ? <p class="muted">{livro.authors}</p> : null}
      {props.aviso ? <p class="aviso">{props.aviso}</p> : null}
      {props.mensagem ? <p class="aviso">{props.mensagem}</p> : null}
      <h2>Posição atual</h2>
      {props.progresso ? (
        <p>{Math.round(props.progresso.percentage * 100)}% · {rotuloAparelho(props.progresso.device)}{props.capitulo ? ` · ${props.capitulo}` : ""}{props.pagina ? ` · ≈ pág. ${props.pagina} no papel` : ""}</p>
      ) : <p class="muted">Nenhum aparelho sincronizou este livro ainda.</p>}
      <a class="btn bloco" href={`/papel/livros/${livro.document}/marcar`}>Marcar onde parei</a>
      <h2>Livro de papel</h2>
      <form method="post" action={`/papel/livros/${livro.document}/paginas`}>
        <label for="paginas">Total de páginas do livro de papel</label>
        <input id="paginas" name="paginas" type="number" min="1" inputmode="numeric" value={livro.paper_pages ?? ""} />
        <button class="btn sec bloco" type="submit">Salvar</button>
      </form>
      <p class="muted">Com o total, o painel mostra a página aproximada no papel. Cada marcação com página informada melhora a estimativa. No X3, marque pelo menos algumas páginas à frente da posição dele, porque ele compara porcentagens.</p>
      <h2>Últimas marcações</h2>
      {props.marcas.length === 0 ? <p class="muted">Nenhuma ainda.</p> : (
        <ul>{props.marcas.map((m) => <li class="cartao muted">{new Date(m.created_at * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {m.method} · {Math.round(m.percentage * 100)}%{m.paper_page ? ` · pág. ${m.paper_page}` : ""}</li>)}</ul>
      )}
      <h2>Arquivo</h2>
      <form method="post" action="/papel/livros" enctype="multipart/form-data">
        <input type="file" name="epub" accept=".epub,application/epub+zip" required />
        <button class="btn sec bloco" type="submit">Reenviar EPUB</button>
      </form>
    </Pagina>
  );
}
```

- [ ] **Step 6: Implementar `src/papel/rotas.tsx` (parte desta tarefa)**

```tsx
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
    for (const l of livros) {
      if (!l.temEpub || !l.paperPages) continue;
      const livro = dados.obterLivro(db, userId, l.document);
      if (livro) paginas.set(l.document, dados.paginaEstimada(db, userId, livro, await dados.carregarIndice(livro.index_path)));
    }
    return c.html(<TelaLivros livros={livros} paginas={paginas} aviso={c.req.query("aviso")} />);
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

  app.post("/papel/sair", (c) => {
    apagarCookieSessao(c);
    return c.redirect("/papel", 302);
  });

  app.use("/papel/*", exigeSessao(salt));

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
    if (!mesmoHash && indice.title) {
      const outro = db.prepare(`SELECT document FROM progress WHERE user_id = ? AND document != ? AND lower(title) = lower(?) AND COALESCE(lower(authors), '') = COALESCE(lower(?), '')`)
        .get(userId, document, indice.title, indice.authors) as { document: string } | null;
      if (outro) {
        return c.html(<TelaLivros livros={dados.listarLivros(db, userId)} paginas={new Map()} aviso="Esta cópia não é a mesma que seus aparelhos usam (hash diferente). Envie o arquivo que está no Kindle/Readest." />, 400);
      }
      aviso = "Nenhum aparelho sincronizou este arquivo ainda; use exatamente esta cópia neles.";
    } else if (!mesmoHash) {
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
    const livro = dados.obterLivro(db, userId, c.req.param("document"));
    if (!livro) return c.redirect("/papel?aviso=" + encodeURIComponent("Envie o EPUB deste livro primeiro."), 302);
    const indice = await dados.carregarIndice(livro.index_path);
    const progresso = dados.progressoDoLivro(db, userId, livro.document);
    const p = progresso ? paragrafoDoXpath(indice, progresso.progress) : null;
    const capitulo = p !== null ? capituloDoParagrafo(indice, p)?.title ?? null : null;
    return c.html(<TelaLivro livro={livro} progresso={progresso} capitulo={capitulo} pagina={dados.paginaEstimada(db, userId, livro, indice)} marcas={dados.listarMarcas(db, userId, livro.document)} aviso={c.req.query("aviso")} mensagem={c.req.query("msg")} />);
  });

  app.post("/papel/livros/:document/paginas", async (c) => {
    const userId = c.get("userId");
    const document = c.req.param("document");
    const form = await c.req.parseBody();
    const n = parseInt(String(form["paginas"] ?? ""), 10);
    dados.salvarPaginas(db, userId, document, Number.isFinite(n) && n > 0 ? n : null);
    return c.redirect(`/papel/livros/${document}?msg=${encodeURIComponent("Total de páginas salvo.")}`, 302);
  });

  return app;
}
```

- [ ] **Step 7: Montar em `src/index.tsx`**

Depois de `app.use("/users/*", authRateLimit);` acrescentar:

```ts
import { criarRotasPapel } from "./papel/rotas";
import { criarLocalizadorIA } from "./papel/ia";
// ...
app.route("/", criarRotasPapel({ db, salt: config.password.salt, dirLivros: "data/books", ia: criarLocalizadorIA(), logger }));
```

(As rotas já vêm com o prefixo `/papel`, por isso `app.route("/", ...)`.)

- [ ] **Step 8: Rodar tudo e o build**

```bash
bun test && bun run build && rm server.js
```

Esperado: todos verdes. Se `parseBody()` não entregar `File` para o campo `epub` no `app.request` com `FormData`, conferir a versão do Hono (≥ 4.0 entrega `File`); se o `set-cookie` vier sem `Secure` no teste, é normal (o teste só confere o nome).

- [ ] **Step 9: Commit**

```bash
git add src/limite.ts src/papel/dados.ts src/papel/telas.tsx src/papel/rotas.tsx src/papel/rotas.test.ts src/index.tsx
git commit -m "Adiciona área /papel: login, livros, configurações e envio do EPUB

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Marcar onde parei: formulário, localização e confirmação

**Files:**
- Modify: `src/papel/telas.tsx` (acrescentar `TelaMarcar` e `TelaResultado`)
- Modify: `src/papel/rotas.tsx` (acrescentar 3 rotas)
- Modify: `src/papel/rotas.test.ts` (acrescentar os testes abaixo)

**Interfaces:**
- Consumes: `casarTrecho`, `paragrafosDoCapitulo` (Task 4), `LocalizadorIA` (7), `dados.*` (8), `gravarProgresso` (1).
- Produces: rotas `GET /papel/livros/:document/marcar`, `POST /papel/livros/:document/localizar`, `POST /papel/livros/:document/confirmar`.
- Campos do formulário de marcar: `capitulo` (posição em `indice.chapters`), `modo` (`auto` | `inicio`), `foto` (arquivo, opcional), `trecho` (texto, opcional), `pagina` (número, opcional).
- Campos ocultos do resultado → confirmar: `paragrafo`, `pagina`, `metodo` (`texto`|`foto`|`capitulo`), `origem` (`local`|`ia`|`manual`), `confianca`, `texto_entrada`.
- Linha gravada em `progress`: `device = "Livro físico"`, `device_id = "papel"`, `progress = xpath`, `percentage = offset/totalChars`, `title/authors/filename` do livro.

- [ ] **Step 1: Acrescentar os testes ao fim de `src/papel/rotas.test.ts`**

```ts
import { salvarChaveApi } from "./dados";

async function livroPronto(): Promise<{ cookie: string; hash: string }> {
  const bytes = epubDeTeste();
  const hash = hashParcialKoreader(bytes);
  gravarProgresso(db, { userId: 1, document: hash, progress: "/body/DocFragment[1]/body/p", percentage: 0.05, device: "KindleBasic3", deviceId: "k", title: "Livro de Teste", authors: "Autora Fictícia", filename: "livro.epub" });
  const cookie = await logar();
  await enviarEpub(cookie, bytes);
  return { cookie, hash };
}

async function localizar(cookie: string, hash: string, campos: Record<string, string>, foto?: Uint8Array) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, v);
  if (foto) form.append("foto", new File([foto], "pagina.jpg", { type: "image/jpeg" }));
  return app.request(`/papel/livros/${hash}/localizar`, comCookie(cookie, { method: "POST", body: form }));
}

test("formulário de marcar lista os capítulos e pré-seleciona o da posição atual", async () => {
  const { cookie, hash } = await livroPronto();
  const html = await (await app.request(`/papel/livros/${hash}/marcar`, comCookie(cookie))).text();
  expect(html).toContain('<option value="0" selected>Um</option>');
  expect(html).toContain('<option value="1">Dois</option>');
  expect(html).toContain('name="foto"');
  expect(html).toContain('name="trecho"');
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
  expect(prog).toMatchObject({ device: "Livro físico", device_id: "papel", progress: "/body/DocFragment[2]/body/p[2]", title: "Livro de Teste", filename: "livro.epub" });
  expect(prog.percentage).toBeGreaterThan(0.5);
  const marca = db.prepare("SELECT * FROM paper_marks WHERE document = ?").get(hash) as any;
  expect(marca).toMatchObject({ paragraph: 3, paper_page: 42, method: "texto", matched_by: "local" });
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

test("texto que não casa e sem chave: mensagem com alternativas; parágrafos gêmeos: candidatos", async () => {
  const { cookie, hash } = await livroPronto();
  const nada = await (await localizar(cookie, hash, { capitulo: "0", modo: "auto", trecho: "frase inexistente neste livro" })).text();
  expect(nada).toContain("Não encontrei");
  expect(nada).toContain("início do capítulo");
});

test("confirmar com parágrafo inválido devolve 400 e não grava", async () => {
  const { cookie, hash } = await livroPronto();
  const r = await app.request(`/papel/livros/${hash}/confirmar`, comCookie(cookie, { method: "POST", body: new URLSearchParams({ paragrafo: "999", metodo: "texto", origem: "local" }) }));
  expect(r.status).toBe(400);
  expect((db.prepare("SELECT device FROM progress WHERE document = ?").get(hash) as any).device).toBe("KindleBasic3");
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/papel/rotas.test.ts
```

- [ ] **Step 3: Acrescentar as telas em `src/papel/telas.tsx`**

```tsx
import type { Capitulo, Paragrafo } from "./epub-index";

export function TelaMarcar(props: { livro: Livro; capitulos: Capitulo[]; capituloAtual: number; temChave: boolean; erro?: string }) {
  return (
    <Pagina titulo="Marcar onde parei" script>
      <div class="topo"><h1>Marcar onde parei</h1><p class="muted"><a href={`/papel/livros/${props.livro.document}`}>{props.livro.title ?? "Livro"}</a></p></div>
      {props.erro ? <p class="erro">{props.erro}</p> : null}
      {!props.temChave ? <p class="aviso">Sem chave de API: a foto e os livros traduzidos não funcionam. Digite as primeiras palavras do parágrafo, ou marque o início do capítulo. <a href="/papel/config">Configurações</a></p> : null}
      <form method="post" action={`/papel/livros/${props.livro.document}/localizar`} enctype="multipart/form-data" id="form-marcar">
        <label for="capitulo">Capítulo</label>
        <select id="capitulo" name="capitulo">
          {props.capitulos.map((c, i) => (i === props.capituloAtual ? <option value={String(i)} selected>{c.title}</option> : <option value={String(i)}>{c.title}</option>))}
        </select>
        <label for="foto">Foto da página</label>
        <input id="foto" name="foto" type="file" accept="image/*" capture="environment" />
        <img id="previa" alt="" style="max-width:100%; display:none; margin-top:.5rem; border-radius:8px" />
        <label for="trecho">Ou as primeiras palavras do parágrafo</label>
        <textarea id="trecho" name="trecho" placeholder="Pode ditar pelo teclado do celular"></textarea>
        <label><input type="checkbox" name="modo" value="inicio" /> Ou só o início do capítulo</label>
        <label for="pagina">Página do livro de papel (opcional)</label>
        <input id="pagina" name="pagina" type="number" min="1" inputmode="numeric" />
        <button class="btn bloco" type="submit" id="botao-localizar">Localizar</button>
      </form>
    </Pagina>
  );
}

export interface CandidatoTela { paragrafo: number; texto: string; anterior: string | null; seguinte: string | null }

export function TelaResultado(props: {
  livro: Livro; capitulo: string; principal: CandidatoTela; outros: CandidatoTela[];
  metodo: string; origem: string; confianca: number | null; textoEntrada: string; pagina: string; usouIA: boolean; duvidoso: boolean;
}) {
  const ocultos = (paragrafo: number) => (
    <>
      <input type="hidden" name="paragrafo" value={String(paragrafo)} />
      <input type="hidden" name="pagina" value={props.pagina} />
      <input type="hidden" name="metodo" value={props.metodo} />
      <input type="hidden" name="origem" value={props.origem} />
      <input type="hidden" name="confianca" value={props.confianca === null ? "" : String(props.confianca)} />
      <input type="hidden" name="texto_entrada" value={props.textoEntrada} />
    </>
  );
  const acao = `/papel/livros/${props.livro.document}/confirmar`;
  return (
    <Pagina titulo="Confirmar posição">
      <div class="topo"><h1>{props.duvidoso ? "Qual destes?" : "É aqui?"}</h1><p class="muted">{props.capitulo}</p></div>
      {props.usouIA ? <p class="muted">Localizado pela IA{props.confianca !== null ? ` (confiança ${Math.round(props.confianca * 100)}%)` : ""}.</p> : null}
      {props.principal.anterior ? <div class="par muted">{props.principal.anterior}</div> : null}
      <div class="par alvo">{props.principal.texto}</div>
      {props.principal.seguinte ? <div class="par muted">{props.principal.seguinte}</div> : null}
      <div class="acoes">
        <form method="post" action={acao}>{ocultos(props.principal.paragrafo)}<button class="btn" type="submit">É este</button></form>
        {props.principal.anterior ? <form method="post" action={acao}>{ocultos(props.principal.paragrafo - 1)}<button class="btn sec" type="submit">O de cima</button></form> : null}
        {props.principal.seguinte ? <form method="post" action={acao}>{ocultos(props.principal.paragrafo + 1)}<button class="btn sec" type="submit">O de baixo</button></form> : null}
      </div>
      {props.outros.length > 0 ? (
        <>
          <h2>Outras possibilidades</h2>
          {props.outros.map((o) => (
            <form method="post" action={acao}><div class="par">{o.texto}</div>{ocultos(o.paragrafo)}<button class="btn sec bloco" type="submit">É este</button></form>
          ))}
        </>
      ) : null}
      <a class="btn sec bloco" href={`/papel/livros/${props.livro.document}/marcar`}>Tentar de novo</a>
    </Pagina>
  );
}

export function candidatoTela(paragrafos: Paragrafo[], i: number): CandidatoTela {
  return { paragrafo: i, texto: paragrafos[i].text, anterior: paragrafos[i - 1]?.text ?? null, seguinte: paragrafos[i + 1]?.text ?? null };
}
```

- [ ] **Step 4: Acrescentar as rotas em `src/papel/rotas.tsx`** (antes de `return app;`)

Novas importações no topo: `import { casarTrecho, paragrafosDoCapitulo } from "./casamento";`, `import { gravarProgresso } from "../progresso";`, e em `./telas` acrescentar `TelaMarcar, TelaResultado, candidatoTela`.

```tsx
  app.get("/papel/livros/:document/marcar", async (c) => {
    const userId = c.get("userId");
    const livro = dados.obterLivro(db, userId, c.req.param("document"));
    if (!livro) return c.redirect("/papel?aviso=" + encodeURIComponent("Envie o EPUB deste livro primeiro."), 302);
    const indice = await dados.carregarIndice(livro.index_path);
    const progresso = dados.progressoDoLivro(db, userId, livro.document);
    const p = progresso ? paragrafoDoXpath(indice, progresso.progress) : null;
    const atual = p !== null ? capituloDoParagrafo(indice, p) : null;
    const capituloAtual = atual ? indice.chapters.indexOf(atual) : 0;
    const temChave = !!(await dados.lerChaveApi(db, userId, salt));
    return c.html(<TelaMarcar livro={livro} capitulos={indice.chapters} capituloAtual={capituloAtual} temChave={temChave} erro={c.req.query("erro")} />);
  });

  app.post("/papel/livros/:document/localizar", async (c) => {
    const userId = c.get("userId");
    const livro = dados.obterLivro(db, userId, c.req.param("document"));
    if (!livro) return c.redirect("/papel", 302);
    const indice = await dados.carregarIndice(livro.index_path);
    const form = await c.req.parseBody();
    const capitulo = parseInt(String(form["capitulo"] ?? "0"), 10) || 0;
    const modo = String(form["modo"] ?? "auto");
    const trecho = String(form["trecho"] ?? "").trim();
    const pagina = String(form["pagina"] ?? "").trim();
    const foto = form["foto"] instanceof File && (form["foto"] as File).size > 0 ? (form["foto"] as File) : null;
    const escopo = paragrafosDoCapitulo(indice, capitulo);
    const titulo = indice.chapters[capitulo]?.title ?? "Capítulo";
    const temChave = !!(await dados.lerChaveApi(db, userId, salt));
    const voltar = (erro: string) => c.html(<TelaMarcar livro={livro} capitulos={indice.chapters} capituloAtual={capitulo} temChave={temChave} erro={erro} />, 400);
    if (escopo.length === 0) return voltar("Este capítulo não tem texto. Escolha outro.");

    const mostrar = (principal: number, outros: number[], metodo: string, origem: string, confianca: number | null, textoEntrada: string, duvidoso: boolean) =>
      c.html(<TelaResultado livro={livro} capitulo={titulo} principal={candidatoTela(indice.paragraphs, principal)} outros={outros.filter((o) => o !== principal).map((o) => candidatoTela(indice.paragraphs, o))}
        metodo={metodo} origem={origem} confianca={confianca} textoEntrada={textoEntrada} pagina={pagina} usouIA={origem === "ia"} duvidoso={duvidoso} />);

    if (modo === "inicio") return mostrar(escopo[0], [], "capitulo", "manual", null, "", false);

    if (foto) {
      if (foto.size > 5 * 1024 * 1024) return voltar("A foto passou de 5 MB mesmo reduzida. Tente de novo com menos zoom.");
      const chave = await dados.lerChaveApi(db, userId, salt);
      if (!chave) return voltar("Sem chave de API: não dá para ler a foto. Digite as primeiras palavras ou marque o início do capítulo.");
      const tipo = (["image/jpeg", "image/png", "image/webp"].includes(foto.type) ? foto.type : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
      const base64 = Buffer.from(await foto.arrayBuffer()).toString("base64");
      const r = await ia.localizar({ chave, paragrafos: escopo.map((i) => ({ texto: indice.paragraphs[i].text })), imagem: { base64, mediaType: tipo } });
      if (r.status === "erro") return voltar(r.mensagem);
      if (r.paragrafo === null) return voltar("Não encontrei esta página no capítulo escolhido. Confira o capítulo, digite as primeiras palavras, ou marque o início do capítulo.");
      const principal = escopo[r.paragrafo];
      const outros = r.candidatos.map((k) => escopo[k]).filter((x) => x !== undefined);
      return mostrar(principal, r.confianca < 0.7 ? outros : [], "foto", "ia", r.confianca, r.transcricao, r.confianca < 0.7);
    }

    if (!trecho) return voltar("Tire a foto, digite as primeiras palavras, ou marque o início do capítulo.");
    const local = casarTrecho(trecho, indice, escopo);
    if (local.status === "confiante") return mostrar(local.candidatos[0].paragraph, [], "texto", "local", local.candidatos[0].score, trecho, false);
    if (local.status === "duvidoso") return mostrar(local.candidatos[0].paragraph, local.candidatos.map((k) => k.paragraph), "texto", "local", local.candidatos[0].score, trecho, true);
    const noLivro = casarTrecho(trecho, indice, indice.paragraphs.map((_, i) => i));
    if (noLivro.status === "confiante") return mostrar(noLivro.candidatos[0].paragraph, [], "texto", "local", noLivro.candidatos[0].score, trecho, false);
    const chave = await dados.lerChaveApi(db, userId, salt);
    if (!chave) return voltar("Não encontrei este trecho. Confira o capítulo, tente outras palavras, ou marque o início do capítulo. Para livro traduzido, cadastre a chave de API em Configurações.");
    const r = await ia.localizar({ chave, paragrafos: escopo.map((i) => ({ texto: indice.paragraphs[i].text })), trecho });
    if (r.status === "erro") return voltar(r.mensagem);
    if (r.paragrafo === null) return voltar("Não encontrei este trecho no capítulo escolhido, nem pela IA. Confira o capítulo ou marque o início do capítulo.");
    const outros = r.candidatos.map((k) => escopo[k]).filter((x) => x !== undefined);
    return mostrar(escopo[r.paragrafo], r.confianca < 0.7 ? outros : [], "texto", "ia", r.confianca, r.transcricao || trecho, r.confianca < 0.7);
  });

  app.post("/papel/livros/:document/confirmar", async (c) => {
    const userId = c.get("userId");
    const livro = dados.obterLivro(db, userId, c.req.param("document"));
    if (!livro) return c.redirect("/papel", 302);
    const indice = await dados.carregarIndice(livro.index_path);
    const form = await c.req.parseBody();
    const paragrafo = parseInt(String(form["paragrafo"] ?? ""), 10);
    if (!Number.isInteger(paragrafo) || paragrafo < 0 || paragrafo >= indice.paragraphs.length) return c.text("Parágrafo inválido.", 400);
    const paginaNum = parseInt(String(form["pagina"] ?? ""), 10);
    const paperPage = Number.isFinite(paginaNum) && paginaNum > 0 ? paginaNum : null;
    const confNum = parseFloat(String(form["confianca"] ?? ""));
    const metodo = ["texto", "foto", "capitulo"].includes(String(form["metodo"])) ? String(form["metodo"]) : "texto";
    const origem = ["local", "ia", "manual"].includes(String(form["origem"])) ? String(form["origem"]) : "manual";
    const p = indice.paragraphs[paragrafo];
    const percentage = indice.totalChars > 0 ? p.offset / indice.totalChars : 0;
    dados.gravarMarca(db, { userId, document: livro.document, paragraph: paragrafo, xpath: p.xpath, charOffset: p.offset, percentage, paperPage, method: metodo, matchedBy: origem, confidence: Number.isFinite(confNum) ? confNum : null, inputText: String(form["texto_entrada"] ?? "").slice(0, 2000) || null });
    gravarProgresso(db, { userId, document: livro.document, progress: p.xpath, percentage, device: "Livro físico", deviceId: "papel", title: livro.title, authors: livro.authors, filename: null });
    logger.info({ userId, document: livro.document, xpath: p.xpath, percentage, metodo, origem }, "Marcação no papel gravada");
    const hora = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    return c.redirect(`/papel/livros/${livro.document}?msg=${encodeURIComponent(`Gravado às ${hora}. A próxima sincronização dos leitores pega daqui.`)}`, 302);
  });
```

Observação: `filename: null` de propósito. O UPSERT usa `COALESCE`, então o nome de arquivo que o Kindle/Readest já gravou é mantido; o caminho no servidor (`data/books/<hash>.epub`) não serve como nome para os leitores.

- [ ] **Step 5: Rodar tudo**

```bash
bun test && bun run build && rm server.js
```

Esperado: todos verdes. Se o teste da foto falhar por `foto.size`, conferir que `parseBody()` entregou `File` (Hono ≥ 4) e que `iaFalsa` está devolvendo `paragrafo: 1`.

- [ ] **Step 6: Commit**

```bash
git add src/papel/telas.tsx src/papel/rotas.tsx src/papel/rotas.test.ts
git commit -m "Adiciona marcação no papel: localizar por texto, foto ou capítulo e confirmar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Painel público: livro físico, página estimada e link

**Files:**
- Modify: `src/dashboard.tsx`
- Modify: `src/index.tsx` (rota `/`)
- Create: `src/dashboard.test.tsx`

**Interfaces:**
- `DashboardRow` ganha `paperPage?: number | null`.
- `deviceLabel("Livro físico")` → `"Livro físico"`.

- [ ] **Step 1: Escrever o teste que falha**

`src/dashboard.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { Dashboard } from "./dashboard";

const base = { document: "abc", percentage: 0.3, filename: null, authors: "A", timestamp: 1000, title: "T" };

test("mostra a página estimada no papel e o aparelho Livro físico", () => {
  const html = (<Dashboard rows={[{ ...base, device: "Livro físico", paperPage: 87 }]} now={2000} />).toString();
  expect(html).toContain("Livro físico");
  expect(html).toContain("≈ pág. 87 no papel");
});

test("sem total de páginas não mostra estimativa; tem link para marcar", () => {
  const html = (<Dashboard rows={[{ ...base, device: "KindleBasic3", paperPage: null }]} now={2000} />).toString();
  expect(html).not.toContain("no papel");
  expect(html).toContain('href="/papel"');
  expect(html).toContain("Guarda os EPUBs");
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/dashboard.test.tsx
```

- [ ] **Step 3: Alterar `src/dashboard.tsx`**

- Em `DashboardRow`, acrescentar `paperPage?: number | null;`.
- Em `deviceLabel`, antes do `return device;`, acrescentar `if (d.includes("físico") || d === "papel") return "Livro físico";`.
- No `<p class="meta">` do `Book`, trocar por:
  ```tsx
  <p class="meta">
    {deviceLabel(r.device)} · {relativeTime(r.timestamp, now)} · {absoluteTime(r.timestamp)}
    {r.paperPage ? ` · ≈ pág. ${r.paperPage} no papel` : ""}
  </p>
  ```
- No `<header>`, dentro do `<div>` do título, depois do `<p class="sub">Onde parei de ler</p>`, acrescentar `<p class="sub"><a href="/papel">Marcar no papel</a></p>` e no CSS `a { color: var(--accent); }`.
- No `<footer>`: `Horários em Brasília. Esta página não mostra nem aceita credenciais. Guarda os EPUBs que você enviou pela área do celular; a foto da página não é guardada.`

- [ ] **Step 4: Alterar a rota `/` em `src/index.tsx`**

```tsx
app.get("/", async (c) => {
  const rows = db
    .prepare(`SELECT user_id, document, percentage, device, filename, title, authors, timestamp FROM progress ORDER BY timestamp DESC`)
    .all() as (DashboardRow & { user_id: number })[];
  for (const r of rows) {
    const livro = dados.obterLivro(db, r.user_id, r.document);
    if (livro?.paper_pages) r.paperPage = dados.paginaEstimada(db, r.user_id, livro, await dados.carregarIndice(livro.index_path));
  }
  const now = Math.floor(Date.now() / 1000);
  c.header("Cache-Control", "no-store");
  return c.html(<Dashboard rows={rows} now={now} />);
});
```

com `import * as dados from "./papel/dados";` no topo.

- [ ] **Step 5: Rodar tudo**

```bash
bun test && bun run build && rm server.js
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.tsx src/dashboard.test.tsx src/index.tsx
git commit -m "Painel mostra o livro físico, a página estimada e o link para marcar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Foto reduzida no celular, README, verificação final e entrega

**Files:**
- Create: `public/papel.js`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-08-livro-fisico.md` (marcar as caixas)

- [ ] **Step 1: Criar `public/papel.js`** (sem dependências; roda só na tela de marcar)

```js
(function () {
  var entrada = document.getElementById("foto");
  var previa = document.getElementById("previa");
  var botao = document.getElementById("botao-localizar");
  if (!entrada || !previa || !botao) return;
  var MAX = 1600;

  entrada.addEventListener("change", function () {
    var arquivo = entrada.files && entrada.files[0];
    if (!arquivo || !arquivo.type || arquivo.type.indexOf("image/") !== 0) return;
    botao.disabled = true;
    var img = new Image();
    var url = URL.createObjectURL(arquivo);
    img.onload = function () {
      var escala = Math.min(1, MAX / Math.max(img.width, img.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        URL.revokeObjectURL(url);
        if (blob && blob.size < arquivo.size) {
          var reduzido = new File([blob], "pagina.jpg", { type: "image/jpeg" });
          var dt = new DataTransfer();
          dt.items.add(reduzido);
          entrada.files = dt.files;
        }
        previa.src = canvas.toDataURL("image/jpeg", 0.6);
        previa.style.display = "block";
        botao.disabled = false;
      }, "image/jpeg", 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); botao.disabled = false; };
    img.src = url;
  });
})();
```

Conferir no Chrome do Mac (`bun run dev` com `DB_PATH=/tmp/x.db PASSWORD_SALT=s`): abrir `http://localhost:3000/papel/livros/<hash>/marcar`, escolher uma foto grande, ver a prévia e, no DevTools → Network após "Localizar", o tamanho do envio abaixo de 1 MB. A CSP atual (`script-src 'self'`) permite o arquivo por ser da mesma origem; `img-src 'self' data:` permite a prévia.

- [ ] **Step 2: README: nova seção "Marcar no papel"** (depois de "Painel de leitura (05/09)")

```markdown
## Marcar no papel (livro físico)

`https://readerserver.up.railway.app/papel` no celular. Login com o mesmo usuário e senha dos aparelhos (cookie válido por 30 dias).

1. **Enviar o EPUB** uma vez por livro: tem de ser a MESMA cópia que está no Kindle/Readest/X3 (o servidor confere o hash e recusa cópia diferente de um livro já sincronizado).
2. **Configurações → Chave de API** (Anthropic): necessária para foto e para livro traduzido. Sem ela, só o texto digitado em livro do mesmo idioma funciona. Guardada cifrada no banco.
3. **Marcar onde parei**: escolher o capítulo, tirar a foto da página (ou digitar as primeiras palavras, ou marcar o início do capítulo), informar a página do papel se quiser, conferir o parágrafo e confirmar. Os aparelhos pegam a posição na próxima sincronização.
4. Na tela do livro, cadastrar o **total de páginas do papel** para o painel mostrar "≈ pág. N no papel".

Convenção da foto: a posição vai para o primeiro parágrafo completo da página fotografada; "O de cima/O de baixo" ajustam. A foto não é guardada; só o texto transcrito fica no histórico.

Limitação: o X3 (Smart sync) aplica a posição mais avançada em porcentagem, e a porcentagem do papel é calculada por caracteres (difere 1–2 pontos da do aparelho). Marque no papel pelo menos algumas páginas à frente da posição do X3.

Dados: tabelas `books`, `paper_marks`, `settings`; arquivos em `/app/data/books/`. Testes: `bun test` na pasta `app/`.
```

E na seção "Infra", trocar a frase do painel: "Painel `/` continua público; guarda os EPUBs enviados pela área `/papel`."

- [ ] **Step 3: Verificação final local**

```bash
cd ~/kosync-server/app && bun test && bun run build && rm server.js
docker build -t readerserver:papel . && docker run -d --name papel -p 3999:3000 -e PASSWORD_SALT=teste -e DISABLE_USER_REGISTRATION=false readerserver:papel
curl -s -o /dev/null -w '%{http_code}\n' localhost:3999/papel          # 200 (login)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3999/health         # 200
docker rm -f papel
```

- [ ] **Step 4: Commit e entrega**

```bash
git add public/papel.js README.md docs/superpowers/plans/2026-09-08-livro-fisico.md
git commit -m "Adiciona redução da foto no celular e documenta a marcação no papel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Depois, **avisar o Eduardo** e só com o OK dele: `cd ~/kosync-server/app && railway up --service kosync --project 37b31d48-10c3-4508-a67e-131b85daa0d9 --environment production --ci`, conferir `/health`, `/` e `/papel` em produção, e pedir a ele o teste de aceite: enviar o EPUB de "The Time Machine" (`~/Documents/Reading/Time Machine - H.G Wells .epub`), cadastrar a chave, marcar por texto, abrir no Kindle e no X3.

---

## Self-review (feito ao escrever)

- **Cobertura da spec:** seção 3 (unidades) → Tasks 1–10; 4.1 tabelas → Task 1; 4.3/4.4 índice e XPath → Task 3; 5 rotas → Tasks 8–9; 6 casamento → Tasks 4, 7, 9; 7.1 aceitação do EPUB → Task 8; 7.2 limitação do X3 → texto na tela do livro (Task 8) e README (Task 11); 8 estimativa → Tasks 5, 8, 10; 9 sessão/segurança → Tasks 6, 8, 9; 10 telas → Tasks 8–9; 11 testes → cada tarefa; 12 deploy → Task 11; 13 fora de escopo → nada implementado além.
- **Nomes conferidos entre tarefas:** `abrirBanco`, `gravarProgresso`, `hashParcialKoreader`, `indexarEpub`/`paragrafoDoXpath`/`capituloDoParagrafo`, `casarTrecho`/`paragrafosDoCapitulo`, `estimarPagina`/`deslocamentoAtual`, `cifrar`/`decifrar`, `criarCookie`/`lerCookie`/`exigeSessao`/`gravarCookieSessao`/`apagarCookieSessao`/`NOME_COOKIE`, `criarLocalizadorIA`/`LocalizadorIA`, `dados.*`, `criarRotasPapel`, `candidatoTela`.
- **Sem placeholders:** todos os passos têm código ou comando.
