const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest, digestFlyerEvents } = require("./make-digest");
const { israelClock, todayIso, addDays, shortDate, isReminderDue, isReminderMissed } = require("./clock");
const { isFreeEntry, formatShort, formatLong } = require("./format-event");
const { makeWeekly } = require("./make-weekly");
const { appendEvent: storeAppendEvent, updateEvent: storeUpdateEvent, findEvent: storeFindEvent } = require("./events-store");
const extractEventModule = require("./extract-event");
const { addCorrection, buildCorrectionGuidance } = require("./corrections-store");
const answerInquiryModule = require("./answer-inquiry");
const { sendWhatsApp, getMessageStatus } = require("./send-whatsapp");
const { fetchMediaAsDataUrl } = require("./fetch-media");
const { saveFlyer, flyerPath, contentTypeFor, deleteFlyer } = require("./flyer-store");
const { logClick, logInteraction, clickStats, pruneOlderThan } = require("./clicks-store");
const { sendChoice, renderNumbered, approvedTemplateSid, ensureTemplates } = require("./send-interactive");
const remindersStore = require("./reminders-store");
const { deliverReminder, REMINDER_TEMPLATE } = require("./send-reminder");

const PORT = Number(process.env.PORT || 3000);
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "+972528762432";
const ADMIN_SENDER = `whatsapp:${ADMIN_PHONE}`;
// Colocated with EVENTS_FILE (not just its dirname) so state always lands next to the
// data it references, even when EVENTS_FILE is a bare relative filename like "events.csv".
const STATE_FILE = process.env.STATE_FILE || path.join(path.dirname(path.resolve(EVENTS_FILE)), "state.json");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

let activeSubmissions = new Map(); // sender -> array of message texts collected while drafting an event
let activeSubmissionImages = new Map(); // sender -> array of image data URLs collected while drafting an event
const imagesSentToModel = new Map(); // sender -> count of images already sent to the LLM, to avoid resending unchanged images every turn
const lastExtractedEvent = new Map(); // sender -> last extracted event fields, carried forward as context when images aren't resent
let activeInquiries = new Set(); // senders currently in the "ask about events" flow
let activeInquiryHistories = new Map(); // sender -> [{ role, content }] conversation so far in inquiry mode
let recentlyCompleted = new Set(); // senders whose last action was a completed submission, for a softer follow-up
let lastSubmittedEventId = new Map(); // sender -> id of their most recent submission, so a follow-up correction can be attached to it
// Both survive a restart on purpose: the gap between asking which day to publish and
// getting an answer is hours, and Fly suspends this machine in between.
let awaitingPublishChoice = new Map(); // sender -> { eventId, options, expectingDate }
let awaitingDailyChoice = new Map(); // sender -> { eventId, options, expectingDate }, asked after approval
let undeliveredAdminNotices = new Set(); // event ids whose review notice never reached the admin, surfaced on her next message
let askedForClarification = new Set(); // senders already asked a clarifying question this submission, so we never ask twice
let incompleteAttempts = new Map(); // sender -> consecutive turns still missing required fields, so a draft can't loop forever
let noticeSidToEventId = new Map(); // Twilio message sid of a review notice -> event id, so a WhatsApp reply to it resolves without a number
// The admin's phone is also her QA/testing phone, so her role can't be inferred from the
// message text: "2" is both a menu choice and (previously) a reject command. She declares
// which hat she's wearing instead. Anyone who isn't the admin is always a customer.
let adminMode = new Map(); // ADMIN_SENDER -> "admin" | "customer"
let lastActivity = new Map(); // sender -> ms timestamp of last inbound message, for idle expiry
// sender -> { eventId, eventName, at } of the reminder they were last sent. Persisted
// like everything else here: the reply comes minutes to hours later, and Fly suspends
// this machine in between, so an in-memory note would be gone before it is read.
let recentlyReminded = new Map();
const llmCallTimestamps = new Map(); // sender -> array of ms timestamps of recent LLM calls
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// activeSubmissionImages is intentionally NOT persisted: images are base64 data URLs that
// can run into megabytes each, and writing them to disk on nearly every message would block
// the event loop for the whole process. A restart mid-submission loses attached images (the
// user is asked to resend them) but keeps the text draft intact.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    activeSubmissions = new Map(raw.activeSubmissions || []);
    activeInquiries = new Set(raw.activeInquiries || []);
    activeInquiryHistories = new Map(raw.activeInquiryHistories || []);
    recentlyCompleted = new Set(raw.recentlyCompleted || []);
    lastSubmittedEventId = new Map(raw.lastSubmittedEventId || []);
    awaitingPublishChoice = new Map(raw.awaitingPublishChoice || []);
    awaitingDailyChoice = new Map(raw.awaitingDailyChoice || []);
    sentBoards = new Set(raw.sentBoards || []);
    sentReminders = new Set(raw.sentReminders || []);
    lastButtonEventId = raw.lastButtonEventId || "";
    pendingBoards = new Map(raw.pendingBoards || []);
    undeliveredAdminNotices = new Set(raw.undeliveredAdminNotices || []);
    askedForClarification = new Set(raw.askedForClarification || []);
    incompleteAttempts = new Map(raw.incompleteAttempts || []);
    noticeSidToEventId = new Map(raw.noticeSidToEventId || []);
    adminMode = new Map(raw.adminMode || []);
    lastActivity = new Map(raw.lastActivity || []);
    recentlyReminded = new Map(raw.recentlyReminded || []);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("failed to load state:", err);
  }
}

const STATE_SAVE_DEBOUNCE_MS = 1000;
let saveStateTimer = null;
let saveStatePending = false;

function writeStateNow() {
  const payload = {
    activeSubmissions: [...activeSubmissions.entries()],
    activeInquiries: [...activeInquiries],
    activeInquiryHistories: [...activeInquiryHistories.entries()],
    recentlyCompleted: [...recentlyCompleted],
    // Bounded like noticeSidToEventId: only a recent submission can still be amended,
    // and this map is never cleared per-sender (clearSession deliberately keeps it).
    lastSubmittedEventId: [...lastSubmittedEventId.entries()].slice(-50),
    awaitingPublishChoice: [...awaitingPublishChoice.entries()].slice(-50),
    awaitingDailyChoice: [...awaitingDailyChoice.entries()].slice(-50),
    // Only the last few send-windows matter; older keys can never fire again.
    sentBoards: [...sentBoards].slice(-20),
    sentReminders: [...sentReminders].slice(-14),
    lastButtonEventId,
    pendingBoards: [...pendingBoards.entries()].slice(-10),
    undeliveredAdminNotices: [...undeliveredAdminNotices],
    askedForClarification: [...askedForClarification],
    incompleteAttempts: [...incompleteAttempts.entries()],
    // Bounded: only recent notices need to stay resolvable by reply.
    noticeSidToEventId: [...noticeSidToEventId].slice(-50),
    adminMode: [...adminMode.entries()],
    lastActivity: [...lastActivity.entries()],
    // Bounded: only a recent reminder can still be replied to.
    recentlyReminded: [...recentlyReminded.entries()].slice(-50),
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (err) {
    console.error("failed to save state:", err);
  }
}

function saveState() {
  if (process.env.NODE_ENV === "test") {
    // Keep test runs synchronous and deterministic; no debounce.
    writeStateNow();
    return;
  }

  saveStatePending = true;
  if (saveStateTimer) return;

  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    if (saveStatePending) {
      saveStatePending = false;
      writeStateNow();
    }
  }, STATE_SAVE_DEBOUNCE_MS);
  saveStateTimer.unref();
}

const MAX_MESSAGE_LENGTH = 1000;
const MAX_IMAGES_PER_EVENT = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CALLS = 5;

const MESSAGE_TOO_LONG_TEXT = "ההודעה ארוכה מדי. נסו לשלוח תיאור קצר יותר של האירוע.";
const RATE_LIMITED_TEXT = "שלחתם הרבה הודעות ברצף. חכו דקה ונסו שוב.";
const MEDIA_FETCH_FAILED_TEXT = "לא הצלחנו לקרוא את התמונה ששלחתם. נסו לשלוח אותה שוב, או המשיכו עם טקסט בלבד.";

const MAX_INQUIRY_EVENTS = 50;
// Raised from 12 alongside the clarify-first change: asking before answering spends two
// turns on what used to take one, so 12 was six exchanges and is now three questions.
const MAX_INQUIRY_HISTORY = 20;

function upcomingPublishedEvents(events, today = todayIso()) {
  return events
    .filter((event) => event.status === "published" && event.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, MAX_INQUIRY_EVENTS);
}

function isRateLimited(sender) {
  const now = Date.now();
  const timestamps = (llmCallTimestamps.get(sender) || []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= RATE_LIMIT_MAX_CALLS) {
    if (timestamps.length) llmCallTimestamps.set(sender, timestamps);
    else llmCallTimestamps.delete(sender);
    return true;
  }

  timestamps.push(now);
  llmCallTimestamps.set(sender, timestamps);
  return false;
}

// Stav forwards to the group at these Israel-local times, so the bot hands her the
// material ten minutes earlier. Weekends get a midday slot as well, because that is
// when the group actually plans a Friday or Saturday.
const DAILY_SLOTS = [
  { slot: "12:00", sendHour: 11, sendMinute: 50, days: [5, 6] },          // Fri, Sat
  { slot: "18:00", sendHour: 17, sendMinute: 50, days: [0, 1, 2, 3, 4, 5, 6] },
];
const BOARD_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Wide enough that a machine waking late still sends. Fly suspends this app when idle
// (auto_stop_machines), so timers do not fire on a fixed cadence — a machine waking at
// 17:58 must still deliver, while one waking at 18:20 should skip rather than hand Stav
// something she was meant to forward twenty minutes ago.
const SEND_WINDOW_MINUTES = 15;
// The Content template this bot expects for the publish-day question. Registering it
// and getting Meta to approve it is a Twilio task, not a code one; until that happens
// the name resolves to nothing and the question renders as a numbered list.
const PUBLISH_DAY_TEMPLATE = "fomo_publish_day_v2";
const LOG_RETENTION_DAYS = 90;
const LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Both are persisted: sentBoards was previously in-memory only, so a restart inside the
// send window re-sent the board despite the comment promising otherwise — and Fly
// suspends this machine when idle (auto_stop_machines), making restarts routine.
let sentBoards = new Set(); // `${date}:${slot}` already sent, so a restart can't double-post
let pendingBoards = new Map(); // `${date}:${slot}` -> post text that Twilio accepted but never delivered
let sentReminders = new Set(); // `${date}` already reminded, so a restart can't send twice
// The event whose review buttons were sent last and not yet acted on. Persisted, because
// Fly suspends this machine between messages: in memory it was gone by the time Stav
// tapped, and a bare "אשר" from a button then had nothing to resolve against — which is
// exactly the "which event do you mean?" she hit.
let lastButtonEventId = "";

// Matching an exact hour could not express a 17:50 send, and matching an exact minute
// would miss whenever the interval tick landed a minute off. A window does both.
function isDue(local, { sendHour, sendMinute }) {
  const nowMinutes = local.hour * 60 + local.minute;
  const dueMinutes = sendHour * 60 + sendMinute;
  return nowMinutes >= dueMinutes && nowMinutes < dueMinutes + SEND_WINDOW_MINUTES;
}

function slotsDueAt(local) {
  return DAILY_SLOTS.filter((entry) => entry.days.includes(local.day) && isDue(local, entry));
}

// One delivery per slot: today's events in full, then the rolling board for the days
// still ahead. Flyers follow as separate messages because Twilio carries one image each.
function buildSlotPost(events, localDate) {
  const links = { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer) };
  // The map goes on the daily message only. The board's one-line entries already carry
  // a location, a price and a link; a second URL there is noise. formatShort ignores
  // mapFor anyway, but passing it only where it is wanted keeps that deliberate.
  const daily = makeDigest(events, localDate, { ...links, mapFor: mapLink });
  const board = makeWeekly(events, localDate, links);
  return `${daily}\n\n———\n\n${board}`;
}

