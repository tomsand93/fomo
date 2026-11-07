# Daily Board and Graphic Ads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the weekly board and the publish-day question with a free daily board and an optional graphic ad booked into a morning or evening window, with the organizer confirming before Stav reviews.

**Architecture:** Pure logic goes in small modules (`format-event.js`, `make-digest.js`, new `ad-windows.js`) with offline tests in a new `test-ads.js`. `server.js` keeps routing and delivery. Two persisted question maps survive idle expiry, and ads reuse the board delivery path.

**Tech Stack:** Node.js with no dependencies, plain `http`, CSV store, Twilio WhatsApp, OpenRouter for extraction. Tests are plain scripts that throw on failure.

**Spec:** `docs/superpowers/specs/2026-11-07-daily-board-and-ads-design.md`. Hebrew wording comes from `docs/superpowers/specs/2026-11-07-flow-mockup.html` unless a task gives exact copy.

## Global Constraints

- Hebrew files: edit with the Edit tool or a node script, never PowerShell. Run `node check-encoding.js` before each commit.
- Windows: morning `10:00`–`13:00`, handed over at `09:50`; evening `18:00`–`21:00`, handed over at `17:50`.
- Offerable window: it has not ended, and `max(window start, now)` is before the event starts. No margin. For a multi-day event, use the start time on its last day.
- One booking per event. No price or payment anywhere in the copy.
- Views are mentioned only above 10.
- Every message stays under 1600 characters; long boards split between events.
- Run `npm test` at the end of every task. Delete old assertions only when this plan removes that behaviour.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An organizer answers `1` more than 5 hours after the prompt: it still confirms, and doesn't open the inquiry menu (Task 6).
2. An organizer writes `ביטול` at the confirmation prompt: the event is cancelled, not left stranded (Task 6).
3. Stav tests a submission in customer mode: the reply carries the banner and real text, never `null` (Task 6).
4. The machine sleeps through a handoff: the booked ad still goes out until the event starts (Task 3).
5. An organizer answers an ad offer after the chosen window has passed, or days later: no stale booking (Task 8).

---

### Task 1: New formats and the daily board

**Files:**
- Modify: `format-event.js`, `make-digest.js`, `package.json`
- Create: `test-ads.js`

**Interfaces:**
- Produces: `formatShort(event, { linkFor })`; `formatLong(event, { linkFor, flyerUrl, mapFor, dateLine })` returning `{ text, mediaUrl }`; `makeBoard(events, date, { linkFor, todayUrl })` returning a string (`""` for no events); `digestEvents(events, date)`.

- [ ] **Step 1: Write failing tests in `test-ads.js`** (add `&& node test-ads.js` to the `test` script; end the file with `console.log("ad tests passed")`)

```js
const assert = require("assert");
const { formatShort, formatLong } = require("./format-event");
const { makeBoard, digestEvents } = require("./make-digest");
const wine = { status: "published", event_name: "ערב יין", date: "2026-11-07", start_time: "20:00",
  location: "לוי'ס, שמריהו לוין 10", category: "אוכל ויין", price: "60 ₪", description: "טעימות", slug: "w" };
const linkFor = () => "https://x/e/w";

// short: three lines, bold head, no category
assert.deepStrictEqual(formatShort(wine, { linkFor }).split("\n"),
  ["🍷 *20:00 · ערב יין*", "📍 לוי'ס, שמריהו לוין 10 · 🎫 60 ₪", "🔗 https://x/e/w"]);
// missing location, price and link: head only
assert.strictEqual(formatShort({ ...wine, location: "", price: "" }, {}).split("\n").length, 1);
// long: bold name, and the date line it is given
const long = formatLong(wine, { linkFor, dateLine: "*מחר!* יום שבת 7.11" }).text;
assert.ok(long.startsWith("🍷 *ערב יין* · אוכל ויין"));
assert.ok(long.includes("📅 *מחר!* יום שבת 7.11"));
// board: today only, ignores daily_days, bold title, today link third
const other = { ...wine, event_name: "מחר", date: "2026-11-08", daily_days: "2026-11-07" };
const board = makeBoard([wine, other], "2026-11-07", { linkFor, todayUrl: "https://x/today" });
const lines = board.split("\n");
assert.ok(lines[0].startsWith("*מה עושים היום בחיפה?*"));
assert.ok(lines[1].startsWith("*") && lines[1].includes("7.11"));
assert.strictEqual(lines[2], "https://x/today");
assert.ok(!board.includes("מחר"));
assert.ok(!board.includes("/m/"));
assert.strictEqual(makeBoard([], "2026-11-07", {}), "");
assert.strictEqual(digestEvents([other], "2026-11-07").length, 0);
```

- [ ] **Step 2: Run `node test-ads.js`.** Expected: FAIL on the first `deepStrictEqual`.

- [ ] **Step 3: Implement.** `formatShort` emits the three lines above, dropping empty ones. `formatLong` bolds the name and replaces `withDate` with `dateLine` (rendered as `📅 ${dateLine}`, with the time, entrance and multi-day lines unchanged). In `make-digest.js`, add `makeBoard`, remove the `daily_days` branch from `digestEvents`, and leave `makeDailyParts` and `makeDigest` until Task 3 removes their callers. Update `sendPublishedPost` and `buildSlotPosts`, which pass `withDate`: pass `dateLine: longDate(event.date)` for now.

- [ ] **Step 4: Run `npm test`.** Expected: `all tests passed`, then `ad tests passed`, after updating `test-server.js` assertions that pinned the old short layout.

