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