async function sendDueBoards(now = new Date()) {
  if (process.env.NODE_ENV === "test") return;
  const local = israelClock(now);
  const localDate = local.date;

  for (const { slot } of slotsDueAt(local)) {
    const key = `${localDate}:${slot}`;
    if (sentBoards.has(key)) continue;
    sentBoards.add(key);
    saveState();

    try {
      const events = loadEvents(EVENTS_FILE);
      const post = buildSlotPost(events, localDate);
      // Goes to Stav, not the group: WhatsApp's API can't post into a normal group
      // (channels.md), so she forwards it — and gets to eyeball it first.
      const result = await sendWhatsApp(ADMIN_SENDER, post);
      // A resolved send is not delivery: the slots fire when Stav is usually not
      // mid-conversation, so her 24h WhatsApp window is typically closed and Twilio
      // drops the message with 63016. Every board between 16 Aug and 23 Aug 2026 was
      // lost this way, silently. Hold it until confirmed.
      pendingBoards.set(key, post);
      saveState();
      confirmBoardDelivery(key, result.sid);
      await sendSlotFlyers(events, localDate);
    } catch (err) {
      console.error(`failed to send the ${slot} message:`, err);
      sentBoards.delete(key); // let the next check retry within the same window
      saveState();
    }
  }
}

// Twilio attaches one image per message, so a day with several flyered events cannot be
// a single send. The text already went out complete; these follow so Stav has the images
// to forward alongside it. Capped, because a busy day should not become a photo album.
const MAX_SLOT_FLYERS = 3;

async function sendSlotFlyers(events, localDate) {
  const flyered = digestFlyerEvents(events, localDate).slice(0, MAX_SLOT_FLYERS);
  for (const event of flyered) {
    const { text, mediaUrl } = formatLong(event, { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer), withDate: true, mapFor: mapLink });
    if (!mediaUrl) continue;
    try {
      await sendWhatsApp(ADMIN_SENDER, text, mediaUrl);
    } catch (err) {
      // One failed image must not stop the rest, and the text has already landed.
      console.error(`failed to send the flyer for event #${event.id}:`, err);
    }
  }
}

// Mirrors confirmAdminNotification: poll detached, and on a non-delivery leave the board
// queued so the next message from Stav re-sends it inside her reopened window.
async function confirmBoardDelivery(key, sid) {
  try {
    const status = await getMessageStatus(sid);
    const outsideWindow = Number(status.error_code) === WHATSAPP_OUTSIDE_WINDOW_ERROR;
    if (UNDELIVERED_STATUSES.has(status.status) || outsideWindow) {
      console.error(
        `${key} board was not delivered (status=${status.status}, error=${status.error_code}); queued for the next admin contact`
      );
      return;
    }
    pendingBoards.delete(key);
    saveState();
  } catch (err) {
    console.error(`failed to confirm delivery of ${key} board:`, err);
  }
}

// Re-sends any board that never reached Stav. Called when she messages the bot, which is
// itself proof the 24h window is open again.
async function flushPendingBoards() {
  if (process.env.NODE_ENV === "test" || !pendingBoards.size) return;
  for (const [key, post] of [...pendingBoards.entries()]) {
    try {
      await sendWhatsApp(ADMIN_SENDER, post);
      pendingBoards.delete(key);
    } catch (err) {
      console.error(`failed to re-send ${key} board:`, err);
    }
  }
  saveState();
}


// An event whose date has passed can't be published, so asking Stav to decide about it is
// busywork - she was being nagged daily about #3 and #5 with no useful action available.
// It closes itself instead.
//
// Status is "expired" rather than "rejected" so the record still says what happened: nobody
// judged this event, it just ran out of time. The submitter is not notified either; from
// their side nothing was decided, and a "your event was declined" message days after the
// fact would be both confusing and slightly insulting.
function expirePastEvents(events, today = todayIso()) {
  const stale = events.filter((e) => e.status === "submitted" && e.date && e.date < today);
  for (const event of stale) {
    storeUpdateEvent(EVENTS_FILE, event.id, {
      status: "expired",
      notes: `${event.notes} | פג תוקף: התאריך עבר`.trim(),
    });
  }
  sweepPastFlyers(events, today);
  // Detached on purpose: callers use the returned list synchronously, and a slow
  // sequence of thank-yous must not hold up expiring the rows. The rows are marked
  // before any send, so nothing is re-sent if this rejects.
  sendGoodbyes(events, today).catch((err) => {
    console.error("failed to send goodbyes:", err);
  });
  return stale;
}

// Once an event is behind them, thank the publisher and remind them the bot is also
// there to answer questions. Marked in notes rather than a new column: notes is
// already the free-form audit field, and this only needs to be idempotent.
const GOODBYE_NOTE = "נשלח תודה";

// Grouped by person, not by event. The note on each row is still the idempotency key —
// no event thanks anyone twice — but one message per *event* meant a publisher with five
// past events got the same text five times in a row. That happened: one submitter has
// events 1, 2, 4, 6 and 14, all swept in a single run, and received five identical
// messages. Dates run from June to August, so this is a backlog being cleared rather
// than natural daily expiry, which is exactly when the pile-up is worst.
async function sendGoodbyes(events, today = todayIso()) {
  const bySubmitter = new Map();
  for (const event of events) {
    if (event.status !== "published") continue;
    if (!event.date || event.date >= today) continue;
    if (!event.submitter) continue;
    if ((event.notes || "").includes(GOODBYE_NOTE)) continue;
    if (!bySubmitter.has(event.submitter)) bySubmitter.set(event.submitter, []);
    bySubmitter.get(event.submitter).push(event);
  }

  for (const [submitter, theirs] of bySubmitter) {
    // Marked before sending, not after: a send that throws must not leave these
    // events eligible again tomorrow and every day after.
    for (const event of theirs) {
      storeUpdateEvent(EVENTS_FILE, event.id, {
        notes: `${event.notes} | ${GOODBYE_NOTE}`.trim(),
      });
    }
    // Awaited rather than fired off in a loop: several sends at once arrive interleaved
    // with whatever else the bot is saying to them.
    await notifySubmitter(submitter, goodbyeMessage(theirs));
  }
}

// One event keeps the original wording. Several become one message that names them,
// because "thanks for publishing" repeated verbatim reads like a broken bot rather
// than a thank-you.
function goodbyeMessage(theirs) {
  // Only mentioned when there is something to mention: "0 people viewed your event"
  // is worse than saying nothing at all.
  const viewsFor = (event) => (event.slug ? clickStats({ eventId: event.id }).total : 0);

  if (theirs.length === 1) {
    const views = viewsFor(theirs[0]);
    const tail = views > 0 ? `\n\n${views} אנשים צפו בקישור לאירוע שלכם דרך FOMO 📈` : "";
    return `${goodbyeText()}${tail}`;
  }

  const lines = [`איזה כיף שפרסמתם אצלנו ${theirs.length} אירועים!`, "", "תהנו 🎉", ""];
  let total = 0;
  for (const event of theirs) {
    const views = viewsFor(event);
    total += views;
    lines.push(`• ${event.event_name}${views > 0 ? ` — ${views} צפיות` : ""}`);
  }
  if (total > 0) {
    lines.push("", `סה״כ ${total} אנשים צפו בקישורים שלכם דרך FOMO 📈`);
  }
  lines.push("", "לא לשכוח שאפשר גם לדבר עם הבוט שלנו ולברר על אירועים");
  return lines.join("\n");
}

// A flyer is only useful while its event is still ahead, and these are megabyte-scale
// files on a small volume. Once the date has passed, drop the image but keep the row —
// the event's text stays in the history either way.
function sweepPastFlyers(events, today = todayIso()) {
  for (const event of events) {
    if (!event.flyer || !event.date || event.date >= today) continue;
    if (deleteFlyer(event.flyer)) {
      storeUpdateEvent(EVENTS_FILE, event.id, { flyer: "" });
    }
  }
}

// Events don't chase themselves: without a nudge a submission can sit unreviewed until its
// date passes (as #3 and #5 did). Re-send the pending list once a day until it's empty.
// Morning, Israel local: early enough that Stav can clear the queue before the 18:00
// slot goes out, late enough not to be a 6am buzz.
const PENDING_REMINDER_SLOT = { sendHour: 9, sendMinute: 0 };
// Fires at a fixed local time rather than 24h after boot.
//
// setInterval(fn, 24h) only fires if the process survives a full day, and this one
// never does: every deploy restarts the timer, and Fly suspends the machine whenever
// it is idle. In three weeks of running it fired exactly once, which is why event #16
// sat unreviewed for days — the nudge that exists to catch precisely that never ran.
async function sendDuePendingReminder(now = new Date()) {
  if (process.env.NODE_ENV === "test") return;
  const local = israelClock(now);
  if (!isDue(local, PENDING_REMINDER_SLOT)) return;
  if (sentReminders.has(local.date)) return;
  sentReminders.add(local.date);
  saveState();
  await sendPendingReminder();
}

async function sendPendingReminder() {
  if (process.env.NODE_ENV === "test") return;
  expirePastEvents(loadEvents(EVENTS_FILE));

  const events = loadEvents(EVENTS_FILE);
  const pending = events.filter((e) => e.status === "submitted");
  if (!pending.length) return;

  const lines = [`יש ${pending.length} אירועים שממתינים לאישור:`, ""];
  for (const e of pending) {
    lines.push(`#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`);
  }
  lines.push("", 'ענו על הודעת האירוע עם "אשר" או "דחה", או כתבו "אשר [מספר]".');

  try {
    // Deliberately not bound to an event id: a reply to a *list* has no single referent,
    // and binding it to one (even when only one is pending) is how "דחה" in reply to a
    // reminder rejected an unrelated event. Replies must target a specific event notice.
    await sendWhatsApp(ADMIN_SENDER, lines.join("\n"));
  } catch (err) {
    console.error("failed to send pending reminder:", err);
  }
}

// ---------------------------------------------------------------------------
// Event reminders for users, opted into during the inquiry flow.
// ---------------------------------------------------------------------------

// Records what the inquiry model marked, and returns the line confirming it.
//
// The id is checked against the events actually shown this turn: the model is asked to
// echo an id from that list, and anything else - a hallucinated id, an event that has
// since been unpublished - is dropped rather than recorded against nothing. The user is
// only told a reminder is set when a row was really written.
function recordReminderOptIns(sender, eventIds = [], events = []) {
  if (!eventIds.length) return "";
  // Gated independently of the prompt. The prompt is the model's instruction and the
  // model can ignore it; this is the one that decides whether a promise is recorded.
  // Both read the same env var, so they can never disagree about whether the feature
  // is on.
  if (!answerInquiryModule.remindersEnabled()) return "";
  const byId = new Map(events.map((event) => [String(event.id), event]));
  const confirmed = [];

  for (const id of eventIds) {
    const event = byId.get(String(id));
    if (!event) {
      console.error(`inquiry asked for a reminder for unknown event ${id}`);
      continue;
    }
    // An event already inside its own reminder window (or past it) can never fire, so
    // promising one would be a lie told at the moment of opting in.
    if (isReminderMissed(event.date, event.start_time)) {
      confirmed.push({ event, tooLate: true });
      continue;
    }
    const { added, already } = remindersStore.addReminder({
      sender,
      eventId: event.id,
      eventName: event.event_name,
      eventDate: event.date,
      eventTime: event.start_time,
    });
    if (added || already) confirmed.push({ event, already });
  }

  if (!confirmed.length) return "";
  return confirmed
    .map(({ event, already, tooLate }) => {
      if (tooLate) return `🔔 ${event.event_name} מתחיל כבר בקרוב, אז לא אספיק לשלוח תזכורת מראש.`;
      if (already) return `🔔 כבר רשמתי לכם תזכורת ל${event.event_name}.`;
      return `🔔 סגור! אשלח תזכורת לפני ${event.event_name}.`;
    })
    .join("\n");
}

