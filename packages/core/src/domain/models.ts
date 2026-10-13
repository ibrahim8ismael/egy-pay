export const PAYMENT_METHODS = ["vodafone_cash", "instapay"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  "AWAITING_PAYMENT",
  "PAID_UNVERIFIED",
  "PAID",
  "EXPIRED",
  "CANCELLED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentClaimStatus = "SUBMITTED" | "APPROVED" | "REJECTED";
export type CurrencyCode = "EGP";
export type IdempotencyOperation =
  | "create_payment_intent"
  | "submit_payment_claim"
  | "verify_payment"
  | "reject_payment_claim"
  | "cancel_payment_intent";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface PaymentIntent {
  id: string;
  merchantId: string;
  orderId: string;
  amountPiasters: number;
  currency: CurrencyCode;
  method: PaymentMethod;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  version: number;
  metadata: JsonObject | null;
}

export interface PaymentClaim {
  id: string;
  merchantId: string;
  paymentIntentId: string;
  customerId: string | null;
  customerReference: string | null;
  reportedAmountPiasters: number | null;
  evidenceReference: string | null;
  status: PaymentClaimStatus;
  reportedAt: string;
  updatedAt: string;
  version: number;
}

export type VerificationDecision = "APPROVED" | "REJECTED";
export type VerificationActorType = "HUMAN" | "TRUSTED_ADAPTER";

export interface VerificationAuthorization {
  actorType: VerificationActorType;
  actorId: string;
  sourceType: string;
  sourceReference: string | null;
  evidenceReference: string | null;
}

export interface VerificationRecord {
  id: string;
  merchantId: string;
  paymentIntentId: string;
  paymentClaimId: string;
  decision: VerificationDecision;
  actorType: VerificationActorType;
  actorId: string;
  sourceType: string;
  sourceReference: string | null;
  evidenceReference: string | null;
  reasonCode: string | null;
  note: string | null;
  verifiedAt: string;
}

export type PaymentEventType =
  | "payment.intent.created"
  | "payment.claim.reported"
  | "payment.paid"
  | "payment.verification.rejected"
  | "payment.intent.cancelled"
  | "payment.intent.expired";

export interface PaymentEvent {
  id: string;
  merchantId: string;
  paymentIntentId: string;
  type: PaymentEventType;
  occurredAt: string;
  schemaVersion: 1;
  aggregateVersion: number;
  payload: JsonObject;
}

export interface IdempotencyRecord {
  merchantId: string;
  operation: IdempotencyOperation;
  key: string;
  requestHash: string;
  result: JsonValue;
  createdAt: string;
}

export interface IdempotencyScope {
  merchantId: string;
  operation: IdempotencyOperation;
  key: string;
}
