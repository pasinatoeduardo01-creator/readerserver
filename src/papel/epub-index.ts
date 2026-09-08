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
  // Regra do crengine: o índice posicional aparece sempre que há mais de um irmão
  // com o mesmo nome (`p[1]`, `p[2]`…) e some quando o elemento é o único daquele
  // nome (`div`). Por isso a contagem por nome vem antes de montar os caminhos.
  const totalPorNome = new Map<string, number>();
  for (const filho of el.children) {
    if (!(filho instanceof Element) || filho.type !== "tag") continue;
    const nome = nomeLocal(filho.name);
    totalPorNome.set(nome, (totalPorNome.get(nome) ?? 0) + 1);
  }
  const contagem = new Map<string, number>();
  for (const filho of el.children) {
    if (!(filho instanceof Element) || filho.type !== "tag") continue;
    const nome = nomeLocal(filho.name);
    const n = (contagem.get(nome) ?? 0) + 1;
    contagem.set(nome, n);
    const sub = `${caminho}/${(totalPorNome.get(nome) ?? 1) > 1 ? `${nome}[${n}]` : nome}`;
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

/**
 * Forma comparável de um XPath: sem o sufixo de caractere (`/text()[k].N`, `/text().N`
 * ou `.N`) e sem os `[1]`, que os três leitores escrevem de jeitos diferentes — o
 * CrossPoint indexa todos os segmentos (`div[1]/p[3]`), crengine e Readest omitem o
 * índice do irmão único (`div/p[3]`).
 */
function comparavel(xpath: string): string {
  return xpath
    .replace(/\/text\(\)(\[\d+\])?\.\d+$/, "")
    .replace(/\.\d+$/, "")
    .replace(/\[1\]/g, "");
}

/** Índice do parágrafo cujo XPath é igual ao dado (ignorando sufixo de caractere e `[1]`). */
export function paragrafoDoXpath(indice: IndiceLivro, xpath: string): number | null {
  const alvo = comparavel(xpath);
  const i = indice.paragraphs.findIndex((p) => comparavel(p.xpath) === alvo);
  return i >= 0 ? i : null;
}
