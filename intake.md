# WhatsApp Intake

## Chosen Intake

People send event details to a WhatsApp number/bot.

For MVP testing, use the Twilio WhatsApp Sandbox:

```text
whatsapp:+14155238886
```

## First Reply

When a user sends any first message, reply with a menu:

```text
היי! מה תרצו לעשות?

1. לברר בנוגע לאירועים
2. לפרסם אירוע
3. לראות מחירון פרסום
4. שירות לקוחות
```

The menu is the fallback, not the automatic first reply: a message whose intent is clear
is acted on directly. See "Routing a first message" in `conversation-flow.md`.

## Publish Event Flow

If the user chooses `2`:

```text
שלחו את פרטי האירוע בפורמט חופשי.
```

The bot should parse free text with the interpretation model and extract what it can.

## Required Fields

- event name
- categories
- exact date
- price/free
- start time
- location
- contact person
- image/flyer

Recommended:
- link

Optional:
- end time
- organizer
- short description
- genres

## Bot Reply Rules

If all required fields exist:

```text
קיבלנו את האירוע.
הוא נכנס לבדיקה לפני פרסום.
```

If details are missing, the gaps are asked as questions a person can answer. The wording
lives in `missingFieldsPrompt` and `FIELD_QUESTIONS` in `server.js`.

## Technical MVP

1. User joins the Twilio sandbox.
2. User sends event details to the sandbox WhatsApp number.
3. Twilio sends `POST /webhook/twilio`.
4. Parser extracts fields from free text.
5. Missing fields get `needs_info`.
6. Complete events get `payment_pending` or `paid_pending_approval`.
7. Stav reviews every event before publication.

## Webhook

```text
POST /webhook/twilio
```
