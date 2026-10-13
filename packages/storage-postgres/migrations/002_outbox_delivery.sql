ALTER TABLE egy_pay_payment_events
  ADD COLUMN available_at timestamptz,
  ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0
    CHECK (delivery_attempts >= 0),
  ADD COLUMN lease_token text,
  ADD COLUMN lease_until timestamptz;

UPDATE egy_pay_payment_events SET available_at = occurred_at;

ALTER TABLE egy_pay_payment_events
  ALTER COLUMN available_at SET NOT NULL,
  ADD CONSTRAINT egy_pay_payment_events_lease_pair_check
    CHECK ((lease_token IS NULL) = (lease_until IS NULL));

CREATE INDEX egy_pay_payment_events_dispatch_idx
  ON egy_pay_payment_events (available_at, lease_until, occurred_at, id)
  WHERE delivered_at IS NULL;