- [ ] **Step 5: Commit** `format-event.js make-digest.js package.json test-ads.js test-server.js server.js` with message `Give the short and long formats their new layout and add the daily board`.

### Task 2: Ad windows and booking columns

**Files:**
- Create: `ad-windows.js`
- Modify: `events-store.js`, `test-ads.js`

**Interfaces:**
- Consumes: `local` as returned by `israelClock` (`{ date, hour, minute, day }`).
- Produces: `AD_WINDOWS`; `availableWindows(event, local)` returning `[{ date, key, label, start, end, openNow }]` in time order; `adDateLine(event, postDate, windowKey)`; `windowPhrase(window, today)`; CSV columns `ad_date`, `ad_window`, `ad_sent_at`, `confirm_asked_at`.

- [ ] **Step 1: Add failing tests to `test-ads.js`**

```js
const { availableWindows, adDateLine, windowPhrase } = require("./ad-windows");
const at = (date, hour, minute = 0) => ({ date, hour, minute, day: new Date(`${date}T12:00:00Z`).getUTCDay() });
const keys = (list) => list.map((w) => `${w.date}:${w.key}`);
const ev = (date, start_time, extra = {}) => ({ date, start_time, ...extra });

assert.deepStrictEqual(keys(availableWindows(ev("2026-11-07", "20:00"), at("2026-11-05", 14, 30))), [
  "2026-11-05:evening", "2026-11-06:morning", "2026-11-06:evening", "2026-11-07:morning", "2026-11-07:evening"]);
// the 21:01 case
assert.deepStrictEqual(availableWindows(ev("2026-11-05", "22:00"), at("2026-11-05", 21, 1)), []);
// a window opening exactly at the start time does not count; 18:30 does
assert.deepStrictEqual(keys(availableWindows(ev("2026-11-05", "18:00"), at("2026-11-05", 9))), ["2026-11-05:morning"]);
assert.strictEqual(availableWindows(ev("2026-11-05", "18:30"), at("2026-11-05", 9)).length, 2);
// open now: from the handoff until the end
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 18, 40))[0].openNow, true);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 9, 55))[0].openNow, true);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 9, 49))[0].openNow, false);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 13, 0))[0].key, "evening");
// multi-day runs to the last day; no start time means no windows
assert.ok(keys(availableWindows(ev("2026-11-05", "20:00", { end_date: "2026-11-07" }), at("2026-11-06", 12))).includes("2026-11-07:evening"));
assert.deepStrictEqual(availableWindows(ev("2026-11-07", ""), at("2026-11-05", 9)), []);

const sat = ev("2026-11-07", "20:00");
assert.strictEqual(adDateLine(ev("2026-11-05", "19:00"), "2026-11-05", "evening"), "*הערב!*");
assert.strictEqual(adDateLine(ev("2026-11-05", "19:00"), "2026-11-05", "morning"), "*הערב!*");
assert.strictEqual(adDateLine(ev("2026-11-05", "12:00"), "2026-11-05", "morning"), "*היום!*");
assert.ok(adDateLine(sat, "2026-11-06", "evening").startsWith("*מחר!* "));
assert.ok(adDateLine(sat, "2026-11-05", "evening").startsWith("*יום"));
assert.strictEqual(adDateLine(ev("2026-11-05", "20:00", { end_date: "2026-11-07" }), "2026-11-06", "evening"), "*הערב!*");

assert.strictEqual(windowPhrase({ date: "2026-11-05", key: "evening" }, "2026-11-05"), "היום בערב");
assert.strictEqual(windowPhrase({ date: "2026-11-06", key: "morning" }, "2026-11-05"), "מחר בבוקר");
assert.ok(windowPhrase({ date: "2026-11-07", key: "evening" }, "2026-11-05").endsWith("בערב"));
```

- [ ] **Step 2: Run `node test-ads.js`.** Expected: FAIL with `Cannot find module './ad-windows'`.

- [ ] **Step 3: Implement `ad-windows.js`.** Compare `"YYYY-MM-DD HH:MM"` strings. Walk days from `local.date` to `end_date || date` using `addDays`. Windows carry `sendHour`/`sendMinute` (9:50, 17:50). A window in progress for a running multi-day event is "same day" for `adDateLine` through `runsOn`. Add the four columns to `CSV_HEADERS` and to the new-row defaults at `events-store.js:225`, and document them in the header comment. `ad_window` holds `morning`, `evening` or `decline`.

- [ ] **Step 4: Run `npm test`.** Expected: both suites pass.

- [ ] **Step 5: Commit** with message `Add ad windows and the booking columns`.

### Task 3: Slots carry the board and booked ads; the weekly board goes

**Files:**
- Modify: `server.js` (`DAILY_SLOTS`, `earlierSlotToday`, `buildSlotPosts`, `sendDueBoards`, `sendSlotPost`, `flushPendingBoards`, `eventLandingPage`, routes), `make-digest.js`, `test-server.js`
- Delete: `make-weekly.js`, `send-weekly.js`, `send-digest.js`

**Interfaces:**
- Consumes: `makeBoard`, `formatLong`, `adDateLine`, `AD_WINDOWS`.
- Produces: `buildSlotPosts(events, localDate, slot, links)` returning `[]` or `[note, ...posts]`; `adPost(event, postDate, windowKey)` returning `{ text, mediaUrl, eventId, isAd: true }`; `adsDue(events, localDate, windowKey)`; `lateAds(events, local)`; `sendLateAds(now)`; `markAdSent(id)`; `todayPage(events, date)`. Task 8 uses `adPost` and `sendLateAds`.

