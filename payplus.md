# PayPlus Setup

> **Status: not implemented, not planned for now.** Paid publication was never
> built — nothing creates payment links and no event ever reaches a paid status.
> The `/webhook/payplus` endpoint existed but only logged callbacks, so it was
> removed along with its settings rather than left as an unused open endpoint.
> This document is kept as the design if the idea returns.

## Purpose

Use PayPlus for paid event publication.

Flow:
1. User submits an event.
2. Bot validates event fields.
3. Bot creates/sends a PayPlus payment link.
4. User pays.
5. PayPlus calls our webhook.
6. Event becomes `paid_pending_approval`.
7. Tom approves.
8. Event becomes `approved` and can enter the digest.

## Receipt / Invoice

Payment approval is not the same thing as a receipt.

For Israel, assume customers should receive a receipt/invoice unless your accountant says otherwise.

PayPlus may support documents/receipts depending on account setup, terminal settings, and enabled modules. Confirm in PayPlus:
- whether invoices/receipts are enabled
- whether receipt is sent automatically after successful payment
- whether VAT details are required
- whether you need an accounting integration

Until confirmed, treat receipt issuing as a required setup item, not guaranteed.

## Needed From PayPlus

- API key / secret
- terminal UID or page UID
- payment page endpoint fields
- webhook/IPN signature rules
- successful payment status value
- receipt/invoice setting

## Webhook

Configure PayPlus payment notification/webhook to:

```text
POST https://YOUR_DOMAIN/webhook/payplus
```

## Local Env

```env
PAYPLUS_API_KEY=
PAYPLUS_SECRET=
PAYPLUS_TERMINAL_UID=
PAYPLUS_SUCCESS_URL=
PAYPLUS_CANCEL_URL=
PAYPLUS_WEBHOOK_SECRET=
PUBLIC_BASE_URL=
```
