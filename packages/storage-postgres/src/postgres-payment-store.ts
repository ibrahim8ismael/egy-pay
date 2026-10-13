import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  StorageConflictError,
  type IdempotencyRecord,
  type JsonObject,
  type PaymentClaim,
  type PaymentEvent,
  type PaymentIntent,
  type ReconciliationRecord,
  type PaymentTransaction,
  type OutboxDeliveryStore,
  type ClaimedOutboxEvent,
  type ClaimOutboxEventsInput,
  type TransactionalPaymentStore,
  type IdempotentTransactionRequest,
  type VerificationRecord,
} from "@ibrahim.one/core";
import type { Pool, PoolClient } from "pg";

type DbRow = Record<string, unknown>;

export class PostgresPaymentStore implements TransactionalPaymentStore, OutboxDeliveryStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (transaction: PaymentTransaction) => Promise<T>): Promise<T> {
    return this.withTransaction((client) => work(createTransaction(client)));
  }

  public async claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<ClaimedOutboxEvent[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbRow>(
        "WITH candidates AS (" +
          "SELECT id FROM egy_pay_payment_events " +
          "WHERE delivered_at IS NULL AND available_at <= $1 " +
          "AND (lease_until IS NULL OR lease_until <= $1) " +
          "ORDER BY occurred_at, id FOR UPDATE SKIP LOCKED LIMIT $2" +
          ") " +
          "UPDATE egy_pay_payment_events AS event SET " +
          "delivery_attempts = event.delivery_attempts + 1, lease_token = $3, lease_until = $4 " +
          "FROM candidates WHERE event.id = candidates.id " +
          "RETURNING event.id, event.merchant_id, event.payment_intent_id, event.type, " +
          "event.occurred_at, event.schema_version, event.aggregate_version, event.payload, " +
          "event.delivery_attempts, event.lease_token, event.lease_until",
        [input.now, input.limit, input.leaseToken, input.leaseUntil],
      );
      return result.rows.map(mapClaimedOutboxEvent);
    });
  }

  public async markOutboxEventDelivered(input: {
    eventId: string;
    leaseToken: string;
    deliveredAt: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE egy_pay_payment_events SET delivered_at = $3, lease_token = NULL, lease_until = NULL " +
        "WHERE id = $1 AND lease_token = $2 AND lease_until > $3 AND delivered_at IS NULL",
      [input.eventId, input.leaseToken, input.deliveredAt],
    );
    return result.rowCount === 1;
  }

  public async rescheduleOutboxEvent(input: {
    eventId: string;
    leaseToken: string;
    availableAt: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE egy_pay_payment_events SET available_at = $3, lease_token = NULL, lease_until = NULL " +
        "WHERE id = $1 AND lease_token = $2 AND delivered_at IS NULL",
      [input.eventId, input.leaseToken, input.availableAt],
    );
    return result.rowCount === 1;
  }

  public async runIdempotent<T>(
    request: IdempotentTransactionRequest,
    work: (transaction: PaymentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(async (client) => {
      const lockNamespace = request.scope.merchantId + ":" + request.scope.operation;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [lockNamespace, request.scope.key],
      );

      const saved = await client.query<DbRow>(
        "SELECT request_hash, result FROM egy_pay_idempotency_records " +
          "WHERE merchant_id = $1 AND operation = $2 AND key = $3 FOR UPDATE",
        [request.scope.merchantId, request.scope.operation, request.scope.key],
      );
      const existing = saved.rows[0];
      if (existing) {
        if (dbText(existing, "request_hash") !== request.requestHash) {
          throw new IdempotencyConflictError();
        }
        return dbJson(existing.result) as T;
      }

      const result = await work(createTransaction(client));
      const serialized = JSON.stringify(result);
      if (serialized === undefined) {
        throw new StorageConflictError("Idempotency results must be JSON serializable.");
      }
      const record: IdempotencyRecord = {
        merchantId: request.scope.merchantId,
        operation: request.scope.operation,
        key: request.scope.key,
        requestHash: request.requestHash,
        result: JSON.parse(serialized) as IdempotencyRecord["result"],
        createdAt: request.createdAt,
      };
      await client.query(
        "INSERT INTO egy_pay_idempotency_records " +
          "(merchant_id, operation, key, request_hash, result, created_at) " +
          "VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
        [
          record.merchantId,
          record.operation,
          record.key,
          record.requestHash,
          JSON.stringify(record.result),
          record.createdAt,
        ],
      );
      return result;
    });
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
      throw translateDatabaseError(error);
    } finally {
      client.release(destroyClient);
    }
  }
}

