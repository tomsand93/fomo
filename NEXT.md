# Next up

## 1. Stav must preview both formats before approving

**Status: identified, not started.**

`formatEventForReview` (`server.js:539`) sends a raw field dump — `שם: … תאריך: … שעה: …`.
It is neither of the two formats the group actually sees, so Stav approves without ever
previewing the output. A wrong line break, a misparsed price or a truncated description
only becomes visible after publication.

Both renderings already exist and are used everywhere else:

- `formatShort(event, { linkFor })` — what goes on the weekly board
- `formatLong(event, { linkFor, flyerUrl })` — what goes in the daily group message,
  returns `{ text, mediaUrl }` with the flyer as media

**What to change:** rebuild the review notice as
1. a short header naming the event and its id,
2. the SHORT rendering under a "this is how it appears on the weekly board" label,
3. the LONG rendering under a "this is how it appears in the daily message" label,
4. the existing `⚠️ לא הובהר` uncertainty note (keep — it is why she reviews at all),
5. the approve/reject instructions.

**Watch out for:**
- The flyer rides on `mediaUrl`, so it is already attached to the notice — do not also
  paste the URL as text.
- Keep `rememberNotice(result.sid, id)` intact (`server.js:723`): replying "אשר" to the
  notice resolves the event by that sid, and losing it reintroduces the ambiguity bug.
- `sendWhatsApp` takes ONE MediaUrl. Short + long + flyer must stay a single message,
  or the reply-to-approve sid points at the wrong message.
- Both formatters need `linkFor: shortLink` so the preview shows the real FOMO link.
- The message gets long; check it against WhatsApp's 1600-char body limit for an event
  with a full description.

**Test:** extend the review-notice assertions in `test-server.js` — the notice must
contain the SHORT line, the LONG block, and still end with the approve/reject lines.

## 2. Reword and submit `fomo_pending_events_reminder`

The daily "events awaiting review" nudge (`server.js:365`) goes out as plain text, so it
is silently dropped by error 63016 whenever Stav's 24h window is shut — the same failure
that lost three weekly boards. The board send is now protected; this one is not.

Reword tighter before submitting ("יש N אירועים שממתינים לאישור") — Meta rejects
templates that read as content pushes, and the current version lists names and ids.

## 3. TwiML → API replies

Unlocks buttons on the main menu and the submission-time publish-day question with no
Meta approval needed (verified: an unapproved template delivers fine inside an open 24h
window). All 58 return statements funnel through one line (`server.js:1125`), so the
change is small — but a failed send becomes silence instead of an error, so apply the
existing delivery-check/retry pattern.

Worth waiting until the 4 pending templates come back, to confirm buttons render well in
the group's clients before restructuring around them.

## Loose end

Rejecting event #19 reported success while leaving it `published`. Data corrected by
hand; the "command said it worked and didn't" path was never diagnosed.
