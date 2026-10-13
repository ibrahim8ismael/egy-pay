CREATE TABLE egy_pay_payment_intents (
  id text PRIMARY KEY,
  merchant_id text NOT NULL CHECK (length(btrim(merchant_id)) > 0),
  order_id text NOT NULL CHECK (length(btrim(order_id)) > 0),
  amount_piasters bigint NOT NULL CHECK (amount_piasters > 0),
  currency text NOT NULL CHECK (currency = 'EGP'),
  method text NOT NULL CHECK (method IN ('vodafone_cash', 'instapay')),
  status text NOT NULL CHECK (
    status IN ('AWAITING_PAYMENT', 'PAID_UNVERIFIED', 'PAID', 'EXPIRED', 'CANCELLED')
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  metadata jsonb CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
  UNIQUE (merchant_id, id)
);

CREATE INDEX egy_pay_payment_intents_expiration_idx
  ON egy_pay_payment_intents (merchant_id, expires_at)
  WHERE status = 'AWAITING_PAYMENT' AND expires_at IS NOT NULL;

CREATE TABLE egy_pay_payment_claims (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  payment_intent_id text NOT NULL,
  customer_id text,
  customer_reference text,
  reported_amount_piasters bigint CHECK (
    reported_amount_piasters IS NULL OR reported_amount_piasters > 0
  ),
  evidence_reference text,
  status text NOT NULL CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
  reported_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (merchant_id, payment_intent_id, id),
  FOREIGN KEY (merchant_id, payment_intent_id)
    REFERENCES egy_pay_payment_intents (merchant_id, id)
);

CREATE UNIQUE INDEX egy_pay_payment_claims_one_active_idx
  ON egy_pay_payment_claims (merchant_id, payment_intent_id)
  WHERE status = 'SUBMITTED';

CREATE INDEX egy_pay_payment_claims_intent_idx
  ON egy_pay_payment_claims (merchant_id, payment_intent_id, reported_at DESC);

CREATE TABLE egy_pay_verification_records (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  payment_intent_id text NOT NULL,
  payment_claim_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  actor_type text NOT NULL CHECK (actor_type IN ('HUMAN', 'TRUSTED_ADAPTER')),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  source_type text NOT NULL CHECK (length(btrim(source_type)) > 0),
  source_reference text,
  evidence_reference text,
  reason_code text,
  note text,
  verified_at timestamptz NOT NULL,
  FOREIGN KEY (merchant_id, payment_intent_id)
    REFERENCES egy_pay_payment_intents (merchant_id, id),
  FOREIGN KEY (merchant_id, payment_intent_id, payment_claim_id)
    REFERENCES egy_pay_payment_claims (merchant_id, payment_intent_id, id)
);

CREATE INDEX egy_pay_verification_records_intent_idx
  ON egy_pay_verification_records (merchant_id, payment_intent_id, verified_at DESC);

CREATE TABLE egy_pay_payment_events (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  payment_intent_id text NOT NULL,
  type text NOT NULL CHECK (
    type IN (
      'payment.intent.created',
      'payment.claim.reported',
      'payment.paid',
      'payment.verification.rejected',
      'payment.intent.cancelled',
      'payment.intent.expired'
    )
  ),
  occurred_at timestamptz NOT NULL,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  delivered_at timestamptz,
  FOREIGN KEY (merchant_id, payment_intent_id)
    REFERENCES egy_pay_payment_intents (merchant_id, id)
);

CREATE INDEX egy_pay_payment_events_outbox_idx
  ON egy_pay_payment_events (occurred_at, id)
  WHERE delivered_at IS NULL;

CREATE TABLE egy_pay_idempotency_records (
  merchant_id text NOT NULL,
  operation text NOT NULL CHECK (
    operation IN (
      'create_payment_intent',
      'submit_payment_claim',
      'verify_payment',
      'reject_payment_claim',
      'cancel_payment_intent'
    )
  ),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (merchant_id, operation, key)
);
