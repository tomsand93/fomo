# Payments

## Goal

Charge for event publication before an event appears in the digest/billboard.

## Current Decisions

- Publication price: TBD.
- Payment is required before publication.
- Paid events may still be rejected after review.
- Rejected paid events get a refund.
- Price list should be available from the first bot menu.

## MVP Payment Flow

1. User submits event.
2. Bot validates required event details.
3. Bot sends price/payment instructions.
4. User pays.
5. Event status becomes `paid_pending_approval`.
6. Stav reviews the event.
7. Approved event status becomes `approved`.
8. Rejected paid event gets refunded.
9. Digest publishes only `approved` events.

## MVP Payment Options

### Bit / PayBox Manual

Best for first tests.

Pros:
- Fast to start in Israel.
- No payment gateway setup.
- Good for low volume.

Cons:
- Confirmation is manual.
- Harder to automate reliably.
- Screenshots can be fake, so admin approval is still needed.

### PayPlus Payment Link

Use later for automation.

Pros:
- Can create payment links.
- Better receipts/invoices.
- Possible webhook for automatic payment confirmation.

Cons:
- Account setup.
- Fees.
- More integration work.

## Required Statuses

- `needs_info`
- `submitted`
- `payment_pending`
- `paid_pending_approval`
- `approved`
- `rejected`
- `published`

## Decision Needed

1. Publication price.
2. Free events allowed or every event paid?
3. Bit, PayBox, or PayPlus link for MVP?
4. Receipt/invoice needed from day one?
