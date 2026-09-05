// =============================================================================
// Painel de leitura (rota "/")
// Mostra os livros sincronizados e onde a leitura parou. Sem login, sem
// credenciais, sem dados de conta: apenas o que os aparelhos enviaram.
// =============================================================================

export interface DashboardRow {
  document: string;
  percentage: number;
  device: string;
  filename: string | null;
  title: string | null;
  authors: string | null;
  timestamp: number;
}

const FINISHED_AT = 0.98;

function bookName(row: DashboardRow): string {
  if (row.title) return row.title;
  if (row.filename) return row.filename.replace(/\.[a-z0-9]+$/i, "");
  return `Livro ${row.document.slice(0, 8)}`;
}

function authorsLine(row: DashboardRow): string | null {
  if (!row.authors) return null;
  return row.authors.split("\n").filter(Boolean).join(", ");
}

function deviceLabel(device: string): string {
  const d = device.toLowerCase();
  if (d.includes("kindle")) return "Kindle";
  if (d.includes("readest")) return device.replace(/\s*\((.*)\)/, " · $1");
  if (d.includes("crosspoint") || d.includes("xteink")) return "Xteink X3";
  return device;
}

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return "agora há pouco";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? "s" : ""}`;
  const mo = Math.floor(d / 30);
  return `há ${mo} m${mo > 1 ? "eses" : "ês"}`;
}

function absoluteTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const css = `
  :root {
    --bg: #ffffff;
    --fg: #111111;
    --muted: #5b5b5b;
    --line: #e4e4e4;
    --accent: #0a5bff;
    --track: #ececec;
    --card: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f10;
      --fg: #f2f2f2;
      --muted: #a3a3a3;
      --line: #2a2a2c;
      --accent: #4d8dff;
      --track: #2a2a2c;
      --card: #161617;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    line-height: 1.45;
    overflow-x: hidden;
  }
  main { max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.5rem; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 0.95rem; margin: 0.25rem 0 0; }
  .stats { display: flex; gap: 1.5rem; margin: 1.5rem 0 1rem; flex-wrap: wrap; }
  .stat { min-width: 0; }
  .stat b { display: block; font-size: 1.4rem; line-height: 1.1; }
  .stat span { color: var(--muted); font-size: 0.85rem; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 2rem 0 0.75rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li.book {
    padding: 1rem 0;
    border-top: 1px solid var(--line);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.25rem 1rem;
    align-items: baseline;
  }
  li.book:last-child { border-bottom: 1px solid var(--line); }
  .name { font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  .author { color: var(--muted); margin: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); white-space: nowrap; }
  .pct.done { color: var(--muted); }
  .bar { grid-column: 1 / -1; height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin-top: 0.35rem; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .bar.done i { background: var(--muted); }
  .meta { grid-column: 1 / -1; color: var(--muted); font-size: 0.8rem; margin: 0.25rem 0 0; }
  .empty { color: var(--muted); padding: 2rem 0; }
  .hint { margin-top: 2rem; padding: 0.9rem 1rem; border: 1px solid var(--line); border-radius: 8px; font-size: 0.85rem; color: var(--muted); }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.8rem; }
`;

export function Dashboard(props: { rows: DashboardRow[]; now: number }) {
  const { rows, now } = props;
  const reading = rows.filter((r) => r.percentage < FINISHED_AT);
  const finished = rows.filter((r) => r.percentage >= FINISHED_AT);
  const lastSync = rows.length ? rows[0].timestamp : null;
  const missingMeta = rows.some((r) => !r.title && !r.filename);

  const Book = (r: DashboardRow) => {
    const done = r.percentage >= FINISHED_AT;
    const pct = Math.round(r.percentage * 100);
    const author = authorsLine(r);
    return (
      <li class="book">
        <p class="name">{bookName(r)}</p>
        <span class={done ? "pct done" : "pct"}>{done ? "Concluído" : `${pct}%`}</span>
        {author ? <p class="author">{author}</p> : null}
        <div class={done ? "bar done" : "bar"}>
          <i style={{ width: `${Math.min(100, Math.max(1, pct))}%` }} />
        </div>
        <p class="meta">
          {deviceLabel(r.device)} · {relativeTime(r.timestamp, now)} · {absoluteTime(r.timestamp)}
        </p>
      </li>
    );
  };

  return (
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" type="image/png" sizes="32x32" href="/public/favicon-32x32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/public/apple-touch-icon.png" />
        <title>Reader Server</title>
        <style>{css}</style>
      </head>
      <body>
        <main>
          <header>
            <div>
              <h1>Reader Server</h1>
              <p class="sub">Onde parei de ler</p>
            </div>
            {lastSync ? (
              <p class="sub">Última sincronização {relativeTime(lastSync, now)}</p>
            ) : null}
          </header>

          <div class="stats">
            <div class="stat">
              <b>{reading.length}</b>
              <span>em leitura</span>
            </div>
            <div class="stat">
              <b>{finished.length}</b>
              <span>concluídos</span>
            </div>
            <div class="stat">
              <b>{rows.length}</b>
              <span>no total</span>
            </div>
          </div>

          {rows.length === 0 ? (
            <p class="empty">Nenhum livro sincronizado ainda.</p>
          ) : null}

          {reading.length ? (
            <>
              <h2>Em leitura</h2>
              <ul>{reading.map(Book)}</ul>
            </>
          ) : null}

          {finished.length ? (
            <>
              <h2>Concluídos</h2>
              <ul>{finished.map(Book)}</ul>
            </>
          ) : null}

          {missingMeta ? (
            <p class="hint">
              Alguns livros aparecem só pelo código porque o aplicativo não enviou
              título e autor. Ligue "Enviar metadados do documento" (Send document
              metadata) nas opções de sincronização do KOReader, do Readest e do
              CrossPoint.
            </p>
          ) : null}

          <footer>Horários em Brasília. Esta página não mostra nem aceita credenciais.</footer>
        </main>
      </body>
    </html>
  );
}
