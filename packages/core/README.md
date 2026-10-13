# @ibrahim.one/core

Headless, framework-agnostic payment workflow services for Node.js and TypeScript.

## Install

~~~bash
npm install @ibrahim.one/core
~~~

Node.js 20 or newer is required.

## What it provides

- Payment intents and customer-submitted claims.
- Explicit PAID_UNVERIFIED and authorized verification transitions.
- Idempotent commands, transactional storage ports, and outbox delivery.
- Trusted-source reconciliation matching primitives.

The core has no built-in database or HTTP framework dependency. Pair it with an adapter such as @ibrahim.one/storage-postgres, or implement the transactional storage port for your own database.

A customer claim, screenshot, or supplied transaction reference is not proof of settlement. Only authorized verification from a trusted source may transition an intent to PAID. egy-pay does not move money or automatically verify Vodafone Cash or InstaPay transfers.

See the documentation at https://egy-pay.vercel.app/docs for setup and framework integration.
