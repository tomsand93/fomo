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

## Current Channel

Public format: existing live WhatsApp group.
Language: Hebrew.
Category scope: validated Haifa culture events only.
Links: see `links.md`.
Channels: see `channels.md`.
Conversation flow: see `conversation-flow.md`.
Payments: see `payments.md`.
Meeting questions: see `meeting-questions.md`.