// Fires reminders whose event starts in 2-3 hours.
//
// Not a fixed daily slot like PENDING_REMINDER_SLOT: that pattern answers "is it 09:00
// yet", and a reminder has to answer "is THIS event 2-3h away", which differs per event.
// What is reused is the important half - reading the clock on every tick instead of
// setInterval(fn, 24h), which never survives Fly suspending the machine.
//
// The window is wider than the tick interval, so a machine asleep for one tick still
// catches the reminder on the next. A machine asleep through the whole window misses it;
// that reminder is closed out as failed rather than left pending forever.
//
// `deliver` is injectable rather than guarded by NODE_ENV like the other slot senders:
// the delivery rules (window open vs template, verify, never silently drop) are the
// whole point of the feature, so the suite has to exercise them rather than skip them.
async function sendDueEventReminders(now = new Date(), deliver = deliverReminder) {
  // Reminders already recorded stay recorded, but nothing fires while the feature is
  // off - switching it off must stop sends, not just stop new opt-ins. They are left
  // pending rather than failed, so turning the flag back on resumes them.
  if (!answerInquiryModule.remindersEnabled()) return;

  let pending;
  try {
    pending = remindersStore.pendingReminders();
  } catch (err) {
    console.error("failed to read pending reminders:", err);
    return;
  }
  if (!pending.length) return;

  for (const reminder of pending) {
    const due = isReminderDue(reminder.eventDate, reminder.eventTime, now);
    if (!due) {
      // Past its window and never sent - the machine was asleep through it. Close it
      // out so it cannot fire at a nonsensical time later, and say so in the log.
      if (isReminderMissed(reminder.eventDate, reminder.eventTime, now)) {
        remindersStore.markReminder(
          reminder.sender, reminder.eventId, remindersStore.STATUS_FAILED, "window passed unsent"
        );
        console.error(
          `reminder for event #${reminder.eventId} to ${reminder.sender} missed its window`
        );
      }
      continue;
    }

    // Claim it before sending. An append here means a crash mid-send can at worst lose
    // one reminder, never send it twice - and "fires once" is the guarantee that
    // matters most to someone being messaged unprompted.
    remindersStore.markReminder(
      reminder.sender, reminder.eventId, remindersStore.STATUS_SENT, "sending"
    );

    const event = loadEvents(EVENTS_FILE).find((e) => String(e.id) === String(reminder.eventId));
    // An event pulled after opt-in should not produce a reminder to turn up to it.
    if (!event || event.status !== "published") {
      remindersStore.markReminder(
        reminder.sender, reminder.eventId, remindersStore.STATUS_CANCELLED, "event no longer published"
      );
      continue;
    }

    try {
      const result = await deliver({
        to: reminder.sender,
        eventName: event.event_name,
        startTime: event.start_time,
        location: event.location,
        lastInboundMs: lastActivity.get(reminder.sender) || 0,
      });
      if (result.ok) {
        remindersStore.markReminder(
          reminder.sender, reminder.eventId, remindersStore.STATUS_SENT, `${result.via} ${result.status}`
        );
        // A reminder arrives unprompted, hours after the conversation that asked for it
        // ended, so the session is long gone. Remember which event it named, or a reply
        // of "תודה" lands on the main menu with nothing to connect it to.
        recentlyReminded.set(reminder.sender, {
          eventId: reminder.eventId,
          eventName: event.event_name,
          at: Date.now(),
        });
        saveState();
        continue;
      }
      // Never silently dropped: recorded as failed and surfaced to the admin, because
      // the user was told this message was coming.
      remindersStore.markReminder(
        reminder.sender, reminder.eventId, remindersStore.STATUS_FAILED, `${result.reason}: ${result.detail}`
      );
      console.error(
        `reminder for event #${reminder.eventId} to ${reminder.sender} failed (${result.reason}: ${result.detail})`
      );
      await notifyAdminOfFailedReminder(event, reminder, result);
    } catch (err) {
      remindersStore.markReminder(
        reminder.sender, reminder.eventId, remindersStore.STATUS_FAILED, err.message
      );
      console.error(`reminder for event #${reminder.eventId} threw:`, err);
    }
  }
}

// How long a reminder stays answerable. Long enough to cover the event itself and a
// reply the morning after; short enough that next week's "תודה" is not attached to it.
const REMINDER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Thanks, in the forms people actually send. Deliberately not a general intent model:
// this only has to recognise a closing pleasantry, and anything it does not recognise
// falls through to the menu exactly as before.
// The heart is written ❤ with an optional variation selector rather than pasted:
// the pasted form is a two-code-point sequence, which the repo forbids on sight, and
// writing it this way matches a heart sent with or without the selector.
const THANKS_RE = /^(תודה|תודה רבה|יאללה|מעולה|מגניב|סבבה|אחלה|\u{1F44D}|\u{1F64F}|\u2764\uFE0F?|thanks|thank you|thx|ty|ok|okay|great|cool|nice)[\s!.…]*$/iu;

// A reminder arrives out of the blue, hours after the conversation that asked for it,
// so by the time someone replies their session has long expired and the reply lands on
// the main menu — a robotic non-sequitur to "thanks".
//
// Returns the reply, or "" to let the caller fall through to the menu untouched.
function replyToReminder(sender, trimmed) {
  const last = recentlyReminded.get(sender);
  if (!last) return "";
  if (Date.now() - last.at > REMINDER_REPLY_WINDOW_MS) {
    recentlyReminded.delete(sender);
    saveState();
    return "";
  }
  if (!THANKS_RE.test(trimmed)) return "";

  // Answered once. A second "תודה" is a new message with no reminder behind it, and
  // should reach the menu like anything else.
  recentlyReminded.delete(sender);
  saveState();
  return `בכיף! תהנו ב${last.eventName} 🎈`;
}

// A failed reminder is a broken promise, so it goes where someone can see it. Sent to
// the admin, whose window is usually open and who is already the channel for every
// other delivery failure in this file.
async function notifyAdminOfFailedReminder(event, reminder, result) {
  if (process.env.NODE_ENV === "test") return;
  const reason = result.reason === "no-template"
    ? `התבנית ${REMINDER_TEMPLATE} עדיין לא מאושרת, וחלון 24 השעות סגור`
    : `${result.reason}: ${result.detail}`;
  try {
    await sendWhatsApp(
      ADMIN_SENDER,
      `🚨 תזכורת לא נשלחה\nאירוע #${event.id} ${event.event_name}\nנמען: ${reminder.sender}\nסיבה: ${reason}`
    );
  } catch (err) {
    console.error("failed to tell the admin about a failed reminder:", err);
  }
}

// Every per-sender conversation structure in one place. "ביטול", idle expiry and a mode
// switch all need exactly this set; keeping it in one function stops them from drifting
// apart and leaving half a session behind (images outliving their draft, say).
function clearSession(sender) {
  activeSubmissions.delete(sender);
  activeSubmissionImages.delete(sender);
  imagesSentToModel.delete(sender);
  lastExtractedEvent.delete(sender);
  askedForClarification.delete(sender);
  incompleteAttempts.delete(sender);
  activeInquiries.delete(sender);
  activeInquiryHistories.delete(sender);
  recentlyCompleted.delete(sender);
  awaitingPublishChoice.delete(sender);
  awaitingDailyChoice.delete(sender);
}

// A conversation that goes quiet is abandoned, not paused. Without this a half-finished
// draft survives forever (it's persisted to state.json, so even a restart won't clear it)
// and the next unrelated message gets answered in the context of a stale one.
// Five hours, up from thirty minutes. Half an hour was tuned to stop a stale draft
// absorbing an unrelated message, but it also meant someone who asked about events over
// lunch and came back after work started from nothing — and the conversation history is
// the thing that makes follow-up questions work at all. The draft risk is still real;
// MAX_INQUIRY_HISTORY still caps how much of a conversation is carried.
const IDLE_TIMEOUT_MS = 5 * 60 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function hasSessionState(sender) {
  return (
    activeSubmissions.has(sender) ||
    activeInquiries.has(sender) ||
    recentlyCompleted.has(sender) ||
    awaitingPublishChoice.has(sender) ||
    awaitingDailyChoice.has(sender)
  );
}

// Silent by design: no outbound "your draft expired" message. It would burn a WhatsApp
// session message and surprise people who abandoned the draft deliberately.
function expireIdleSessions(now = Date.now()) {
  let changed = false;
  for (const [sender, seenAt] of lastActivity) {
    if (now - seenAt < IDLE_TIMEOUT_MS) continue;
    if (hasSessionState(sender)) {
      clearSession(sender);
      changed = true;
    }
    lastActivity.delete(sender);
    changed = true;
  }
  if (changed) saveState();
}

function sweepStaleRateLimitEntries() {
  const now = Date.now();
  for (const [sender, timestamps] of llmCallTimestamps) {
    const fresh = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) llmCallTimestamps.set(sender, fresh);
    else llmCallTimestamps.delete(sender);
  }
}

const MENU_TEXT = `היי! מה תרצו לעשות?

1. לברר בנוגע לאירועים
2. לפרסם אירוע
3. לראות מחירון פרסום
4. שירות לקוחות`;

const ASK_EVENT_DETAILS_TEXT = "שלחו את פרטי האירוע בפורמט חופשי.";

const ASK_INQUIRY_TEXT = "מה תרצו לדעת על האירועים? (לדוגמה: \"אילו אירועי מוזיקה יש היום?\"). כתבו \"ביטול\" כדי לצאת.";

const PRICE_PLACEHOLDER_TEXT = "מחיר הפרסום: יעודכן בקרוב, פנו אלינו לפרטים.";

const CUSTOMER_SERVICE_TEXT = "לשירות לקוחות פנו לסתיו: +972528762432";

// Sent when the message after a submission is a genuine amendment ("actually it's
// tomorrow"). The old copy told them the event "was already sent, no need to resend" and
// dropped the text — a correction to a date or price was silently thrown away. Forward it
// to Stav instead and say so, so the submitter knows their fix landed.
const AMENDMENT_FORWARDED_TEXT = "העברנו את התוספת לסתיו, היא תעדכן את האירוע לפני הפרסום.";

// A follow-up right after a submission is either a question about it ("when will this be
// published?") or a correction to it ("actually it's tomorrow"). Only the correction
// carries content Stav needs; a question is answered by the standing acknowledgement.
// Questions are the narrower, more recognisable set, so detect those and treat the rest
// as a correction — the failure mode that matters is dropping a fix, not forwarding one
// question too many.
const QUESTION_MARKERS = /[?？]|^(מתי|איפה|מה|האם|כמה|למה|איך|מי)\b/;

function looksLikeQuestion(text) {
  return QUESTION_MARKERS.test(text.trim());
}

// No menu appended: the flag is cleared as this is sent, so the next message falls through
// to the menu on its own. Including it here printed the menu twice in a row.
const FOLLOW_UP_AFTER_SUBMISSION_TEXT = "האירוע האחרון שלכם כבר נשלח לבדיקה, אין צורך לשלוח שוב.";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Deliberately unanchored: the extractor often returns a usable contact with surrounding
// words ("לפרטים: 054-1234567", "לרכישת כרטיסים https://..."). Requiring the whole field to
// be a bare URL/phone rejected messages that plainly contained one, and the submitter was
// re-asked for a link they had already sent. A contact anywhere in the value is enough.
const MAX_INCOMPLETE_ATTEMPTS = 3;
const CONTACT_LINK_RE = /(https?:\/\/\S+|\+?\d[\d\s-]{6,}\d|@\w+)/i;

function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Turns what a person types into the ISO date everything downstream stores.
//
// Asking for YYYY-MM-DD put the burden on the submitter to write a date backwards, and
// anything else — "14/9", "14-09-26", the way dates are actually written here — was
// rejected by re-showing the same prompt, with no hint as to why. Day always comes
// first: that is how dates are read in Israel, and it is the order we now ask for.
//
// A missing year means the next occurrence, not year 0026: someone writing "14/9" in
// December means next September.
function parseUserDate(value, today = todayIso()) {
  const text = String(value || "").trim();
  if (isValidDate(text)) return text; // already ISO, from a button or a careful typist

  const match = text.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/);
  if (!match) return "";

  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return "";

  let year;
  if (match[3]) {
    year = Number(match[3]);
    if (year < 100) year += 2000; // "26" is 2026, not 1926
  } else {
    // No year given: this year, or next if that date has already passed.
    year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (candidate < today) year += 1;
  }

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Rejects 31/2 and friends: the round-trip only survives a real calendar date.
  return isValidDate(iso) ? iso : "";
}