function createTransaction(client: PoolClient): PaymentTransaction {
  return {
    async getPaymentIntent(merchantId, paymentIntentId) {
      const result = await client.query<DbRow>(
        "SELECT id, merchant_id, order_id, amount_piasters, currency, method, status, " +
          "created_at, updated_at, expires_at, version, metadata " +
          "FROM egy_pay_payment_intents WHERE merchant_id = $1 AND id = $2",
        [merchantId, paymentIntentId],
      );
      return result.rows[0] ? mapPaymentIntent(result.rows[0]) : null;
    },

    async insertPaymentIntent(intent) {
      await client.query(
        "INSERT INTO egy_pay_payment_intents " +
          "(id, merchant_id, order_id, amount_piasters, currency, method, status, " +
          "created_at, updated_at, expires_at, version, metadata) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)",
        [
          intent.id, intent.merchantId, intent.orderId, intent.amountPiasters,
          intent.currency, intent.method, intent.status, intent.createdAt,
          intent.updatedAt, intent.expiresAt, intent.version,
          intent.metadata === null ? null : JSON.stringify(intent.metadata),
        ],
      );
    },

    async updatePaymentIntent(intent, expectedVersion) {
      assertNextVersion(intent.version, expectedVersion, "payment intent");
      const result = await client.query(
        "UPDATE egy_pay_payment_intents SET order_id = $4, amount_piasters = $5, " +
          "currency = $6, method = $7, status = $8, updated_at = $9, expires_at = $10, " +
          "version = $11, metadata = $12::jsonb " +
          "WHERE merchant_id = $1 AND id = $2 AND version = $3",
        [
          intent.merchantId, intent.id, expectedVersion, intent.orderId,
          intent.amountPiasters, intent.currency, intent.method, intent.status,
          intent.updatedAt, intent.expiresAt, intent.version,
          intent.metadata === null ? null : JSON.stringify(intent.metadata),
        ],
      );
      if (result.rowCount !== 1) throw new ConcurrentModificationError();
    },

    async getPaymentClaim(merchantId, paymentClaimId) {
      const result = await client.query<DbRow>(
        "SELECT id, merchant_id, payment_intent_id, customer_id, customer_reference, " +
          "reported_amount_piasters, evidence_reference, status, reported_at, updated_at, version " +
          "FROM egy_pay_payment_claims WHERE merchant_id = $1 AND id = $2",
        [merchantId, paymentClaimId],
      );
      return result.rows[0] ? mapPaymentClaim(result.rows[0]) : null;
    },

    async findActivePaymentClaim(merchantId, paymentIntentId) {
      const result = await client.query<DbRow>(
        "SELECT id, merchant_id, payment_intent_id, customer_id, customer_reference, " +
          "reported_amount_piasters, evidence_reference, status, reported_at, updated_at, version " +
          "FROM egy_pay_payment_claims " +
          "WHERE merchant_id = $1 AND payment_intent_id = $2 AND status = 'SUBMITTED' LIMIT 1",
        [merchantId, paymentIntentId],
      );
      return result.rows[0] ? mapPaymentClaim(result.rows[0]) : null;
    },

    async insertPaymentClaim(claim) {
      await client.query(
        "INSERT INTO egy_pay_payment_claims " +
          "(id, merchant_id, payment_intent_id, customer_id, customer_reference, " +
          "reported_amount_piasters, evidence_reference, status, reported_at, updated_at, version) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [
          claim.id, claim.merchantId, claim.paymentIntentId, claim.customerId,
          claim.customerReference, claim.reportedAmountPiasters, claim.evidenceReference,
          claim.status, claim.reportedAt, claim.updatedAt, claim.version,
        ],
      );
    },

    async updatePaymentClaim(claim, expectedVersion) {
      assertNextVersion(claim.version, expectedVersion, "payment claim");
      const result = await client.query(
        "UPDATE egy_pay_payment_claims SET customer_id = $4, customer_reference = $5, " +
          "reported_amount_piasters = $6, evidence_reference = $7, status = $8, " +
          "updated_at = $9, version = $10 WHERE merchant_id = $1 AND id = $2 AND version = $3",
        [
          claim.merchantId, claim.id, expectedVersion, claim.customerId,
          claim.customerReference, claim.reportedAmountPiasters, claim.evidenceReference,
          claim.status, claim.updatedAt, claim.version,
        ],
      );
      if (result.rowCount !== 1) throw new ConcurrentModificationError();
    },

    async insertVerificationRecord(record) {
      await client.query(
        "INSERT INTO egy_pay_verification_records " +
          "(id, merchant_id, payment_intent_id, payment_claim_id, decision, actor_type, " +
          "actor_id, source_type, source_reference, evidence_reference, reason_code, note, verified_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        [
          record.id, record.merchantId, record.paymentIntentId, record.paymentClaimId,
          record.decision, record.actorType, record.actorId, record.sourceType,
          record.sourceReference, record.evidenceReference, record.reasonCode,
          record.note, record.verifiedAt,
        ],
      );
    },

    async appendPaymentEvent(event) {
      await client.query(
        "INSERT INTO egy_pay_payment_events " +
          "(id, merchant_id, payment_intent_id, type, occurred_at, schema_version, " +
          "aggregate_version, payload, available_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)",
        [
          event.id, event.merchantId, event.paymentIntentId, event.type,
          event.occurredAt, event.schemaVersion, event.aggregateVersion,
          JSON.stringify(event.payload), event.occurredAt,
        ],
      );
    },

    async findReconciliationCandidates(input) {
      const result = await client.query<DbRow>(
        "SELECT intent.id AS intent_id, intent.merchant_id AS intent_merchant_id, " +
          "intent.order_id AS intent_order_id, intent.amount_piasters AS intent_amount_piasters, " +
          "intent.currency AS intent_currency, intent.method AS intent_method, " +
          "intent.status AS intent_status, intent.created_at AS intent_created_at, " +
          "intent.updated_at AS intent_updated_at, intent.expires_at AS intent_expires_at, " +
          "intent.version AS intent_version, intent.metadata AS intent_metadata, " +
          "claim.id AS claim_id, claim.merchant_id AS claim_merchant_id, " +
          "claim.payment_intent_id AS claim_payment_intent_id, claim.customer_id AS claim_customer_id, " +
          "claim.customer_reference AS claim_customer_reference, " +
          "claim.reported_amount_piasters AS claim_reported_amount_piasters, " +
          "claim.evidence_reference AS claim_evidence_reference, claim.status AS claim_status, " +
          "claim.reported_at AS claim_reported_at, claim.updated_at AS claim_updated_at, " +
          "claim.version AS claim_version, count(*) OVER() AS candidate_count " +
          "FROM egy_pay_payment_claims AS claim " +
          "JOIN egy_pay_payment_intents AS intent " +
          "ON intent.merchant_id = claim.merchant_id AND intent.id = claim.payment_intent_id " +
          "WHERE claim.merchant_id = $1 AND claim.customer_reference = $2 " +
          "AND claim.status = 'SUBMITTED' AND intent.status = 'PAID_UNVERIFIED' " +
          "AND intent.amount_piasters = $3 AND intent.currency = $4 AND intent.method = $5 " +
          "AND (claim.reported_amount_piasters IS NULL OR claim.reported_amount_piasters = $3) " +
          "AND intent.created_at <= $6 AND (intent.expires_at IS NULL OR $6 <= intent.expires_at) " +
          "ORDER BY claim.reported_at, claim.id LIMIT 2",
        [
          input.merchantId,
          input.transactionReference,
          input.amountPiasters,
          input.currency,
          input.method,
          input.occurredAt,
        ],
      );
      const candidates = result.rows.map((row) => ({
        paymentIntent: mapPaymentIntent({
          id: row.intent_id,
          merchant_id: row.intent_merchant_id,
          order_id: row.intent_order_id,
          amount_piasters: row.intent_amount_piasters,
          currency: row.intent_currency,
          method: row.intent_method,
          status: row.intent_status,
          created_at: row.intent_created_at,
          updated_at: row.intent_updated_at,
          expires_at: row.intent_expires_at,
          version: row.intent_version,
          metadata: row.intent_metadata,
        }),
        paymentClaim: mapPaymentClaim({
          id: row.claim_id,
          merchant_id: row.claim_merchant_id,
          payment_intent_id: row.claim_payment_intent_id,
          customer_id: row.claim_customer_id,
          customer_reference: row.claim_customer_reference,
          reported_amount_piasters: row.claim_reported_amount_piasters,
          evidence_reference: row.claim_evidence_reference,
          status: row.claim_status,
          reported_at: row.claim_reported_at,
          updated_at: row.claim_updated_at,
          version: row.claim_version,
        }),
      }));
      return {
        candidates,
        totalCount: result.rows[0]
          ? dbSafeInteger(result.rows[0].candidate_count, "candidate_count")
          : 0,
      };
    },

    async getReconciliationRecord(merchantId, sourceType, sourceRecordId) {
      const result = await client.query<DbRow>(
        "SELECT id, merchant_id, source_type, source_record_id, transaction_reference, " +
          "amount_piasters, currency, method, occurred_at, actor_id, source_hash, status, " +
          "candidate_count, candidate_payment_intent_ids, candidate_payment_claim_ids, created_at " +
          "FROM egy_pay_reconciliation_records " +
          "WHERE merchant_id = $1 AND source_type = $2 AND source_record_id = $3",
        [merchantId, sourceType, sourceRecordId],
      );
      return result.rows[0] ? mapReconciliationRecord(result.rows[0]) : null;
    },

    async insertReconciliationRecord(record) {
      await client.query(
        "INSERT INTO egy_pay_reconciliation_records " +
          "(id, merchant_id, source_type, source_record_id, transaction_reference, " +
          "amount_piasters, currency, method, occurred_at, actor_id, source_hash, status, " +
          "candidate_count, candidate_payment_intent_ids, candidate_payment_claim_ids, created_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16)",
        [
          record.id, record.merchantId, record.sourceType, record.sourceRecordId,
          record.transactionReference, record.amountPiasters, record.currency, record.method,
          record.occurredAt, record.actorId, record.sourceHash, record.status,
          record.candidateCount, JSON.stringify(record.candidatePaymentIntentIds),
          JSON.stringify(record.candidatePaymentClaimIds), record.createdAt,
        ],
      );
    },
  };
}

