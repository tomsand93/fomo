# Product

## Core Idea

FOMO Haifa is a Haifa culture event board that collects local event submissions and turns approved events into a clean Hebrew WhatsApp digest.

## Audience

- Event organizers submit events through the WhatsApp bot.
- Event visitors read the published digest/group messages.
- Stav approves and distributes events to the group during MVP.

## Flow

1. Organizer sends event details to the WhatsApp bot.
2. Bot extracts structured fields from free text:
   - name
   - categories
   - genres
   - exact date
   - start time
   - location
   - price/free
   - contact person
   - link
   - image/flyer
   - short description
3. Bot replies with all missing required fields at once.
4. Complete events go to payment/review.
5. Stav reviews every event during MVP.
6. Approved events are published manually to the WhatsApp group.
7. Later outputs can reuse the same data:
   - weekly board
   - website
   - billboard
   - social post

## Bot Tone

Light and casual Hebrew.

## MVP Build Order

1. Submission bot menu.
2. Free-text event parsing.
3. Missing-field feedback.
4. Manual review queue.
5. Payment link/manual payment.
6. Digest generation.

## Constraint

Normal WhatsApp groups may not be publishable through the official Business API. Use generated messages and manual forwarding for MVP unless the publishing path is confirmed.
