# FOMO Setup Decisions

Use this as the current product definition before continuing implementation.

## 1. Core Concept

- Promise: FOMO Haifa is a Haifa culture event board.
- Audience: both event organizers and event visitors.
- Organizer channel: WhatsApp bot for submitting events.
- Visitor channel: a distribution bot/message that sends the event to Stav/Tom, then it is forwarded to the group.
- Scope: not every event. Publish only events that pass validation.
- Tone: light and casual.

## 2. Submission Bot Flow

- First message: show an initial numbered menu.
- Menu:
  - `1. לפרסם אירוע`
  - `2. לראות מחירון פרסום`
  - `3. שירות לקוחות`
- Event submission flow:
  - User chooses `1. לפרסם אירוע`.
  - Bot replies: `הכניסו את פרטי האירוע בפורמט חופשי`.
  - User may send free text.
  - Interpretation model extracts what exists and what is missing.
  - Bot replies with all missing fields at once.

## 3. Event Format

Required fields:
- Event name.
- Category.
- Exact date.
- Ticket price / free.
- Start time.
- Location.
- Contact person.
- Image/flyer.

Recommended, not required:
- Link.

Categories:
- תרבות
- ספורט
- יריד
- לכל המשפחה
- ריטריטים וסדנאות
- הופעה
- פסטיבל
- מסיבת טבע
- Other/add more

Genres:
- מיינסטרים
- כללי
- אלטרנטיבי
- רטרו
- Other/add more

Rules:
- One event may have multiple genres.
- Accept only exact dates. Do not accept relative dates like today, tomorrow, Thursday.
- Do not accept events outside Haifa.

## 4. Validation

Valid event:
- Public culture event for a broad audience.
- Public workshop for a broad audience.
- Not suspicious.
- Fits the spirit of the group.
- Submitted at least 12 hours before the event.

Auto-reject or send back for correction:
- Missing required payment.
- Missing required field.
- Not relevant to the full group, including women-only or men-only events.
- Duplicate events.

Manual review:
- MVP: every event requires human review while the bot learns.
- Approver: Stav, `+972528762432`.
- Paid events may still be rejected.
- If a paid event is rejected, refund the payment.

## 5. Payment

- Publication price: TBD.
- Payment is required before publication unless manually waived later.
- Price menu appears from the first bot menu.

Open payment decisions:
- Exact price per event.
- Whether some community/nonprofit events are free.
- Whether paid priority/highlight exists.
- Payment method for MVP.
- Whether receipt/invoice is required from day one.

## 6. Event Info Bot

Needs definition:
- Visitor-facing menu.
- Whether it sends today's events, weekly events, or search by category/date.
- Whether users receive direct messages or only the admin receives a prepared message for forwarding.
