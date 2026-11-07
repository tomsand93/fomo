# Daily board and graphic ads

Replaces the weekly board and the "pick a day for the daily message" question with two
formats: a daily board and an optional graphic ad.

Sources: Tom and Stav's notes (05/11/2026) and Stav's answers on the mockup page
(07/11/2026). The mockup is saved next to this file as
`2026-11-07-flow-mockup.html`. Its Hebrew wording is the starting point for all copy,
except where this document changes the flow (see "Where the mockup is out of date").

## Why

The group gets too many overlapping formats, and Stav cuts and sorts them by hand. An
organizer does not know when their event will actually be posted. The flyer goes out on
rules nobody chose. Two clear products fix this: every approved event is listed free on
its day, and an organizer who wants more books an ad for a named time.

## Goals

- Only two things reach the group: the daily board and graphic ads.
- An organizer always knows exactly when their ad will be posted.
- An organizer sees and confirms both versions before Stav sees anything.
- Stav can change anything before she approves, without learning a command syntax.
- A correction is never ignored, whatever question the bot is waiting on.

## Non-goals

- Payment. The price is undecided and Stav wants to research what sells. Ads are free
  until then, and the offer wording mentions no price.
- Automatic posting to the group. WhatsApp's API can't do it (`channels.md`), so Stav
  still forwards everything.
- Several ads per event. One booking per event.

## Anti-goals

- An ad offered for a time after the event has started.
- An event silently lost because a step waited on someone who never answered.
- Telling an organizer a view count so small it embarrasses them.

## The two formats

**Daily board (short listing).** Every approved event, on its own day only, for free.
Sent to Stav at the existing slots: 17:50 for 18:00 daily, and 11:50 for 12:00 on Friday
and Saturday. `coveredByEarlierSlot` stays as it is. Layout, from the mockup:

- Bold title and bold date line, then a link to a new `/today` page.
- Per event: bold `time · name`, then location and price, then the `/e/` link.
- No map link and no category. The map stays on the event page.
- No flyers.

A day with no events sends only the note to Stav, saying there is nothing to forward.

**Graphic ad (expanded, with flyer).** `formatLong` plus the flyer as media, with a date
line that depends on when it is posted (below). It needs a flyer.

**Date line on an ad.** Worked out when the ad is posted, on every ad:

- Same day, and the evening window or a start at 17:00 or later: bold `הערב!` (tonight).
- Same day otherwise: bold `היום!` (today).
- The next day: bold `מחר!` (tomorrow), then the weekday and date.
- Later: the bold long date.

## Ad windows

Morning is 10:00–13:00, handed to Stav at 09:50. Evening is 18:00–21:00, handed to her at
17:50 in the same run as the board, after the board post.

**The one rule:** a window can be offered only if `max(window start, now)` is before the
event starts, and the window has not ended. For a multi-day event, "the event starts"
means the start time on its last day. Stav did not understand the one-hour margin on the
mockup, so there is no margin. She can see the event time in the handoff.

"As soon as possible" means the first window that passes the rule. If a window is already
open, the ad goes to Stav immediately.

If no window passes, the bot offers no ad and says why. This covers the 21:01 case: event
tonight at 22:00, next window tomorrow at 10:00.

## The flow

1. **Organizer submits.** Extraction and the missing-field questions are unchanged.
2. **Bot shows both versions.** Three messages: the short listing, the ad with the flyer,
   and a prompt to confirm or say what to change. The event is stored with a new status,
   `awaiting_confirm`. Stav is not told yet. These are outbound sends, because a TwiML
   reply carries no media and only one message. The webhook returns `EMPTY_TWIML`.
3. **Organizer confirms or corrects.**
   - A confirmation (`1`, or a Hebrew yes such as `אישור`/`מאשר`) sets the status to
     `submitted` and calls `forwardEventToAdmin`.
   - Any other text is a correction, applied through `applyCorrection` (below). The bot
     shows the updated versions and asks again.
   - An image replaces the flyer.
4. **Stav reviews.** The notice uses the new labels, with both versions. She can approve,
   reject, or edit. If the organizer sends a correction now, it is applied too, and Stav
   gets the updated notice.
5. **Stav approves.** The event is published. Two separate messages go to the organizer:
   the approval with the daily board date and time, then the ad offer.
6. **Organizer answers the offer.** Yes as soon as possible (with the real time in the
   option), yes and pick a window, or no. Picking lists up to six windows, with
   `תאריך אחר` (another date) when there are more. The second step asks morning or
   evening.
7. **Handoff.** The ad goes to Stav in its window, and the organizer already has the time.

No ad is offered and step 6 is skipped when no window passes the rule. The approval
message then explains why.

### Stav's edit

`ערוך` (with an id, or as a reply to the notice) makes the bot ask what to change. Her next
message goes through `applyCorrection`, and the bot shows both updated versions with the
approve line. `תקן 42 field: value` keeps working. `ערוך` joins
`ADMIN_ONLY_COMMAND_RE` and `ADMIN_HELP_TEXT`. Add an edit button to the review template
only when that template is next resubmitted; typing works without it.

### `applyCorrection(event, text)`