// "Haifa" is not somewhere you can turn up to. A usable location names the venue and
// enough of an address to find it, so require either a street number or a comma
// separating venue from address — which is how every good submission already reads
// ("ALF BAR, Yafo 44, Haifa"). Deliberately loose: the point is to catch a bare city,
// not to police formatting, and anything rejected here is asked for rather than lost.
const VAGUE_LOCATION_RE = /^\s*(חיפה|haifa|בחיפה|העיר|בעיר)\s*$/i;

function isUsableLocation(value) {
  const text = String(value || "").trim();
  if (!text) return true; // emptiness is missingFields' job
  if (VAGUE_LOCATION_RE.test(text)) return false;
  return text.includes(",") || /\d/.test(text) || text.split(/\s+/).length >= 2;
}

function fieldIsValid(key, value) {
  if (!value) return true; // emptiness is handled by missingFields, not here
  if (key === "date") return isValidDate(value);
  if (key === "start_time" || key === "end_time") return TIME_RE.test(value);
  if (key === "contact_link") return CONTACT_LINK_RE.test(value.trim());
  if (key === "location") return isUsableLocation(value);
  return true;
}

// The extractor normalizes free entry to "כניסה חופשית", but it's an LLM writing free text
// and submitters phrase it many ways, so match the family rather than that one literal.
// "הופעת כובע" and "תרומה חופשית" are hat-passing shows: nothing to pay to get in.
// FREE_ENTRY_RE and isFreeEntry now live in format-event.js: both formatters need
// them to pick the entrance emoji, and missingFields needs them to decide whether a
// link is required, so a single copy avoids the two drifting apart.

// A paid event needs a link or contact — that's where people buy a ticket, so without it
// the listing is useless. A free one has nothing to buy: "just show up" is the whole
// instruction, and demanding a link traps submitters who have nothing to give (the ג'אם
// שישי and הופעת כובע submissions in the transcript are exactly this shape).
function missingFields(event) {
  const required = [
    ["event_name", "שם האירוע"],
    ["date", "תאריך"],
    ["start_time", "שעה"],
    ["location", "מיקום (שם המקום והכתובת)"],
    ["category", "קטגוריה"],
  ];
  if (!isFreeEntry(event)) required.push(["contact_link", "קישור / איש קשר"]);

  return required
    .filter(([key]) => !event[key] || !fieldIsValid(key, event[key]))
    .map(([, label]) => label);
}

// The same gaps as missingFields, phrased as something a person can answer.
//
// A label ("מיקום (שם המקום והכתובת)") names a database column and leaves the
// submitter to work out what to type; Stav asked for a plain question instead. Keyed
// off the same list, so a field can never be required without also having a question.
const FIELD_QUESTIONS = new Map([
  ["שם האירוע", "מה שם האירוע?"],
  ["תאריך", "באיזה תאריך האירוע?"],
  ["שעה", "באיזו שעה האירוע מתחיל?"],
  ["מיקום (שם המקום והכתובת)", "מה המיקום של האירוע? (שם המקום והכתובת)"],
  ["קטגוריה", "מה סוג האירוע? (מוזיקה, מסיבה, קולנוע וכו')"],
  ["קישור / איש קשר", "מה הקישור או מספר הטלפון לפרטים?"],
]);

// One missing field gets a direct question. Several get a short list, because six
// separate questions in one message is worse than the labels were.
function missingFieldsPrompt(missing) {
  if (missing.length === 1) {
    const question = FIELD_QUESTIONS.get(missing[0]);
    if (question) return `${question}\n(או "ביטול" כדי לצאת)`;
  }
  const questions = missing.map((label) => FIELD_QUESTIONS.get(label) || label);
  return `כדי להמשיך חסרים עוד כמה פרטים:\n${questions.map((q) => `• ${q}`).join("\n")}\n\n(או "ביטול" כדי לצאת)`;
}

function appendEvent(event, source, sender) {
  const missing = missingFields(event);
  const id = storeAppendEvent(EVENTS_FILE, event, source, sender, missing);
  return { missing, id };
}

// What Stav approves is what the group gets, so the notice shows exactly that: the
// board line and the daily message, rendered by the same two functions that produce
// the real thing. It used to be a field dump — labelled name/date/time lines — which
// meant a misparsed price or an awkward description only became visible after
// publication, when the fix costs a correction and a re-send.
//
// The raw fields are gone deliberately: everything in them is visible in one of the
// two previews, and repeating it made the message twice as long to read.
function formatEventForReview(id, event, sender, unresolved = []) {
  // Surface anything the submitter couldn't clear up, so Stav reviews with the same
  // doubt the extractor had rather than trusting a silently guessed value.
  const uncertaintyNote = unresolved.length
    ? `⚠ לא הובהר: ${unresolved.join(" | ")}`
    : "";

  const links = { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer) };
  return [
    `אירוע חדש לבדיקה #${id}`,
    `נשלח מ: ${sender}`,
    uncertaintyNote || null,
    "",
    "— כך זה ייראה בלוח השבועי —",
    formatShort(event, links),
    "",
    "— כך זה ייראה בהודעה היומית —",
    formatLong(event, links).text,
    "",
    `לאישור: אשר ${id}`,
    `לדחייה: דחה ${id} [סיבה]`,
  ].filter((line) => line !== null).join("\n");
}

const MAX_TRACKED_NOTICES = 50;

// Remembering which event a notice was about is what lets Stav reply "אשר" to the message
// itself instead of retyping an id she has to go find.
function rememberNotice(sid, eventId) {
  if (sid) {
    noticeSidToEventId.set(sid, String(eventId));
    if (noticeSidToEventId.size > MAX_TRACKED_NOTICES) {
      const oldest = noticeSidToEventId.keys().next().value;
      noticeSidToEventId.delete(oldest);
    }
  }
  saveState();
}

// WhatsApp only permits free-form messages within 24h of the recipient's last inbound
// message. Outside that window Twilio accepts the API call but reports error 63016 and
// never delivers, so a resolved promise is NOT proof of delivery — the status must be
// inspected. Undelivered notifications leave the event queued for the next admin contact.
const WHATSAPP_OUTSIDE_WINDOW_ERROR = 63016;
const UNDELIVERED_STATUSES = new Set(["undelivered", "failed"]);

// Verifying delivery means polling Twilio for several seconds, so it must never block the
// webhook reply. The send is awaited (fast); the status check runs detached afterwards and
// only records the outcome for the next admin contact.
async function confirmAdminNotification(id, sid) {
  try {
    const status = await getMessageStatus(sid);
    const outsideWindow = Number(status.error_code) === WHATSAPP_OUTSIDE_WINDOW_ERROR;
    if (UNDELIVERED_STATUSES.has(status.status) || outsideWindow) {
      console.error(
        `admin notification for event #${id} was not delivered (status=${status.status}, error=${status.error_code}); event stays queued for the next admin contact`
      );
      saveState();
      return;
    }
    undeliveredAdminNotices.delete(String(id));
    saveState();
  } catch (err) {
    console.error(`failed to confirm admin notification for event #${id}:`, err);
  }
}

// Only the first image becomes the event's flyer: WhatsApp attaches one image per message,
// and a submitter who sends several is almost always sending variants of the same poster.
function persistFlyer(id, dataUrl) {
  if (!dataUrl) return "";
  const name = saveFlyer(dataUrl, id);
  if (name) storeUpdateEvent(EVENTS_FILE, id, { flyer: name });
  return name;
}

// The FOMO link for an event. Falls back to whatever contact the submitter gave rather
// than to nothing: a message with a dead link is worse than one with a plain phone
// number, and slugs only exist on events created since they were introduced.
function shortLink(event) {
  if (!event.slug || !PUBLIC_BASE_URL) return event.contact_link || "";
  return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/e/${event.slug}`;
}

// Where /m/<slug> sends someone. A search query rather than coordinates: the addresses
// here are typed by submitters ("בר בזל, מסדה 12, חיפה"), and a search resolves those
// the way a person would, while geocoding them would need an API and a key.
//
// "חיפה" is appended when the address does not already say it, because a bare street
// name resolves to whichever city the viewer happens to be near.
function mapsUrl(location) {
  const address = String(location || "").trim();
  const query = /חיפה|haifa/i.test(address) ? address : `${address}, חיפה`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Unlike shortLink there is no fallback: without a slug or a base URL there is nothing
// to point at, and a raw maps URL in the message would not be counted.
function mapLink(event) {
  if (!event.slug || !PUBLIC_BASE_URL || !event.location) return "";
  return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${event.slug}`;
}

// contact_link holds whatever the submitter wrote, and in practice that is almost never
// a bare URL — of the events in production only one is, the rest being names, phone
// numbers or prices. So the link resolves to a real destination only when there is one
// to resolve to; otherwise the landing page below carries the details itself.
const URL_IN_TEXT_RE = /https?:\/\/\S+/;

