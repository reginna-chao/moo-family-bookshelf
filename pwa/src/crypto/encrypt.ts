/**
 * E2EE encryption module using Web Crypto API (AES-256-GCM).
 * All data is encrypted in the browser before being sent to the server.
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToBase62(raw);
}

export async function importKey(encoded: string): Promise<CryptoKey> {
  const raw = base62ToBuffer(encoded);
  const rawBytes = new Uint8Array(raw);
  const keyLengthBytes = KEY_LENGTH / 8;

  // Base62 encoding (via BigInt) drops leading zeros. Pad it back to exactly 32 bytes.
  const paddedBytes = new Uint8Array(keyLengthBytes);
  const offset = keyLengthBytes - rawBytes.length;
  if (offset < 0) {
    throw new Error("Encoded key is longer than expected");
  }
  paddedBytes.set(rawBytes, offset);

  // Pass Uint8Array instead of ArrayBuffer to avoid JSDOM cross-realm instanceof issues
  return crypto.subtle.importKey("raw", paddedBytes, { name: ALGORITHM }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  data: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(data);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded,
  );

  // Combine IV + ciphertext into a single buffer
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return bufferToBase64(combined.buffer);
}

export async function decrypt(
  payload: string,
  key: CryptoKey,
): Promise<string> {
  const combined = base64ToBuffer(payload);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// --- Encoding helpers ---

const BASE62_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function bufferToBase62(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = "";
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  if (value === 0n) return "0";
  while (value > 0n) {
    result = BASE62_CHARS[Number(value % 62n)] + result;
    value = value / 62n;
  }
  return result;
}

export function base62ToBuffer(str: string): ArrayBuffer {
  let value = 0n;
  for (const char of str) {
    const index = BASE62_CHARS.indexOf(char);
    if (index === -1) throw new Error(`Invalid Base62 character: ${char}`);
    value = value * 62n + BigInt(index);
  }
  // Convert BigInt to byte array
  const hex = value.toString(16).padStart(2, "0");
  const paddedHex = hex.length % 2 ? "0" + hex : hex;
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }
  // Create a clean ArrayBuffer by copying into a new Uint8Array — needed
  // because in Node.js, Uint8Array.buffer may be a shared Buffer pool
  // allocation that crypto.subtle.importKey rejects.
  return new Uint8Array(bytes).buffer;
}

/**
 * Derive a userId from email with an app-specific salt.
 * Prevents rainbow table attacks against plain SHA-256 of email.
 */
export async function deriveUserId(email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  return sha256Hex(`moo:${normalized}`);
}

/**
 * SHA-256 hash a string and return the hex digest.
 * Used to derive a deterministic, privacy-preserving userId from email.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input.toLowerCase().trim());
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
