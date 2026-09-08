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
