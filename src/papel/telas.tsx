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
      ) : <p class="muted">Nenhum aparelho sincronizou este arquivo ainda.</p>}
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
