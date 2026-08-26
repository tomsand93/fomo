# Feature: event reminders for users

## Prompt

Build opt-in event reminders for FOMO Haifa. A user asking the bot about events
can ask to be reminded about a specific one, and the bot messages them shortly
before it happens.

Today the bot **cannot** do this, and `answer-inquiry.js` is explicitly told to
say so — that rule must be removed as part of this work, not left contradicting
the new behaviour.

## Why

A real user asked for it unprompted, mid-conversation. The bot offered a
reminder, then admitted one message later that it could not send one. That
contradiction is fixed for now by forbidding the offer; this feature is what
makes the offer honest.

## What exists to build on

- `clicks-store.js` — append-only JSONL on the `/data` volume, the pattern for
  any new per-user data
- `sendDuePendingReminder` (`server.js`) — the clock-based slot pattern:
  `israelClock` + `isDue` + a persisted sent-marker, checked every 5 min.
  Reuse this rather than `setInterval(fn, 24h)`, which does not survive Fly
  suspending the machine.
- `sendChoice` (`send-interactive.js`) — buttons when an approved template
  matches, numbered text otherwise
- `upcomingPublishedEvents` (`server.js`) — the events the inquiry flow can see

## Decisions to make first

1. **Where reminders live.** A `reminders.jsonl` beside `clicks.jsonl`, or a
   column on the event row. Probably the former: it is per-user-per-event, and
   the event row is already wide.
2. **When to fire.** Morning of the event, the evening before, or the user's
   choice. A fixed default is simpler and probably enough.
3. **How to ask.** During the inquiry flow the user is mid-conversation, so a
   webhook reply can offer it — but only the *menu* currently routes through
   the API/button path, so this needs the same treatment or stays numbered.

## The hard part — read before estimating

A reminder fires hours or days after the user last messaged, so **their 24-hour
WhatsApp window will usually be closed**. A plain text send is accepted by
Twilio and then silently dropped with error 63016 — this is not hypothetical,
it silently lost three weekly boards in this project.

That means a reminder needs an **approved Content template**, submitted to Meta
in advance. Constraints learned the hard way here:

- a template body cannot be only a parameter — it needs literal text around
  `{{1}}`
- button titles cannot contain variables
- max 3 quick-reply buttons; list-picker is not eligible on this account
- too many variables for the body length is rejected
- `sendChoice` only uses a template when the option keys match its fixed
  buttons exactly

Delivery must be verified, not assumed: `confirmBoardDelivery` shows the
pattern (poll `getMessageStatus`, treat 63016 as undelivered, keep a retry
queue). A reminder that silently fails is worse than none, because the user was
told it would come.

## Definition of done

- A user can ask for a reminder and get a clear confirmation
- The reminder actually arrives, verified on production with a real submission
- A failed send is retried or surfaced, never silently dropped
- `answer-inquiry.js` no longer denies the capability
- Regression tests: opt-in recorded, fires once per user per event, survives a
  restart, does not fire twice
