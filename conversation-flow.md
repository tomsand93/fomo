# Conversation Flow

## Channels

1. Submission bot: organizers send events to the WhatsApp number.
2. Billboard: approved event messages are sent to Stav/Tom and forwarded to the audience.

## User Menu

When a user sends any first message, reply:

```text
היי! מה תרצו לעשות?

1. לפרסם אירוע
2. לראות מחירון פרסום
3. שירות לקוחות
```

## Option 1 - Publish Event

Ask for the event in free text:

```text
שלחו את פרטי האירוע בפורמט חופשי.
```

After receiving it:
- parse fields with the interpretation model
- validate required fields
- return all missing fields at once
- save complete events to `events.csv`
- mark complete events as `payment_pending`
- mark incomplete events as `needs_info`

Reply if complete:

```text
קיבלנו את האירוע.
הוא נכנס לבדיקה לפני פרסום.
```

Reply if incomplete:

```text
חסרים פרטים כדי להמשיך:
- תאריך מדויק
- שעת התחלה
- פלייר / תמונה

שלחו את הפרטים החסרים בהודעה אחת.
```

## Option 2 - Price List

Reply with the current publication price and payment instructions.

Current price:

```text
TBD
```

## Option 3 - Customer Service

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
- complete events are saved as `payment_pending`
- user pays by the chosen MVP method
- every paid event is manually reviewed
- Stav approves or rejects
- rejected paid events are refunded

Production:
- digest should use only `approved`

## What Tom Needs To Decide

1. Publication price.
2. Free/community event policy.
3. MVP payment method.
4. Daily send time.
5. Weekly send day/time.
6. Exact visitor-facing event info bot behavior.