function mapPaymentIntent(row: DbRow): PaymentIntent {
  return {
    id: dbText(row, "id"),
    merchantId: dbText(row, "merchant_id"),
    orderId: dbText(row, "order_id"),
    amountPiasters: dbSafeInteger(row.amount_piasters, "amount_piasters"),
    currency: dbText(row, "currency") as PaymentIntent["currency"],
    method: dbText(row, "method") as PaymentIntent["method"],
    status: dbText(row, "status") as PaymentIntent["status"],
    createdAt: dbDate(row.created_at, "created_at"),
    updatedAt: dbDate(row.updated_at, "updated_at"),
    expiresAt: row.expires_at === null ? null : dbDate(row.expires_at, "expires_at"),
    version: dbSafeInteger(row.version, "version"),
    metadata: row.metadata === null ? null : dbObject(row.metadata, "metadata"),
  };
}

function mapPaymentClaim(row: DbRow): PaymentClaim {
  return {
    id: dbText(row, "id"),
    merchantId: dbText(row, "merchant_id"),
    paymentIntentId: dbText(row, "payment_intent_id"),
    customerId: dbNullableText(row.customer_id, "customer_id"),
    customerReference: dbNullableText(row.customer_reference, "customer_reference"),
    reportedAmountPiasters: row.reported_amount_piasters === null
      ? null
      : dbSafeInteger(row.reported_amount_piasters, "reported_amount_piasters"),
    evidenceReference: dbNullableText(row.evidence_reference, "evidence_reference"),
    status: dbText(row, "status") as PaymentClaim["status"],
    reportedAt: dbDate(row.reported_at, "reported_at"),
    updatedAt: dbDate(row.updated_at, "updated_at"),
    version: dbSafeInteger(row.version, "version"),
  };
}