- [ ] **Step 1: Write failing tests in `test-server.js`** (export the new functions from `server.js`; add before the final cleanup)

```js
{
  const base = { status: "published", location: "מקום", price: "20 ₪", slug: "s", contact_link: "", daily_days: "" };
  const today = { ...base, id: "1", event_name: "היום בערב", date: "2026-11-05", start_time: "20:00" };
  const early = { ...base, id: "2", event_name: "בוקר", date: "2026-11-05", start_time: "09:00" };
  const booked = { ...base, id: "3", event_name: "מודעה", date: "2026-11-07", start_time: "20:00",
    flyer: "f.jpg", ad_date: "2026-11-06", ad_window: "evening", ad_sent_at: "" };
  const morningAd = { ...booked, id: "4", ad_window: "morning" };

  // Thursday 18:00: board has today's events only, and the 10:00 ads slot is not an
  // earlier board, so the 09:00 event stays in.
  const thu = buildSlotPosts([today, early, booked], "2026-11-05", "18:00");
  if (thu.length !== 2) throw new Error("note and board only");
  if (!thu[1].text.includes("בוקר") || thu[1].text.includes("מודעה")) throw new Error("board is today only");
  // Friday 18:00: board-less day, the ad still goes, after the note
  const fri = buildSlotPosts([booked], "2026-11-06", "18:00");
  if (fri.length !== 2 || !fri[1].text.includes("*מחר!*") || fri[1].eventId !== "3") throw new Error("evening ad");
  // the ads-only slot is silent with nothing booked, and carries a morning booking
  if (buildSlotPosts([today], "2026-11-05", "10:00").length !== 0) throw new Error("empty ads slot sends nothing");
  if (buildSlotPosts([morningAd], "2026-11-06", "10:00").length !== 2) throw new Error("morning ad");
  // sent once; a declined booking never goes
  if (buildSlotPosts([{ ...booked, ad_sent_at: "x" }], "2026-11-06", "18:00").length !== 1) throw new Error("ad resent");
  // quiet day: the note alone
  const quiet = buildSlotPosts([], "2026-11-05", "18:00");
  if (quiet.length !== 1 || !quiet[0].text.includes("אין")) throw new Error("quiet note");
  // Saturday 18:00 still drops what 12:00 covered
  const satEarly = { ...early, date: "2026-11-07", start_time: "11:00" };
  if (buildSlotPosts([satEarly], "2026-11-07", "18:00").length !== 1) throw new Error("covered by 12:00");
  // late ads: unsent after handoff and before the event; not before handoff, not after start
  const local = (date, hour) => ({ date, hour, minute: 0, day: 5 });
  if (lateAds([morningAd], local("2026-11-06", 11)).length !== 1) throw new Error("late ad found");
  if (lateAds([morningAd], local("2026-11-06", 9)).length !== 0) throw new Error("before handoff");
  if (lateAds([{ ...morningAd, date: "2026-11-06", start_time: "10:30" }], local("2026-11-06", 11)).length !== 0) throw new Error("event started");
  if (lateAds([{ ...morningAd, ad_window: "decline" }], local("2026-11-06", 11)).length !== 0) throw new Error("declined");
  // pages
  const page = todayPage([today], "2026-11-05");
  if (!page.includes('property="og:title"') || !page.includes("היום בערב")) throw new Error("today page");
  if (!eventLandingPage(today).includes('property="og:title"')) throw new Error("event page tags");
}
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL, `buildSlotPosts` returns the old posts.

- [ ] **Step 3: Implement.**
  - Add `{ slot: "10:00", sendHour: 9, sendMinute: 50, days: [0,1,2,3,4,5,6], adsOnly: true }` to `DAILY_SLOTS`. `earlierSlotToday` ignores `adsOnly` entries. This matters: otherwise every 18:00 board treats 10:00 as an earlier board and drops morning events.
  - `buildSlotPosts`: `10:00` carries morning ads only and returns `[]` when there are none. `12:00` carries the board. `18:00` carries the board, then evening ads. Rewrite the note for these two post kinds, and with no posts say there are no events today. Build the board from `fresh` events with `todayUrl` = `${PUBLIC_BASE_URL}/today`. Drop the `flyered`, `promoted` and `board` posts, `SLOT_POST_LABELS.promoted`, `SLOT_POST_LABELS.board` and `MAX_SLOT_FLYERS`.
  - `sendDueBoards` skips sending when `posts` is empty, and calls `sendLateAds(now)` after its loop. `sendLateAds` uses the same `pendingBoards` and `confirmBoardDelivery` path under key `${date}:${HH:MM}`, because `sendSlotReadyPing` reads the slot with `key.slice(11)`. Add a note saying the ad is late. Wire it into the same interval.
  - Split a board longer than 1600 characters between events into several posts; `sendWhatsApp`'s `splitBody` cuts by length only.
  - `sendSlotPost`: posts with `isAd` call `markAdSent(eventId)` after either send path; `markFlyerSent` goes. In `flushPendingBoards`, when a past-day key is dropped, clear `ad_sent_at` on its ad posts so `lateAds` can retry while the event is still ahead.
  - `/today` serves `todayPage`. Add `og:title`, `og:description` and `og:image` to it and to `eventLandingPage`, with the flyer as image on `/e/`. Serve `assets/og-card.png` at `/og-card.png`. Include the image tag on `/today` only if that file exists.
  - Remove `/weekly`, `/digest`, `makeWeekly`, `makeDailyParts`, `makeDigest`, `digestFlyerEvents`, and the three deleted scripts.

- [ ] **Step 4: Run `npm test`.** Expected: both suites pass, after removing assertions about the weekly board, the promoted section and flyer posts in slots.

- [ ] **Step 5: Commit** with message `Send the daily board and booked ads at the slots; remove the weekly board`.

### Task 4: View counts only above 10

**Files:**
- Modify: `server.js` (`goodbyeMessage`), `test-server.js`

- [ ] **Step 1: Update the `goodbyeMessage` tests** so a single event with 10 views shows no count and 11 shows it; for several events, one with 3 views shows no count, one with 12 does, and the total line appears only when the total is above 10. Seed views the way the existing goodbye tests do.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL on the 10-view case.

- [ ] **Step 3: Add `const MIN_VIEWS_TO_MENTION = 10;`** and change the three `> 0` checks to `> MIN_VIEWS_TO_MENTION`. Update the comment: a small number reads as a failure, not just zero.

- [ ] **Step 4: Run `npm test`.** Expected: PASS.

- [ ] **Step 5: Commit** with message `Mention view counts only above 10`.

### Task 5: One correction path

**Files:**
- Modify: `extract-event.js`, `server.js`, `test-server.js`

**Interfaces:**
- Produces: `extractCorrection(event, text, todayIso)` returning an object holding only the `FIELD_KEYS` the text changes; `applyCorrection(id, text, { byAdmin = false })` returning `{ changed: string[], event }`, where `changed` holds field names; `sendToSubmitter(sender, text, mediaUrl = "")`; exported `outbox` array.

- [ ] **Step 1: Write failing tests.** Stub `extractEventModule.extractCorrection` next to the other stubs, driven by a `CORRECTION_STUB` map from text to changes.

```js
{
  const { id } = eventsStore.appendEvent(TEST_EVENTS_FILE, { event_name: "תיקון", date: "2099-01-01", start_time: "20:00", location: "מקום", price: "60", submitter: "whatsapp:+972500017001" });
  CORRECTION_STUB.set("המחיר 50", { price: "50" });
  const fixed = await applyCorrection(id, "המחיר 50");
  if (fixed.changed.join() !== "price" || fixed.event.price !== "50") throw new Error("correction applied");
  // an invalid value is dropped, and unknown text changes nothing
  CORRECTION_STUB.set("תאריך גרוע", { date: "not-a-date" });
  if ((await applyCorrection(id, "תאריך גרוע")).changed.length) throw new Error("invalid value dropped");
  if ((await applyCorrection(id, "שלום")).changed.length) throw new Error("nothing to change");
  // Stav's corrections teach the extractor; the organizer's don't
  const before = loadCorrections().length;
  CORRECTION_STUB.set("מחיר 70", { price: "70" });
  await applyCorrection(id, "מחיר 70", { byAdmin: true });
  if (loadCorrections().length !== before + 1) throw new Error("admin correction recorded");
}
```

Use the helper the suite already uses to read corrections, and the real `appendEvent` signature from `events-store.js`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL, `applyCorrection` is not defined.

- [ ] **Step 3: Implement.**
  - `extractCorrection` in `extract-event.js`: one model call, reusing the field rules from `buildPrompt` (move them to a shared constant) and asking for JSON with only the changed fields. Include the user-text-is-data warning. Return `{}` on a model or parse failure, so a bad call reads as "didn't understand".
  - `applyCorrection` in `server.js`: call it as `extractEventModule.extractCorrection`, so the stub applies. Filter with `fieldIsValid`, keep real changes only, write with `storeUpdateEvent`, and call `addCorrection` per field when `byAdmin`.
  - `sendToSubmitter`: in tests push `{ to, text, mediaUrl }` to `outbox`; otherwise `sendWhatsApp` with the same catch as `notifySubmitter`. Make `notifySubmitter` call it. In tests, `forwardEventToAdmin` pushes `{ to: ADMIN_SENDER, text: formatEventForReview(...) }` to `outbox` before returning.

- [ ] **Step 4: Run `npm test`.** Expected: PASS.

- [ ] **Step 5: Commit** with message `Apply corrections to the event through one function`.

### Task 6: The organizer confirms before Stav sees it

**Files:**
- Modify: `server.js` (`handleActiveSubmission`, `routeMessageInner`, `clearSession`, `hasSessionState`, state load/save, `expirePastEvents`, `CANCELLABLE_STATUSES`, `findDuplicateEvent`, `formatPendingList`, `senderFlow`), `test-server.js`

**Interfaces:**
- Consumes: `applyCorrection`, `sendToSubmitter`, `outbox`, `replaceFlyer`, `forwardEventToAdmin`.
- Produces: status `awaiting_confirm`; persisted `awaitingConfirmation` Map (sender to `{ eventId }`); `previewMessages(event)` returning `[{ text, mediaUrl }, { text, mediaUrl }]`, short then ad, which Task 7 also uses for Stav; `sendDueConfirmReminders(now)`.

Exact copy:

```js
const RECEIVED_TEXT = "קיבלנו את האירוע! 🎉\n\nככה הוא ייראה בקבוצה, בשתי גרסאות 👇";
const CONFIRM_PROMPT_TEXT = "הכול נכון?\n1. כן, שלחו לבדיקה\n\nמשהו לא נכון? פשוט כתבו כאן מה לשנות ✏️";
const CONFIRMED_TEXT = "מעולה! האירוע עבר לבדיקה של סתיו. נעדכן אתכם כשיאושר 🙌";
const CORRECTION_UNCLEAR_TEXT = "לא הצלחנו להבין מה לשנות. כתבו למשל: \"המחיר הוא 50\".";
const confirmReminderText = (name) => `תזכורת: האירוע "${name}" עדיין מחכה לאישור שלכם.\nענו 1 כדי לשלוח אותו לבדיקה, או כתבו מה לשנות.`;
const CONFIRM_RE = /^(1|כן|אישור|מאשר|מאשרת|מאושר|אשר|נכון)[\s!.]*$/;
```

- [ ] **Step 1: Write failing tests**

```js
{
  const sender = "whatsapp:+972500017101";
  const submit = () => routeMessage(sender, "שם האירוע: אישור\nתאריך: 2099-02-01\nשעה: 20:00\nמיקום: בר בזל, מסדה 12, חיפה\nקטגוריה: מסיבה\nקישור: https://x.co");
  const find = () => loadEvents(TEST_EVENTS_FILE).filter((e) => e.submitter === sender).pop();
  const toAdmin = () => outbox.filter((m) => m.to === ADMIN);

  outbox.length = 0;
  startSubmissionForTest(sender);
  const reply = await submit();
  if (!reply.includes("1. כן")) throw new Error("the reply is the confirm prompt");
  if (outbox.filter((m) => m.to === sender).length !== 3) throw new Error("received text and two previews");
  if (find().status !== "awaiting_confirm" || toAdmin().length) throw new Error("Stav must not see it yet");

  // a correction refreshes the previews and asks again; nothing reaches Stav
  CORRECTION_STUB.set("השעה 21:00", { start_time: "21:00" });
  outbox.length = 0;
  if (!(await routeMessage(sender, "השעה 21:00")).includes("1. כן")) throw new Error("asks again");
  if (find().start_time !== "21:00" || toAdmin().length) throw new Error("applied, Stav not told");
  // text that changes nothing says so
  if (!(await routeMessage(sender, "שלום")).includes("לא הצלחנו להבין")) throw new Error("unclear");

  // idle for six hours: still answers the prompt, not the menu
  lastActivity.set(sender, Date.now() - 6 * 60 * 60 * 1000);
  const done = await routeMessage(sender, "1");
  if (!done.includes("עבר לבדיקה") || find().status !== "submitted") throw new Error("confirmed after idle");
  if (toAdmin().length !== 1) throw new Error("Stav gets it once");

  // ביטול cancels instead of stranding it; תפריט only closes the question
  startSubmissionForTest(sender);
  await routeMessage(sender, "שם האירוע: שני\nתאריך: 2099-02-02\nשעה: 20:00\nמיקום: בר בזל, מסדה 12, חיפה\nקטגוריה: מסיבה\nקישור: https://x.co");
  await routeMessage(sender, "ביטול");
  if (find().status !== "cancelled" || awaitingConfirmation.has(sender)) throw new Error("cancelled");

  // customer-mode replies are real text
  adminMode.set(ADMIN, "customer");
  startSubmissionForTest(ADMIN);
  const customer = await routeMessage(ADMIN, "שם האירוע: בדיקה\nתאריך: 2099-02-03\nשעה: 20:00\nמיקום: בר בזל, מסדה 12, חיפה\nקטגוריה: מסיבה\nקישור: https://x.co");
  if (String(customer).includes("null") || !customer.includes("1. כן")) throw new Error("banner and text");
  adminMode.delete(ADMIN);
  awaitingConfirmation.delete(ADMIN);

  // reminder: once, after three hours
  const waiting = eventsStore.appendEvent(TEST_EVENTS_FILE, { event_name: "ישן", date: "2099-03-01", start_time: "20:00", status: "awaiting_confirm", submitter: "whatsapp:+972500017102" }).id;
  eventsStore.updateEvent(TEST_EVENTS_FILE, waiting, { status: "awaiting_confirm", confirm_asked_at: new Date(Date.now() - 4 * 3600e3).toISOString() });
  outbox.length = 0;
  await sendDueConfirmReminders();
  await sendDueConfirmReminders();
  if (outbox.filter((m) => m.text.includes("תזכורת")).length !== 1) throw new Error("one reminder");
}
```

`startSubmissionForTest` is whatever the existing submission tests use to enter the flow; use the suite's own helper and the store's real function names.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL at the confirm prompt assertion.

- [ ] **Step 3: Implement.**
  - On a complete draft: `appendEvent`, set status `awaiting_confirm` and `confirm_asked_at`, persist the flyer, set `awaitingConfirmation`, await `sendToSubmitter` for `RECEIVED_TEXT` and both previews, and return `CONFIRM_PROMPT_TEXT`.
  - **Deviation from the spec:** the prompt goes as the normal webhook reply, not `EMPTY_TWIML`. Returning `null` from `routeMessage` prints `null` under the customer-mode banner, and the reply stays testable. Previews are awaited first, so the order holds.
  - The incomplete path that hands a draft to Stav with `unresolvedMissing` is unchanged, because the organizer already failed to complete it.
  - `previewMessages`: short from `formatShort` under a bold label, ad from `formatLong` with `dateLine: *longDate*`, `mapFor: mapLink` and the flyer, under a bold label. Labels come from the mockup.
  - Routing, placed before the old publish-choice branches: an image with no text, or with text that isn't `looksLikeEventAnnouncement`, replaces the flyer and re-shows the previews; an image with an announcement starts a new submission and leaves the first event on the pending list; `CONFIRM_RE` sets `submitted`, closes the question, adds `recentlyCompleted`, calls `forwardEventToAdmin`, and returns `CONFIRMED_TEXT`; other text goes to `applyCorrection`.
  - `clearSession` must not touch `awaitingConfirmation`, and it stays out of `hasSessionState`. Otherwise the 5-hour sweep sends a late `1` to the inquiry menu. In the `CANCEL_KEYWORDS`/`MENU_KEYWORDS` branch: `ביטול` also sets the event `cancelled`; both close the question.
  - Add `awaiting_confirm` to `expirePastEvents`, `CANCELLABLE_STATUSES` and `findDuplicateEvent`. `formatPendingList` lists these under their own heading. Keep it out of `AWAITING_REVIEW` and the missed-notice banner. `expirePastEvents` also removes the map entry.
  - `sendDueConfirmReminders`: every `awaiting_confirm` event asked over 3 hours ago, without the note `נשלחה תזכורת אישור`, gets the note, then the reminder. It sets `awaitingConfirmation` if the sender has no open entry. Runs on `BOARD_CHECK_INTERVAL_MS`.

- [ ] **Step 4: Run `npm test`.** Expected: PASS, after updating submission tests that expected the old receipt.

- [ ] **Step 5: Commit** with message `Have the organizer confirm both versions before Stav reviews`.

### Task 7: Stav's review notice and `ערוך`

**Files:**
- Modify: `server.js` (`formatEventForReview`, `handleAdminMessage`, `ADMIN_ONLY_COMMAND_RE`, `ADMIN_HELP_TEXT`, the `recentlyCompleted` branch), `test-server.js`

**Interfaces:**
- Consumes: `applyCorrection`, `resolveEventId`, `previewMessages`.
- Produces: persisted `awaitingAdminEdit` (string event id, `""` when closed).

Exact copy: ask `` `מה לשנות באירוע #${id}? כתבו במילים שלכם.` ``. After an edit: `` `עודכן ✏️ #${id}. ככה זה נראה עכשיו:` `` and the two previews and `` `לאישור: אשר ${id}` ``. Notice lines: `— לוח יומי (מקוצר) —`, `— מודעה גרפית (מורחבת, עם הפלייר) —`, `` `לעריכה: ערוך ${id}` ``.

