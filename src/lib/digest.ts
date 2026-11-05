import { createHash, createHmac } from "node:crypto";

/** SHA-256 hex digest of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: object keys sorted, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

/**
 * A short one-way key (the first 16 hex characters of SHA-256 over the parts joined by ":"), for
 * record ids that must stay stable for the same inputs without revealing them.
 */
export function opaqueKey(...parts: Array<string | number>): string {
  return sha256Hex(parts.join(":")).slice(0, 16);
}

/** Keyed digest (HMAC-SHA-256 hex), for pseudonymous ids that must not be reversible without the key. */
export function keyedDigest(key: string | Uint8Array, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}
