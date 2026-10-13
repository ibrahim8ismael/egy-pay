export type EgyPayErrorCode =
  | "VALIDATION_ERROR"
  | "PAYMENT_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "PAYMENT_EXPIRED"
  | "VERIFICATION_NOT_AUTHORIZED"
  | "IDEMPOTENCY_CONFLICT"
  | "CONCURRENT_MODIFICATION"
  | "STORAGE_CONFLICT";

export class EgyPayError extends Error {
  public readonly code: EgyPayErrorCode;

  public constructor(code: EgyPayErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends EgyPayError {
  public constructor(message: string) {
    super("VALIDATION_ERROR", message);
  }
}

export class PaymentNotFoundError extends EgyPayError {
  public constructor() {
    super("PAYMENT_NOT_FOUND", "Payment intent was not found.");
  }
}

export class InvalidTransitionError extends EgyPayError {
  public constructor(operation: string, status: string) {
    super("INVALID_TRANSITION", "Cannot " + operation + " while payment is " + status + ".");
  }
}

export class PaymentExpiredError extends EgyPayError {
  public constructor() {
    super("PAYMENT_EXPIRED", "The payment deadline has passed.");
  }
}

export class VerificationNotAuthorizedError extends EgyPayError {
  public constructor() {
    super("VERIFICATION_NOT_AUTHORIZED", "The verification actor is not authorized for this operation.");
  }
}

export class IdempotencyConflictError extends EgyPayError {
  public constructor() {
    super("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.");
  }
}

export class ConcurrentModificationError extends EgyPayError {
  public constructor() {
    super("CONCURRENT_MODIFICATION", "The payment changed during this operation. Retry with the same idempotency key.");
  }
}

export class StorageConflictError extends EgyPayError {
  public constructor(message = "A storage uniqueness constraint was violated.") {
    super("STORAGE_CONFLICT", message);
  }
}