One function for organizer and Stav edits. A model call returns only the fields the text
changes, reusing the extraction prompt's field rules. The result goes through
`fieldIsValid` and `storeUpdateEvent`, and a Stav edit also goes through `addCorrection`
as `תקן` does. If nothing changed, the bot says it didn't understand and asks again. It
never repeats the previous question as if nothing was said.

### Corrections after approval

Nothing changes automatically. The text goes to Stav through `forwardAmendmentToAdmin`,
the organizer is told, and any open ad question is repeated after that. This fixes the
reported bug: `handleDayChoice` re-shows the list for anything that is not an option.

## Data

New columns in `CSV_HEADERS`: `ad_date`, `ad_window` (`morning`, `evening` or `decline`),
`ad_sent_at`. Empty `ad_window` means not asked. `daily_days` stops being read or written
and the column stays, so old rows still parse. `flyer_sent_at` stops being used the same
way.

`awaitingPublishChoice` is removed. `awaitingDailyChoice` becomes `awaitingAdChoice`.
`awaitingConfirmation` is new (sender to event id). All are persisted in `state.json`.
Stored entries for the removed maps are ignored on load.

`awaiting_confirm` must be handled wherever statuses are listed: `expirePastEvents`,
`CANCELLABLE_STATUSES`, `findDuplicateEvent`, and `formatPendingList` (under its own
heading, so Stav can see who hasn't confirmed). It is excluded from `AWAITING_REVIEW` and
from the missed-notice banner.

## What is removed

- `make-weekly.js`, `send-weekly.js`, the `/weekly` route, and the board and "promoted"
  posts in `buildSlotPosts`.
- `publishDayOptions`, `publishChoicePrompt`, `recordDailyDays` and the rest of the
  publish-day code, and the question in the submission receipt.
- The `sendPublishedPost` flyer post at approval. An event approved on its own day after
  the last slot has passed still goes to Stav at once, in short form.
- `makeDigest`, `send-digest.js` and `/digest`, which only exist for the old long daily
  message. Keep `/digest` only if it is rewritten to return the new board.
- Weekly board wording in `README.md`, `product.md`, `conversation-flow.md`, `NEXT.md`
  and `reminder-template.md`.

The Wednesday publisher nudge is a reminder to organizers, not the board, and stays.
Check `nudge-variants.js` for promises that no longer hold.

## View counts

`goodbyeMessage` mentions views only above 10: the single-event line, each per-event count,
and the total line. Stav's words were "more than 10", so exactly 10 stays silent.

## Constraints

- **WhatsApp's 24-hour window.** The code comment at `server.js:2598` records that a
  question asked after approval often arrives outside the window and is never seen. The
  organizer's confirmation in step 3 reopens the window, which covers approvals within a
  day. Later than that, the offer needs an approved template. Submit a new
  `fomo_ad_offer` template to Meta. `fomo_publish_day_v2` names the old options and can't
  be reused. Until it is approved, an offer that hits a closed window waits and goes out
  on the organizer's next message, checked through `windowIsOpen` and `lastActivity`.
- **Stale options.** The offer may be answered hours later, so windows are recomputed
  when the answer arrives. If the chosen one has passed, the bot says so and offers what is
  left.
- **Delivery to Stav.** Morning ads use the same path as boards: `sentBoards` key,
  `pendingBoards`, `confirmBoardDelivery`, `sendSlotReadyPing`. The balance warning stays
  on the note.
- **Link preview.** WhatsApp previews the first link in a message. `/today` needs `og:`
  tags and a branded 1200x630 image served by the app, and `/e/` should get them too.
  This must be checked on a real phone, including after Stav forwards the message, because
  it can't be tested in code.
- **Hebrew files.** Edit with the Edit tool or a node script, never PowerShell. Run
  `check-encoding.js`.
- **Message size.** Keep each message under WhatsApp's 1600 characters. A long board is
  split between events, not inside one.

## Calls made by Claude, not yet confirmed

1. The ad offer goes right after Stav approves. Tom answered "yes" to an either/or
   question, so this reading needs confirming.
2. "Not sent to me before the organizer approves" became a confirmation step before Stav.
3. An organizer who never confirms is reminded once after 3 hours. The event never reaches
   Stav on its own; it stays on her pending list until it expires.
4. `ערוך` means describing the change in free text, not retyping the whole ad. That keeps
   the date line computed at posting time.
5. Corrections after approval go to Stav and change nothing automatically. This is simpler
   than the re-approval proposed on the mockup.
6. A flyer now reaches the group only through an ad. An event with a flyer and no ad is
   listed as text. Choosing an ad without a flyer makes the bot ask for one first.
7. Ads are free until a price is set.

## Left to the builder

File layout, function names not given here, exact prompt wording for `applyCorrection`,
how the board is split when long, and the order of work. Tests follow the existing style
in `test-server.js` and `test-reminders.js`.

## Where the mockup is out of date

Steps 1 to 3 on the page have no confirmation step. Step 5 shows a correction applied
after approval. The simulator's margin defaults to 60 minutes. The ad on the page has no
map line; the real ad keeps it (Claude's call), because a message with a flyer shows no
link preview, so the map tile problem can't occur there. Previews shown before an ad is
booked use the bold long date, since the posting day isn't known yet.