function destinationFor(event) {
  const match = String(event.contact_link || "").match(URL_IN_TEXT_RE);
  return match ? match[0] : "";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Where a short link lands when the submitter gave a contact rather than a URL, which
// is the common case. Self-contained: one file, no external assets, so it renders on a
// phone with a bad connection and nothing to fetch.
function eventLandingPage(event) {
  const rows = [
    ["📅", event.date ? shortDate(event.date) : ""],
    ["🕗", event.start_time ? `${event.start_time}${event.end_time ? `-${event.end_time}` : ""}` : ""],
    ["📍", event.location],
    [isFreeEntry(event) ? "🆓" : "🎫", isFreeEntry(event) ? "כניסה חופשית" : event.price],
    ["👤", event.contact_person],
    ["📞", destinationFor(event) ? "" : event.contact_link],
  ]
    .filter(([, value]) => value)
    .map(([icon, value]) => `<div class="row"><span>${icon}</span><span>${escapeHtml(value)}</span></div>`)
    .join("\n      ");

  const flyer = event.flyer && flyerUrl(event.flyer)
    ? `<img src="${escapeHtml(flyerUrl(event.flyer))}" alt="">`
    : "";

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(event.event_name)} · FOMO חיפה</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
         background: #faf7f2; color: #1c1a17; display: flex; justify-content: center; }
  .card { width: 100%; max-width: 32rem; background: #fff; border-radius: 18px; padding: 24px;
          box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); }
  .brand { font-size: .8rem; letter-spacing: .12em; color: #b4652a; font-weight: 700; margin-bottom: 14px; }
  h1 { margin: 0 0 4px; font-size: 1.5rem; line-height: 1.25; }
  .cat { color: #6b6560; font-size: .95rem; margin-bottom: 18px; }
  .row { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; font-size: 1.02rem; }
  .row span:first-child { flex: 0 0 1.4rem; }
  .desc { margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee7dd;
          white-space: pre-wrap; line-height: 1.55; color: #3b3733; }
  img { width: 100%; border-radius: 12px; margin-top: 18px; display: block; }
  .foot { margin-top: 20px; font-size: .82rem; color: #8a837c; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #17150f; color: #f2ede4; }
    .card { background: #221f18; box-shadow: none; }
    .desc { color: #ccc5b8; border-top-color: #332f26; }
    .cat, .foot { color: #9a938a; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">FOMO חיפה</div>
    <h1>${escapeHtml(event.event_name)}</h1>
    ${event.category ? `<div class="cat">${escapeHtml(event.category)}</div>` : ""}
      ${rows}
    ${event.description ? `<div class="desc">${escapeHtml(event.description)}</div>` : ""}
    ${flyer}
    <div class="foot">מה עושים היום בחיפה?</div>
  </div>
</body>
</html>`;
}

// Twilio fetches media itself, so the flyer needs an absolute URL it can reach. Without
// PUBLIC_BASE_URL there is no such address and the message goes out as text.
function flyerUrl(name) {
  if (!name || !PUBLIC_BASE_URL) return "";
  return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/flyer/${encodeURIComponent(name)}`;
}

// A button tap is not a reply, so WhatsApp may not send OriginalRepliedMessageSid with
// it. That would leave a tapped "אשר" with nothing to resolve against. This is NOT the
// old "most recent event" fallback: it is the single event whose buttons were sent last
// and not yet acted on, cleared the moment anything resolves it, so it cannot drift onto
// an unrelated event the way the old guess did.

const REVIEW_TEMPLATE = "fomo_review_event";
// The template's buttons send these back as ButtonPayload. handleTwilio normalises that
// into the message text, so a tap arrives looking exactly like her typing the word —
// which is why the ids are the commands themselves rather than digits.
const REVIEW_BUTTON_OPTIONS = [
  { key: "אשר", label: "אשר ופרסם" },
  { key: "דחה", label: "דחה" },
  { key: "ממתינים", label: "הצג ממתינים" },
];

// Sent right after the preview, so she can tap instead of typing "אשר 12". Silent when
// no template is approved — the preview already carries typed instructions, and a
// second message repeating them would just be noise.
async function sendReviewButtons(id, eventName) {
  try {
    // Populate the cache before asking it anything. It fills lazily, so on a freshly
    // started machine — which Fly gives us constantly, since it suspends when idle —
    // the first review of the day would otherwise see an empty map and skip silently.
    await ensureTemplates();
    if (!approvedTemplateSid(REVIEW_TEMPLATE)) return;
    const result = await sendChoice(ADMIN_SENDER, {
      // text is the fallback wording; it is only used if the template send fails.
      text: `אירוע #${id} ממתין לאישור.`,
      options: REVIEW_BUTTON_OPTIONS,
      template: REVIEW_TEMPLATE,
      variables: { 1: eventName },
    });
    // Re-bind to this message: a bare "אשר" resolves through the sid of whatever she
    // replied to, and from here on that is the buttons, not the preview above it.
    if (result && result.sid) rememberNotice(result.sid, id);
    lastButtonEventId = String(id);
    saveState();
  } catch (err) {
    console.error(`failed to send review buttons for event #${id}:`, err);
  }
}

async function forwardEventToAdmin(id, event, sender, unresolved = [], flyer = "") {
  if (process.env.NODE_ENV === "test") return;
  try {
    // Preview the stored row, not the extractor's object: the slug and flyer are
    // written by appendEvent and persistFlyer, so only the row has them. Previewing
    // the extractor's version would show Stav a different link from the one the group
    // will actually receive.
    const stored = storeFindEvent(EVENTS_FILE, id) || { ...event, flyer };
    const result = await sendWhatsApp(
      ADMIN_SENDER,
      formatEventForReview(id, stored, sender, unresolved),
      flyerUrl(flyer)
    );
    rememberNotice(result.sid, id);

    // The previews and the buttons cannot share a message: a template message carries
    // only its own approved body, so putting the buttons on it would mean approving an
    // event without seeing what the group gets. They go as a second, short message
    // instead — and the notice id is re-bound to it, because that is the one she taps
    // or replies to. Falls back to nothing extra when no template is approved: the
    // first message already told her how to approve by typing.
    await sendReviewButtons(id, stored.event_name);
    // Assume undelivered until proven otherwise, so a crash mid-check fails safe (the event
    // still gets surfaced on Stav's next message) rather than silently disappearing.
    undeliveredAdminNotices.add(String(id));
    saveState();
    confirmAdminNotification(id, result.sid);
  } catch (err) {
    console.error("failed to forward event to admin:", err);
    undeliveredAdminNotices.add(String(id));
    saveState();
  }
}

// A correction the submitter sent right after their event. Goes to Stav as plain text
// rather than being re-extracted: it's usually a fragment ("actually it's tomorrow") that
// only means anything against the event it amends, and she's editing the row by hand anyway.
async function forwardAmendmentToAdmin(id, text, sender) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await sendWhatsApp(ADMIN_SENDER, `✏ תוספת לאירוע #${id}\nמאת: ${sender}\n\n${text}`);
  } catch (err) {
    console.error(`failed to forward amendment for event #${id}:`, err);
  }
}

// A ready-to-forward post for the group. Same LONG rendering the daily message uses,
// so the group sees one consistent format however an event reaches it.
function formatPublishedPost(event) {
  return formatLong(event, { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer), withDate: true, mapFor: mapLink }).text;
}

async function sendPublishedPost(id, event) {
  if (process.env.NODE_ENV === "test") return;
  const { text, mediaUrl } = formatLong(event, { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer), withDate: true, mapFor: mapLink });
  if (event.flyer && !mediaUrl) {
    console.error(`event #${id} has a flyer but PUBLIC_BASE_URL is unset; sending text only`);
  }
  try {
    await sendWhatsApp(ADMIN_SENDER, text, mediaUrl);
  } catch (err) {
    console.error(`failed to send published post for event #${id}:`, err);
  }
}

async function notifySubmitter(sender, text) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await sendWhatsApp(sender, text);
  } catch (err) {
    console.error("failed to notify submitter:", err);
  }
}

// Approval tells the submitter three things in order: it is live, it is already on
// the board and discoverable, and — if they have not already chosen a day — which
// day they would like it in the group message.
//
// This message is the one most likely to fall outside the submitter's 24h WhatsApp
// window, since it arrives whenever Stav gets round to reviewing. If it never
// lands, the event is still on the board; only the optional group slot is missed.
async function notifyApproved(sender, id, event) {
  const alreadyChose = Boolean(event.daily_days);
  const lines = [`האירוע שלכם "${event.event_name}" אושר ויפורסם 🎉`];

  if (alreadyChose) {
    await notifySubmitter(sender, lines.join("\n"));
    return;
  }

  if (!event.date || !isValidDate(event.date)) {
    await notifySubmitter(sender, lines.join("\n"));
    return;
  }

  const options = publishDayOptions(event.date);
  awaitingDailyChoice.set(sender, { eventId: id, options, expectingDate: false });
  saveState();

  // Unlike the question asked at submission time — which is a webhook reply, and TwiML
  // carries no buttons — this one is an outbound send, so it can be tappable. Falls back
  // to the same numbered list whenever no approved template is available.
  if (process.env.NODE_ENV === "test") return;
  const prompt = `${lines.join("\n")}\n\n${publishChoicePrompt()}`;
  try {
    // The template's body already says "your event X was approved… which day?", so its
    // only variable is the name. `text` is the fallback wording, used when the option
    // list does not match the template's fixed buttons — which is most of the time, since
    // publishDayOptions returns up to six.
    await sendChoice(sender, {
      text: prompt,
      options,
      template: PUBLISH_DAY_TEMPLATE,
      variables: { 1: event.event_name },
    });
  } catch (err) {
    console.error("failed to send the approval notice:", err);
  }
}

const ADMIN_HELP_TEXT = `פקודות ניהול:
הכי פשוט: ענו על הודעת האירוע עצמה עם "אשר" או "דחה"

אשר [מספר] - לאשר ולפרסם אירוע
דחה [מספר] [סיבה] - לדחות אירוע
ממתינים - רשימת אירועים ממתינים לבדיקה
צפיות - כמה צפיות יש לקישורים של האירועים
צפיות [מספר] - פירוט לאירוע אחד
תקן [מספר] [שדה]: [ערך] - לתקן פרט באירוע (הבוט ילמד מהתיקון)

שדות לתיקון: שם, תאריך, שעה, שעת סיום, מיקום, קטגוריה, מחיר, מארגן, קישור, איש קשר, תיאור
לדוגמה: תקן 6 מחיר: כניסה חופשית

לקוח - מעבר למצב לקוח (לבדיקות), כדי לשלוח אירוע כמו משתמש רגיל
ניהול - חזרה למצב ניהול`;

// Hebrew labels Stav actually types, mapped to the CSV/extractor field names.
const FIELD_LABELS = new Map([
  ["שם", "event_name"],
  ["תאריך", "date"],
  ["שעה", "start_time"],
  ["שעת סיום", "end_time"],
  ["מיקום", "location"],
  ["קטגוריה", "category"],
  ["מחיר", "price"],
  ["מארגן", "organizer"],
  ["קישור", "contact_link"],
  ["איש קשר", "contact_person"],
  ["תיאור", "description"],
]);

const CORRECT_COMMAND_RE = /^תקן\s*#?(\d+)\s+([^:]+):\s*(.*)$/s;

async function handleCorrectionCommand(match) {
  const [, id, rawField, rawValue] = match;
  const fieldLabel = rawField.trim();
  const field = FIELD_LABELS.get(fieldLabel);
  const value = rawValue.trim();

  if (!field) {
    const known = [...FIELD_LABELS.keys()].join(", ");
    return `לא מכיר את השדה "${fieldLabel}".\nשדות אפשריים: ${known}`;
  }

  const existing = storeFindEvent(EVENTS_FILE, id);
  if (!existing) return `לא נמצא אירוע #${id}.`;

  if (!fieldIsValid(field, value)) {
    return `הערך "${value}" לא בפורמט הנכון עבור ${fieldLabel}.`;
  }

  const wrongValue = existing[field] || "";
  if (wrongValue === value) return `אירוע #${id}: ${fieldLabel} כבר "${value}".`;

  storeUpdateEvent(EVENTS_FILE, id, { [field]: value });
  // The description is the best available record of what the submitter actually wrote,
  // so it doubles as the source snippet that led the extractor astray.
  addCorrection(EVENTS_FILE, {
    field,
    wrongValue,
    rightValue: value,
    sourceText: existing.description || existing.event_name || "",
  });

  return `עודכן: אירוע #${id}, ${fieldLabel} = "${value}".\nהבוט ילמד מהתיקון הזה. 🧠`;
}

function formatPendingList(events) {
  const today = todayIso();
  // Past-dated submissions are never worth showing: they can't be published, so listing
  // them only invites a decision that has no effect. The daily sweep closes them; this
  // filter keeps them out of the list in between sweeps.
  const pending = events.filter((e) => e.status === "submitted" && (!e.date || e.date >= today));
  if (!pending.length) return "אין אירועים ממתינים כרגע.";
  return pending
    .map((e) => `#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`)
    .join("\n");
}