function mapReconciliationRecord(row: DbRow): ReconciliationRecord {
  return {
    id: dbText(row, "id"),
    merchantId: dbText(row, "merchant_id"),
    sourceType: dbText(row, "source_type"),
    sourceRecordId: dbText(row, "source_record_id"),
    transactionReference: dbText(row, "transaction_reference"),
    amountPiasters: dbSafeInteger(row.amount_piasters, "amount_piasters"),
    currency: dbText(row, "currency") as ReconciliationRecord["currency"],
    method: dbText(row, "method") as ReconciliationRecord["method"],
    occurredAt: dbDate(row.occurred_at, "occurred_at"),
    actorId: dbText(row, "actor_id"),
    sourceHash: dbText(row, "source_hash"),
    status: dbText(row, "status") as ReconciliationRecord["status"],
    candidateCount: dbSafeInteger(row.candidate_count, "candidate_count"),
    candidatePaymentIntentIds: dbTextArray(row.candidate_payment_intent_ids, "candidate_payment_intent_ids"),
    candidatePaymentClaimIds: dbTextArray(row.candidate_payment_claim_ids, "candidate_payment_claim_ids"),
    createdAt: dbDate(row.created_at, "created_at"),
  };
}

function mapClaimedOutboxEvent(row: DbRow): ClaimedOutboxEvent {
  const payload = dbObject(row.payload, "payload");
  const schemaVersion = dbSafeInteger(row.schema_version, "schema_version");
  if (schemaVersion !== 1) {
    throw new StorageConflictError("Unsupported payment event schema version.");
  }
  return {
    event: {
      id: dbText(row, "id"),
      merchantId: dbText(row, "merchant_id"),
      paymentIntentId: dbText(row, "payment_intent_id"),
      type: dbText(row, "type") as PaymentEvent["type"],
      occurredAt: dbDate(row.occurred_at, "occurred_at"),
      schemaVersion: 1,
      aggregateVersion: dbSafeInteger(row.aggregate_version, "aggregate_version"),
      payload,
    },
    attempt: dbSafeInteger(row.delivery_attempts, "delivery_attempts"),
    leaseToken: dbText(row, "lease_token"),
    leaseUntil: dbDate(row.lease_until, "lease_until"),
  };
}

