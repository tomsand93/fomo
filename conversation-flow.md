# Conversation Flow

## Channels

1. Submission bot: organizers send events to the WhatsApp number.
2. Billboard: approved event messages are sent to Stav/Tom and forwarded to the audience.

## User Menu

The menu is what a message falls through to when nothing more specific fits
(`MENU_TEXT` in `server.js`):

```text
היי! מה תרצו לעשות?

1. לברר בנוגע לאירועים
2. לפרסם אירוע
3. לראות מחירון פרסום
4. שירות לקוחות
```

## Routing a first message

A message that is not a menu digit does not go straight to the menu. It is classified
(`classify-intent.js`) as `submit`, `inquire` or `other`:

- media attached → always `submit`, with no model call. A flyer is unambiguous.
- confidence ≥ 0.7 → routed straight into that flow. A confident `inquire` is answered
  immediately, using the message they already sent — it does not ask what they want to
  know.
- confidence < 0.7 between the two real flows → the sender is asked which they meant.
- anything else, or a classifier that fails or is unconfigured → the menu.

This replaced a rule that read any message of 40+ characters as an event submission. It
put people asking for recommendations into the publishing flow, where the
`activeSubmissions` check outranks the menu digits, so they could not get out; and it left
short questions ("what's on tonight?") falling through to the menu instead of an answer.

## Leaving a submission

Two safety nets, because a misclassification must never be a trap:

- if a message inside a draft adds no identifying field, reads as a question or an
  objection, and is not the first prompt, the bot offers the menu instead of repeating the
  missing-fields questions.
- at the attempt limit, a draft with fewer than two of
  event_name/date/start_time/location/contact_link is abandoned with the menu rather than
  filed. It used to be written to `events.csv` and acknowledged with "we received your
  event", which was false.

## Option 2 - Publish Event

Ask for the event in free text:

```text
שלחו את פרטי האירוע בפורמט חופשי.
```

After receiving it:
- parse fields with the interpretation model
- validate required fields
- return all missing fields at once
- save complete events to `events.csv`
- mark complete events as `payment_pending`
- mark incomplete events as `needs_info`

Reply if complete:

```text
קיבלנו את האירוע.
הוא נכנס לבדיקה לפני פרסום.
```

Reply if incomplete: the gaps are asked as questions a person can answer, one directly if
only one field is missing and a short list otherwise. The exact wording lives in
`missingFieldsPrompt` and `FIELD_QUESTIONS` in `server.js` — restating it here is how this
file drifted out of date before.

A draft that is still incomplete after three tries is handed to Stav with the gap named,
unless almost nothing was extracted at all, in which case it is dropped rather than filed
(see "Leaving a submission" above).

## Option 3 - Price List

Reply with the current publication price and payment instructions.

Current price:

```text
TBD
```

## Option 4 - Customer Service

Forward to the admin contact.

Admin:
- Stav, `+972528762432`

## Validation

Required:
- event name
- category
- exact date
- price/free
- start time
- location
- contact person
- image/flyer

Recommended:
- link

Reject or hold:
- missing required fields
- missing payment
- relative date
- not in Haifa
- women-only or men-only
- spam/scam/suspicious
- duplicate event
- unsafe/illegal content

## Approval

MVP:
- complete events are saved as `payment_pending`
- user pays by the chosen MVP method
- every paid event is manually reviewed
- Stav approves or rejects
- rejected paid events are refunded

Production:
- digest should use only `approved`

## What Tom Needs To Decide

1. Publication price.
2. Free/community event policy.
3. MVP payment method.
4. Daily send time.
5. Weekly send day/time.
6. Exact visitor-facing event info bot behavior.
