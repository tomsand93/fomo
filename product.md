# Product

## Core Idea

FOMO Haifa is a Haifa culture event board that collects local event submissions and turns approved events into a daily Hebrew WhatsApp board and optional graphic ads.

## Audience

- Event organizers submit events through the WhatsApp bot.
- Event visitors read the daily board and the ads in the group.
- Stav approves events and forwards the board and ads to the group during MVP.

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
4. The organizer confirms the short listing and the graphic ad.
5. Stav reviews every confirmed event during MVP, and can edit it in her own words.
6. Approved events are listed on the daily board for their day; Stav forwards it to the WhatsApp group.
7. The organizer can book a graphic ad in a morning or evening window, free for now.
8. Later outputs can reuse the same data:
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
6. Daily board and ad generation.

## Constraint

Normal WhatsApp groups may not be publishable through the official Business API. Use generated messages and manual forwarding for MVP unless the publishing path is confirmed.
