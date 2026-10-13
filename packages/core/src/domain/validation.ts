import { PAYMENT_METHODS, type JsonObject, type JsonValue, type PaymentMethod } from "./models.js";
import { ValidationError } from "./errors.js";

export function requireText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string") {
    throw new ValidationError(field + " must be a string.");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ValidationError(field + " must contain 1 to " + maxLength + " characters.");
  }
  return normalized;
}

export function optionalText(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ValidationError(field + " must be a string.");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw new ValidationError(field + " must not exceed " + maxLength + " characters.");
  }
  return normalized;
}

export function validateAmountPiasters(value: unknown, field = "amountPiasters"): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(field + " must be a positive safe integer in piasters.");
  }
}

export function validateMethod(value: unknown): asserts value is PaymentMethod {
  if (typeof value !== "string" || !PAYMENT_METHODS.includes(value as PaymentMethod)) {
    throw new ValidationError("method must be vodafone_cash or instapay.");
  }
}

export function validateCurrency(value: unknown): asserts value is "EGP" {
  if (value !== "EGP") {
    throw new ValidationError("Only EGP is supported by the initial manual payment workflows.");
  }
}

export function normalizeIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(field + " must be an ISO date string.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ValidationError(field + " must be a valid date.");
  }
  return new Date(timestamp).toISOString();
}

export function normalizeMetadata(value: unknown): JsonObject | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = normalizeJson(value, 0, new Set());
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new ValidationError("metadata must be a JSON object.");
  }
  if (JSON.stringify(normalized).length > 4096) {
    throw new ValidationError("metadata must not exceed 4096 serialized characters.");
  }
  return normalized;
}

export function normalizeJson(value: unknown, depth = 0, seen = new Set<object>()): JsonValue {
  if (depth > 8) {
    throw new ValidationError("JSON data must not exceed 8 nested levels.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError("JSON numbers must be finite.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ValidationError("JSON data must not contain cycles.");
    }
    seen.add(value);
    const result = value.map((item) => normalizeJson(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationError("JSON objects must be plain objects.");
    }
    if (seen.has(value)) {
      throw new ValidationError("JSON data must not contain cycles.");
    }
    seen.add(value);
    const result: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) {
        throw new ValidationError("JSON data must not contain undefined values.");
      }
      result[key] = normalizeJson(child, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new ValidationError("Value is not JSON serializable.");
}