- [ ] **Step 1: Write failing tests**

```js
{
  const { id } = eventsStore.appendEvent(TEST_EVENTS_FILE, { event_name: "עריכה", date: "2099-04-01", start_time: "20:00", location: "מקום", submitter: "whatsapp:+972500017201" });
  eventsStore.updateEvent(TEST_EVENTS_FILE, id, { status: "submitted" });
  const notice = formatEventForReview(id, eventsStore.findEvent(TEST_EVENTS_FILE, id), "x");
  if (notice.includes("שבועי") || !notice.includes("לוח יומי") || !notice.includes(`ערוך ${id}`)) throw new Error("notice labels");

  if (!(await routeMessage(ADMIN, `ערוך ${id}`)).includes("מה לשנות")) throw new Error("asks what to change");
  CORRECTION_STUB.set("תיאור חדש", { description: "תיאור חדש" });
  const edited = await routeMessage(ADMIN, "תיאור חדש");
  if (!edited.includes("עודכן") || !edited.includes(`אשר ${id}`)) throw new Error("shows the result");
  if (eventsStore.findEvent(TEST_EVENTS_FILE, id).description !== "תיאור חדש") throw new Error("saved");

  // a real command outranks an open edit, and תקן still works
  await routeMessage(ADMIN, `ערוך ${id}`);
  await routeMessage(ADMIN, "ממתינים");
  if (eventsStore.findEvent(TEST_EVENTS_FILE, id).description !== "תיאור חדש") throw new Error("command is not an edit");
  await routeMessage(ADMIN, `תקן ${id} מחיר: 30`);
  if (eventsStore.findEvent(TEST_EVENTS_FILE, id).price !== "30") throw new Error("תקן works");

  // customer mode still reaches ערוך
  adminMode.set(ADMIN, "customer");
  if (!(await routeMessage(ADMIN, `ערוך ${id}`)).includes("מה לשנות")) throw new Error("admin-only command");
  await routeMessage(ADMIN, "ביטול");
  adminMode.delete(ADMIN);

  // an organizer correction during review updates the event and Stav's notice
  const sender = "whatsapp:+972500017201";
  recentlyCompleted.add(sender);
  lastSubmittedEventIdForTest(sender, id);
  CORRECTION_STUB.set("המחיר 40", { price: "40" });
  outbox.length = 0;
  await routeMessage(sender, "המחיר 40");
  if (eventsStore.findEvent(TEST_EVENTS_FILE, id).price !== "40") throw new Error("applied during review");
  if (!outbox.some((m) => m.to === ADMIN && m.text.includes("40"))) throw new Error("Stav sees the update");
}
```