// Explicit id ("אשר 6"), or bare ("אשר") as a WhatsApp reply to the event's own notice.
const ADMIN_COMMAND_RE = /^(אשר|דחה)(?:\s*#?(\d+))?\s*(.*)$/;

// Approving and rejecting are irreversible from the submitter's point of view - they get a
// "your event was published/declined" message either way - so the target is never guessed.
// A bare command used to fall back to the most recently notified event, which silently
// rejected #8 when Stav replied "דחה" to a reminder listing #3 and #5, and rejected #10
// when she typed "2" meaning the menu's "publish an event". An unresolvable command now
// asks which event instead of picking one — except for lastButtonEventId, which is a
// single named event rather than a guess (see its declaration).
function resolveEventId(explicitId, repliedSid) {
  if (explicitId) return String(explicitId);
  if (repliedSid && noticeSidToEventId.has(repliedSid)) return noticeSidToEventId.get(repliedSid);
  if (lastButtonEventId) return lastButtonEventId;
  return "";
}

// Any inbound admin message reopens WhatsApp's 24h window, so it's the one reliable moment
// to deliver review notices that were dropped earlier (error 63016).
function missedNoticesBanner(events) {
  if (!undeliveredAdminNotices.size) return "";
  const stillPending = events.filter(
    (e) => e.status === "submitted" && undeliveredAdminNotices.has(String(e.id))
  );
  if (!stillPending.length) {
    undeliveredAdminNotices.clear();
    saveState();
    return "";
  }
  const lines = stillPending
    .map((e) => `#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`)
    .join("\n");
  return `⚠ אירועים שההודעה עליהם לא הגיעה אליך:\n${lines}\n\n`;
}

// "Views" rather than "clicks" on purpose: WhatsApp and every preview crawler fetch a
// link the moment it appears in a message. Those are filtered out by user-agent, but no
// filter is perfect, so the word stays honest about what the number is.
function formatViewStats(idArg) {
  const events = loadEvents(EVENTS_FILE);

  if (idArg) {
    const event = events.find((e) => e.id === String(idArg));
    if (!event) return `לא נמצא אירוע #${idArg}.`;
    const stats = clickStats({ eventId: event.id });
    return [
      `📈 אירוע #${event.id} — ${event.event_name}`,
      `צפיות בקישור: ${stats.total}`,
      `מכשירים שונים: ${stats.unique}`,
      event.slug ? `קישור: ${shortLink(event)}` : "",
    ].filter(Boolean).join("\n");
  }

  const ranked = events
    .filter((e) => e.slug)
    .map((e) => ({ event: e, stats: clickStats({ eventId: e.id }) }))
    .filter((row) => row.stats.total > 0)
    .sort((a, b) => b.stats.total - a.stats.total)
    .slice(0, 10);

  if (!ranked.length) return "עוד אין צפיות בקישורים.";
  return [
    "📈 צפיות בקישורים:",
    ...ranked.map((row) => `#${row.event.id} ${row.event.event_name} — ${row.stats.total}`),
    "",
    'לפירוט על אירוע: צפיות [מספר]',
  ].join("\n");
}

async function handleAdminMessage(text, repliedSid = "") {
  const trimmed = text.trim();
  // Her message just reopened the 24h WhatsApp window, so any board Twilio dropped with
  // 63016 can finally be delivered. Detached: a slow re-send must not delay her reply.
  flushPendingBoards();
  const banner = missedNoticesBanner(loadEvents(EVENTS_FILE));

  // "צפיות" on its own gives the busiest events; with an id, that event alone.
  if (trimmed === "צפיות" || trimmed.startsWith("צפיות ")) {
    return `${banner}${formatViewStats(trimmed.slice("צפיות".length).trim())}`;
  }

  if (trimmed === "ממתינים") {
    expirePastEvents(loadEvents(EVENTS_FILE));
    return `${banner}${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

  const correction = trimmed.match(CORRECT_COMMAND_RE);
  if (correction) {
    return `${banner}${await handleCorrectionCommand(correction)}`;
  }

  const match = trimmed.match(ADMIN_COMMAND_RE);
  if (!match) return `${banner}${ADMIN_HELP_TEXT}`;

  const [, action, explicitId, reason] = match;
  const id = resolveEventId(explicitId, repliedSid);
  if (!id) {
    return `${banner}לא ברור לאיזה אירוע הכוונה — לא שיניתי כלום.\nענו על הודעת האירוע עם "${action}", או כתבו "${action} [מספר]".\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

  const existing = storeFindEvent(EVENTS_FILE, id);
  if (!existing) {
    return `${banner}לא נמצא אירוע #${id}.\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

  // Acting on an event means it was seen; stop flagging it as a missed notice.
  if (undeliveredAdminNotices.delete(String(id))) saveState();
  // Consumed: the buttons have done their job, and leaving this set would let the next
  // bare command land on an event nobody was looking at.
  if (lastButtonEventId === String(id)) { lastButtonEventId = ""; saveState(); }

  if (action === "אשר") {
    if (existing.status === "published") {
      return `אירוע #${id} כבר מאושר ומפורסם.`;
    }
    // Expired events close themselves, so reaching one by explicit id is either a typo or
    // a deliberate revival. Say what happened rather than silently publishing a past date;
    // she can still correct the date with "תקן" and approve it then.
    if (existing.status === "expired") {
      return `אירוע #${id} "${existing.event_name}" כבר עבר (${existing.date}) ולכן נסגר אוטומטית.\nאם התאריך השתנה: תקן ${id} תאריך: [תאריך חדש] ואז אשר ${id}.`;
    }
    storeUpdateEvent(EVENTS_FILE, id, { status: "published", published_at: todayIso() });
    if (existing.submitter) {
      await notifyApproved(existing.submitter, id, existing);
    }
    // The API can't post into a normal WhatsApp group (channels.md), so send the finished
    // post for her to forward. An event happening today has missed its scheduled slot or
    // is about to, so it goes out immediately and on its own — no publish time mentioned,
    // because there isn't one to wait for.
    const publishedEvent = storeFindEvent(EVENTS_FILE, id) || existing;
    if (publishedEvent.date === todayIso()) {
      await sendPublishedPost(id, publishedEvent);
      return `אירוע #${id} אושר ופורסם.\nהאירוע היום — שלחתי לך אותו עכשיו, אפשר להעביר לקבוצה.`;
    }
    if (publishedEvent.flyer) {
      await sendPublishedPost(id, publishedEvent);
      return `אירוע #${id} אושר ופורסם.\nשלחתי לך את הפוסט עם התמונה — אפשר להעביר לקבוצה.`;
    }
    return `אירוע #${id} אושר ופורסם.`;
  }

  // action === "דחה"
  if (existing.status === "rejected") {
    return `אירוע #${id} כבר נדחה.`;
  }
  // Already closed by the date sweep. Rejecting it again would send the submitter a
  // "declined" message for something nobody actually judged.
  if (existing.status === "expired") {
    return `אירוע #${id} כבר עבר (${existing.date}) ונסגר אוטומטית — אין צורך לדחות.`;
  }
  storeUpdateEvent(EVENTS_FILE, id, { status: "rejected", notes: `${existing.notes} | נדחה: ${reason}`.trim() });
  if (existing.submitter) {
    const reasonText = reason ? `\nסיבה: ${reason}` : "";
    await notifySubmitter(existing.submitter, `האירוע שלכם "${existing.event_name}" לא אושר לפרסום.${reasonText}`);
  }
  return `אירוע #${id} נדחה.`;
}

function buildTwilioSignatureBaseString(url, params) {
  const sortedKeys = [...params.keys()].sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params.get(key);
  }
  return data;
}

