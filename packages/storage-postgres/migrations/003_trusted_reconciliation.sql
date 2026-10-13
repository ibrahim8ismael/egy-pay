ALTER TABLE egy_pay_idempotency_records
  DROP CONSTRAINT egy_pay_idempotency_records_operation_check;

ALTER TABLE egy_pay_idempotency_records
  ADD CONSTRAINT egy_pay_idempotency_records_operation_check CHECK (
    operation IN (
      'create_payment_intent',
      'submit_payment_claim',
      'verify_payment',
      'reject_payment_claim',
      'cancel_payment_intent',
      'reconcile_trusted_transaction'
    )
  );

CREATE TABLE egy_pay_reconciliation_records (
  id text PRIMARY KEY,
  merchant_id text NOT NULL CHECK (length(btrim(merchant_id)) > 0),
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 1 AND 128),
  source_record_id text NOT NULL CHECK (length(btrim(source_record_id)) BETWEEN 1 AND 128),
  transaction_reference text NOT NULL CHECK (length(btrim(transaction_reference)) BETWEEN 1 AND 256),
  amount_piasters bigint NOT NULL CHECK (amount_piasters > 0),
  currency text NOT NULL CHECK (currency = 'EGP'),
  method text NOT NULL CHECK (method IN ('vodafone_cash', 'instapay')),
  occurred_at timestamptz NOT NULL,
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 200),
  source_hash text NOT NULL CHECK (length(source_hash) = 64),
  status text NOT NULL CHECK (status IN ('MATCHED', 'AMBIGUOUS', 'UNMATCHED')),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  candidate_payment_intent_ids jsonb NOT NULL CHECK (
    jsonb_typeof(candidate_payment_intent_ids) = 'array'
  ),
  candidate_payment_claim_ids jsonb NOT NULL CHECK (
    jsonb_typeof(candidate_payment_claim_ids) = 'array'
  ),
  created_at timestamptz NOT NULL,
  UNIQUE (merchant_id, source_type, source_record_id),
  CHECK (
    jsonb_array_length(candidate_payment_intent_ids) = LEAST(candidate_count, 2)
    AND jsonb_array_length(candidate_payment_claim_ids) = LEAST(candidate_count, 2)
  ),
  CHECK (
    (status = 'UNMATCHED' AND candidate_count = 0)
    OR (status = 'MATCHED' AND candidate_count = 1)
    OR (status = 'AMBIGUOUS' AND candidate_count > 1)
  )
);

CREATE INDEX egy_pay_reconciliation_records_review_idx
  ON egy_pay_reconciliation_records (merchant_id, status, created_at DESC);