Export `lastSubmittedEventId` for the test if it isn't already, and replace `lastSubmittedEventIdForTest` with a direct `.set`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL on the notice labels.

- [ ] **Step 3: Implement.** Rewrite the notice with the labels above, using the same two renderings as `previewMessages`. Parse `ערוך` with an optional id through `resolveEventId`, so a reply to the notice or a tap works, and add it to `ADMIN_ONLY_COMMAND_RE` and `ADMIN_HELP_TEXT`. In `handleAdminMessage`, any recognised command closes an open edit; otherwise, with `awaitingAdminEdit` set, the text goes to `applyCorrection(id, text, { byAdmin: true })`. `ביטול` closes it; since the keyword branch runs after the admin branch, handle it inside `handleAdminMessage`. In customer mode, an open edit routes her next message to `handleAdminMessage`.

  In the `recentlyCompleted` branch, when the last event is `submitted`: `applyCorrection`, then `forwardEventToAdmin`, re-add `recentlyCompleted` so a second correction works, and reply with the changed fields. If nothing changed, forward the text with `forwardAmendmentToAdmin` as today.

- [ ] **Step 4: Run `npm test`.** Expected: PASS.

- [ ] **Step 5: Commit** with message `Let Stav edit in her own words and keep her notice current`.

### Task 8: Ad offer and booking; the publish-day question goes

