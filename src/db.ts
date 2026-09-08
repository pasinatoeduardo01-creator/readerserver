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

  // Última posição enviada por cada aparelho (guarda contra o reenvio cego do KOReader).
  // Banco antigo: a posição atual de cada livro passa a valer como o último envio daquele aparelho.
  db.run(`
    CREATE TABLE IF NOT EXISTS device_progress (
      user_id INTEGER NOT NULL,
      document TEXT NOT NULL,
      device_id TEXT NOT NULL,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY(user_id, document, device_id)
    )
  `);
  db.run(`
    INSERT OR IGNORE INTO device_progress (user_id, document, device_id, progress, percentage, timestamp)
    SELECT user_id, document, device_id, progress, percentage, timestamp FROM progress
  `);

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
