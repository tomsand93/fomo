# The reminder template — submit this to Meta

The reminder feature is built and tested, but **out-of-window reminders cannot be
delivered until this template is approved**. Until then they are recorded as failed and
surfaced to the admin (never silently dropped), which is the intended safe state, not a
bug.

## Why a template is needed at all

A reminder fires 2–3h before an event, but the user opted in whenever they last asked
about events — often days earlier. WhatsApp only allows free-form messages within 24h of
the recipient's **last inbound message**. Outside that window Twilio accepts the send,
returns a SID, and drops the message with error 63016. Three weekly boards in this
project were lost exactly that way.

`send-reminder.js` sends free text when the window is provably open (using
`lastActivity`) and needs this template for every other case.

## Submit in Twilio Console → Content Template Builder

- **Friendly name:** `fomo_event_reminder`
  (must match `REMINDER_TEMPLATE` in `send-reminder.js` exactly — that string is how the
  code finds the approved SID)
- **Content type:** Text
- **Language:** Hebrew (`he`)
- **Category:** Utility
  (**not** Marketing — this is a user-requested reminder. Marketing has worse delivery
  and a higher rejection rate for this shape.)

**Body** — copy exactly:

```
היי! 👋 עוד קצת ומתחיל {{1}}, ב-{{2}}. תהנו! 🎈
```

Glossed: "Hey! 👋 A little while and {{1}} starts, at {{2}}. Enjoy! 🎈"

| Variable | Value sent | Sample for the submission form |
|----------|-----------|-------------------------------|
| `{{1}}`  | event name  | מסיבת גג |
| `{{2}}`  | start time  | 20:00 |

**Location is deliberately not a variable.** It arrives as a full address
(`בר בזל, מסדה 12, חיפה`), which makes the sentence long, and two variables is a
safer approval shape than three. The user already has the address from the
conversation where they opted in.

**A note on the wording:** the verb `מתחיל` is placed *before* `{{1}}` on purpose.
Hebrew verbs agree with gender, and event names vary (`מסיבה` is feminine,
`פסטיבל` masculine). Putting the verb first reads as an impersonal "it's starting
soon" and stays correct for either, which a trailing verb would not.

**No buttons.** Button titles cannot contain variables, and a reminder has nothing to
ask — adding them only risks rejection.

## Constraints this shape already respects

Each of these caused a real rejection on this account:

- a body cannot be **only** a parameter — this one has literal text around every variable
- button titles cannot contain variables — so there are no buttons
- max 3 quick-reply buttons — not applicable here
- list-picker is not eligible on this account
- too many variables for the body length is rejected — 2 variables at this length is
  comfortably within it (this is why location was dropped)
- emoji must be single code points, no variation selectors: 👋 is U+1F44B and 🎈 is
  U+1F388, both one code point. A pair like U+1F39F+U+FE0F renders as nothing on
  clients that do not know it, which is how a price line once arrived unlabelled.

## After approval

Turn the feature on — it ships gated off, so that deploying the code and making a
promise to users are separate acts:

```
fly secrets set REMINDERS_ENABLED=1 -a fomo-qe2gha
```

No redeploy is needed beyond that. `send-interactive.js` refreshes approved templates
hourly and `approvedTemplateSid("fomo_event_reminder")` starts returning a SID, so
out-of-window reminders begin sending on their own.

To turn it back off, `fly secrets unset REMINDERS_ENABLED -a fomo-qe2gha`. Reminders
already opted into stay recorded and stop firing; they resume if it is switched on
again, rather than being closed out as failed.

**While it is off:** the bot does not offer reminders and does not record them, so no
user is ever promised something that will not arrive. That is the deliberate default —
an unset variable means "promise nothing", never "promise and hope".

## Verifying on production (the definition of done)

1. Ask the bot about events, then ask for a reminder for one starting in ~4 hours.
2. Confirm a `pending` line appears in `reminders.jsonl` on the volume.
3. **Do not message the bot again** — that would reopen the 24h window and test the
   free-text path instead of the template one.
4. At 2–3h before the event, confirm the reminder arrives.
5. Confirm the line in `reminders.jsonl` reads `status: "sent"` with `detail`
   starting `template`, not `text`.

Step 3 is the one that actually tests the hard part. A test where you keep chatting with
the bot proves nothing about the case this template exists for.