**Files:**
- Modify: `server.js` (`notifyApproved`, `handleAdminMessage` approve branch, routing, `senderFlow`, `buttonReplyFor`, state load/save), `send-interactive.js`, `test-server.js`

**Interfaces:**
- Consumes: `availableWindows`, `windowPhrase`, `adPost`, `sendLateAds`, `sendToSubmitter`, `windowIsOpen`, `lastActivity`, `applyCorrection`.
- Produces: persisted `awaitingAdChoice` Map (sender to `{ eventId, step, askedAt, options }`, `step` being `offer`, `pick`, `date`, `window` or `flyer`); persisted `pendingAdOffers` Set of event ids; `offerFor(event, local)` returning `{ approvalText, offerText, options }`, with `offerText` empty when no window passes.

Exact copy:

```js
const AD_OFFER_TTL_MS = 48 * 60 * 60 * 1000;
const NO_AD_WINDOW_TEXT = (start, next) => `האירוע מתחיל ב-${start}, והחלון הבא למודעות הוא ${next}, אז הפעם לא נוכל לפרסם עליו מודעה 🙏\n\nבפעם הבאה שלחו לפחות יום מראש, ונוכל לפרסם גם מודעה.`;
const NO_AD_TEXT = (date) => `אין בעיה. האירוע יופיע בלוח היומי של ${date}.`;
const ASK_FLYER_TEXT = "כדי לפרסם מודעה גרפית צריך פלייר. שלחו אותו כאן כתמונה.";
const WINDOW_PASSED_TEXT = "החלון הזה כבר עבר. אלה האפשרויות שנשארו:";
const AMENDMENT_AFTER_APPROVAL_TEXT = "העברנו את הבקשה לסתיו, היא תעדכן את האירוע.";
```

