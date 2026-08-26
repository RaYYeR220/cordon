/**
 * base64url, implemented here rather than pulled in.
 *
 * `Buffer` is Node-only and `atob`/`btoa` are awkward with binary in some runtimes, and neither is
 * worth a dependency or a runtime branch for forty lines of table lookup. This is the padless
 * URL-safe alphabet from RFC 4648 §5, so an encoded credential survives a query string, a QR code
 * and a copy-paste out of a chat window.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const LOOKUP: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
);

/** Thrown when a string is not valid base64url. */
export class Base64UrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base64UrlError";
  }
}

/** Encode bytes as padless base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];

    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0b111111];
  }
  return out;
}

/** Decode padless base64url. Standard base64 padding and `+`/`/` are also accepted. */
export function decodeBase64Url(text: string): Uint8Array {
  const cleaned = text.trim().replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (cleaned.length % 4 === 1) {
    throw new Base64UrlError(`base64url string has a truncated final group: ${cleaned.length} chars`);
  }

  const bytes = new Uint8Array(Math.floor((cleaned.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (const character of cleaned) {
    const value = LOOKUP.get(character);
    if (value === undefined) {
      throw new Base64UrlError(`not a base64url character: ${JSON.stringify(character)}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes.subarray(0, written);
}
