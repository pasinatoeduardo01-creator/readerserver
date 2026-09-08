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
