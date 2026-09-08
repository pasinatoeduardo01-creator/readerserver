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
