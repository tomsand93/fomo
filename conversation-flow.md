# Conversation Flow

## Channels

1. Submission bot: organizers send events to the WhatsApp number.
2. Group posts: the daily board and graphic ads are handed to Stav, who forwards them to the
   group. WhatsApp's API cannot post to a group (`channels.md`).

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
- save incomplete events as `needs_info`
- save complete events as `awaiting_confirm` and show the organizer both versions (below)

Incomplete reply: the gaps are asked as questions a person can answer, one directly if
only one field is missing and a short list otherwise. The exact wording lives in
`missingFieldsPrompt` and `FIELD_QUESTIONS` in `server.js` — restating it here is how this
file drifted out of date before.

A draft that is still incomplete after three tries is handed to Stav with the gap named,
unless almost nothing was extracted at all, in which case it is dropped rather than filed
(see "Leaving a submission" above).

### Confirming both versions

A complete event is not sent to Stav yet. The organizer gets three separate messages
(outbound sends, since a TwiML reply carries no media and only one message):

1. the short listing, as it will appear on the daily board
2. the graphic ad, with the flyer
3. a prompt to confirm or say what to change

Then:
- A confirmation (`1`, or a Hebrew yes such as `אישור` / `מאשר`) sets the status to
  `submitted` and forwards the event to Stav.
- Any other text is a correction. It goes through `applyCorrection` (a model call that
  returns only the fields the text changes, validated before it is stored), the bot shows
  the updated versions and asks again. If nothing changed, the bot says it did not
  understand; it never repeats the old question as if nothing was said.
- An image replaces the flyer. A caption on it is a correction too.
- An organizer who has not answered after 3 hours is reminded once. The event never
  reaches Stav by itself; it stays on her pending list, under its own heading, until it
  expires.

### Stav reviews

The review notice shows both versions with the labels for the daily board and the ad. She
can approve (`אשר`), reject (`דחה`), or edit:

- `ערוך` (with an id, or as a reply to the notice) makes the bot ask what to change. Her
  next message goes through `applyCorrection`, the bot shows both updated versions and
  the approve line.
- `תקן 42 field: value` still works.
- If the organizer sends a correction while the event is with her, it is applied and she
  gets the updated notice.

### After approval

Two separate messages go to the organizer: the approval, naming the daily board's day and
slot (18:00 daily; 12:00 as well on Friday and Saturday), then the ad offer:

```text
1. כן, בהקדם האפשרי: <the first window that passes the rule> (<hours>)
2. כן, אבחר יום וחלון
3. לא, רק בלוח של <היום / מחר / the board's day>
```

Option 3 names the board the event is on. Once every board it could be on has gone to
Stav, it reads `לא, תודה` instead. The template's button is always `לא, תודה`, because a
button title can't change; the reply after the tap names the board.

- **1** books the first window that passes the rule.
- **2** lists up to six windows, with `תאריך אחר` when there are more. Windows are morning
  (10:00-13:00, handed to Stav at 09:50) and evening (18:00-21:00, handed to her at 17:50
  after the board).
- **3** declines; the event stays on the daily board only.

The one rule: a window is offered only if the later of its start and now is before the
event starts, and the window has not ended. For a multi-day event, the start time on its
last day counts. If no window passes, no ad is offered and the approval says why. Windows
are recomputed when the answer arrives; if the chosen one has passed, the bot says so and
offers what is left. Choosing an ad for an event with no flyer makes the bot ask for one
first. One ad per event; ads are free until a price is set.

When the organizer's 24-hour window is shut, the approval and the offer go as the
`fomo_ad_offer` template (`submit-ad-offer-template.js`). Until Meta approves it, both
wait and are attached to the reply to the organizer's next message. An organizer in
another open conversation gets the approval at once; only the offer waits.

A correction sent after approval changes nothing by itself. It goes to Stav, the organizer
is told, and any open ad question is asked again.

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
- the organizer confirms both versions; the event is then `submitted`
- payment is not collected yet (the price is undecided)
- every event is manually reviewed
- Stav approves or rejects
- rejected events are not published

Production:
- the daily board uses only approved events, each on its own day

## What Tom Needs To Decide

1. Publication price.
2. Free/community event policy.
3. MVP payment method.
4. Ad price, and when ads stop being free.
5. Exact visitor-facing event info bot behavior.
