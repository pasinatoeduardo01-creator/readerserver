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
