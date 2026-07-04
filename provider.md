# WhatsApp Provider

## Recommended Provider

Use Twilio for the MVP.

Why:
- Can manage phone numbers and WhatsApp API in one place.
- Simple inbound webhook format.
- Good enough for testing without building Meta app plumbing first.

Tradeoff:
- Twilio adds its own per-message fee on top of WhatsApp/Meta fees.
- Meta Cloud API direct is cheaper if you bring/manage the number yourself.

## Expected Costs

Costs depend on destination country and message category.

Typical cost buckets:
- Phone number monthly rental.
- Twilio WhatsApp message fee.
- Meta WhatsApp conversation/message fees.

For the MVP, inbound event submissions should be low volume. The main cost risk is not intake; it is high-volume outbound broadcasts.

## Setup Needed

1. Create Twilio account.
2. For MVP testing, use the Twilio WhatsApp Sandbox.
3. Set `TWILIO_WHATSAPP_FROM` to:

```text
whatsapp:+14155238886
```

4. Join the sandbox from the test phone using the join code shown in Twilio.
5. Set inbound webhook URL to:

```text
https://YOUR_DOMAIN/webhook/twilio
```

6. Point the webhook to this project server.

## Sandbox Notes

The sandbox is enough to test intake:
- user sends event details to the Twilio sandbox number
- Twilio calls `/webhook/twilio`
- the server appends the event to `events.csv`
- the server replies with missing fields or confirmation

Business-initiated messages in the sandbox require a pre-approved template until the user replies. For FOMO intake, prefer user-initiated testing: the user sends the event first.

## Production Later

1. Buy or register a WhatsApp-capable sender/number.
2. Complete WhatsApp sender approval.
3. Move webhook from sandbox sender to production sender.

## Sources

- Twilio WhatsApp pricing: https://www.twilio.com/en-us/whatsapp/pricing
- Twilio WhatsApp docs: https://www.twilio.com/docs/whatsapp
- Meta WhatsApp Platform: https://developers.facebook.com/docs/whatsapp