The offer, the window list and the booking confirmation come from mockup step 4, and the approval text names the daily board's date and slot.

- [ ] **Step 1: Write failing tests**

```js
{
  const sender = "whatsapp:+972500017301";
  const clock = { date: "2026-11-05", hour: 14, minute: 30, day: 4 };
  const event = { id: "9", event_name: "יין", date: "2026-11-07", start_time: "20:00", flyer: "f.jpg" };

  const offer = offerFor(event, clock);
  if (!offer.offerText.includes("היום בערב") || !offer.offerText.includes("18:00")) throw new Error("names the real time");
  if (offer.offerText.includes("שבועי")) throw new Error("no weekly board");
  if (!offer.approvalText.includes("12:00")) throw new Error("names the board slot");
  // the 21:01 case: no offer, and the reason
  const late = offerFor({ ...event, date: "2026-11-05", start_time: "22:00" }, { ...clock, hour: 21, minute: 1 });
  if (late.offerText || !late.approvalText.includes("10:00")) throw new Error("no window");

  const seed = async (fields = {}) => {
    const { id } = eventsStore.appendEvent(TEST_EVENTS_FILE, { event_name: "יין", date: "2099-05-10", start_time: "20:00", location: "מקום", flyer: "f.jpg", submitter: sender, ...fields });
    eventsStore.updateEvent(TEST_EVENTS_FILE, id, { status: "submitted", ...fields });
    outbox.length = 0;
    await routeMessage(ADMIN, `אשר ${id}`);
    return id;
  };
  const row = (id) => eventsStore.findEvent(TEST_EVENTS_FILE, id);

  // two separate messages, nothing posted to Stav at approval
  lastActivity.set(sender, Date.now());
  let id = await seed();
  if (outbox.filter((m) => m.to === sender).length !== 2) throw new Error("approval then offer");
  if (outbox.some((m) => m.to === ADMIN && m.mediaUrl)) throw new Error("no flyer post at approval");

  // "1" books the first window
  const yes = await routeMessage(sender, "1");
  if (!yes.includes("סגור") || !row(id).ad_date || !row(id).ad_window) throw new Error("booked");
  if (awaitingAdChoice.has(sender)) throw new Error("closed");

  // "3" declines
  id = await seed();
  await routeMessage(sender, "3");
  if (row(id).ad_window !== "decline") throw new Error("declined");

  // "2" lists windows; a pick books that one
  id = await seed();
  const list = await routeMessage(sender, "2");
  if (!list.includes("1.") || !list.includes("תאריך אחר")) throw new Error("window list, with more available");
  await routeMessage(sender, "2");
  if (!row(id).ad_window) throw new Error("picked");

  // a window that passed while they waited is not booked
  id = await seed({ date: "2099-05-10" });
  await routeMessage(sender, "2");
  const open = awaitingAdChoice.get(sender);
  open.options[0] = { ...open.options[0], date: "2020-01-01" };
  const stale = await routeMessage(sender, "1");
  if (!stale.includes("כבר עבר") || row(id).ad_window) throw new Error("stale window");
  awaitingAdChoice.delete(sender);

  // a correction during the question reaches Stav, and the question is repeated
  id = await seed();
  outbox.length = 0;
  const fix = await routeMessage(sender, "אפשר לשנות את השעה ל-20:30?");
  if (!fix.includes("העברנו") || !fix.includes("1.")) throw new Error("forwarded, then repeated");
  if (row(id).start_time !== "20:00") throw new Error("nothing changes automatically");
  awaitingAdChoice.delete(sender);

  // no flyer: asks for one, and the image completes the booking
  id = await seed({ flyer: "" });
  if (!(await routeMessage(sender, "1")).includes("פלייר")) throw new Error("asks for a flyer");
  awaitingAdChoice.delete(sender);

  // an old offer no longer captures a digit
  id = await seed();
  awaitingAdChoice.get(sender).askedAt = Date.now() - 49 * 3600e3;
  await routeMessage(sender, "1");
  if (row(id).ad_window) throw new Error("expired offer");

  // closed window, no template: held, then attached to their next reply
  lastActivity.set(sender, Date.now() - 25 * 3600e3);
  id = await seed();
  if (outbox.some((m) => m.to === sender) || !pendingAdOffers.has(id)) throw new Error("held");
  const next = await routeMessage(sender, "תפריט");
  if (!next.includes("מודעה גרפית") || pendingAdOffers.has(id)) throw new Error("delivered on next message");
  awaitingAdChoice.delete(sender);
}
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL, `offerFor` is not defined.

- [ ] **Step 3: Implement.**
  - `offerFor`: daily board slot from the first of the event day's board slots, skipping `adsOnly`. The window list shows up to six windows, then `תאריך אחר` when more exist; that option asks for a date with `parseUserDate`, then morning or evening.
  - `notifyApproved`: decide the delivery. Open window: `sendToSubmitter` the approval, then `sendChoice` with the offer. Closed window with `fomo_ad_offer` approved: `sendChoice` with `template: "fomo_ad_offer"`, `variables: { 1: name, 2: phrase }`. Closed window without a template: add to `pendingAdOffers`. In tests the send goes to `outbox`.
  - Approve branch in `handleAdminMessage`: remove both `sendPublishedPost` flyer paths. An event on today's date after its last board slot goes to Stav at once in short form; otherwise reply `אירוע #N אושר.`
  - Answer handling: recompute `availableWindows` before booking. If the pick is gone, reply `WINDOW_PASSED_TEXT` with fresh options. On a booking, write `ad_date` and `ad_window`, confirm with the mockup copy, and call `sendLateAds()`, which delivers an ad whose handoff already passed. With no flyer, set `step: "flyer"` and ask; an image on that step goes through `replaceFlyer` and completes the booking.
  - Text that is no option and no date: `forwardAmendmentToAdmin`, then `AMENDMENT_AFTER_APPROVAL_TEXT` and the question again. This replaces the re-show in `handleDayChoice`.
  - An offer older than `AD_OFFER_TTL_MS` is dropped on arrival and the message is routed normally. `awaitingAdChoice` stays out of `clearSession` and `hasSessionState`, as in Task 6. The keyword branch closes it.
  - In `routeMessage`, after the reply is built and the sender has no draft or open question, an event in `pendingAdOffers` appends its approval and offer to the reply and opens the question.
  - Remove `awaitingPublishChoice`, `awaitingDailyChoice`, `publishDayOptions`, `publishChoicePrompt`, `publishChoiceText`, `PUBLISH_CHOICE_INTRO`, `recordDailyDays`, `recordDailyDay`, `pickDayOptions`, `handleDayChoice`, `NO_DAILY_TEXT`, `formatSubmissionReceipt`, `PUBLISH_DAY_TEMPLATE`, `sendPublishedPost` if unused, and their exports and state entries. `loadState` ignores the old keys. Check `buttonReplyFor` for a branch that keyed on the old prompt. Add `["fomo_ad_offer", ["1", "2", "3"]]` to `send-interactive.js:119` and remove the two publish-day rows.

