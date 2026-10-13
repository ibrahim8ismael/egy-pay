import type {
  IdempotencyOperation,
  IdempotencyScope,
  PaymentClaim,
  PaymentEvent,
  PaymentIntent,
  ReconciliationCandidateSet,
  ReconciliationRecord,
  VerificationRecord,
} from "../domain/models.js";

export interface PaymentTransaction {
  getPaymentIntent(merchantId: string, paymentIntentId: string): Promise<PaymentIntent | null>;
  insertPaymentIntent(intent: PaymentIntent): Promise<void>;
  updatePaymentIntent(intent: PaymentIntent, expectedVersion: number): Promise<void>;

  getPaymentClaim(merchantId: string, paymentClaimId: string): Promise<PaymentClaim | null>;
  findActivePaymentClaim(merchantId: string, paymentIntentId: string): Promise<PaymentClaim | null>;
  insertPaymentClaim(claim: PaymentClaim): Promise<void>;
  updatePaymentClaim(claim: PaymentClaim, expectedVersion: number): Promise<void>;

  insertVerificationRecord(record: VerificationRecord): Promise<void>;
  appendPaymentEvent(event: PaymentEvent): Promise<void>;

  findReconciliationCandidates(input: {
    merchantId: string;
    transactionReference: string;
    amountPiasters: number;
    currency: "EGP";
    method: "vodafone_cash" | "instapay";
    occurredAt: string;
  }): Promise<ReconciliationCandidateSet>;
  getReconciliationRecord(
    merchantId: string,
    sourceType: string,
    sourceRecordId: string,
  ): Promise<ReconciliationRecord | null>;
  insertReconciliationRecord(record: ReconciliationRecord): Promise<void>;
}

export interface ClaimOutboxEventsInput {
  now: string;
  leaseUntil: string;
  limit: number;
  leaseToken: string;
}

export interface ClaimedOutboxEvent {
  event: PaymentEvent;
  attempt: number;
  leaseToken: string;
  leaseUntil: string;
}

/**
 * Delivery is at-least-once. A consumer must deduplicate using event.id.
 * Implementations claim rows transactionally, then let the dispatcher call
 * the consumer after that transaction has committed.
 */
export interface OutboxDeliveryStore {
  claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<ClaimedOutboxEvent[]>;
  markOutboxEventDelivered(input: {
    eventId: string;
    leaseToken: string;
    deliveredAt: string;
  }): Promise<boolean>;
  rescheduleOutboxEvent(input: {
    eventId: string;
    leaseToken: string;
    availableAt: string;
  }): Promise<boolean>;
}

export interface IdempotentTransactionRequest {
  scope: IdempotencyScope & { operation: IdempotencyOperation };
  requestHash: string;
  createdAt: string;
}

/**
 * A production implementation must make the callback's writes and its
 * IdempotencyRecord atomic. Calls with the same merchant/operation/key must be
 * serialized: a matching hash replays the saved result, while a different
 * hash throws IdempotencyConflictError. The callback must run at most once,
 * and its returned value must be a JSON-serializable result DTO.
 */
export interface TransactionalPaymentStore {
  transaction<T>(work: (transaction: PaymentTransaction) => Promise<T>): Promise<T>;

  runIdempotent<T>(
    request: IdempotentTransactionRequest,
    work: (transaction: PaymentTransaction) => Promise<T>,
  ): Promise<T>;
}
