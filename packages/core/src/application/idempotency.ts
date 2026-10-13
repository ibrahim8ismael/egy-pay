import { ValidationError } from "../domain/errors.js";
import { normalizeJson, requireText } from "../domain/validation.js";

export async function hashRequest(value: unknown): Promise<string> {
  const canonical = normalizeJson(value);
  const serialized = JSON.stringify(canonical);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("idempotencyKey is required.");
  }
  const key = requireText(value, "idempotencyKey", 128);
  if (key.length > 128) {
    throw new ValidationError("idempotencyKey must not exceed 128 characters.");
  }
  return key;
}