function isValidTwilioSignature(req, body, signature) {
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  if (!PUBLIC_BASE_URL) {
    console.error("PUBLIC_BASE_URL is not set; rejecting Twilio webhook request");
    return false;
  }

  const params = new URLSearchParams(body);
  const url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${req.url}`;
  const baseString = buildTwilioSignatureBaseString(url, params);
  const expected = crypto.createHmac("sha1", TWILIO_AUTH_TOKEN).update(baseString, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function twiml(message) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

function extractMediaUrls(params) {
  const numMedia = Number(params.get("NumMedia") || "0");
  const urls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    const contentType = params.get(`MediaContentType${i}`) || "";
    if (url && contentType.startsWith("image/")) urls.push(url);
  }
  return urls;
}

async function handleTwilio(req, res, body) {
  if (process.env.NODE_ENV !== "test") {
    const signature = req.headers["x-twilio-signature"];
    if (!isValidTwilioSignature(req, body, signature)) {
      console.error("rejected Twilio webhook request: invalid or missing signature");
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
  }

  const params = new URLSearchParams(body);
  // A quick-reply tap arrives as ButtonPayload, not Body, and carries the button's id.
  // Every button is built with its id set to the option's key — the same "1" or "2" a
  // person would type — so from here down a tap and a typed digit are the same message
  // and nothing else in the router has to know buttons exist.
  const text = params.get("ButtonPayload") || params.get("Body") || "";
  const sender = params.get("From") || "";
  const mediaUrls = extractMediaUrls(params);
  // Present when the user replied to a specific WhatsApp message; lets a bare "אשר"
  // resolve to the event that notice was about.
  const repliedSid = params.get("OriginalRepliedMessageSid") || "";

  let reply;
  try {
    reply = await routeMessage(sender, text, mediaUrls, repliedSid);
  } catch (err) {
    console.error("routeMessage failed:", err);
    reply = "מצטערים, קרתה תקלה. נסו שוב בעוד רגע.";
  }

  // A TwiML reply is one plain-text node — it cannot carry buttons however many
  // templates are approved. When the reply is a choice we have an approved template
  // for, send it over the API instead and acknowledge the webhook with an empty
  // response. Everything else stays TwiML, which keeps the risky path narrow: the
  // webhook's own response is still the delivery mechanism for almost every message,
  // and only the handful of button-eligible replies depend on a second call.
  //
  // Safe because the sender just messaged us, so their 24h window is open by
  // definition and a free-form template send is allowed without extra approval.
  const asButtons = buttonReplyFor(reply);
  if (asButtons) {
    try {
      await sendChoice(sender, asButtons);
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(EMPTY_TWIML);
      return;
    } catch (err) {
      // Falling through costs nothing: the text below is the same wording the buttons
      // would have carried, so a failed send degrades to what the bot always sent.
      console.error("button reply failed, falling back to TwiML:", err);
    }
  }

  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(twiml(reply));
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Recognises the replies that have an approved button template, by matching the text
// the router already produced rather than threading a flag through 58 return
// statements. Returns null for everything else, which is most replies.
function buttonReplyFor(reply) {
  if (typeof reply !== "string" || !reply) return null;

  // The menu, whether it was reached by "cancel", an unrecognised message, or the
  // customer-mode banner being prefixed to it.
  if (reply.includes("1. לברר בנוגע לאירועים") && reply.includes("4. שירות לקוחות")) {
    return {
      text: reply,
      options: MAIN_MENU_BUTTON_OPTIONS,
      template: MAIN_MENU_TEMPLATE,
      variables: {},
    };
  }

  return null;
}

const MAIN_MENU_TEMPLATE = "fomo_main_menu";
// Three of the four menu entries; WhatsApp allows no more. The price list is the one
// left off, and the template body tells people to type 3 for it — it is the least-used
// of the four and the only one that is purely informational.
const MAIN_MENU_BUTTON_OPTIONS = [
  { key: "1", label: "לברר על אירועים" },
  { key: "2", label: "לפרסם אירוע" },
  { key: "4", label: "שירות לקוחות" },
];

const MENU_KEYWORDS = new Set(["תפריט", "/menu", "menu"]);
const CANCEL_KEYWORDS = new Set(["ביטול", "/cancel", "cancel"]);

const LIKELY_EVENT_TEXT_MIN_LENGTH = 40;

function looksLikeEventSubmission(trimmed, mediaUrls) {
  if (mediaUrls.length) return true;
  return trimmed.length >= LIKELY_EVENT_TEXT_MIN_LENGTH;
}

const LIKELY_EVENT_DETECTED_TEXT = "נראה ששיתפתם פרטים על אירוע — מעבדים את זה עכשיו. (כתבו \"ביטול\" כדי לחזור לתפריט)";

async function handleActiveSubmission(sender, text, mediaUrls) {
  const trimmed = text.trim();

  if (text.length > MAX_MESSAGE_LENGTH) {
    return MESSAGE_TOO_LONG_TEXT;
  }

  if (isRateLimited(sender)) {
    return RATE_LIMITED_TEXT;
  }

  const images = activeSubmissionImages.get(sender) || [];
  if (mediaUrls.length) {
    const remainingSlots = Math.max(0, MAX_IMAGES_PER_EVENT - images.length);
    const urlsToFetch = mediaUrls.slice(0, remainingSlots);
    try {
      const fetched = await Promise.all(urlsToFetch.map(fetchMediaAsDataUrl));
      images.push(...fetched);
      activeSubmissionImages.set(sender, images);
      saveState();
    } catch (err) {
      console.error("failed to fetch WhatsApp media:", err);
      if (!trimmed) return MEDIA_FETCH_FAILED_TEXT;
    }
  }

  const messages = activeSubmissions.get(sender);
  messages.push(text);
  saveState();

  if (!messages.some((m) => m.trim()) && !images.length) {
    return ASK_EVENT_DETAILS_TEXT;
  }

  const conversationText = messages.map((line, i) => `הודעה ${i + 1}: ${line}`).join("\n");

  // Only send images the model hasn't already seen; carry forward the previously
  // extracted fields as text context so information from earlier images isn't lost.
  const alreadySentCount = imagesSentToModel.get(sender) || 0;
  const newImages = images.slice(alreadySentCount);
  const previousEvent = alreadySentCount ? lastExtractedEvent.get(sender) || null : null;

  const correctionGuidance = buildCorrectionGuidance(EVENTS_FILE);
  const event = await extractEventModule.extractEvent(conversationText, undefined, newImages, previousEvent, correctionGuidance);
  imagesSentToModel.set(sender, images.length);
  lastExtractedEvent.set(sender, event);
  const missing = missingFields(event);

  // Re-asking forever is worse than forwarding an imperfect draft: a submitter who has
  // already sent the detail (and can see it in their own message) has no way to satisfy
  // the bot, and no reason to believe a fourth attempt will work. After a few tries, hand
  // it to Stav with the gap named — she can fill it in or reject it.
  if (missing.length) {
    const attempts = (incompleteAttempts.get(sender) || 0) + 1;
    incompleteAttempts.set(sender, attempts);
    saveState();

    if (attempts < MAX_INCOMPLETE_ATTEMPTS) {
      return missingFieldsPrompt(missing);
    }

    const unresolvedMissing = [`חסרים פרטים שלא הצלחנו לקבל: ${missing.join(", ")}`];
    const firstImage = images[0] || "";
    clearSession(sender);
    recentlyCompleted.add(sender);
    saveState();
    const { id } = appendEvent(event, "Twilio WhatsApp", sender);
    lastSubmittedEventId.set(sender, id);
    const flyer = persistFlyer(id, firstImage);
    await forwardEventToAdmin(id, event, sender, unresolvedMissing, flyer);
    return "קיבלנו את האירוע והעברנו אותו לבדיקה. אם חסר פרט, נשלים אותו מולכם.";
  }

  incompleteAttempts.delete(sender);

  // Everything required is present, but the extractor may still be genuinely unsure about
  // something (a price that could be admission or a product, say). Ask the submitter once
  // — they know the answer, unlike Stav. Only once: if their reply doesn't settle it, the
  // event proceeds with a note rather than trapping them in a question loop.
  const questions = event._questions || [];
  if (questions.length && !askedForClarification.has(sender)) {
    askedForClarification.add(sender);
    saveState();
    const list = questions.length === 1 ? questions[0] : questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return `כמעט סיימנו! רק שאלה קטנה:\n${list}\n\n(אפשר גם לכתוב "לא יודע" ונעביר לבדיקה כמו שזה)`;
  }

  const unresolved = questions.length ? [...questions] : [];
  // A free event is allowed through without a link, but say so on the review message:
  // Stav should see that attendees have no way to ask a question before she publishes it.
  if (!event.contact_link && isFreeEntry(event)) {
    unresolved.push("אין קישור או איש קשר — אירוע חינמי");
  }

  // Read the flyer before clearSession drops it.
  const firstImage = images[0] || "";
  clearSession(sender);
  recentlyCompleted.add(sender);
  saveState();
  const { id } = appendEvent(event, "Twilio WhatsApp", sender);
  lastSubmittedEventId.set(sender, id);
  const flyer = persistFlyer(id, firstImage);
  await forwardEventToAdmin(id, event, sender, unresolved, flyer);
  // The receipt confirms what was captured; the question that follows is the one
  // decision the submitter still owns. Asked now, while they are still in the
  // conversation — the same question after approval often lands outside WhatsApp's
  // 24h window and is never seen.
  const receipt = formatSubmissionReceipt(event, flyer);
  if (event.date && isValidDate(event.date)) {
    const options = publishDayOptions(event.date);
    awaitingPublishChoice.set(sender, { eventId: id, options, expectingDate: false });
    saveState();
    return `${receipt}\n\n${publishChoiceText(event, options)}`;
  }
  return receipt;
}

// A bare "we got it" gave the submitter nothing to check against, so a misread date or
// location only surfaced after publication — or never. Echo back what was actually
// extracted: wrong fields are obvious at a glance, and the next message can correct them.
function formatSubmissionReceipt(event, flyer = "") {
  const [, , month, day] = (event.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  const lines = [
    "קיבלנו את האירוע! 🎉 הוא נכנס לבדיקה לפני פרסום.",
    "",
    "זה מה שקלטנו:",
    event.event_name ? `📌 ${event.event_name}` : null,
    day ? `📅 ${Number(day)}.${Number(month)}${event.start_time ? ` בשעה ${event.start_time}` : ""}` : null,
    event.location ? `📍 ${event.location}` : null,
    event.price ? `💸 ${event.price}` : null,
    event.contact_link ? `🔗 ${event.contact_link}` : null,
    flyer ? "📷 הפלייר צורף" : null,
    "",
    'משהו לא נכון? פשוט כתבו לנו כאן מה לתקן.',
  ];
  return lines.filter((line) => line !== null).join("\n");
}

// When the group message should go out. Options whose day has already passed are
// dropped rather than offered and rejected — "a week before" is meaningless for an
// event three days away — and the survivors are renumbered so the keys are always
// 1..n with no gaps. The shape is deliberately {key, label, date}: a quick-reply
// button carries exactly this, so switching from typed numbers to taps later is a
// rendering change and nothing more.
// Distinguishes "no daily message" from "a date I haven't given you yet" (null). Both
// are non-dates, so they need to be told apart where the answer is handled.
const DECLINE_DAILY = "decline";

function publishDayOptions(eventDate, today = todayIso()) {
  const candidates = [
    { label: "ביום האירוע", date: eventDate },
    { label: "יום לפני", date: addDays(eventDate, -1) },
    { label: "שבוע לפני", date: addDays(eventDate, -7) },
    { label: "בהקדם האפשרי", date: today },
  ].filter((option) => option.date >= today && option.date <= eventDate);

  // Distinct dates only: for an event tomorrow, "day before" and "as soon as
  // possible" are the same day, and offering it twice looks broken.
  const seen = new Set();
  const unique = candidates.filter((option) => {
    if (seen.has(option.date)) return false;
    seen.add(option.date);
    return true;
  });

  const options = unique.map((option, i) => ({ ...option, key: String(i + 1) }));
  options.push({ key: String(options.length + 1), label: "תאריך אחר", date: null });
  // Declining has to be one of the choices. Without it every option picked a date, so a
  // submitter who only wanted the weekly board could not say so: anything that was not
  // an option key just re-asked the question, and ignoring it left the draft to expire
  // half an hour later. "No" is an answer, not a failure to answer.
  options.push({ key: String(options.length + 1), label: "לא, רק בלוח השבועי", date: DECLINE_DAILY });
  return options;
}

function renderOptions(options) {
  return options.map((option) => `${option.key}. ${option.label}`).join("\n");
}

const PUBLISH_CHOICE_INTRO = `רוצים שנפרסם אותו גם בהודעה היומית בקבוצה? באיזה יום?`;

// Everything the submitter is told once their event is in: it is already on the
// board, other people can find it by asking the bot, and here is the one decision
// left. Requirement order matters — board first, then the question.
//
// Split from its options so the same copy can be a numbered list in a webhook reply
// (TwiML carries no buttons) and tappable buttons in an outbound send.
function publishChoicePrompt() {
  return [
    "📋 האירוע נכנס אוטומטית ללוח השבועי שלנו,",
    "וגם מי ששואל את הבוט על אירועים בעיר יגלה אותו.",
    "",
    PUBLISH_CHOICE_INTRO,
  ].join("\n");
}

function publishChoiceText(event, options) {
  return `${publishChoicePrompt()}\n${renderOptions(options)}`;
}

const NO_DAILY_TEXT = "אין בעיה — האירוע יופיע בלוח השבועי בלבד.";
const ASK_OTHER_DATE_TEXT = 'איזה תאריך? כתבו בפורמט DD-MM-YY (למשל 14-09-26).';

function goodbyeText() {
  return [
    "איזה כיף שפרסמתם אצלנו!",
    "תהנו באירוע שלכם 🎉",
    "לא לשכוח שאפשר גם לדבר עם הבוט שלנו ולברר על אירועים",
  ].join("\n");
}

// Records the chosen day on the event and closes the question.
function recordDailyDay(sender, pending, date, map) {
  const event = storeFindEvent(EVENTS_FILE, pending.eventId);
  if (event) {
    const days = new Set((event.daily_days || "").split(",").filter(Boolean));
    days.add(date);
    storeUpdateEvent(EVENTS_FILE, pending.eventId, { daily_days: [...days].sort().join(",") });
  }
  map.delete(sender);
  saveState();
  const [, , month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  const when = day ? `${Number(day)}.${Number(month)}` : date;
  return `סגור — נשלח אותו להודעה היומית ב-${when}. 🙌`;
}

// Shared by both questions: the one asked right after submission and the one asked
// again after Stav approves. Same options, same parsing, different map.
function handleDayChoice(sender, trimmed, map) {
  const pending = map.get(sender);

  if (pending.expectingDate) {
    const date = parseUserDate(trimmed);
    if (!date) {
      return ASK_OTHER_DATE_TEXT;
    }
    if (date < todayIso()) {
      return "התאריך הזה כבר עבר. כתבו תאריך מהיום והלאה.";
    }
    return recordDailyDay(sender, pending, date, map);
  }

  const chosen = pending.options.find((option) => option.key === trimmed);
  if (!chosen) {
    // Not a menu key. Rather than scold, re-show the options — a submitter who
    // typed a sentence here is answering the question, just not in the shape asked.
    return `${PUBLISH_CHOICE_INTRO}\n${renderOptions(pending.options)}`;
  }

  if (chosen.date === DECLINE_DAILY) {
    // Recorded rather than left empty. Empty means "not asked yet", and the question is
    // asked a second time after approval — so without a marker, someone who declined at
    // submission would be asked the same thing again days later.
    storeUpdateEvent(EVENTS_FILE, pending.eventId, { daily_days: DECLINE_DAILY });
    map.delete(sender);
    saveState();
    return NO_DAILY_TEXT;
  }

  if (chosen.date === null) {
    map.set(sender, { ...pending, expectingDate: true });
    saveState();
    return ASK_OTHER_DATE_TEXT;
  }

  return recordDailyDay(sender, pending, chosen.date, map);
}

const ADMIN_MODE_KEYWORDS = new Set(["ניהול", "admin"]);
const CUSTOMER_MODE_KEYWORDS = new Set(["לקוח", "customer", "qa"]);

const ADMIN_MODE_TEXT = `🛠 מצב ניהול. כתבו "לקוח" כדי לבדוק כמו משתמש רגיל.

${ADMIN_HELP_TEXT}`;

// Prefixed to every customer-mode reply, so the mode is never something she has to
// remember from a switch that may have happened days and a restart ago.
const CUSTOMER_MODE_BANNER = '👤 מצב לקוח (בדיקות) — כתבו "ניהול" כדי לחזור.';

const CUSTOMER_MODE_TEXT = `👤 מצב לקוח (בדיקות) — פקודות הניהול כבויות. כתבו "ניהול" כדי לחזור.

${MENU_TEXT}`;

// Wrapper so the customer-mode banner reaches every reply, whichever branch below produced
// it, without threading a flag through each return.
// Which flow the sender was in when a message arrived. Recorded with the interaction so
// the log can answer "where do people drop out", which raw text alone cannot.
function senderFlow(sender) {
  if (activeSubmissions.has(sender)) return "submission";
  if (activeInquiries.has(sender)) return "inquiry";
  if (awaitingPublishChoice.has(sender) || awaitingDailyChoice.has(sender)) return "publish-choice";
  if (recentlyCompleted.has(sender)) return "post-submission";
  return "menu";
}

async function routeMessage(sender, text, mediaUrls = [], repliedSid = "") {
  const state = { inCustomerModeReply: false };
  // Captured before routing, since routing is what changes it.
  const flow = senderFlow(sender);
  logInteraction({
    dir: "in",
    sender,
    flow,
    text: String(text || "").slice(0, MAX_MESSAGE_LENGTH),
    media: mediaUrls.length,
  });

  const reply = await routeMessageInner(sender, text, mediaUrls, repliedSid, state);
  const full = state.inCustomerModeReply ? `${CUSTOMER_MODE_BANNER}\n\n${reply}` : reply;

  // Outbound keeps a length, not the text: every reply is reconstructible from the code,
  // and storing them again would double the log for nothing.
  logInteraction({ dir: "out", sender, flow, chars: String(full || "").length });
  return full;
}

async function routeMessageInner(sender, text, mediaUrls = [], repliedSid = "", state = {}) {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Expire before reading any state: the periodic sweep may not have run since a restart,
  // and acting on an hours-old draft is exactly what this is meant to prevent.
  expireIdleSessions();
  lastActivity.set(sender, Date.now());

  // The admin declares which role she's in rather than having it guessed from her text.
  // Guessing is what made "2" (menu: publish an event) reject an event instead.
  if (sender === ADMIN_SENDER) {
    if (ADMIN_MODE_KEYWORDS.has(lowerTrimmed)) {
      adminMode.set(sender, "admin");
      clearSession(sender);
      saveState();
      return ADMIN_MODE_TEXT;
    }
    if (CUSTOMER_MODE_KEYWORDS.has(lowerTrimmed)) {
      adminMode.set(sender, "customer");
      clearSession(sender);
      saveState();
      return CUSTOMER_MODE_TEXT;
    }
    // Default is admin: her real job. QA is the mode she opts into.
    if (adminMode.get(sender) !== "customer") {
      return handleAdminMessage(text, repliedSid);
    }
    // Customer mode is sticky and survives restarts, so announcing it only at the switch
    // left her guessing hours later — and a silent customer-mode reply looks exactly like
    // a broken admin command. Tag every reply while she is in the mode she opted into;
    // admin mode is the default and needs no banner on each message.
    state.inCustomerModeReply = true;
  }

  if (CANCEL_KEYWORDS.has(lowerTrimmed) || MENU_KEYWORDS.has(lowerTrimmed)) {
    clearSession(sender);
    saveState();
    return MENU_TEXT;
  }

  if (activeSubmissions.has(sender)) {
    return handleActiveSubmission(sender, text, mediaUrls);
  }

  // Must sit above the recentlyCompleted branch below: a bare "2" answering the
  // publish-day question would otherwise be read as a stray follow-up and forwarded
  // to Stav as a correction to the event.
  if (awaitingPublishChoice.has(sender)) {
    return handleDayChoice(sender, trimmed, awaitingPublishChoice);
  }

  if (awaitingDailyChoice.has(sender)) {
    return handleDayChoice(sender, trimmed, awaitingDailyChoice);
  }

  if (activeInquiries.has(sender)) {
    if (text.length > MAX_MESSAGE_LENGTH) {
      return MESSAGE_TOO_LONG_TEXT;
    }

    if (isRateLimited(sender)) {
      return RATE_LIMITED_TEXT;
    }

    const history = activeInquiryHistories.get(sender) || [];
    const isFirstExchange = history.length === 0;
    history.push({ role: "user", content: text });

    const events = upcomingPublishedEvents(loadEvents(EVENTS_FILE));
    const raw = await answerInquiryModule.answerInquiry(history, events);
    // The model marks a reminder opt-in inline; strip the marker and act on it, so the
    // user only ever sees prose.
    const { text: answer, eventIds } = answerInquiryModule.extractReminderRequest(raw);
    const confirmation = recordReminderOptIns(sender, eventIds, events);

    history.push({ role: "assistant", content: answer });
    activeInquiryHistories.set(sender, history.slice(-MAX_INQUIRY_HISTORY));
    saveState();

    const withConfirmation = confirmation ? `${answer}\n\n${confirmation}` : answer;
    return isFirstExchange
      ? `${withConfirmation}\n\n(כתבו "ביטול" כדי לחזור לתפריט)`
      : withConfirmation;
  }

  if (recentlyCompleted.has(sender)) {
    const lastId = lastSubmittedEventId.get(sender) || "";
    recentlyCompleted.delete(sender);
    saveState();
    if (trimmed !== "1" && trimmed !== "2" && trimmed !== "3" && trimmed !== "4") {
      // The message right after a submission is usually about that submission, not a new
      // one. Treating every such message as a duplicate discarded real corrections — a
      // date fix ("תאמת שזה מחר") never reached Stav. Anything with content gets forwarded
      // as an amendment; only an empty/media-only message falls back to the old notice.
      if (lastId && trimmed && !looksLikeQuestion(trimmed)) {
        await forwardAmendmentToAdmin(lastId, trimmed, sender);
        return AMENDMENT_FORWARDED_TEXT;
      }
      return FOLLOW_UP_AFTER_SUBMISSION_TEXT;
    }
  }

  switch (trimmed) {
    case "1":
      activeInquiries.add(sender);
      activeInquiryHistories.delete(sender);
      saveState();
      return ASK_INQUIRY_TEXT;
    case "2":
      clearSession(sender);
      activeSubmissions.set(sender, []);
      saveState();
      return ASK_EVENT_DETAILS_TEXT;
    case "3":
      return PRICE_PLACEHOLDER_TEXT;
    case "4":
      return CUSTOMER_SERVICE_TEXT;
    default:
      if (looksLikeEventSubmission(trimmed, mediaUrls)) {
        clearSession(sender);
        activeSubmissions.set(sender, []);
        saveState();
        const reply = await handleActiveSubmission(sender, text, mediaUrls);
        return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
      }
      // Answering a reminder we sent unprompted. Checked here, after the menu keys and
      // the submission sniffer, so it only ever catches what would have fallen through
      // to the menu anyway.
      {
        const reply = replyToReminder(sender, trimmed);
        if (reply) return reply;
      }
      return MENU_TEXT;
  }
}

function requestBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => callback(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && req.url === "/webhook/twilio") {
    requestBody(req, (body) => handleTwilio(req, res, body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/digest") {
    const targetDate = url.searchParams.get("date") || todayIso();
    const digest = makeDigest(loadEvents(EVENTS_FILE), targetDate);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(digest);
    return;
  }

  if (req.method === "GET" && url.pathname === "/weekly") {
    // ?board= is gone with the two fixed boards, but old links still carry it; ignoring
    // an unknown parameter beats a 400 for something that no longer means anything.
    const fromDate = url.searchParams.get("date") || todayIso();
    const post = makeWeekly(loadEvents(EVENTS_FILE), fromDate, { linkFor: shortLink });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(post);
    return;
  }

  // Twilio fetches this URL to attach the flyer. Unguessable by content hash rather than
  // authenticated, because Twilio's fetch carries no credentials of ours.
  if (req.method === "GET" && url.pathname.startsWith("/flyer/")) {
    const name = decodeURIComponent(url.pathname.slice("/flyer/".length));
    const resolved = flyerPath(name);
    if (!resolved) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(name),
      "Cache-Control": "public, max-age=86400",
    });
    fs.createReadStream(resolved).pipe(res);
    return;
  }

  // The FOMO short link. Counts the visit, then either forwards to the submitter's own
  // URL or — far more often, since most events give a name or a phone rather than a link
  // — shows the event on a page of ours.
  // The map link. A separate slug space from /e/ so the two are counted separately:
  // opening a map is a much stronger signal of intent to attend than opening a link,
  // and mixing them into one number would hide that.
  if (req.method === "GET" && url.pathname.startsWith("/m/")) {
    const slug = decodeURIComponent(url.pathname.slice("/m/".length));
    const event = loadEvents(EVENTS_FILE).find((e) => e.slug && e.slug === slug);
    if (!event || !event.location) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("האירוע לא נמצא");
      return;
    }

    logClick({
      slug: `map:${slug}`,
      eventId: event.id,
      userAgent: req.headers["user-agent"],
      referer: req.headers.referer,
      ip: (req.headers["fly-client-ip"] || req.socket.remoteAddress || ""),
    });

    // no-store for the same reason /e/ uses it: a cached redirect goes uncounted.
    res.writeHead(302, { Location: mapsUrl(event.location), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/e/")) {
    const slug = decodeURIComponent(url.pathname.slice("/e/".length));
    const event = loadEvents(EVENTS_FILE).find((e) => e.slug && e.slug === slug);
    if (!event) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("האירוע לא נמצא");
      return;
    }

    logClick({
      slug,
      eventId: event.id,
      userAgent: req.headers["user-agent"],
      referer: req.headers.referer,
      // Fly terminates TLS, so the visitor's address arrives in the forwarded header.
      ip: (req.headers["fly-client-ip"] || req.socket.remoteAddress || ""),
    });

    const destination = destinationFor(event);
    if (destination) {
      // no-store or a cached redirect means every later visit goes uncounted.
      res.writeHead(302, { Location: destination, "Cache-Control": "no-store" });
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(eventLandingPage(event));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

loadState();

if (require.main === module) {
  // handleTwilio skips signature verification under NODE_ENV=test, which is right for
  // the suite and catastrophic anywhere else: without it, anyone who can reach the
  // webhook can post From=<admin phone> and approve, reject or correct events. The two
  // settings only ever coincide by mistake, so refuse to start rather than serve.
  if (process.env.NODE_ENV === "test" && process.env.TWILIO_AUTH_TOKEN) {
    console.error(
      "refusing to start: NODE_ENV=test disables Twilio signature verification, " +
      "but TWILIO_AUTH_TOKEN is set — this would accept forged webhooks as the admin."
    );
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`listening on ${PORT}`));
  setInterval(sweepStaleRateLimitEntries, RATE_LIMIT_SWEEP_INTERVAL_MS).unref();
  setInterval(sendDuePendingReminder, BOARD_CHECK_INTERVAL_MS).unref();
  setInterval(expireIdleSessions, IDLE_SWEEP_INTERVAL_MS).unref();
  setInterval(sendDueBoards, BOARD_CHECK_INTERVAL_MS).unref();
  // Same 5-minute tick as the boards: the 1h reminder window is far wider, so a
  // missed tick still catches it, and reading the clock each time is what survives
  // Fly suspending the machine.
  setInterval(sendDueEventReminders, BOARD_CHECK_INTERVAL_MS).unref();
  // Keeps the click and interaction logs from growing without bound on a small volume.
  setInterval(() => {
    pruneOlderThan(LOG_RETENTION_DAYS);
    remindersStore.pruneOlderThan(LOG_RETENTION_DAYS);
  }, LOG_PRUNE_INTERVAL_MS).unref();
}

module.exports = {
  routeMessage,
  recordReminderOptIns,
  sendDueEventReminders,
  replyToReminder,
  get recentlyReminded() { return recentlyReminded; },
  upcomingPublishedEvents,
  get activeSubmissions() { return activeSubmissions; },
  get activeSubmissionImages() { return activeSubmissionImages; },
  get activeInquiries() { return activeInquiries; },
  get activeInquiryHistories() { return activeInquiryHistories; },
  get recentlyCompleted() { return recentlyCompleted; },
  get undeliveredAdminNotices() { return undeliveredAdminNotices; },
  get adminMode() { return adminMode; },
  get lastActivity() { return lastActivity; },
  rememberNotice,
  // Exported so the routes can be exercised against a real listener in tests.
  server,
  shortLink,
  destinationFor,
  formatEventForReview,
  missingFields,
  missingFieldsPrompt,
  parseUserDate,
  ASK_OTHER_DATE_TEXT,
  buttonReplyFor,
  // Pure, so the schedule and the choice list can be tested without sending anything.
  isDue,
  slotsDueAt,
  PENDING_REMINDER_SLOT,
  publishDayOptions,
  goodbyeText,
  goodbyeMessage,
  mapsUrl,
  mapLink,
  sendGoodbyes,
  get awaitingPublishChoice() { return awaitingPublishChoice; },
  get awaitingDailyChoice() { return awaitingDailyChoice; },
  DAILY_SLOTS,
  SEND_WINDOW_MINUTES,
  expireIdleSessions,
  IDLE_TIMEOUT_MS,
};
