import Link from 'next/link';
import { BrandLockup } from '@/components/brand';

export default function HomePage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="landing-copy">
          <div className="landing-brand">
            <BrandLockup />
          </div>
          <p className="landing-kicker">A TypeScript toolkit for manual payments in Egypt</p>
          <h1 className="landing-title">A transfer claim is not a payment.</h1>
          <p className="landing-description">
            egy-pay records manual transfer claims and keeps fulfillment on hold until an
            authorized reviewer confirms the payment from a trusted source.
          </p>
          <div className="landing-actions">
            <Link className="landing-action landing-action-primary" href="/docs">
              Read the guide
            </Link>
            <Link className="landing-action landing-action-secondary" href="/docs/payment-lifecycle">
              Explore the lifecycle
            </Link>
          </div>
        </div>

        <aside className="workflow" aria-label="Payment verification lifecycle">
          <div className="workflow-header">
            <strong>Payment intent</strong>
            <span>EGP 500.00</span>
          </div>
          <ol className="workflow-list">
            <li className="workflow-item">
              <span className="workflow-node" aria-hidden="true" />
              <div>
                <span className="workflow-label">AWAITING_PAYMENT</span>
                <span className="workflow-copy">The customer receives manual transfer instructions.</span>
              </div>
            </li>
            <li className="workflow-item workflow-item-unverified">
              <span className="workflow-node" aria-hidden="true" />
              <div>
                <span className="workflow-label">PAID_UNVERIFIED</span>
                <span className="workflow-copy">A claim was submitted. It is not settlement proof.</span>
              </div>
            </li>
            <li className="workflow-item workflow-item-paid">
              <span className="workflow-node" aria-hidden="true" />
              <div>
                <span className="workflow-label">PAID</span>
                <span className="workflow-copy">An authorized review confirmed a trusted record.</span>
              </div>
            </li>
          </ol>
          <div className="workflow-warning">
            <strong>Fulfillment unlocks after verification.</strong>
            <span>Only the confirmed PAID transition emits payment.paid.</span>
          </div>
        </aside>
      </section>

      <section className="landing-rule" aria-label="Payment safety rule">
        <strong>One boundary keeps the workflow honest.</strong>
        <p>
          Customer input can start a review, but only an authorized trusted verification can
          confirm payment. egy-pay does not move money or connect to unofficial provider APIs.
        </p>
      </section>

      <section className="landing-principles">
        <h2>Payment state, storage, and events stay in sync.</h2>
        <div className="principle-list">
          <article className="principle">
            <h3>Manual by design</h3>
            <p>Vodafone Cash and InstaPay instructions support a merchant-run transfer flow.</p>
          </article>
          <article className="principle">
            <h3>Verification is explicit</h3>
            <p>Claims stay unverified until an authorized actor checks a trusted source.</p>
          </article>
          <article className="principle">
            <h3>Writes are transactional</h3>
            <p>Your application stores state changes, audit records, idempotency, and outbox events together using its existing database.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
