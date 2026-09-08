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

export interface ResultadoGravacao {
  /** true quando o envio repetia a última posição do próprio aparelho e outro aparelho já tinha avançado */
  ignorado: boolean;
}

/**
 * Grava a posição, exceto no reenvio cego: o KOReader manda a posição ao dormir/fechar sem consultar
 * o servidor. Se o aparelho repete exatamente o que ele mesmo mandou por último e a última posição
 * do livro já é de outro aparelho, o reenvio é ignorado para não apagar o avanço do outro.
 */
export function gravarProgresso(db: Database, p: NovoProgresso): ResultadoGravacao {
  const timestamp = p.timestamp ?? Math.floor(Date.now() / 1000);

  const atual = db
    .prepare(`SELECT device_id FROM progress WHERE user_id = ? AND document = ?`)
    .get(p.userId, p.document) as { device_id: string } | null;
  if (atual && atual.device_id !== p.deviceId) {
    const anterior = db
      .prepare(`SELECT progress, percentage FROM device_progress WHERE user_id = ? AND document = ? AND device_id = ?`)
      .get(p.userId, p.document, p.deviceId) as { progress: string; percentage: number } | null;
    if (anterior && anterior.progress === p.progress && anterior.percentage === p.percentage) {
      return { ignorado: true };
    }
  }

  db.prepare(
    `
    INSERT INTO device_progress (user_id, document, device_id, progress, percentage, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, document, device_id) DO UPDATE SET
      progress = excluded.progress,
      percentage = excluded.percentage,
      timestamp = excluded.timestamp
  `
  ).run(p.userId, p.document, p.deviceId, p.progress, p.percentage, timestamp);

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
  return { ignorado: false };
}