- [ ] **Step 4: Run `npm test`.** Expected: PASS, after deleting tests of the removed question.

- [ ] **Step 5: Commit** with message `Offer the graphic ad after approval and book it into a window`.

### Task 9: Template and documentation

**Files:**
- Create: `submit-ad-offer-template.js`
- Modify: `README.md`, `product.md`, `conversation-flow.md`, `NEXT.md`, `reminder-template.md`, `nudge-variants.js` (only if its copy promises something removed)

- [ ] **Step 1: Write `submit-ad-offer-template.js`** modelled on `submit-slot-ready-template.js`: friendly name `fomo_ad_offer`, body with `{{1}}` (event name) and `{{2}}` (the as-soon-as-possible time), three buttons with ids `1`, `2`, `3`, wording from the mockup's offer. Do not run it; it submits to Meta.

- [ ] **Step 2: Verify the script parses.** Run `node --check submit-ad-offer-template.js`. Expected: no output.

- [ ] **Step 3: Update the docs.** Rewrite `conversation-flow.md` for the new flow. Remove weekly board, `/weekly`, `/digest` and publish-day references from the others.

- [ ] **Step 4: Verify nothing is left.** Run `git grep -n "לוח השבועי\|לוח שבועי\|makeWeekly\|daily_days\|fomo_publish_day" -- ":!docs/superpowers"`. Expected: only the `daily_days` column in `events-store.js` and its comment. Run `npm test` and `node check-encoding.js`. Expected: pass.

- [ ] **Step 5: Commit** with message `Add the ad offer template script and update the docs`.
