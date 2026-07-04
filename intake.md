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

1. לפרסם אירוע
2. לראות מחירון פרסום
3. שירות לקוחות
```

## Publish Event Flow

If the user chooses `1`:

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

If details are missing, reply with all missing fields at once:

```text
חסרים פרטים כדי להמשיך:
- תאריך מדויק
- שעת התחלה
- פלייר / תמונה

שלחו את הפרטים החסרים בהודעה אחת.
```

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