function dbText(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new StorageConflictError("Unexpected database value for " + column + ".");
  }
  return value;
}

function dbNullableText(value: unknown, column: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new StorageConflictError("Unexpected database value for " + column + ".");
  }
  return value;
}

function dbSafeInteger(value: unknown, column: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new StorageConflictError("Database value for " + column + " is not a safe integer.");
  }
  return numberValue;
}

function dbDate(value: unknown, column: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new StorageConflictError("Unexpected database timestamp for " + column + ".");
  }
  return date.toISOString();
}

function dbObject(value: unknown, column: string): JsonObject {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageConflictError("Unexpected database JSON object for " + column + ".");
  }
  return parsed as JsonObject;
}

function dbTextArray(value: unknown, column: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new StorageConflictError("Unexpected database JSON array for " + column + ".");
  }
  return parsed;
}

function dbJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function assertNextVersion(next: number, expected: number, label: string): void {
  if (next !== expected + 1) {
    throw new StorageConflictError(label + " version must increment by one.");
  }
}

function translateDatabaseError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return error;
  const code = (error as { code?: unknown }).code;
  if (code === "23505" || code === "23503" || code === "23514" || code === "23502") {
    return new StorageConflictError();
  }
  if (code === "40001" || code === "40P01") return new ConcurrentModificationError();
  return error;
}
