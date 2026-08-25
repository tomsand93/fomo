# FOMO Haifa

Automated WhatsApp intake and daily events digest for Haifa.

## Goal

Collect Haifa culture event messages, structure them, validate them, and publish one organized Hebrew WhatsApp message.

## Product Shape

- Two channels:
  - submission channel: users send events to the WhatsApp bot
  - billboard channel: one daily organized digest is published
- Users submit events by WhatsApp message.
- Chosen intake: WhatsApp number/bot.
- The system extracts event details into `events.csv`.
- Events are reviewed by Stav during MVP.
- Once a day, the system generates one Hebrew WhatsApp digest.
- The digest is prepared for manual forwarding to the live WhatsApp group during MVP.
- Later, the same events can feed weekly boards, billboards, or a website.

## Decisions Needed

- WhatsApp publishing method:
  - official WhatsApp Business API if it can support the needed destination
  - generated digest + manual paste if group posting is not supported
  - alternative channel if needed
- WhatsApp provider for intake: Twilio for MVP.

## First Tasks

1. Create Twilio WhatsApp sender/number.
2. Deploy this webhook server.
3. Set Twilio inbound webhook to `/webhook/twilio`.
4. Extract incoming messages into `events.csv`.
5. Generate daily digest from structured events.

Skipped: full API integration first. Add it after the daily digest format works and the WhatsApp publishing path is confirmed.

## Data

Everything lives on the Fly volume, next to `events.csv` (`/data` in production):

| File | What it holds |
|---|---|
| `events.csv` | the events themselves, one row each |
| `state.json` | open conversations and scheduling state |
| `corrections.json` | corrections the extractor has learned from |
| `flyers/` | submitted flyer images |
| `clicks.jsonl` | one line per visit to a short link |
| `interactions.jsonl` | one line per message in or out of the bot |

Short links are `/e/<slug>`, four characters from an alphabet with no `0/O/1/l/I`.
A slug is assigned when the event is created, so the link in the receipt is the same
one that reaches the group. It redirects when the submitter gave a real URL, and
otherwise shows the event on a FOMO page — which is the common case, since most
people send a name or a phone number rather than a link.

Click counts exclude WhatsApp's own link-preview fetches (matched by user-agent, kept
in the log and flagged rather than dropped, so they can be re-filtered later). They
are reported as "צפיות", not clicks, because no such filter is perfect.

Visitor addresses are stored as a salted SHA-256 prefix, never raw — enough to tell
two visitors apart, useless for identifying either. Set `IP_SALT` in production.

Both logs are pruned to 90 days by a daily sweep.

To read them:

```
fly ssh console -a fomo-qe2gha
wc -l /data/clicks.jsonl
tail -5 /data/interactions.jsonl
```

Or ask the bot as admin: `צפיות` for the busiest links, `צפיות <id>` for one event.

## Current Channel

Public format: existing live WhatsApp group.
Language: Hebrew.
Category scope: validated Haifa culture events only.
Links: see `links.md`.
Channels: see `channels.md`.
Conversation flow: see `conversation-flow.md`.
Payments: see `payments.md`.
Meeting questions: see `meeting-questions.md`.
