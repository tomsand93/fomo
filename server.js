const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { loadEvents, makeBoard, digestEvents } = require("./make-digest");
const { israelClock, todayIso, addDays, dayOfWeek, longDate, isReminderDue, isReminderMissed } = require("./clock");
const { isFreeEntry, entranceLabel, formatShort, formatLong } = require("./format-event");
const { AD_WINDOWS, availableWindows, adDateLine, windowPhrase } = require("./ad-windows");
const { appendEvent: storeAppendEvent, updateEvent: storeUpdateEvent, findEvent: storeFindEvent, lastDay, runsOn, isSameEvent } = require("./events-store");
const extractEventModule = require("./extract-event");
const { FIELD_KEYS } = extractEventModule;
const intentModule = require("./classify-intent");
const { addCorrection, buildCorrectionGuidance } = require("./corrections-store");
const answerInquiryModule = require("./answer-inquiry");
const { sendWhatsApp, getMessageStatus, postForm, splitBody } = require("./send-whatsapp");
// Called through the module object, so the suite can stub a successful download.
const fetchMediaModule = require("./fetch-media");
const { saveFlyer, flyerPath, contentTypeFor, deleteFlyer } = require("./flyer-store");
const { logClick, logInteraction, clickStats, pruneOlderThan } = require("./clicks-store");
const { sendChoice, renderNumbered, approvedTemplateSid, ensureTemplates } = require("./send-interactive");
const remindersStore = require("./reminders-store");
const { deliverReminder, REMINDER_TEMPLATE, windowIsOpen } = require("./send-reminder");
const { fetchBalance } = require("./twilio-balance");

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
// Both survive a restart on purpose: the gap between offering an ad and getting an
// answer is hours, and Fly suspends this machine in between.
// sender -> { eventId, step, askedAt, options, prompt, window }. The ad offered after
// approval, and the step of booking it: offer, pick, date, window or flyer. Left alone by
// clearSession and kept out of hasSessionState, like awaitingConfirmation; it lapses after
// AD_OFFER_TTL_MS instead.
let awaitingAdChoice = new Map();
// Event ids whose approval and ad offer have not reached the organizer: their window was
// closed with no approved template, or they were in another conversation. Attached to
// their next reply (deliverPendingAdOffer).
let pendingAdOffers = new Set();
// The held offers whose approval already went out (the organizer was busy, not out of
// reach): only the offer is still owed, so it comes with a reminder line, not the
// approval again.
let approvalAlreadySent = new Set();
// sender -> { eventId, unresolved }. The organizer has seen both versions and has not yet
// confirmed them or said what to change. Deliberately left alone by clearSession and kept
// out of hasSessionState: the answer can come hours later, and the idle sweep must not
// turn a late "1" into a menu choice. unresolved is what Stav's notice flags once it goes.
let awaitingConfirmation = new Map();
let undeliveredAdminNotices = new Set(); // event ids whose review notice never reached the admin, surfaced on her next message
let askedForClarification = new Set(); // senders already asked a clarifying question this submission, so we never ask twice
let incompleteAttempts = new Map(); // sender -> consecutive turns still missing required fields, so a draft can't loop forever
let contactDeclined = new Set(); // senders who answered the link question with "אין", so it is never asked again this submission
// sender -> { text, at }. Set when the classifier can't tell which flow a stranger wants.
// Persisted like every other conversation flag: the answer arrives on a separate inbound
// webhook and Fly suspends this machine in between. The original text rides along so
// answering doesn't make them retype what they already sent.
let awaitingIntentConfirm = new Map();
// senders just offered a way out of a submission that looks misrouted. Its own flag
// because the activeSubmissions branch swallows every message: without it, the "1"
// answering the offer would be appended to the event draft.
let offeredEscape = new Set();
let noticeSidToEventId = new Map(); // Twilio message sid of a review notice -> event id, so a WhatsApp reply to it resolves without a number
// The admin's phone is also her QA/testing phone, so her role can't be inferred from the
// message text: "2" is both a menu choice and (previously) a reject command. She declares
// which hat she's wearing instead. Anyone who isn't the admin is always a customer.
let adminMode = new Map(); // ADMIN_SENDER -> "admin" | "customer"
// The event id Stav is editing in her own words after "ערוך", "" when no edit is open.
// Persisted: her answer is a separate webhook, and Fly suspends this machine in between.
let awaitingAdminEdit = "";
let lastActivity = new Map(); // sender -> ms timestamp of last inbound message, for idle expiry
// sender -> ms timestamp of last inbound message, for the 24h WhatsApp window. Its own map
// because the idle sweep drops lastActivity after 5h, which read a 5-24h-old open window as
// closed and held approvals that could have gone out. Pruned only once the window is shut.
let lastInbound = new Map();
const LAST_INBOUND_TTL_MS = 24 * 60 * 60 * 1000;
// sender -> { eventId, eventName, at } of the reminder they were last sent. Persisted
// like everything else here: the reply comes minutes to hours later, and Fly suspends
// this machine in between, so an in-memory note would be gone before it is read.
let recentlyReminded = new Map();
// sender -> { ids, pickedId }. A submitter cancelling one of their own events: ids is the
// numbered list they were shown, pickedId the one awaiting a yes/no.
let awaitingCancelChoice = new Map();
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
    // Older state also holds awaitingPublishChoice and awaitingDailyChoice, the removed
    // publish-day question; they are ignored.
    awaitingAdChoice = new Map(raw.awaitingAdChoice || []);
    pendingAdOffers = new Set(raw.pendingAdOffers || []);
    approvalAlreadySent = new Set(raw.approvalAlreadySent || []);
    awaitingConfirmation = new Map(raw.awaitingConfirmation || []);
    sentBoards = new Set(raw.sentBoards || []);
    sentReminders = new Set(raw.sentReminders || []);
    sentNudges = new Set(raw.sentNudges || []);
    nudgeOptOuts = new Set(raw.nudgeOptOuts || []);
    lastNudgeVariant = raw.lastNudgeVariant || "";
    lastButtonEventId = raw.lastButtonEventId || "";
    // Older state held each board as one joined string; it goes out as a single post.
    pendingBoards = new Map(
      (raw.pendingBoards || []).map(([key, posts]) => [key, Array.isArray(posts) ? posts : [{ text: posts }]])
    );
    undeliveredAdminNotices = new Set(raw.undeliveredAdminNotices || []);
    askedForClarification = new Set(raw.askedForClarification || []);
    incompleteAttempts = new Map(raw.incompleteAttempts || []);
    contactDeclined = new Set(raw.contactDeclined || []);
    awaitingIntentConfirm = new Map(raw.awaitingIntentConfirm || []);
    offeredEscape = new Set(raw.offeredEscape || []);
    noticeSidToEventId = new Map(raw.noticeSidToEventId || []);
    adminMode = new Map(raw.adminMode || []);
    awaitingAdminEdit = raw.awaitingAdminEdit || "";
    lastActivity = new Map(raw.lastActivity || []);
    lastInbound = new Map(raw.lastInbound || []);
    recentlyReminded = new Map(raw.recentlyReminded || []);
    awaitingCancelChoice = new Map(raw.awaitingCancelChoice || []);
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
    awaitingAdChoice: [...awaitingAdChoice.entries()].slice(-50),
    pendingAdOffers: [...pendingAdOffers].slice(-100),
    approvalAlreadySent: [...approvalAlreadySent].slice(-100),
    awaitingConfirmation: [...awaitingConfirmation.entries()].slice(-50),
    // Only the last few send-windows matter; older keys can never fire again.
    sentBoards: [...sentBoards].slice(-20),
    sentReminders: [...sentReminders].slice(-14),
    sentNudges: [...sentNudges].slice(-8),
    // Never bounded: dropping an opt-out would start messaging someone who said stop.
    nudgeOptOuts: [...nudgeOptOuts],
    lastNudgeVariant,
    lastButtonEventId,
    pendingBoards: [...pendingBoards.entries()].slice(-10),
    undeliveredAdminNotices: [...undeliveredAdminNotices],
    askedForClarification: [...askedForClarification],
    incompleteAttempts: [...incompleteAttempts.entries()],
    contactDeclined: [...contactDeclined],
    // Bounded: an unanswered confirmation older than the last few is dead anyway.
    awaitingIntentConfirm: [...awaitingIntentConfirm.entries()].slice(-50),
    offeredEscape: [...offeredEscape],
    awaitingCancelChoice: [...awaitingCancelChoice.entries()].slice(-50),
    // Bounded: only recent notices need to stay resolvable by reply.
    noticeSidToEventId: [...noticeSidToEventId].slice(-50),
    adminMode: [...adminMode.entries()],
    awaitingAdminEdit,
    lastActivity: [...lastActivity.entries()],
    lastInbound: [...lastInbound.entries()],
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
    .filter((event) => event.status === "published" && lastDay(event) >= today)
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
//
// 10:00 is the morning ad window (ad-windows.js) and carries booked ads only, never the
// board: a day with nothing booked sends nothing at 10:00. adsOnly keeps it out of
// earlierSlotToday, or every 18:00 board would take 10:00 for an earlier board and drop
// the day's morning events.
const DAILY_SLOTS = [
  { slot: "10:00", sendHour: 9, sendMinute: 50, days: [0, 1, 2, 3, 4, 5, 6], adsOnly: true },
  { slot: "12:00", sendHour: 11, sendMinute: 50, days: [5, 6] },          // Fri, Sat
  { slot: "18:00", sendHour: 17, sendMinute: 50, days: [0, 1, 2, 3, 4, 5, 6] },
];
const BOARD_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Wide enough that a machine waking late still sends. Fly suspends this app when idle
// (auto_stop_machines), so timers do not fire on a fixed cadence — a machine waking at
// 17:58 must still deliver, while one waking at 18:20 should skip rather than hand Stav
// something she was meant to forward twenty minutes ago.
const SEND_WINDOW_MINUTES = 15;
const LOG_RETENTION_DAYS = 90;
const LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Both are persisted: sentBoards was previously in-memory only, so a restart inside the
// send window re-sent the board despite the comment promising otherwise — and Fly
// suspends this machine when idle (auto_stop_machines), making restarts routine.
let sentBoards = new Set(); // `${date}:${slot}` already sent, so a restart can't double-post
let pendingBoards = new Map(); // `${date}:${slot}` -> [{ text, mediaUrl, eventId, isAd }] Twilio accepted but never delivered
let sentReminders = new Set(); // `${date}` already reminded, so a restart can't send twice
let sentNudges = new Set(); // `${date}` the weekly publisher nudge already went out, same reason
let nudgeOptOuts = new Set(); // senders who answered the weekly nudge with "הסר"
let lastNudgeVariant = ""; // id of the wording sent last week, so this week's differs
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

// Each slot is a short note for Stav, then the messages she forwards as is, in order:
// the daily board (today's events, short form), then the ads booked for the window that
// opens at that slot. 10:00 carries ads only, 12:00 the board only, 18:00 both. A slot
// with no board and no ads still sends its note, saying so, so a quiet day shows the bot
// ran. 10:00 with nothing booked sends nothing: it never carries a board to miss.
//
// The note names each message by what she sees in the chat. It used to say "1. today's
// events, 2. ..." over messages that carry no numbers, and she could not match them up
// (21/10/2026).
const SLOT_POST_LABELS = {
  today: "הלוח היומי",
  ad: "מודעה",
};
const SLOT_LINKS = { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer) };
// sendWhatsApp's own margin under Twilio's 1600. A longer board becomes several posts,
// cut at the blank line between two events, so the note can count them and each one
// forwards as is.
const MAX_BOARD_CHARS = 1500;

// The earlier slot that already ran today, if any — the weekend's 12:00 before its 18:00.
// The 10:00 ads slot never carries the board, so it is not an earlier board.
function earlierSlotToday(localDate, slot) {
  const day = dayOfWeek(localDate);
  const earlier = DAILY_SLOTS.filter((entry) => !entry.adsOnly && entry.days.includes(day) && slot && entry.slot < slot);
  return earlier.length ? earlier[earlier.length - 1].slot : "";
}

// On a day with two slots, the second leaves out what the first already sent and is no
// longer ahead: today's events that start before it, and the later events promoted for
// today. Stav asked that a morning event never go out again in the evening, even when it
// runs into the night (22/10/2026). An evening event goes in both, because at noon it
// was still hours away.
function coveredByEarlierSlot(event, localDate, slot) {
  if (!earlierSlotToday(localDate, slot)) return false;
  return !runsOn(event, localDate) || (event.start_time || "") < slot;
}

// The date line for a post forwarded on its own: day name, and the last day of a festival.
function dateLineFor(event) {
  const multiDay = event.end_date && event.end_date > event.date;
  return `${longDate(event.date)}${multiDay ? `–${longDate(event.end_date)}` : ""}`;
}

// The ad window that opens at a slot: 10:00 is the morning one, 18:00 the evening one.
function adWindowAt(slot) {
  const window = AD_WINDOWS.find((entry) => entry.start === slot);
  return window ? window.key : "";
}

// Ads booked for a window on this day that have not gone to Stav yet. A declined offer
// has ad_window "decline", which no window matches.
function adsDue(events, localDate, windowKey) {
  return events
    .filter((event) =>
      event.status === "published" &&
      event.ad_date === localDate &&
      event.ad_window === windowKey &&
      !event.ad_sent_at
    )
    .sort((a, b) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`));
}

// The graphic ad: the long form with the flyer as media, dated for the day it is posted.
// It keeps the map line. A message with a flyer shows no link preview, so the map tile
// can't push anything else out of it.
function adPost(event, postDate, windowKey, links = SLOT_LINKS) {
  const { text, mediaUrl } = formatLong(event, { ...links, mapFor: mapLink, dateLine: adDateLine(event, postDate, windowKey) });
  return { text, mediaUrl, eventId: event.id, isAd: true };
}

function adLabel(event) {
  return `${SLOT_POST_LABELS.ad}: ${event.event_name} (${longDate(event.date)})`;
}

const postCount = (n) => (n === 1 ? "הודעה אחת" : `${n} הודעות`);

// What leaves buildSlotPosts and sendLateAds: the labels are for the note only.
const forwardable = ({ text, mediaUrl = "", eventId = "", isAd = false }) => ({ text, mediaUrl, eventId, isAd });

// Returns [] for a 10:00 slot with nothing booked, otherwise the note and then the posts.
function buildSlotPosts(events, localDate, slot = "", links = SLOT_LINKS) {
  const entry = DAILY_SLOTS.find((candidate) => candidate.slot === slot) || {};
  const windowKey = adWindowAt(slot);
  const ads = windowKey ? adsDue(events, localDate, windowKey) : [];
  if (entry.adsOnly && !ads.length) return [];

  const daily = entry.adsOnly ? [] : digestEvents(events, localDate);
  const fresh = daily.filter((event) => !coveredByEarlierSlot(event, localDate, slot));
  const board = entry.adsOnly ? "" : makeBoard(fresh, localDate, { linkFor: links.linkFor, todayUrl: absoluteUrl("/today") });
  const boardParts = board ? splitBody(board, MAX_BOARD_CHARS) : [];
  const title = board.split("\n")[0].replace(/\*/g, "").trim();

  const posts = [
    ...boardParts.map((text, i) => ({
      text,
      label: `"${title}" (${SLOT_POST_LABELS.today}${boardParts.length > 1 ? `, חלק ${i + 1} מתוך ${boardParts.length}` : ""})`,
    })),
    ...ads.map((event) => ({ ...adPost(event, localDate, windowKey, links), label: adLabel(event) })),
  ];

  const where = slot ? ` ב-${slot}` : "";
  const intro = posts.length
    ? [`📬 להעביר לקבוצה${where} — ${postCount(posts.length)}, לפי הסדר:`, "", ...posts.map((post, i) => `${i + 1}. ${post.label}`)]
    : [`📬 אין הודעות להעביר לקבוצה${where}.`];
  if (!entry.adsOnly) {
    const earlier = earlierSlotToday(localDate, slot);
    const covered = fresh.length < daily.length;
    if (!board && covered) {
      intro.push("", `אירועי היום כבר נשלחו בהודעה של ${earlier}, לכן אין לוח יומי.`);
    } else if (!board) {
      intro.push("", "אין אירועים שמתקיימים היום, לכן אין לוח יומי.");
    } else if (covered) {
      intro.push("", `אירועים שכבר נשלחו בהודעה של ${earlier} לא מופיעים שוב.`);
    }
  }
  if (posts.length) intro.push("", "כל ההודעות שמתחת לזו — להעביר כמו שהן.");

  return [{ text: intro.join("\n") }, ...posts.map(forwardable)];
}

// Booked ads whose handoff has passed with the ad still not handed to Stav: the machine
// slept through the slot, the slot failed, a past-day board holding the ad was dropped,
// or the booking came in after its window's handoff. Each comes back as
// { event, window }, with window the ad window open right now (from its handoff to its
// end) that still starts before the event, by availableWindows' rule. With no such
// window the ad is not late-sent now: it waits for the next one, or never goes if none
// is left before the event. So a late ad never reaches Stav outside 09:50-13:00 or
// 17:50-21:00.
function lateAds(events, local) {
  const order = (key) => AD_WINDOWS.findIndex((entry) => entry.key === key);
  const late = [];
  for (const event of events) {
    if (event.status !== "published" || event.ad_sent_at || !event.ad_date) continue;
    if (order(event.ad_window) < 0) continue; // not booked, or declined
    const window = availableWindows(event, local).find((entry) => entry.openNow && entry.date === local.date);
    if (!window) continue;
    // The booked handoff has passed: an earlier day, or today at a window no later than
    // the open one.
    const handoffPassed = event.ad_date < local.date ||
      (event.ad_date === local.date && order(event.ad_window) <= order(window.key));
    if (handoffPassed) late.push({ event, window });
  }
  return late.sort((a, b) => `${a.event.date} ${a.event.start_time}`.localeCompare(`${b.event.date} ${b.event.start_time}`));
}

// The Twilio balance is prepaid; at zero the account is suspended and the bot goes
// silent (05/11/2026). Spend runs about $4 a month, so $10 is roughly two months of
// warning. The warning rides on the daily board's note to Stav rather than a message of
// its own: the board is the one thing that reaches her every day, closed window or not
// (sendSlotReadyPing), so it needs no template of its own. The note is hers only — she
// forwards the posts under it, never the note itself.
const BALANCE_ALERT_USD = Number(process.env.BALANCE_ALERT_USD) || 10;
const TWILIO_BILLING_URL = "https://console.twilio.com/us1/billing/manage-billing/billing-overview";

function balanceWarning(balance, threshold = BALANCE_ALERT_USD) {
  if (!Number.isFinite(balance) || balance >= threshold) return "";
  return [
    `🚨 היתרה בחשבון Twilio נמוכה: $${balance.toFixed(2)}.`,
    "כשהיא נגמרת הבוט מפסיק לשלוח הודעות. צריך להטעין כאן:",
    TWILIO_BILLING_URL,
  ].join("\n");
}

// A failed lookup must never cost the board: it is logged and the board goes without.
async function lowBalanceWarning(lookup = fetchBalance) {
  try {
    const { balance } = await lookup();
    return balanceWarning(balance);
  } catch (err) {
    console.error("failed to read the Twilio balance:", err.message);
    return "";
  }
}

function withBalanceWarning(posts, warning) {
  if (!warning || !posts.length) return posts;
  const [intro, ...rest] = posts;
  return [{ ...intro, text: `${warning}\n\n${intro.text}` }, ...rest];
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

    const events = loadEvents(EVENTS_FILE);
    const slotPosts = buildSlotPosts(events, localDate, slot);
    if (!slotPosts.length) continue; // the 10:00 ads slot with nothing booked
    const posts = withBalanceWarning(slotPosts, await lowBalanceWarning());
    if (!(await sendPostsToStav(key, posts))) {
      sentBoards.delete(key); // nothing went out: let the next check retry within the window
      saveState();
    }
  }

  // After the slots, so an ad a slot just sent is already marked and not sent twice.
  await sendLateAds(now);
}

// Sends one batch to Stav in order and holds it until delivery is confirmed. Resolves to
// false when nothing went out, so the caller can let the next check retry.
async function sendPostsToStav(key, posts) {
  let sent = 0;
  try {
    // Goes to Stav, not the group: WhatsApp's API can't post into a normal group
    // (channels.md), so she forwards it — and gets to eyeball it first.
    let firstSid = "";
    for (const post of posts) {
      const result = await sendSlotPost(post);
      if (!firstSid) firstSid = result.sid;
      sent += 1;
    }
    // A resolved send is not delivery: the slots fire when Stav is usually not
    // mid-conversation, so her 24h WhatsApp window is typically closed and Twilio
    // drops the message with 63016. Every board between 16 Aug and 23 Aug 2026 was
    // lost this way, silently. Hold it until confirmed. The posts stay separate (with
    // their flyers): she forwards each one as is, and a single joined message had her
    // cutting it apart by hand (29/10/2026).
    //
    // A late-ad key is the window's start, the same as that window's slot key, so it can
    // meet a batch still queued under it; the two are kept together rather than one
    // overwriting the other, and each confirm or flush removes only its own posts.
    pendingBoards.set(key, [...(pendingBoards.get(key) || []), ...posts]);
    saveState();
    confirmBoardDelivery(key, firstSid, posts);
    return true;
  } catch (err) {
    console.error(`failed to send the ${key} messages:`, err);
    if (sent > 0 || err.sentParts > 0) {
      // Some of it already reached Stav. Retrying from the top re-sent it every five
      // minutes, so only the rest is queued, for her next message.
      const rest = [err.sentParts > 0 ? { ...posts[sent], text: err.unsent, mediaUrl: "" } : posts[sent], ...posts.slice(sent + 1)];
      pendingBoards.set(key, [...(pendingBoards.get(key) || []), ...rest]);
      saveState();
      return true;
    }
    return false;
  }
}

// Hands Stav every late ad (lateAds) in one batch, under a note saying they are late.
// Keyed `${date}:${window start}`, the same key as that window's slot, because
// sendSlotReadyPing reads the time back with key.slice(11); a batch still queued under
// it is kept alongside (sendPostsToStav). Runs one at a time: the interval and a fresh
// booking can both call it, and two runs reading the file before either marks
// ad_sent_at would send twice.
let lateAdsRun = Promise.resolve();

function sendLateAds(now = new Date()) {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  const run = lateAdsRun.then(() => sendLateAdsNow(now));
  lateAdsRun = run.catch((err) => console.error("failed to send late ads:", err));
  return lateAdsRun;
}

async function sendLateAdsNow(now) {
  const local = israelClock(now);
  // An ad already queued for Stav is not late, it is waiting for her window to reopen.
  const queued = new Set(
    [...pendingBoards.values()].flat().filter((post) => post.isAd).map((post) => String(post.eventId))
  );
  const late = lateAds(loadEvents(EVENTS_FILE), local).filter(({ event }) => !queued.has(String(event.id)));
  if (!late.length) return;

  // Only one window is open at a time, so every late ad shares it. The date line is
  // worked out for that window, the one the ad actually goes in.
  const { window } = late[0];
  const posts = late.map(({ event }) => ({ ...adPost(event, local.date, window.key), label: adLabel(event) }));
  const note = [
    `⏰ ${late.length === 1 ? "מודעה באיחור" : `${late.length} מודעות באיחור`} — להעביר לקבוצה כבר עכשיו, בחלון ה${window.label} (${window.start}-${window.end}), ${postCount(posts.length)}, לפי הסדר:`,
    "",
    ...posts.map((post, i) => `${i + 1}. ${post.label}`),
    "",
    "כל ההודעות שמתחת לזו — להעביר כמו שהן.",
  ].join("\n");
  await sendPostsToStav(`${local.date}:${window.start}`, [{ text: note }, ...posts.map(forwardable)]);
}

// Twilio attaches one image per message, so an ad goes as its own post. A failed image
// must not lose the ad: the post goes again as text only. Either way the ad is marked
// as handed over, so neither the slot nor lateAds sends it again.
async function sendSlotPost(post) {
  let result;
  if (!post.mediaUrl) {
    result = await sendWhatsApp(ADMIN_SENDER, post.text);
  } else {
    try {
      result = await sendWhatsApp(ADMIN_SENDER, post.text, post.mediaUrl);
    } catch (err) {
      console.error(`failed to send the flyer for event #${post.eventId}, sending its text alone:`, err);
      result = await sendWhatsApp(ADMIN_SENDER, post.text);
    }
  }
  if (post.isAd && post.eventId) markAdSent(post.eventId);
  return result;
}

function markAdSent(id) {
  storeUpdateEvent(EVENTS_FILE, id, { ad_sent_at: new Date().toISOString() });
}

// Takes the given posts (by identity) off the key's queue, and the key once it is empty.
// A key can hold more than one batch (a late ad meeting its window's board), so deleting
// or overwriting the whole key dropped a batch that was still undelivered.
function removeQueuedPosts(key, posts) {
  const queued = pendingBoards.get(key);
  if (!queued) return;
  const done = new Set(posts);
  const rest = queued.filter((post) => !done.has(post));
  if (rest.length) pendingBoards.set(key, rest);
  else pendingBoards.delete(key);
}

// Mirrors confirmAdminNotification: poll detached, and on a non-delivery leave the board
// queued so the next message from Stav re-sends it inside her reopened window. posts is
// the batch this sid started; only those leave the queue. getStatus is injectable so the
// suite can confirm without asking Twilio.
async function confirmBoardDelivery(key, sid, posts, getStatus = getMessageStatus) {
  try {
    const status = await getStatus(sid);
    const outsideWindow = Number(status.error_code) === WHATSAPP_OUTSIDE_WINDOW_ERROR;
    if (UNDELIVERED_STATUSES.has(status.status) || outsideWindow) {
      console.error(
        `${key} board was not delivered (status=${status.status}, error=${status.error_code}); queued for the next admin contact`
      );
      // Waiting for her next message lost every Saturday she didn't happen to write
      // (24/10/2026: both slots, on a busy day). The template is the one thing a closed
      // window lets through; her tap reopens it, and that flushes the queue.
      await sendSlotReadyPing(key);
      return;
    }
    removeQueuedPosts(key, posts);
    saveState();
  } catch (err) {
    console.error(`failed to confirm delivery of ${key} board:`, err);
  }
}

// Approved by Meta as a Utility template (submit-slot-ready-template.js). Its single
// button sends SLOT_READY_KEY back, which handleAdminMessage answers by flushing the
// queued boards.
const SLOT_READY_TEMPLATE = "fomo_slot_ready";
const SLOT_READY_KEY = "שלח";
const SLOT_READY_OPTIONS = [
  { key: "שלח", label: "לקבל את ההודעות" },
];

// Stopgap while SLOT_READY_TEMPLATE awaits Meta: an already-approved template whose
// variables are free text. It has no button, so {{1}} asks her to write anything; any
// message from her flushes the queue. Body: "היי! 👋 עוד קצת ומתחיל {{1}}, ב-{{2}}. תהנו! 🎈"
const SLOT_READY_FALLBACK_TEMPLATE = "fomo_event_reminder";
const SLOT_READY_FALLBACK_TEXT = "סבב ההודעות לקבוצה (כתבו כאן כל דבר כדי לקבל אותן)";

async function sendSlotReadyPing(key) {
  try {
    await ensureTemplates();
    const slot = key.slice(11); // `${date}:${slot}`
    if (!approvedTemplateSid(SLOT_READY_TEMPLATE)) {
      const fallbackSid = approvedTemplateSid(SLOT_READY_FALLBACK_TEMPLATE);
      if (!fallbackSid) {
        console.error(`neither ${SLOT_READY_TEMPLATE} nor ${SLOT_READY_FALLBACK_TEMPLATE} is approved; the ${key} board waits for her next message`);
        return;
      }
      await postForm({
        To: ADMIN_SENDER,
        ContentSid: fallbackSid,
        ContentVariables: JSON.stringify({ 1: SLOT_READY_FALLBACK_TEXT, 2: slot }),
      });
      return;
    }
    await sendChoice(ADMIN_SENDER, {
      text: `ההודעות להעברה לקבוצה ב-${slot} מוכנות.`,
      options: SLOT_READY_OPTIONS,
      template: SLOT_READY_TEMPLATE,
      variables: { 1: slot },
    });
  } catch (err) {
    console.error(`failed to send the slot-ready ping for ${key}:`, err);
  }
}

// Re-sends any board that never reached Stav. Called when she messages the bot, which is
// itself proof the 24h window is open again.
//
// Stav's messages arrive as separate webhook hits, each calling this detached (not
// awaited by handleAdminMessage). Without a lock, two messages seconds apart both
// snapshot the same still-pending key and both send it before either await resolves
// and deletes it - she got the same board 3-4 times over. One in-flight flush at a
// time; a call that arrives mid-flush just waits for it instead of racing it.
let flushingBoards = null;

// Resolves to how many boards went out, so a tap on the slot-ready button can say so.
// sendPost is injectable so the suite can flush without sending; without it, a test run
// sends nothing.
async function flushPendingBoards(sendPost = null) {
  if ((process.env.NODE_ENV === "test" && !sendPost) || !pendingBoards.size) return 0;
  const send = sendPost || sendSlotPost;
  if (flushingBoards) return flushingBoards;
  flushingBoards = (async () => {
    let sent = 0;
    const today = israelClock(new Date()).date;
    for (const key of [...pendingBoards.keys()]) {
      // Read as the key comes up, not up front: a confirm during an earlier key's sends
      // may already have taken some of these off.
      const posts = pendingBoards.get(key);
      if (!posts) continue; // sent by an earlier flush already
      // A board from a day that has passed headlines "what's on today" for yesterday;
      // forwarding it would mislead the group, so it is dropped, not sent late.
      if (key.slice(0, 10) < today) {
        console.error(`dropping the ${key} board: its day has passed`);
        // An ad in it never reached her. Unmarked, lateAds hands it over again, with a
        // date line for the day it actually goes, if the event is still ahead.
        for (const post of posts) {
          if (post.isAd && post.eventId) storeUpdateEvent(EVENTS_FILE, post.eventId, { ad_sent_at: "" });
        }
        removeQueuedPosts(key, posts);
        continue;
      }
      // posts is a snapshot: a batch queued under this key while these sends are awaited
      // is not part of it, and stays queued for the next flush.
      let done = 0;
      try {
        for (const post of posts) {
          await send(post);
          done += 1;
        }
        removeQueuedPosts(key, posts);
        sent += 1;
      } catch (err) {
        console.error(`failed to re-send ${key} board:`, err);
        // Only what didn't go out stays queued, so the next flush doesn't repeat posts.
        removeQueuedPosts(key, posts.slice(0, done));
      }
    }
    saveState();
    return sent;
  })();
  try {
    return await flushingBoards;
  } finally {
    flushingBoards = null;
  }
}


// An event whose date has passed can't be published, so asking Stav to decide about it is
// busywork - she was being nagged daily about #3 and #5 with no useful action available.
// It closes itself instead.
//
// Status is "expired" rather than "rejected" so the record still says what happened: nobody
// judged this event, it just ran out of time. The submitter is not notified either; from
// their side nothing was decided, and a "your event was declined" message days after the
// fact would be both confusing and slightly insulting.
// needs_info is a submission forwarded with gaps. It waits for Stav like any other, but
// the pending list only knew "submitted", so these never showed up there.
const AWAITING_REVIEW = new Set(["submitted", "needs_info"]);

// An event the organizer never confirmed closes the same way, and so does its question.
function expirePastEvents(events, today = todayIso()) {
  const stale = events.filter(
    (e) => (AWAITING_REVIEW.has(e.status) || e.status === "awaiting_confirm") && e.date && lastDay(e) < today
  );
  for (const event of stale) {
    storeUpdateEvent(EVENTS_FILE, event.id, {
      status: "expired",
      notes: `${event.notes} | פג תוקף: התאריך עבר`.trim(),
    });
  }
  const staleIds = new Set(stale.map((e) => String(e.id)));
  let droppedQuestion = false;
  for (const [sender, pending] of awaitingConfirmation) {
    if (staleIds.has(String(pending.eventId))) {
      awaitingConfirmation.delete(sender);
      droppedQuestion = true;
    }
  }
  if (droppedQuestion) saveState();
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
    if (!event.date || lastDay(event) >= today) continue;
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

// Counts are mentioned only above this. A small number ("3 people viewed your event")
// reads like a failure, not a success, so below it the goodbye says nothing about views.
const MIN_VIEWS_TO_MENTION = 10;

// One event keeps the original wording. Several become one message that names them,
// because "thanks for publishing" repeated verbatim reads like a broken bot rather
// than a thank-you.
function goodbyeMessage(theirs) {
  // Only mentioned when there is something to mention: "0 people viewed your event"
  // is worse than saying nothing at all.
  const viewsFor = (event) => (event.slug ? clickStats({ eventId: event.id }).total : 0);

  if (theirs.length === 1) {
    const views = viewsFor(theirs[0]);
    const tail = views > MIN_VIEWS_TO_MENTION ? `\n\n${views} אנשים צפו בקישור לאירוע שלכם דרך FOMO 📈` : "";
    return `${goodbyeText()}${tail}`;
  }

  const lines = [`איזה כיף שפרסמתם אצלנו ${theirs.length} אירועים!`, "", "תהנו 🎉", ""];
  let total = 0;
  for (const event of theirs) {
    const views = viewsFor(event);
    total += views;
    lines.push(`• ${event.event_name}${views > MIN_VIEWS_TO_MENTION ? ` — ${views} צפיות` : ""}`);
  }
  if (total > MIN_VIEWS_TO_MENTION) {
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
    if (!event.flyer || !event.date || lastDay(event) >= today) continue;
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
  const pending = events.filter((e) => AWAITING_REVIEW.has(e.status));
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
// Weekly nudge to publishers: Wednesday 18:00, ahead of the weekend.
// ---------------------------------------------------------------------------

// Wednesday, because that is when people are planning the weekend, and late enough in
// the week that an event sent now still makes the Friday and Saturday slots.
const WEEKLY_NUDGE_SLOT = { day: 3, sendHour: 18, sendMinute: 0 };

// The wordings and buttons live in nudge-variants.js, one Meta template per wording, all
// submitted as MARKETING (submit-nudge-template.js): it is promotional, and Meta
// re-categorised the friendlier reminder template as marketing anyway.
const { NUDGE_OPT_OUT_KEY, NUDGE_OPTIONS, NUDGE_VARIANTS } = require("./nudge-variants");
// The free-text version cannot carry buttons, so it spells out what they would do.
function nudgeFreeText(variant) {
  return `${variant.text}

לפרסום כתבו 2 · כדי להפסיק לקבל את התזכורת הזו כתבו "${NUDGE_OPT_OUT_KEY}"`;
}
const NUDGE_OPT_OUT_TEXT = "הסרנו אתכם מהתזכורת השבועית. תמיד אפשר לשלוח לנו אירוע כאן 💙";

// Published at least once. A published event Stav later cancelled or that its submitter
// cancelled still counts (published_at survives the status change); one she rejected
// does not, and neither does anything that only ever sat in review.
function wasPublished(event) {
  if (event.status === "published") return true;
  return Boolean(event.published_at) && event.status !== "rejected";
}

// Everyone who has had an event published, once each. Stav is excluded (she is the one
// publishing them), as is anyone who opted out or is mid-draft — a nudge to send an
// event, landing in the middle of sending one, would only confuse the draft.
function nudgeRecipients(events) {
  const recipients = new Set();
  for (const event of events) {
    const sender = event.submitter;
    if (!sender || sender === ADMIN_SENDER || !wasPublished(event)) continue;
    if (nudgeOptOuts.has(sender) || activeSubmissions.has(sender)) continue;
    recipients.add(sender);
  }
  return [...recipients];
}

// One wording for the whole week, drawn at random and never last week's. Approved
// wordings are preferred, since only they reach people whose window is closed (nearly
// everyone). If none but last week's is approved, an unapproved one is still drawn
// rather than repeating: it reaches only open windows that week, which is the price of
// never sending the same words twice in a row. A pool of one has no choice but to repeat.
function pickNudgeVariant(lastId, isApproved, random = Math.random) {
  const fresh = NUDGE_VARIANTS.filter((variant) => variant.id !== lastId);
  const approved = fresh.filter(isApproved);
  const pool = approved.length ? approved : fresh.length ? fresh : NUDGE_VARIANTS;
  return pool[Math.floor(random() * pool.length)];
}

// Same clock-based slot as sendDuePendingReminder, for the same reason: setInterval(7d)
// would never survive Fly suspending the machine.
//
// `deliver` and `isApproved` are injectable so the suite can check who is messaged, and
// with which wording, without sending or asking Twilio.
async function sendDueWeeklyNudge(now = new Date(), deliver = deliverNudge, isApproved = null) {
  const local = israelClock(now);
  if (local.day !== WEEKLY_NUDGE_SLOT.day || !isDue(local, WEEKLY_NUDGE_SLOT)) return;
  if (sentNudges.has(local.date)) return;
  if (!isApproved) {
    if (process.env.NODE_ENV !== "test") await ensureTemplates();
    isApproved = (variant) => Boolean(approvedTemplateSid(variant.template));
  }
  const variant = pickNudgeVariant(lastNudgeVariant, isApproved);
  // Claimed before sending: a crash mid-run can at worst skip someone this week, never
  // message them twice.
  sentNudges.add(local.date);
  lastNudgeVariant = variant.id;
  saveState();
  console.log(`weekly nudge ${local.date}: "${variant.id}" (${isApproved(variant) ? "approved" : "not approved, open windows only"})`);

  for (const sender of nudgeRecipients(loadEvents(EVENTS_FILE))) {
    try {
      await deliver(sender, lastInbound.get(sender) || 0, variant);
    } catch (err) {
      console.error(`failed to send the weekly nudge to ${sender}:`, err);
    }
  }
}

// Buttons through the approved template whenever there is one. Without it, only people
// whose 24h window is provably open get the free-text version: outside the window Twilio
// accepts text and then drops it (63016), so sending it would only look like it worked.
async function deliverNudge(sender, lastInboundMs, variant) {
  if (process.env.NODE_ENV === "test") return;
  await ensureTemplates();
  if (approvedTemplateSid(variant.template)) {
    await sendChoice(sender, { text: variant.text, options: NUDGE_OPTIONS, template: variant.template });
    return;
  }
  if (windowIsOpen(lastInboundMs)) {
    await sendWhatsApp(sender, nudgeFreeText(variant));
    return;
  }
  console.error(`${variant.template} is not approved and ${sender}'s window is closed; skipping their weekly nudge`);
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
        lastInboundMs: lastInbound.get(reminder.sender) || 0,
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
  contactDeclined.delete(sender);
  awaitingIntentConfirm.delete(sender);
  offeredEscape.delete(sender);
  activeInquiries.delete(sender);
  activeInquiryHistories.delete(sender);
  recentlyCompleted.delete(sender);
  awaitingCancelChoice.delete(sender);
  // An edit left open would swallow her next message, in either role.
  if (sender === ADMIN_SENDER) awaitingAdminEdit = "";
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
    awaitingIntentConfirm.has(sender) ||
    (sender === ADMIN_SENDER && Boolean(awaitingAdminEdit))
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
  for (const [sender, seenAt] of lastInbound) {
    if (now - seenAt < LAST_INBOUND_TTL_MS) continue;
    lastInbound.delete(sender);
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
4. שירות לקוחות
5. לבטל אירוע שפרסמתי`;

const ASK_EVENT_DETAILS_TEXT = "שלחו את פרטי האירוע בפורמט חופשי.";

const ASK_INQUIRY_TEXT = "מה תרצו לדעת על האירועים? (לדוגמה: \"אילו אירועי מוזיקה יש היום?\"). כתבו \"ביטול\" כדי לצאת.";

const PRICE_PLACEHOLDER_TEXT = "מחיר הפרסום: יעודכן בקרוב, פנו אלינו לפרטים.";

const CUSTOMER_SERVICE_TEXT = "לשירות לקוחות פנו לסתיו: +972528762432";

// Sent when the message after a submission is a genuine amendment ("actually it's
// tomorrow"). The old copy told them the event "was already sent, no need to resend" and
// dropped the text — a correction to a date or price was silently thrown away. Forward it
// to Stav instead and say so, so the submitter knows their fix landed.
const AMENDMENT_FORWARDED_TEXT = "העברנו את התוספת לסתיו, היא תעדכן את האירוע לפני הפרסום.";
// A correction applied while the event is still under review, naming what changed.
function amendmentAppliedText(changed) {
  const labels = changed.map((key) => FIELD_LABEL_FOR_KEY.get(key) || key).join(", ");
  return `עדכנו באירוע: ${labels} ✏\nסתיו תקבל את הגרסה המעודכנת לבדיקה.`;
}

// A follow-up right after a submission is either a question about it ("when will this be
// published?") or a correction to it ("actually it's tomorrow"). Only the correction
// carries content Stav needs; a question is answered by the standing acknowledgement.
// Questions are the narrower, more recognisable set, so detect those and treat the rest
// as a correction — the failure mode that matters is dropping a fix, not forwarding one
// question too many.
// Not \b: JS word boundaries only know ASCII letters, so "מה\b" never matched "מה קורה"
// and only a literal question mark was ever detected.
const QUESTION_MARKERS = /[?？]|^(מתי|איפה|מה|האם|כמה|למה|איך|מי)(\s|$)/;

function looksLikeQuestion(text) {
  return QUESTION_MARKERS.test(text.trim());
}

// A forwarded announcement, recognisable without the model: it says when, plus where or
// how to get in. Stav forwards events cold, without picking "publish" first, and the
// classifier calling one "other" (or timing out) dropped her back at the menu
// (16/10/2026). Only consulted when the model did not say "inquire".
const ANNOUNCEMENT_WHEN_RE = /\d{1,2}[./]\d{1,2}|\d{1,2}:\d{2}|יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מוצ"?ש|הערב|מחר/;
const ANNOUNCEMENT_DETAIL_RE = /https?:\/\/|www\.|\d{9,}|📍|כתובת|רחוב|כניסה|כרטיס|₪|ש"ח|ש״ח/;
const ANNOUNCEMENT_MIN_LENGTH = 120;

function looksLikeEventAnnouncement(text) {
  const value = String(text || "").trim();
  if (!value || looksLikeQuestion(value)) return false;
  if (!ANNOUNCEMENT_WHEN_RE.test(value)) return false;
  return ANNOUNCEMENT_DETAIL_RE.test(value) || value.length >= ANNOUNCEMENT_MIN_LENGTH;
}

// Pushback, as distinct from a question. "I'm interested in an event, not marketing one"
// has no question mark and starts with no interrogative, but it is the clearest possible
// signal that someone is in the wrong flow. Kept narrow and matched anywhere in the
// message: these are phrases people reach for only once the bot has misunderstood them.
// Note the final-letter variants: מפרסם and מפרסמת are different strings, and a prefix
// written with a medial mem matches neither.
const OBJECTION_MARKERS = /לא רוצה|לא מעוניינ|לא שלי|לא לפרסם|לא לשווק|לא מפרסמ?[םת]|לא מארגנ|לא הבנת|לא נכון|טעות|מעניין אותי/;

function looksLikeObjection(text) {
  return OBJECTION_MARKERS.test(text.trim());
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
  if (key === "date" || key === "end_date") return isValidDate(value);
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

const CONTACT_LABEL = "קישור / איש קשר";

// "אין" is a complete answer to "what's the link or phone?", but the old flow handed it to
// the extractor like any other detail. Nothing got filled in, so the same question came
// straight back, and the submitter either gave up with "ביטול" (lost the event: 25/09/2026)
// or said "אין" twice and got a curt fallback with no receipt. Short, and starting with a
// "no", so a real contact ("אין לנו אתר, 054-1234567") is still read as one: the caller
// checks the extractor found nothing first.
const NO_CONTACT_RE = /^(אין|לא|אינ|no\b|none|nope|n\/a|-+|—)/i;

function declinesContact(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length > 0 && trimmed.length <= 40 && NO_CONTACT_RE.test(trimmed);
}

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
// daily-board line and the ad, the same two renderings the organizer confirmed
// (previewRenderings). It used to be a field dump — labelled name/date/time lines —
// which meant a misparsed price or an awkward description only became visible after
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

  const { short, ad } = previewRenderings(event);
  return [
    `אירוע חדש לבדיקה #${id}`,
    `נשלח מ: ${sender}`,
    uncertaintyNote || null,
    "",
    "— לוח יומי (מקוצר) —",
    short,
    "",
    // Names the flyer only when there is one, as the organizer's preview does.
    ad.mediaUrl ? "— מודעה גרפית (מורחבת, עם הפלייר) —" : "— מודעה גרפית (מורחבת) —",
    ad.text,
    "",
    `לאישור: אשר ${id}`,
    `לעריכה: ערוך ${id}`,
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
//
// No template retry here for the preview itself: it carries a flyer image plus a full
// paragraph of free text, which Meta will not approve as a template body. The actual
// fallback is sendReviewButtons, sent unconditionally right after this in
// forwardEventToAdmin — it goes through fomo_review_event via ContentSid, which (unlike
// this preview) bypasses the 24h window whenever that template is approved. So the ping
// reaches her regardless; only the flyer/description preview is what a closed window can
// still cost her, and missedNoticesBanner is what surfaces that on her next message.
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

// The branded card WhatsApp shows when /today is linked (1200x630). Optional: without the
// file the page carries no og:image and the preview falls back to its title and text.
const OG_CARD_FILE = path.join(__dirname, "assets", "og-card.png");

function absoluteUrl(pathname) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/, "")}${pathname}` : "";
}

function ogCardUrl() {
  return fs.existsSync(OG_CARD_FILE) ? absoluteUrl("/og-card.png") : "";
}

// WhatsApp builds a link preview from these. og:image has to be an absolute URL, so it
// is left out when there is none to give.
function ogTags({ title, description, image }) {
  return [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : "",
  ].filter(Boolean).join("\n");
}

const PAGE_STYLE = `<style>
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
  .event { padding: 12px 0; border-top: 1px solid #eee7dd; }
  .event:first-of-type { border-top: 0; }
  .when { font-weight: 700; font-size: 1.05rem; }
  .when a { color: inherit; }
  .details { color: #6b6560; font-size: .95rem; margin-top: 3px; }
  img { width: 100%; border-radius: 12px; margin-top: 18px; display: block; }
  .foot { margin-top: 20px; font-size: .82rem; color: #8a837c; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #17150f; color: #f2ede4; }
    .card { background: #221f18; box-shadow: none; }
    .desc { color: #ccc5b8; border-top-color: #332f26; }
    .event { border-top-color: #332f26; }
    .cat, .foot, .details { color: #9a938a; }
  }
</style>`;

// Where a short link lands when the submitter gave a contact rather than a URL, which
// is the common case. Self-contained: one file, no external assets, so it renders on a
// phone with a bad connection and nothing to fetch.
function eventLandingPage(event) {
  const dates = event.date ? `${longDate(event.date)}${lastDay(event) !== event.date ? `–${longDate(lastDay(event))}` : ""}` : "";
  const rows = [
    ["📅", dates],
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
  const og = ogTags({
    title: event.event_name,
    description: [dates, event.start_time, event.location].filter(Boolean).join(" · "),
    image: (event.flyer && flyerUrl(event.flyer)) || ogCardUrl(),
  });

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(event.event_name)} · FOMO חיפה</title>
${og}
${PAGE_STYLE}
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

// /today, the link at the top of the daily board: the board's events, each opening its
// own /e/ page. Its og: tags are the branded preview WhatsApp shows above the board.
function todayPage(events, date) {
  const today = digestEvents(events, date);
  const title = "מה עושים היום בחיפה?";
  const items = today.map((event) => {
    const name = escapeHtml(`${event.start_time} · ${event.event_name}`);
    const link = shortLink(event);
    const details = [event.location ? `📍 ${event.location}` : "", entranceLabel(event)].filter(Boolean).join(" · ");
    return [
      `<div class="event">`,
      `      <div class="when">${/^https?:\/\//.test(link) ? `<a href="${escapeHtml(link)}">${name}</a>` : name}</div>`,
      details ? `      <div class="details">${escapeHtml(details)}</div>` : "",
      `    </div>`,
    ].filter(Boolean).join("\n");
  });
  const count = today.length === 1 ? "אירוע אחד" : `${today.length} אירועים`;
  const og = ogTags({
    title,
    description: today.length ? `${longDate(date)} · ${count}` : longDate(date),
    image: ogCardUrl(),
  });

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · FOMO חיפה</title>
${og}
${PAGE_STYLE}
</head>
<body>
  <div class="card">
    <div class="brand">FOMO חיפה</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="cat">${escapeHtml(longDate(date))}</div>
    ${items.length ? items.join("\n    ") : `<div class="row">אין אירועים היום עדיין.</div>`}
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

// v1 (fomo_review_event) reads "כל הפרטים המלאים מופיעים בהודעה שמעל" and invites a
// swipe-reply to that message — wording that assumes the preview above it was delivered.
// It is sent as the one thing that survives a closed 24h window, i.e. exactly when that
// preview did NOT arrive, so the reply-to-message-above instruction pointed at nothing:
// WhatsApp answered her swipe with "אין הודעה מעל" (event #38, 22/09/2026). v2 is
// self-contained — no reference to another message — so the fallback holds up even when
// it is the only thing she received.
const REVIEW_TEMPLATE = "fomo_review_event_v2";
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
  if (process.env.NODE_ENV === "test") {
    const stored = storeFindEvent(EVENTS_FILE, id) || { ...event, flyer };
    outbox.push({ to: ADMIN_SENDER, text: formatEventForReview(id, stored, sender, unresolved), mediaUrl: "" });
    return;
  }
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

// The same event submitted again — retried by its submitter, or sent by a second
// organiser — used to become a second row, a second review for Stav and, once both were
// approved, two identical lines on the board (#69/#71, #73/#74, 21/10/2026). The copy
// already on file is kept; the new one is not saved. CANCELLABLE_STATUSES includes
// awaiting_confirm, so an event still waiting on its organizer counts as on file.
function findDuplicateEvent(event) {
  return loadEvents(EVENTS_FILE).find((other) => CANCELLABLE_STATUSES.has(other.status) && isSameEvent(other, event));
}

// A new image from the event's own submitter becomes its flyer, replacing any earlier
// one. Sending the poster again was the only way a submitter could add or swap one, and
// the duplicate check above would otherwise drop it. Cleared flyer_sent_at so the new
// image goes out in the next slot. Returns "" when nothing changed (the same image).
function replaceFlyer(existing, image) {
  const name = saveFlyer(image, existing.id);
  if (!name || name === existing.flyer) return "";
  storeUpdateEvent(EVENTS_FILE, existing.id, { flyer: name, flyer_sent_at: "" });
  if (existing.flyer) deleteFlyer(existing.flyer);
  return name;
}

async function acknowledgeDuplicate(sender, existing, image = "") {
  // A correction that follows lands on the copy that was kept.
  lastSubmittedEventId.set(sender, existing.id);
  saveState();
  const own = existing.submitter === sender;
  const newFlyer = own && image ? replaceFlyer(existing, image) : "";

  // Their own event, still waiting on their confirmation: Stav hasn't seen it, so she is
  // not told. Show them the versions again and reopen the question.
  if (own && existing.status === "awaiting_confirm") {
    awaitingConfirmation.set(sender, { eventId: existing.id, unresolved: [] });
    recentlyCompleted.delete(sender);
    saveState();
    return reshowPreviews(sender, existing.id);
  }

  // Someone else's submission matched: tell Stav, so a false match — two real events
  // at one address and hour — can still be added by hand. Their image is shown to her
  // but never replaces the organiser's flyer.
  let notice = "";
  let noticeImage = "";
  if (newFlyer) {
    notice = `🖼 ${existing.flyer ? "פלייר חדש" : "פלייר"} לאירוע #${existing.id} (${existing.event_name}), מ: ${sender}\n${existing.flyer ? "הוחלף באירוע" : "צורף לאירוע"}, ויישלח בהודעה היומית הבאה שהאירוע מופיע בה.`;
    noticeImage = flyerUrl(newFlyer);
  } else if (!own && existing.status === "awaiting_confirm") {
    // Stav has not seen this one: its organizer has not confirmed it yet. Someone else
    // sending it is no confirmation, but she can approve it herself.
    notice = `🔁 אירוע #${existing.id} (${existing.event_name}) נשלח גם מ: ${sender}\nהוא עדיין מחכה לאישור של מי ששלח אותו. אפשר לאשר אותו כבר עכשיו: אשר ${existing.id}`;
    if (image) {
      notice += "\nהתמונה שצירפו מצורפת כאן, והפלייר של האירוע לא הוחלף.";
      noticeImage = flyerUrl(saveFlyer(image, `${existing.id}-offered`));
    }
  } else if (!own) {
    notice = `🔁 אירוע #${existing.id} (${existing.event_name}) נשלח שוב, מ: ${sender}\nלא נוסף כאירוע חדש.`;
    if (image) {
      notice += "\nהתמונה שצירפו מצורפת כאן, והפלייר של האירוע לא הוחלף.";
      noticeImage = flyerUrl(saveFlyer(image, `${existing.id}-offered`));
    }
  }
  if (notice && process.env.NODE_ENV === "test") {
    outbox.push({ to: ADMIN_SENDER, text: notice, mediaUrl: noticeImage });
  } else if (notice) {
    try {
      await sendWhatsApp(ADMIN_SENDER, notice, noticeImage);
    } catch (err) {
      console.error(`failed to tell the admin about a duplicate of event #${existing.id}:`, err);
    }
  }

  if (!own && existing.status === "awaiting_confirm") {
    return "האירוע הזה כבר אצלנו ומחכה לאישור של מי ששלח אותו. העברנו את זה לסתיו.";
  }

  if (newFlyer) {
    return [
      `עדכנו את הפלייר של האירוע 🙌`,
      `📌 ${existing.event_name}${existing.date ? ` · ${longDate(existing.date)}` : ""}`,
      "",
      "משהו נוסף לתקן? פשוט כתבו לנו כאן.",
    ].join("\n");
  }
  const status = existing.status === "published" ? "וכבר אושר לפרסום" : "והוא בבדיקה";
  return [
    `האירוע הזה כבר אצלנו ${status} 🙌`,
    `📌 ${existing.event_name}${existing.date ? ` · ${longDate(existing.date)}` : ""}`,
    "",
    "אין צורך לשלוח אותו שוב. משהו לא נכון? פשוט כתבו לנו כאן מה לתקן.",
  ].join("\n");
}

// A correction the submitter sent right after their event. Goes to Stav as plain text
// rather than being re-extracted: it's usually a fragment ("actually it's tomorrow") that
// only means anything against the event it amends, and she's editing the row by hand anyway.
async function forwardAmendmentToAdmin(id, text, sender) {
  const body = `✏ תוספת לאירוע #${id}\nמאת: ${sender}\n\n${text}`;
  // Recorded under test, so the suite can tell a forwarded message from one kept back.
  if (process.env.NODE_ENV === "test") {
    outbox.push({ to: ADMIN_SENDER, text: body, mediaUrl: "" });
    return;
  }
  try {
    await sendWhatsApp(ADMIN_SENDER, body);
  } catch (err) {
    console.error(`failed to forward amendment for event #${id}:`, err);
  }
}

// An event approved today after its last board: the board's short form, on its own, for
// Stav to forward. No flyer: a flyer reaches the group only in a booked ad.
async function sendShortToAdmin(id, event) {
  const text = formatShort(event, SLOT_LINKS);
  if (process.env.NODE_ENV === "test") {
    outbox.push({ to: ADMIN_SENDER, text, mediaUrl: "" });
    return;
  }
  try {
    await sendWhatsApp(ADMIN_SENDER, text);
  } catch (err) {
    console.error(`failed to send event #${id} to the admin in short form:`, err);
  }
}

// A ready-to-forward post for the group. Same LONG rendering the daily message uses,
// so the group sees one consistent format however an event reaches it.
function formatPublishedPost(event) {
  return formatLong(event, { linkFor: shortLink, flyerUrl: (e) => flyerUrl(e.flyer), dateLine: dateLineFor(event), mapFor: mapLink }).text;
}

// Everything the bot says in tests is collected here instead of sent.
const outbox = [];

async function sendToSubmitter(sender, text, mediaUrl = "") {
  if (process.env.NODE_ENV === "test") {
    outbox.push({ to: sender, text, mediaUrl });
    return;
  }
  try {
    await sendWhatsApp(sender, text, mediaUrl);
  } catch (err) {
    console.error("failed to notify submitter:", err);
  }
}

async function notifySubmitter(sender, text) {
  await sendToSubmitter(sender, text);
}

// One path for a free-text correction, whoever sends it. Only the fields the text really
// changes are written; Stav's corrections are also recorded so the extractor learns.
async function applyCorrection(id, text, { byAdmin = false } = {}) {
  const event = storeFindEvent(EVENTS_FILE, id);
  if (!event) return { changed: [], event: null };
  return writeCorrection(event, await correctionUpdates(event, text), { byAdmin });
}

// What the text would change, without writing it: the fields it really changes, valid.
async function correctionUpdates(event, text) {
  const proposed = await extractEventModule.extractCorrection(event, text, todayIso());
  const updates = {};
  for (const key of FIELD_KEYS) {
    const value = proposed && proposed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const next = value.trim();
    if (next === (event[key] || "") || !fieldIsValid(key, next)) continue;
    updates[key] = next;
  }
  return updates;
}

function writeCorrection(event, updates, { byAdmin = false } = {}) {
  const id = event.id;
  const changed = Object.keys(updates);
  if (!changed.length) return { changed, event };
  storeUpdateEvent(EVENTS_FILE, id, updates);
  if (byAdmin) {
    for (const field of changed) {
      addCorrection(EVENTS_FILE, {
        field,
        wrongValue: event[field] || "",
        rightValue: updates[field],
        sourceText: event.description || event.event_name || "",
      });
    }
  }
  return { changed, event: storeFindEvent(EVENTS_FILE, id) };
}

// --- The organizer confirms both versions before Stav sees the event ---
const RECEIVED_TEXT = "קיבלנו את האירוע! 🎉\n\nככה הוא ייראה בקבוצה, בשתי גרסאות 👇";
const CONFIRM_PROMPT_TEXT = "הכול נכון?\n1. כן, שלחו לבדיקה\n\nמשהו לא נכון? פשוט כתבו כאן מה לשנות ✏";
const CONFIRMED_TEXT = "מעולה! האירוע עבר לבדיקה של סתיו. נעדכן אתכם כשיאושר 🙌";
const CORRECTION_UNCLEAR_TEXT = "לא הצלחנו להבין מה לשנות. כתבו למשל: \"המחיר הוא 50\".";
const confirmReminderText = (name) => `תזכורת: האירוע "${name}" עדיין מחכה לאישור שלכם.\nענו 1 כדי לשלוח אותו לבדיקה, או כתבו מה לשנות.`;
const CONFIRM_RE = /^(1|כן|אישור|מאשר|מאשרת|מאושר|אשר|נכון)[\s!.]*$/;
const CONFIRM_REMINDER_AFTER_MS = 3 * 60 * 60 * 1000;
const CONFIRM_REMINDER_NOTE = "נשלחה תזכורת אישור";
// The labels from the mockup. The ad's names the flyer only when there is one.
const PREVIEW_SHORT_LABEL = "*לוח יומי · מודעה מקוצרת*";
const PREVIEW_AD_LABEL = "*מודעה גרפית מורחבת*";
const PREVIEW_AD_FLYER_LABEL = "*מודעה גרפית מורחבת · כולל פלייר*";

// Both versions as the group would get them: the board line, and the ad with its flyer.
// The ad's posting day isn't known yet, so it carries the bold long date. Stav's review
// notice uses the same pair.
function previewRenderings(event) {
  const dateLine = event.date && isValidDate(event.date) ? `*${dateLineFor(event)}*` : "";
  return { short: formatShort(event, SLOT_LINKS), ad: formatLong(event, { ...SLOT_LINKS, mapFor: mapLink, dateLine }) };
}

function previewMessages(event) {
  const { short, ad } = previewRenderings(event);
  return [
    { text: `${PREVIEW_SHORT_LABEL}\n\n${short}`, mediaUrl: "" },
    { text: `${ad.mediaUrl ? PREVIEW_AD_FLYER_LABEL : PREVIEW_AD_LABEL}\n\n${ad.text}`, mediaUrl: ad.mediaUrl },
  ];
}

async function sendPreviews(sender, event) {
  for (const { text, mediaUrl } of previewMessages(event)) {
    await sendToSubmitter(sender, text, mediaUrl);
  }
}

// After a change: the updated versions, then the question again. The reminder clock
// restarts, since this is a fresh ask.
async function reshowPreviews(sender, id) {
  storeUpdateEvent(EVENTS_FILE, id, { confirm_asked_at: new Date().toISOString() });
  await sendPreviews(sender, storeFindEvent(EVENTS_FILE, id));
  return CONFIRM_PROMPT_TEXT;
}

// The answer to the confirm prompt. Returns null when the question no longer applies
// (Stav acted on the event by its id, or it was cancelled), so the message is routed as
// if it had never been asked.
async function handleConfirmation(sender, text, mediaUrls) {
  const pending = awaitingConfirmation.get(sender);
  const event = storeFindEvent(EVENTS_FILE, pending.eventId);
  if (!event || event.status !== "awaiting_confirm") {
    awaitingConfirmation.delete(sender);
    saveState();
    return null;
  }
  const trimmed = text.trim();

  if (mediaUrls.length) {
    // A poster with its own announcement is the next event. This one stays on Stav's
    // pending list, unconfirmed, and the reminder asks about it again.
    if (trimmed && looksLikeEventAnnouncement(trimmed)) {
      awaitingConfirmation.delete(sender);
      return startNextSubmission(sender, text, mediaUrls);
    }
    // A caption is a correction too ("new poster, and it's at 21:00"). Shown back
    // unapplied, the organizer would take the change as made. Guarded before the
    // download, so a refused caption leaves the flyer as it was.
    const refused = trimmed ? correctionRefusal(sender, text) : "";
    if (refused) return refused;
    let image;
    try {
      image = await fetchMediaModule.fetchMediaAsDataUrl(mediaUrls[0]);
    } catch (err) {
      console.error("failed to fetch a replacement flyer:", err);
      return MEDIA_FETCH_FAILED_TEXT;
    }
    replaceFlyer(event, image);
    const changed = trimmed ? (await applyCorrection(event.id, trimmed)).changed : [];
    // The flyer changed either way, so the previews always come back.
    const prompt = await reshowPreviews(sender, event.id);
    return trimmed && !changed.length ? `${CORRECTION_UNCLEAR_TEXT}\n\n${prompt}` : prompt;
  }

  if (CONFIRM_RE.test(trimmed)) {
    awaitingConfirmation.delete(sender);
    storeUpdateEvent(EVENTS_FILE, event.id, { status: "submitted" });
    recentlyCompleted.add(sender);
    lastSubmittedEventId.set(sender, event.id);
    saveState();
    const stored = storeFindEvent(EVENTS_FILE, event.id);
    await forwardEventToAdmin(event.id, stored, sender, pending.unresolved || [], stored.flyer);
    return CONFIRMED_TEXT;
  }

  if (!trimmed) return CONFIRM_PROMPT_TEXT;
  // Their next event pasted as text is not a change to this one: applied as a correction
  // it overwrote the event still waiting for their "1". Like a poster with its own
  // announcement, it starts a new submission, and this one stays on Stav's pending list,
  // unconfirmed, for the reminder to ask about again.
  if (looksLikeNewAnnouncement(trimmed)) {
    awaitingConfirmation.delete(sender);
    return startNextSubmission(sender, text, []);
  }
  const refused = correctionRefusal(sender, text);
  if (refused) return refused;
  const updates = await correctionUpdates(event, trimmed);
  // A new name and a new date is a different event, not a fix to this one.
  if (updates.event_name && updates.date) {
    awaitingConfirmation.delete(sender);
    return startNextSubmission(sender, text, []);
  }
  const { changed } = writeCorrection(event, updates);
  if (!changed.length) return `${CORRECTION_UNCLEAR_TEXT}\n\n${CONFIRM_PROMPT_TEXT}`;
  return reshowPreviews(sender, event.id);
}

// Text that reads as a whole new announcement. The length floor keeps a short correction
// that happens to name a time and a price ("21:00, כניסה 40 ₪") a correction.
function looksLikeNewAnnouncement(trimmed) {
  return trimmed.length >= ANNOUNCEMENT_MIN_LENGTH && looksLikeEventAnnouncement(trimmed);
}

// The message opens a new submission, and is its first message.
async function startNextSubmission(sender, text, mediaUrls) {
  startSubmission(sender);
  const reply = await handleActiveSubmission(sender, text, mediaUrls);
  return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
}

// The guards in front of a correction's model call, whether the text came alone or as
// an image caption. Returns the refusal, or "" to go ahead.
function correctionRefusal(sender, text) {
  if (text.length > MAX_MESSAGE_LENGTH) return MESSAGE_TOO_LONG_TEXT;
  if (isRateLimited(sender)) return RATE_LIMITED_TEXT;
  return "";
}

// An organizer who never answers is reminded once, three hours after being asked. The
// event never reaches Stav on its own: it waits on her pending list until it expires.
// Deferred, without the note, while the sender is in any other conversation (a draft,
// an inquiry, another open question, or the confirm question for a different event):
// the reminder's "1" would land there, or confirm the wrong event. A later sweep sends it.
function busyForConfirmReminder(sender, eventId) {
  const open = awaitingConfirmation.get(sender);
  if (open && String(open.eventId) !== String(eventId)) return true;
  return inOtherQuestion(sender);
}

// Every open conversation but the confirm question: a draft, an inquiry, or a question
// whose next digit means something of its own.
function inOtherQuestion(sender) {
  return (
    activeSubmissions.has(sender) ||
    activeInquiries.has(sender) ||
    adChoiceIsOpen(sender) ||
    awaitingCancelChoice.has(sender) ||
    awaitingIntentConfirm.has(sender) ||
    offeredEscape.has(sender)
  );
}

// Any open conversation at all, the confirm question included. An ad offer waits while
// this holds, so its "1" never lands in someone else's question.
function inOpenConversation(sender) {
  return awaitingConfirmation.has(sender) || inOtherQuestion(sender);
}

async function sendDueConfirmReminders(now = Date.now()) {
  const today = todayIso();
  const due = loadEvents(EVENTS_FILE).filter(
    (e) =>
      e.status === "awaiting_confirm" &&
      e.submitter &&
      e.confirm_asked_at &&
      now - Date.parse(e.confirm_asked_at) > CONFIRM_REMINDER_AFTER_MS &&
      !(e.notes || "").includes(CONFIRM_REMINDER_NOTE) &&
      (!e.date || lastDay(e) >= today)
  );
  for (const event of due) {
    const sender = event.submitter;
    if (busyForConfirmReminder(sender, event.id)) continue;
    // Noted before the send, so a failed or slow send is never repeated.
    storeUpdateEvent(EVENTS_FILE, event.id, { notes: `${event.notes || ""} | ${CONFIRM_REMINDER_NOTE}`.replace(/^ \| /, "") });
    if (!awaitingConfirmation.has(sender)) {
      awaitingConfirmation.set(sender, { eventId: event.id, unresolved: [] });
      saveState();
    }
    await sendToSubmitter(sender, confirmReminderText(event.event_name));
  }
}

// --- After approval: the graphic ad is offered, and booked into a window ---
const AD_OFFER_TEMPLATE = "fomo_ad_offer";
const AD_OFFER_TTL_MS = 48 * 60 * 60 * 1000;
const NO_AD_WINDOW_TEXT = (start, next) => `האירוע מתחיל ב-${start}, והחלון הבא למודעות הוא ${next}, אז הפעם לא נוכל לפרסם עליו מודעה 🙏\n\nבפעם הבאה שלחו לפחות יום מראש, ונוכל לפרסם גם מודעה.`;
const NO_AD_TEXT = (date) => `אין בעיה. האירוע יופיע בלוח היומי של ${date}.`;
const ASK_FLYER_TEXT = "כדי לפרסם מודעה גרפית צריך פלייר. שלחו אותו כאן כתמונה.";
const WINDOW_PASSED_TEXT = "החלון הזה כבר עבר. אלה האפשרויות שנשארו:";
const AMENDMENT_AFTER_APPROVAL_TEXT = "העברנו את הבקשה לסתיו, היא תעדכן את האירוע.";
// Said only when no daily board the event could be on is still ahead (boardSlotFor is
// null): promising one would be untrue once today's has gone out.
const NO_AD_NO_BOARD_TEXT = "אין בעיה, לא נפרסם מודעה.";
const NO_WINDOW_LEFT_BASE_TEXT = "החלון הזה כבר עבר, ולא נשאר עוד חלון למודעה לפני שהאירוע מתחיל 🙏";
const NO_WINDOW_LEFT_TEXT = `${NO_WINDOW_LEFT_BASE_TEXT} האירוע יופיע בלוח היומי.`;
const BOARD_ALREADY_OUT_TEXT = "📋 הלוח היומי של היום כבר יצא, אז הוא יישלח לקבוצה בנפרד.";
const HELD_OFFER_LEAD = (name) => `📌 לגבי האירוע "${name}" שאושר:`;
const PICK_WINDOW_PROMPT = "מתי לפרסם את המודעה?";
const PAST_DATE_TEXT = "התאריך הזה כבר עבר. כתבו תאריך מהיום והלאה.";
const MAX_LISTED_WINDOWS = 6;
// Twilio refuses a WhatsApp message longer than this.
const WHATSAPP_MAX_CHARS = 1600;

// "שבת 7.11", the way the mockup names a day to the organizer.
const dayName = (date) => longDate(date).replace(/^יום /, "");
// "היום (חמישי 5.11)", "מחר (שישי 6.11)", or just "שבת 7.11".
function dayLabel(date, today) {
  if (date === today) return `היום (${dayName(date)})`;
  if (date === addDays(today, 1)) return `מחר (${dayName(date)})`;
  return dayName(date);
}

const localNow = (local) => `${local.date} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;

// The daily board an approved event goes out on, { date, slot }: the first board slot of
// its day, never the 10:00 ads slot. On the day itself only a slot whose handoff is still
// ahead counts, and only if that board will carry the event (coveredByEarlierSlot leaves
// a morning event out of the weekend's 18:00). Null once every board it could be on has
// gone to Stav.
function boardSlotFor(event, local) {
  if (!event.date || !isValidDate(event.date)) return null;
  const nowMinutes = local.hour * 60 + local.minute;
  const first = event.date > local.date ? event.date : local.date;
  for (let date = first; date <= lastDay(event); date = addDays(date, 1)) {
    for (const entry of DAILY_SLOTS) {
      if (entry.adsOnly || !entry.days.includes(dayOfWeek(date))) continue;
      if (date === local.date) {
        if (nowMinutes >= entry.sendHour * 60 + entry.sendMinute) continue;
        if (coveredByEarlierSlot(event, date, entry.slot)) continue;
      }
      return { date, slot: entry.slot };
    }
  }
  return null;
}

// The next ad window to open after now, whatever the event: what the organizer is told
// when no window is left before their event.
function nextAdWindow(local) {
  const now = localNow(local);
  for (let date = local.date; ; date = addDays(date, 1)) {
    const window = AD_WINDOWS.find((w) => `${date} ${w.start}` > now);
    if (window) return { ...window, date };
  }
}

// Option 3 of the offer names the board the event is really on. Once every board it
// could be on has gone to Stav, it promises none.
function declineLabel(board, today) {
  if (!board) return "לא, תודה";
  if (board.date === today) return "לא, רק בלוח של היום";
  if (board.date === addDays(today, 1)) return "לא, רק בלוח של מחר";
  return `לא, רק בלוח של ${dayName(board.date)}`;
}

// The approval message and the ad offer, as two texts. The approval names the daily
// board's date and slot. offerText is empty when no window is left before the event
// (the approval then says why) or the event already has its one booking.
function offerFor(event, local) {
  const today = local.date;
  const board = boardSlotFor(event, local);
  const lines = [`האירוע שלכם "${event.event_name}" אושר 🎉`];
  if (board) lines.push(`📋 הוא ייכנס ללוח היומי של *${dayName(board.date)}*, שיוצא לקבוצה ב-${board.slot}.`);
  else if (runsOn(event, today)) lines.push(BOARD_ALREADY_OUT_TEXT);
  const result = { approvalText: lines.join("\n"), offerText: "", options: [], prompt: "", phrase: "" };
  if (event.ad_window) return result;

  const windows = availableWindows(event, local);
  if (!windows.length) {
    // Said only while the event is still ahead: once it has started there is nothing
    // to explain.
    const start = event.start_time || "";
    if (TIME_RE.test(start) && `${lastDay(event)} ${start}` > localNow(local)) {
      const next = nextAdWindow(local);
      const nextText = `${windowPhrase(next, today)} (${next.start}–${next.end})`;
      result.approvalText += `\n\n${NO_AD_WINDOW_TEXT(start, nextText)}`;
    }
    return result;
  }

  const first = windows[0];
  const phrase = windowPhrase(first, today);
  const options = [
    { key: "1", label: `כן, בהקדם האפשרי: *${phrase}* (${first.start}–${first.end})`, date: first.date, window: first.key },
    { key: "2", label: "כן, אבחר יום וחלון", action: "pick" },
    { key: "3", label: declineLabel(board, today), action: "decline" },
  ];
  const prompt = `רוצים שנפרסם גם *מודעה גרפית מורחבת*${event.flyer ? " עם הפלייר" : ""}?`;
  return { ...result, offerText: renderNumbered(prompt, options), options, prompt, phrase };
}

// Up to six windows, then "another date" when there are more.
function windowOptions(windows, today) {
  const options = windows.slice(0, MAX_LISTED_WINDOWS).map((w, i) => ({
    key: String(i + 1),
    label: `${dayLabel(w.date, today)} · ${w.label} ${w.start}–${w.end}`,
    date: w.date,
    window: w.key,
  }));
  if (windows.length > MAX_LISTED_WINDOWS) {
    options.push({ key: String(options.length + 1), label: "תאריך אחר", action: "date" });
  }
  return options;
}

// The open question, lapsed ones aside. A lapsed one is not deleted here: the router
// drops it on the sender's next message.
function adChoiceIsOpen(sender) {
  const open = awaitingAdChoice.get(sender);
  return Boolean(open) && Date.now() - open.askedAt < AD_OFFER_TTL_MS;
}

function setAdStep(sender, eventId, step, fields = {}) {
  awaitingAdChoice.set(sender, { eventId: String(eventId), step, askedAt: Date.now(), options: [], prompt: "", ...fields });
  saveState();
}

function adQuestionText(open) {
  if (open.step === "date") return ASK_OTHER_DATE_TEXT;
  if (open.step === "flyer") return ASK_FLYER_TEXT;
  return renderNumbered(open.prompt, open.options);
}

// Approval reaches the organizer as two messages: the approval with the board's date and
// slot, then the ad offer. An open window gets both as text. A closed one can only take
// the fomo_ad_offer template, which carries both; without it, both wait in
// pendingAdOffers for the organizer's next message. An organizer in another conversation
// gets the approval at once, since it asks nothing, and only the offer waits: its "1"
// would land in that other question.
async function notifyApproved(sender, id, event) {
  const offer = offerFor(event, israelClock(new Date()));
  const open = windowIsOpen(lastInbound.get(sender) || 0);
  const busy = inOpenConversation(sender);

  if (open) {
    await sendToSubmitter(sender, offer.approvalText);
    if (!offer.offerText) return;
    if (busy) {
      pendingAdOffers.add(String(id));
      approvalAlreadySent.add(String(id));
      saveState();
      return;
    }
    setAdStep(sender, id, "offer", { options: offer.options, prompt: offer.prompt });
    await sendToSubmitter(sender, offer.offerText);
    return;
  }

  if (!open && !busy && offer.offerText && (await adOfferTemplateApproved())) {
    setAdStep(sender, id, "offer", { options: offer.options, prompt: offer.prompt });
    // The template's body has the approval and the question; text is the fallback.
    const choice = {
      text: `${offer.approvalText}\n\n${offer.prompt}`,
      options: offer.options,
      template: AD_OFFER_TEMPLATE,
      variables: { 1: event.event_name, 2: offer.phrase },
    };
    try {
      await sendAdOffer(sender, choice);
    } catch (err) {
      // Nothing reached them: the open step would capture their next message as an
      // answer to a question they never saw, and the approval would be lost. Both wait
      // for their next message instead, like a closed window with no template.
      console.error(`failed to send the ad offer for event #${id}, holding it:`, err);
      awaitingAdChoice.delete(sender);
      pendingAdOffers.add(String(id));
      saveState();
    }
    return;
  }

  pendingAdOffers.add(String(id));
  saveState();
}

// The fomo_ad_offer send. Injectable so the suite can make it fail without Twilio.
let adOfferSender = null;
function sendAdOffer(sender, choice) {
  if (adOfferSender) return adOfferSender(sender, choice);
  if (process.env.NODE_ENV === "test") {
    outbox.push({ to: sender, text: renderNumbered(choice.text, choice.options), mediaUrl: "", template: AD_OFFER_TEMPLATE });
    return Promise.resolve();
  }
  return sendChoice(sender, choice);
}

function dropHeldOffer(id) {
  pendingAdOffers.delete(id);
  approvalAlreadySent.delete(String(id));
  saveState();
}

async function adOfferTemplateApproved() {
  if (process.env.NODE_ENV !== "test") await ensureTemplates();
  return Boolean(approvedTemplateSid(AD_OFFER_TEMPLATE));
}

// A held approval and offer, attached under the reply to the organizer's next message.
// The approval asks nothing, so it comes at once, even mid-conversation; the offer waits
// until they are in no other conversation, since its "1" would land in that question.
// One offer per message: one question can be open. When the approval already went out,
// the offer comes under a line naming the event.
function deliverPendingAdOffer(sender, reply) {
  if (!pendingAdOffers.size) return reply;
  const busy = inOpenConversation(sender);
  const local = israelClock(new Date());
  const events = loadEvents(EVENTS_FILE); // read once, not once per held offer
  for (const id of [...pendingAdOffers]) {
    const event = events.find((candidate) => candidate.id === String(id));
    if (!event || event.status !== "published" || !event.date || lastDay(event) < local.date) {
      dropHeldOffer(id);
      continue;
    }
    if (event.submitter !== sender) continue;
    const offer = offerFor(event, local);
    const approved = approvalAlreadySent.has(String(id));
    // Approved already, and no window left: there is nothing more to tell them.
    if (approved && !offer.offerText) {
      dropHeldOffer(id);
      continue;
    }
    if (busy) {
      if (approved) continue;
      const withApproval = reply ? `${reply}\n\n${offer.approvalText}` : offer.approvalText;
      if (withApproval.length >= WHATSAPP_MAX_CHARS) continue; // waits for a shorter reply
      reply = withApproval;
      // As notifyApproved does for a busy organizer: the offer stays held, marked so it
      // comes later under the event's name rather than with the approval again.
      if (offer.offerText) {
        approvalAlreadySent.add(String(id));
        saveState();
      } else {
        dropHeldOffer(id);
      }
      continue;
    }
    const lead = approved ? HELD_OFFER_LEAD(event.event_name) : offer.approvalText;
    const extra = offer.offerText ? `${lead}\n\n${offer.offerText}` : lead;
    const full = reply ? `${reply}\n\n${extra}` : extra;
    if (full.length >= WHATSAPP_MAX_CHARS) return reply; // waits for a shorter reply
    pendingAdOffers.delete(id);
    approvalAlreadySent.delete(String(id));
    if (offer.offerText) setAdStep(sender, id, "offer", { options: offer.options, prompt: offer.prompt });
    saveState();
    return full;
  }
  return reply;
}

// The answer to the ad question, at any step. Returns null when the question no longer
// applies (lapsed, the event cancelled or already booked), so the message is routed as if
// it had never been asked.
async function handleAdChoice(sender, text, mediaUrls) {
  const open = awaitingAdChoice.get(sender);
  const event = storeFindEvent(EVENTS_FILE, open.eventId);
  if (!event || event.status !== "published" || event.ad_window || !adChoiceIsOpen(sender)) {
    awaitingAdChoice.delete(sender);
    saveState();
    return null;
  }
  const trimmed = text.trim();
  const local = israelClock(new Date());

  if (open.step === "flyer" && mediaUrls.length) {
    let image;
    try {
      image = await fetchMediaModule.fetchMediaAsDataUrl(mediaUrls[0]);
    } catch (err) {
      console.error("failed to fetch the flyer for an ad:", err);
      return MEDIA_FETCH_FAILED_TEXT;
    }
    replaceFlyer(event, image);
    // A caption is still a correction, and goes to Stav like any other.
    if (trimmed) await forwardAmendmentToAdmin(event.id, trimmed, sender);
    const stored = storeFindEvent(EVENTS_FILE, event.id);
    if (!stored.flyer) return ASK_FLYER_TEXT;
    return chooseAdWindow(sender, stored, open.window, local);
  }

  // A flyer at any other step is the next event, as everywhere else, and so is a whole
  // announcement pasted as text: it is not a correction for Stav.
  if (hasUnambiguousSubmissionSignal(mediaUrls) || (!mediaUrls.length && looksLikeNewAnnouncement(trimmed))) {
    return startNextSubmission(sender, text, mediaUrls);
  }

  if (!trimmed) return adQuestionText(open);

  const picked = (open.options || []).find((option) => option.key === trimmed);
  if (picked && picked.action === "decline") return declineAd(sender, event, local);
  if (picked && picked.action === "pick") {
    return askForWindow(sender, event, local, PICK_WINDOW_PROMPT);
  }
  if (picked && picked.action === "date") {
    setAdStep(sender, event.id, "date");
    return ASK_OTHER_DATE_TEXT;
  }
  if (picked && picked.window) {
    return chooseAdWindow(sender, event, { date: picked.date, window: picked.window }, local);
  }

  // A date typed at the offer or the window list is the "another date" answer, given
  // early: the organizer skipped the step that asks for it.
  if (open.step === "date" || open.step === "offer" || open.step === "pick") {
    const date = parseUserDate(trimmed, local.date);
    if (date && date < local.date) return PAST_DATE_TEXT;
    if (date) {
      const windows = availableWindows(event, local).filter((w) => w.date === date);
      if (!windows.length) return `אין חלון למודעה ב${dayName(date)} לפני שהאירוע מתחיל. כתבו תאריך אחר.`;
      const options = windows.map((w, i) => ({ key: String(i + 1), label: `${w.label} ${w.start}–${w.end}`, date: w.date, window: w.key }));
      const prompt = `${dayLabel(date, local.date)}: בוקר או ערב?`;
      setAdStep(sender, event.id, "window", { options, prompt });
      return renderNumbered(prompt, options);
    }
  }

  // A plain no is the "no" option, at any step. A plain yes can't say which window, so
  // the question is asked again. Neither is a correction for Stav.
  if (AD_NO_RE.test(trimmed)) return declineAd(sender, event, local);
  if (AD_YES_RE.test(trimmed)) return adQuestionText(open);
  // A question about the ad or the event ("when does it go out?") has nothing for Stav
  // to change, so it gets the question again. A change asked as a question ("can you
  // change the price to 50?") is still a correction, and goes on to her below: a
  // correction is never dropped.
  if (looksLikeQuestion(trimmed) && !CHANGE_REQUEST_RE.test(trimmed)) return adQuestionText(open);

  // A number that is no option is a mistyped answer, not a correction for Stav.
  if (/^\d+[.)]?$/.test(trimmed)) return adQuestionText(open);

  // Anything else is about the event. After approval nothing changes on its own: it goes
  // to Stav, and the question is asked again.
  await forwardAmendmentToAdmin(event.id, trimmed, sender);
  return `${AMENDMENT_AFTER_APPROVAL_TEXT}\n\n${adQuestionText(open)}`;
}

// Natural answers to the ad question, whole message only.
const AD_NO_RE = /^(לא|לא,? תודה|לא צריך|no|no thanks)[\s!.]*$/i;
const AD_YES_RE = /^(כן|בטח|yes)[\s!.]*$/i;
// A question that asks for a change to the event, which Stav has to see.
const CHANGE_REQUEST_RE = /לשנות|לתקן|לעדכן|להחליף|להוסיף|להוריד|להזיז|לדחות|להקדים|שינוי|תיקון|טעות|במקום/;

// "No ad": recorded so the event is never offered again, and the question closes.
function declineAd(sender, event, local) {
  storeUpdateEvent(EVENTS_FILE, event.id, { ad_window: "decline" });
  awaitingAdChoice.delete(sender);
  saveState();
  const board = boardSlotFor(event, local);
  return board ? NO_AD_TEXT(dayName(board.date)) : NO_AD_NO_BOARD_TEXT;
}

// The window list, freshly worked out. With nothing left, the question closes.
function askForWindow(sender, event, local, intro) {
  const windows = availableWindows(event, local);
  if (!windows.length) {
    awaitingAdChoice.delete(sender);
    saveState();
    return boardSlotFor(event, local) ? NO_WINDOW_LEFT_TEXT : NO_WINDOW_LEFT_BASE_TEXT;
  }
  const options = windowOptions(windows, local.date);
  setAdStep(sender, event.id, "pick", { options, prompt: PICK_WINDOW_PROMPT });
  return renderNumbered(intro, options);
}

// The windows are worked out again here, since the answer can come hours after the
// question: a window that has passed meanwhile is not booked. Without a flyer the bot asks
// for one first and books once it arrives.
function chooseAdWindow(sender, event, choice, local) {
  const window = availableWindows(event, local).find((w) => w.date === choice.date && w.key === choice.window);
  if (!window) return askForWindow(sender, event, local, WINDOW_PASSED_TEXT);
  if (!event.flyer) {
    setAdStep(sender, event.id, "flyer", { window: { date: window.date, window: window.key } });
    return ASK_FLYER_TEXT;
  }
  storeUpdateEvent(EVENTS_FILE, event.id, { ad_date: window.date, ad_window: window.key });
  awaitingAdChoice.delete(sender);
  saveState();
  // A window already open hands the ad to Stav now rather than at the next slot.
  // Detached: sendLateAds catches its own errors, and the organizer's reply must not wait.
  sendLateAds();
  const near = window.date === local.date || window.date === addDays(local.date, 1);
  return `סגור ✅\nהמודעה תתפרסם בקבוצה *${windowPhrase(window, local.date)}*${near ? `: ${dayName(window.date)}` : ""}, בין ${window.start} ל-${window.end}.`;
}

const ADMIN_HELP_TEXT = `פקודות ניהול:
הכי פשוט: ענו על הודעת האירוע עצמה עם "אשר" או "דחה"

אשר [מספר] - לאשר ולפרסם אירוע
דחה [מספר] [סיבה] - לדחות אירוע
ממתינים - רשימת אירועים ממתינים לבדיקה
צפיות - כמה צפיות יש לקישורים של האירועים
צפיות [מספר] - פירוט לאירוע אחד
ערוך [מספר] - לשנות אירוע במילים שלך (הבוט ישאל מה לשנות)
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
  ["תאריך סיום", "end_date"],
  ["מיקום", "location"],
  ["קטגוריה", "category"],
  ["מחיר", "price"],
  ["מארגן", "organizer"],
  ["קישור", "contact_link"],
  ["איש קשר", "contact_person"],
  ["תיאור", "description"],
]);
const FIELD_LABEL_FOR_KEY = new Map([...FIELD_LABELS].map(([label, key]) => [key, label]));

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
  const upcoming = (e) => !e.date || lastDay(e) >= today;
  const line = (e) => `#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`;
  const pending = events.filter((e) => AWAITING_REVIEW.has(e.status) && upcoming(e));
  // Not hers to review yet, but she should see who hasn't confirmed.
  const unconfirmed = events.filter((e) => e.status === "awaiting_confirm" && upcoming(e));
  const parts = [pending.length ? pending.map(line).join("\n") : "אין אירועים ממתינים כרגע."];
  if (unconfirmed.length) parts.push(["⏳ מחכים לאישור של המפרסם:", ...unconfirmed.map(line)].join("\n"));
  return parts.join("\n\n");
}

// Explicit id ("אשר 6"), or bare ("אשר") as a WhatsApp reply to the event's own notice.
const ADMIN_COMMAND_RE = /^(אשר|דחה)(?:\s*#?(\d+))?\s*(.*)$/;
// The subset of admin commands unambiguous enough to run from customer mode: a bare
// button payload, or approve/reject with an id. Not ADMIN_COMMAND_RE itself, which
// accepts any text that merely starts with "אשר".
const ADMIN_ONLY_COMMAND_RE = /^(?:(?:אשר|דחה)(?:\s*#?\d+.*)?|ממתינים|שלח|תקן\s*#?\d+.*|ערוך(?:\s*#?\d+)?\s*)$/s;
// "ערוך 42", or a bare "ערוך" as a reply to the notice. Opens an edit; her next message
// says what to change.
const EDIT_COMMAND_RE = /^ערוך(?:\s*#?(\d+))?\s*$/;
const editAskText = (id) => `מה לשנות באירוע #${id}? כתבו במילים שלכם.`;

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
  // The original notice never reached her phone, so there is no message to swipe-reply to
  // (WhatsApp itself will say "אין הודעה מעל" if she tries) — spell out the typed form.
  return `⚠ אירועים שההודעה עליהם לא הגיעה אליך (אי אפשר לענות על ההודעה המקורית — היא לא הגיעה):\n${lines}\n\nלטפל: אשר [מספר] או דחה [מספר]\n\n`;
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

// A command that closes an open edit instead of being read as one.
function isAdminCommand(trimmed) {
  return ADMIN_ONLY_COMMAND_RE.test(trimmed) || trimmed === "צפיות" || trimmed.startsWith("צפיות ");
}

// Her answer to "ערוך": applied like any correction, and recorded so the extractor
// learns. Unclear or refused text keeps the edit open and asks again.
async function handleAdminEdit(id, text) {
  const trimmed = text.trim();
  const askAgain = (reply) => {
    awaitingAdminEdit = id;
    saveState();
    return reply;
  };
  if (!trimmed) return askAgain(editAskText(id));
  if (text.length > MAX_MESSAGE_LENGTH) return askAgain(MESSAGE_TOO_LONG_TEXT);
  const { changed, event } = await applyCorrection(id, trimmed, { byAdmin: true });
  if (!event) return `לא נמצא אירוע #${id}.`;
  if (!changed.length) return askAgain(`${CORRECTION_UNCLEAR_TEXT}\n\n${editAskText(id)}`);
  const [short, ad] = previewMessages(event);
  // Only an event still under review can be approved; on any other the line would invite
  // a command that does nothing useful (or re-publishes one already out).
  const approvable = event.status === "submitted" || event.status === "needs_info";
  return [`עודכן ✏ #${id}. ככה זה נראה עכשיו:`, short.text, ad.text, ...(approvable ? [`לאישור: אשר ${id}`] : [])].join("\n\n");
}

async function handleAdminMessage(text, repliedSid = "") {
  const trimmed = text.trim();
  // Her message just reopened the 24h WhatsApp window, so any board Twilio dropped with
  // 63016 can finally be delivered. Detached: a slow re-send must not delay her reply.
  const flushing = flushPendingBoards();
  const banner = missedNoticesBanner(loadEvents(EVENTS_FILE));

  // An open edit takes her next message, unless it is a command: any command closes the
  // edit and runs as usual. Only the strict command forms count, so an edit that starts
  // with a command word ("דחה ל-21:00", postpone to 21:00) is still an edit. "ביטול"
  // closes it here because the customer keyword branch runs after this handler.
  if (awaitingAdminEdit) {
    const editId = awaitingAdminEdit;
    awaitingAdminEdit = "";
    saveState();
    if (CANCEL_KEYWORDS.has(trimmed.toLowerCase())) {
      return `${banner}העריכה של אירוע #${editId} בוטלה, לא שיניתי כלום.`;
    }
    if (!isAdminCommand(trimmed)) return `${banner}${await handleAdminEdit(editId, text)}`;
  }

  const edit = trimmed.match(EDIT_COMMAND_RE);
  if (edit) {
    const id = resolveEventId(edit[1], repliedSid);
    if (!id) {
      return `${banner}לא ברור לאיזה אירוע הכוונה — לא שיניתי כלום.\nענו על הודעת האירוע עם "ערוך", או כתבו "ערוך [מספר]".\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
    }
    if (!storeFindEvent(EVENTS_FILE, id)) {
      return `${banner}לא נמצא אירוע #${id}.\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
    }
    // Editing it means she saw it. lastButtonEventId is not consumed: opening an edit
    // decides nothing about the event.
    undeliveredAdminNotices.delete(String(id));
    awaitingAdminEdit = id;
    saveState();
    return `${banner}${editAskText(id)}`;
  }

  // A tap on the slot-ready button. Waits for the flush, so this reply lands after the
  // boards instead of above them.
  if (trimmed === SLOT_READY_KEY) {
    const sent = await flushing;
    return `${banner}${sent ? "אלה כל ההודעות שחיכו." : "אין הודעות שמחכות כרגע."}`;
  }

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
    if (existing.status === "cancelled") {
      return `אירוע #${id} "${existing.event_name}" בוטל על ידי המפרסם.`;
    }
    // Expired events close themselves, so reaching one by explicit id is either a typo or
    // a deliberate revival. Say what happened rather than silently publishing a past date;
    // she can still correct the date with "תקן" and approve it then.
    if (existing.status === "expired") {
      return `אירוע #${id} "${existing.event_name}" כבר עבר (${existing.date}) ולכן נסגר אוטומטית.\nאם התאריך השתנה: תקן ${id} תאריך: [תאריך חדש] ואז אשר ${id}.`;
    }
    storeUpdateEvent(EVENTS_FILE, id, { status: "published", published_at: todayIso() });
    const publishedEvent = storeFindEvent(EVENTS_FILE, id) || existing;
    if (existing.submitter) {
      await notifyApproved(existing.submitter, id, publishedEvent);
    }
    // Nothing goes to Stav at approval: the event reaches the group on its daily board,
    // and as an ad only if the organizer books one. The exception is an event today whose
    // last board has already gone out. It would never be listed, so she gets it now, in
    // the board's short form, to forward on its own.
    const local = israelClock(new Date());
    if (runsOn(publishedEvent, local.date) && !boardSlotFor(publishedEvent, local)) {
      await sendShortToAdmin(id, publishedEvent);
      return `אירוע #${id} אושר.\nהלוח היומי של היום כבר יצא, אז שלחתי לך את האירוע עכשיו — אפשר להעביר לקבוצה.`;
    }
    return `אירוע #${id} אושר.`;
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

// WhatsApp sends a flyer and its text as two webhooks a second apart, and they ran in
// parallel: the text's classifier call wiped the image's fresh draft (or sent it to
// the menu), or two extractions raced over one draft (16/10/2026). Each sender's
// messages now run one at a time, and the first half of a likely pair waits briefly so
// both reach the router as one message.
const PAIR_WAIT_MS = Number(process.env.PAIR_WAIT_MS || 3000);
const inboundChains = new Map(); // sender -> tail of that sender's routing queue
const heldInbound = new Map(); // sender -> { msg, timer, dispatch } waiting for its other half

function isBareCommand(text) {
  const value = text.trim().toLowerCase();
  return /^\d{1,2}$/.test(value) || MENU_KEYWORDS.has(value) || CANCEL_KEYWORDS.has(value);
}

// Only from the menu, where the two halves would otherwise go separate ways. Inside a
// flow the queue alone is enough: the second half lands in the same draft.
function shouldHoldForCompanion(sender, text, mediaUrls) {
  if (sender === ADMIN_SENDER && adminMode.get(sender) !== "customer") return false;
  const flow = senderFlow(sender);
  if (flow !== "menu" && flow !== "post-submission") return false;
  if (mediaUrls.length) return !text.trim();
  return Boolean(text.trim()) && !isBareCommand(text);
}

function mergeInbound(first, second) {
  return {
    text: [first.text, second.text].map((t) => t.trim()).filter(Boolean).join("\n"),
    mediaUrls: [...first.mediaUrls, ...second.mediaUrls],
    repliedSid: first.repliedSid || second.repliedSid,
  };
}

function enqueueInbound(sender, msg) {
  const previous = inboundChains.get(sender) || Promise.resolve();
  const run = previous.then(() => routeMessage(sender, msg.text, msg.mediaUrls, msg.repliedSid));
  const tail = run.catch(() => {});
  inboundChains.set(sender, tail);
  tail.then(() => {
    if (inboundChains.get(sender) === tail) inboundChains.delete(sender);
  });
  return run;
}

// Resolves to the reply, or to null when this message was folded into another one's
// and that webhook answers for both.
function receiveInbound(sender, text, mediaUrls = [], repliedSid = "") {
  const msg = { text, mediaUrls, repliedSid };
  const held = heldInbound.get(sender);
  if (held) {
    clearTimeout(held.timer);
    heldInbound.delete(sender);
    if (isBareCommand(text) && !mediaUrls.length) {
      held.dispatch(held.msg);
      return enqueueInbound(sender, msg);
    }
    held.dispatch(mergeInbound(held.msg, msg));
    return Promise.resolve(null);
  }
  if (!shouldHoldForCompanion(sender, text, mediaUrls)) return enqueueInbound(sender, msg);
  return new Promise((resolve, reject) => {
    const entry = {
      msg,
      dispatch: (final) => enqueueInbound(sender, final).then(resolve, reject),
    };
    entry.timer = setTimeout(() => {
      heldInbound.delete(sender);
      entry.dispatch(entry.msg);
    }, PAIR_WAIT_MS);
    heldInbound.set(sender, entry);
  });
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
    reply = await receiveInbound(sender, text, mediaUrls, repliedSid);
  } catch (err) {
    console.error("routeMessage failed:", err);
    reply = "מצטערים, קרתה תקלה. נסו שוב בעוד רגע.";
  }

  // Folded into the other half of a flyer-and-text pair, which replies for both.
  if (reply === null) {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(EMPTY_TWIML);
    return;
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
  // customer-mode banner being prefixed to it. Only when it ends the reply: a held ad
  // offer attached under it (deliverPendingAdOffer) would be lost under the template.
  if (reply.includes("1. לברר בנוגע לאירועים") && reply.endsWith(MENU_TEXT)) {
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

// Above this the classifier's verdict is acted on directly; below it the sender is
// asked. Deliberately cautious: the cost of asking is one extra message, and the cost
// of guessing wrong is someone locked in an event draft with no way out.
const INTENT_CONFIDENCE_THRESHOLD = 0.7;

// Media is never ambiguous. A flyer is the clearest "publish this" signal the bot gets,
// it is the main job, and routing it anywhere but the draft would break the path that
// matters most. Checked before the classifier so a flyer costs no model call and cannot
// be talked out of the submission flow by its own caption.
function hasUnambiguousSubmissionSignal(mediaUrls) {
  return mediaUrls.length > 0;
}

const LIKELY_EVENT_DETECTED_TEXT = "נראה ששיתפתם פרטים על אירוע — מעבדים את זה עכשיו. (כתבו \"ביטול\" כדי לחזור לתפריט)";

// The fields that only appear when someone is genuinely describing an event.
//
// category and description are deliberately excluded: the extractor is told to infer a
// category from almost any text and description is a free-text catch-all, so both come
// back populated for a message that was never an event at all. Counting them would mean
// the checks below never fire.
const CORE_IDENTIFYING_FIELDS = ["event_name", "date", "start_time", "location", "contact_link"];
// Two, not one: a real submitter a few turns in has a name and something else, while a
// misrouted conversation yields at most one incidental field.
const MIN_FIELDS_WORTH_FILING = 2;

function countIdentifyingFields(event) {
  return CORE_IDENTIFYING_FIELDS.filter(
    (key) => event[key] && fieldIsValid(key, event[key])
  ).length;
}

// Whether a draft has enough in it to be worth Stav's time.
function isEssentiallyEmptyDraft(event, images = []) {
  // A flyer is content in itself: Stav can read one the extractor could not.
  if (images.length) return false;
  return countIdentifyingFields(event) < MIN_FIELDS_WORTH_FILING;
}

const GAVE_UP_ON_DRAFT_TEXT = "לא הצלחנו לקלוט פרטי אירוע מההודעות האחרונות, אז לא שלחנו כלום לבדיקה.";

// Offers the exit rather than taking it: someone genuinely mid-submission who phrased a
// message oddly can carry on by simply answering, and nothing is discarded unless they
// say so. Numbered to match the main menu, so "1" means here what it means there.
const WRONG_FLOW_ESCAPE_TEXT = `נראה שאולי לא התכוונתם לפרסם אירוע.

1. לברר בנוגע לאירועים
2. להמשיך לפרסם את האירוע

או פשוט המשיכו לכתוב את פרטי האירוע.`;

// Asked when the classifier cannot tell a submission from a question. Worded as what the
// person wants rather than what the bot does. Plain numbered text on purpose: sendChoice
// falls back to exactly this when no template is approved, so a template would change
// nothing today and adds a Meta approval step.
const INTENT_CONFIRM_TEXT = `רגע, רק לוודא — מה תרצו?

1. לברר בנוגע לאירועים (אני מחפש/ת לאן ללכת)
2. לפרסם אירוע (יש לי אירוע שאני רוצה לפרסם)`;

// Submitters had no way to take an event back (16/10/2026). They can cancel their own,
// matched by phone number, from the menu ("5"), by saying so ("בטל אירוע"), or when the
// classifier hears it. A bare "ביטול" still only exits whatever flow they are in.
const CANCEL_EVENT_RE = /^(לבטל|בטל|ביטול|מבטל|מבטלת)\s+(את\s+)?(ה)?אירוע|^cancel (my )?event/i;
const CANCELLABLE_STATUSES = new Set(["awaiting_confirm", "submitted", "needs_info", "published"]);
const NO_EVENTS_TO_CANCEL_TEXT = "לא מצאנו אירועים קרובים שפרסמתם מהמספר הזה.";
const CANCEL_KEPT_TEXT = "בסדר, לא ביטלנו כלום.";

function cancellableEventsFor(sender, today = todayIso()) {
  return loadEvents(EVENTS_FILE)
    .filter((e) => e.submitter === sender && CANCELLABLE_STATUSES.has(e.status) && (!e.date || lastDay(e) >= today))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

function cancelLabel(event) {
  return event.date ? `${event.event_name} — ${longDate(event.date)}` : event.event_name;
}

function cancelConfirmText(event) {
  return `לבטל את "${cancelLabel(event)}"?\n\n1. כן, לבטל\n2. לא`;
}

function startCancellation(sender) {
  clearSession(sender);
  const theirs = cancellableEventsFor(sender);
  if (!theirs.length) {
    saveState();
    return `${NO_EVENTS_TO_CANCEL_TEXT}\n\n${MENU_TEXT}`;
  }
  const ids = theirs.map((e) => e.id);
  // One event needs no list: go straight to the yes/no.
  if (theirs.length === 1) {
    awaitingCancelChoice.set(sender, { ids, pickedId: ids[0] });
    saveState();
    return cancelConfirmText(theirs[0]);
  }
  awaitingCancelChoice.set(sender, { ids, pickedId: "" });
  saveState();
  const lines = theirs.map((e, i) => `${i + 1}. ${cancelLabel(e)}`);
  return `איזה אירוע לבטל?\n\n${lines.join("\n")}\n\nשלחו את המספר.`;
}

async function handleCancelChoice(sender, trimmed) {
  const pending = awaitingCancelChoice.get(sender);

  if (!pending.pickedId) {
    const index = Number(trimmed) - 1;
    const id = Number.isInteger(index) ? pending.ids[index] : undefined;
    const event = id && storeFindEvent(EVENTS_FILE, id);
    if (!event) return `שלחו את מספר האירוע מהרשימה (1-${pending.ids.length}), או "ביטול" כדי לחזור לתפריט.`;
    awaitingCancelChoice.set(sender, { ...pending, pickedId: id });
    saveState();
    return cancelConfirmText(event);
  }

  const event = storeFindEvent(EVENTS_FILE, pending.pickedId);
  if (trimmed === "2" || !event) {
    awaitingCancelChoice.delete(sender);
    saveState();
    return CANCEL_KEPT_TEXT;
  }
  if (trimmed !== "1") return cancelConfirmText(event);

  awaitingCancelChoice.delete(sender);
  saveState();
  await cancelEvent(event, sender);
  return `האירוע "${event.event_name}" בוטל ולא יופיע יותר בלוח ובהודעות.`;
}

async function cancelEvent(event, sender) {
  // Re-checked against the row, not the list shown earlier: the owner is the only
  // person this may act for, and the event may have changed since.
  if (event.submitter !== sender || !CANCELLABLE_STATUSES.has(event.status)) return;
  storeUpdateEvent(EVENTS_FILE, event.id, {
    status: "cancelled",
    notes: `${event.notes} | בוטל על ידי המפרסם`.trim(),
  });
  if (undeliveredAdminNotices.delete(String(event.id))) saveState();
  if (lastButtonEventId === String(event.id)) { lastButtonEventId = ""; saveState(); }
  const pending = awaitingConfirmation.get(sender);
  if (pending && String(pending.eventId) === String(event.id)) {
    awaitingConfirmation.delete(sender);
    saveState();
  }
  if (process.env.NODE_ENV === "test") return;
  // Stav never saw an event its organizer had not confirmed, so there is nothing to tell her.
  if (event.status === "awaiting_confirm") return;
  // Boards and reminders skip it from now on by themselves. A post Stav already
  // forwarded to the group is the one thing the bot cannot take back, so she is told.
  const wasPublished = event.status === "published";
  const lines = [`🚫 אירוע #${event.id} "${event.event_name}" בוטל על ידי המפרסם (${sender}).`];
  if (wasPublished) lines.push("אם הוא כבר הועבר לקבוצה, כדאי לעדכן שם.");
  try {
    await sendWhatsApp(ADMIN_SENDER, lines.join("\n"));
  } catch (err) {
    console.error(`failed to tell the admin about cancelled event #${event.id}:`, err);
  }
}

// The two flow entry points, so the router switch, the classifier, the confirmation
// answer and the escape answer cannot drift on what "start an inquiry" means.
function startInquiry(sender) {
  clearSession(sender);
  activeInquiries.add(sender);
  activeInquiryHistories.delete(sender);
  saveState();
}

function startSubmission(sender) {
  clearSession(sender);
  activeSubmissions.set(sender, []);
  saveState();
}

async function handleActiveSubmission(sender, text, mediaUrls, { rateCounted = false } = {}) {
  const trimmed = text.trim();

  // Answering the escape offer. Above the append below, so the answer never becomes part
  // of the event text — swallowing menu digits into the draft is the same class of bug
  // this change exists to fix. Keyed off the flag rather than matching "1" unconditionally,
  // because a bare "1" is a perfectly good answer to a question mid-draft.
  if (offeredEscape.has(sender)) {
    offeredEscape.delete(sender);
    saveState();
    if (trimmed === "1") {
      startInquiry(sender);
      return ASK_INQUIRY_TEXT;
    }
    // "2" carries no event detail of its own, so acknowledge it rather than appending it.
    if (trimmed === "2") return ASK_EVENT_DETAILS_TEXT;
    // Anything else: they carried on submitting, so fall through and process it normally.
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return MESSAGE_TOO_LONG_TEXT;
  }

  const images = activeSubmissionImages.get(sender) || [];
  if (mediaUrls.length) {
    const remainingSlots = Math.max(0, MAX_IMAGES_PER_EVENT - images.length);
    const urlsToFetch = mediaUrls.slice(0, remainingSlots);
    try {
      const fetched = await Promise.all(urlsToFetch.map((url) => fetchMediaModule.fetchMediaAsDataUrl(url)));
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

  // Checked only once the image and text are stored: a flyer sent in a burst of messages
  // used to be refused before it was even fetched, and never reached the draft. Now it
  // is kept, and the next message picks it up.
  if (!rateCounted && isRateLimited(sender)) {
    return RATE_LIMITED_TEXT;
  }

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
  // Read before the set below overwrites it: the escape hatch needs to know whether this
  // turn actually added anything.
  const previousExtraction = lastExtractedEvent.get(sender) || null;
  const event = await extractEventModule.extractEvent(conversationText, undefined, newImages, previousEvent, correctionGuidance);
  imagesSentToModel.set(sender, images.length);
  lastExtractedEvent.set(sender, event);

  // Already on file: checked before anything is asked, because a poster sent again —
  // usually to add or swap the flyer — would otherwise be quizzed for a contact link
  // only to end up as a copy that is never saved.
  const knownEvent = findDuplicateEvent(event);
  if (knownEvent) {
    const firstImage = images[0] || "";
    clearSession(sender);
    recentlyCompleted.add(sender);
    saveState();
    return acknowledgeDuplicate(sender, knownEvent, firstImage);
  }

  // Only a "no" to a question we actually asked: the previous turn has to have been
  // missing the contact, and this turn must not have found one anyway.
  if (
    previousExtraction &&
    missingFields(previousExtraction).includes(CONTACT_LABEL) &&
    missingFields(event).includes(CONTACT_LABEL) &&
    declinesContact(trimmed)
  ) {
    contactDeclined.add(sender);
    saveState();
  }
  // The extractor may copy the "אין" itself into the field; it is not a contact, and
  // left there it would be printed as the event's link.
  if (contactDeclined.has(sender) && event.contact_link && !fieldIsValid("contact_link", event.contact_link)) {
    event.contact_link = "";
  }
  const missing = missingFields(event).filter((label) => !(label === CONTACT_LABEL && contactDeclined.has(sender)));

  // Re-asking forever is worse than forwarding an imperfect draft: a submitter who has
  // already sent the detail (and can see it in their own message) has no way to satisfy
  // the bot, and no reason to believe a fourth attempt will work. After a few tries, hand
  // it to Stav with the gap named — she can fill it in or reject it.
  if (missing.length) {
    // Only a turn that got nowhere counts toward giving up. Counting every turn cut off
    // people who were answering: a flyer sent as two images plus an opening "I want to
    // publish" used all three tries and was forwarded half-empty (event #40, 24/09/2026),
    // and the full text that followed arrived as a duplicate.
    const previousMissing = previousExtraction ? missingFields(previousExtraction).length : Infinity;
    const madeProgress = previousExtraction && missing.length < previousMissing;
    const attempts = (incompleteAttempts.get(sender) || 0) + (madeProgress ? 0 : 1);
    incompleteAttempts.set(sender, attempts);
    saveState();

    // Repeating the checklist at someone who is not submitting an event is the trap this
    // whole change removes. Three conditions, all required:
    //
    // - the message added no identifying field. This is what protects the genuine
    //   submitter: a bare "מחר" fills date, a bare venue name fills location, and either
    //   raises the count, so the hatch cannot fire on someone answering slowly.
    // - it reads as a question or an objection — the shape of someone who thinks they are
    //   talking to something else.
    // - it is not the first prompt. The first checklist is legitimate and usually
    //   answered; only a repeat is the failure.
    const addedNothing = countIdentifyingFields(event) <= (previousExtraction ? countIdentifyingFields(previousExtraction) : 0);
    const soundsMisrouted = looksLikeQuestion(trimmed) || looksLikeObjection(trimmed);

    if (attempts >= 2 && addedNothing && soundsMisrouted && !images.length) {
      offeredEscape.add(sender);
      saveState();
      return WRONG_FLOW_ESCAPE_TEXT;
    }

    if (attempts < MAX_INCOMPLETE_ATTEMPTS) {
      return missingFieldsPrompt(missing);
    }

    // Three tries and still nothing that looks like an event: this was probably never a
    // submission. Filing it anyway wrote junk into the review queue and — worse — told the
    // sender "we received your event and forwarded it for review", which was untrue. One
    // visitor got that in answer to "what is your purpose?". Hand them the menu instead;
    // it is the honest reply and the only recoverable one.
    if (isEssentiallyEmptyDraft(event, images)) {
      clearSession(sender);
      saveState();
      return `${GAVE_UP_ON_DRAFT_TEXT}\n\n${MENU_TEXT}`;
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
  } else if (!event.contact_link && contactDeclined.has(sender)) {
    unresolved.push("אין קישור או איש קשר — המגיש/ה אמר/ה שאין");
  }

  // Read the flyer before clearSession drops it.
  const firstImage = images[0] || "";
  clearSession(sender);
  saveState();
  const { id } = appendEvent(event, "Twilio WhatsApp", sender);
  lastSubmittedEventId.set(sender, id);
  persistFlyer(id, firstImage);
  // Stav is not told yet. The organizer sees exactly what the group would get, and
  // confirms or corrects it first (handleConfirmation).
  storeUpdateEvent(EVENTS_FILE, id, { status: "awaiting_confirm", confirm_asked_at: new Date().toISOString() });
  awaitingConfirmation.set(sender, { eventId: id, unresolved });
  saveState();
  // The previews are outbound sends, because a webhook reply carries one message and no
  // media. Awaited, so they land before the prompt that goes back as the reply.
  await sendToSubmitter(sender, RECEIVED_TEXT);
  await sendPreviews(sender, storeFindEvent(EVENTS_FILE, id));
  return CONFIRM_PROMPT_TEXT;
}

const ASK_OTHER_DATE_TEXT = 'איזה תאריך? כתבו בפורמט DD-MM-YY (למשל 14-09-26).';

function goodbyeText() {
  return [
    "איזה כיף שפרסמתם אצלנו!",
    "תהנו באירוע שלכם 🎉",
    "לא לשכוח שאפשר גם לדבר עם הבוט שלנו ולברר על אירועים",
  ].join("\n");
}

const ADMIN_MODE_KEYWORDS = new Set(["ניהול", "admin"]);
const CUSTOMER_MODE_KEYWORDS = new Set(["לקוח", "customer", "qa"]);

const ADMIN_MODE_TEXT = `🛠 מצב ניהול. כתבו "לקוח" כדי לבדוק כמו משתמש רגיל.

${ADMIN_HELP_TEXT}`;

// Prefixed to every customer-mode reply, so the mode is never something she has to
// remember from a switch that may have happened days and a restart ago.
const CUSTOMER_MODE_BANNER = '👤 מצב לקוח (בדיקות) — כתבו "ניהול" כדי לחזור.';

// Prefixed to every admin-mode reply for the same reason: a command that silently landed
// in the wrong mode (e.g. "דחה 37" answered by the customer menu) is indistinguishable
// from a bug unless every reply says outright which mode produced it.
const ADMIN_MODE_BANNER = '🛠 מצב ניהול — כתבו "לקוח" למצב בדיקות.';

const CUSTOMER_MODE_TEXT = `👤 מצב לקוח (בדיקות) — פקודות הניהול כבויות. כתבו "ניהול" כדי לחזור.

${MENU_TEXT}`;

// Wrapper so the customer-mode banner reaches every reply, whichever branch below produced
// it, without threading a flag through each return.
// Which flow the sender was in when a message arrived. Recorded with the interaction so
// the log can answer "where do people drop out", which raw text alone cannot.
function senderFlow(sender) {
  if (activeSubmissions.has(sender)) return "submission";
  if (activeInquiries.has(sender)) return "inquiry";
  if (awaitingConfirmation.has(sender)) return "confirm";
  if (adChoiceIsOpen(sender)) return "ad-choice";
  if (awaitingCancelChoice.has(sender)) return "cancel";
  // Its own tag so drop-off at the confirmation is visible in interactions.jsonl.
  if (awaitingIntentConfirm.has(sender)) return "intent-confirm";
  if (recentlyCompleted.has(sender)) return "post-submission";
  return "menu";
}

async function routeMessage(sender, text, mediaUrls = [], repliedSid = "") {
  const state = { inCustomerModeReply: false, inAdminModeReply: false };
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
  const banner = state.inCustomerModeReply
    ? `${CUSTOMER_MODE_BANNER}\n\n${reply}`
    : state.inAdminModeReply
    ? `${ADMIN_MODE_BANNER}\n\n${reply}`
    : reply;
  // An approval and ad offer that could not be sent are attached under this reply, once
  // the sender is in no other conversation. Never under Stav's admin replies.
  const full = !state.inAdminModeReply && typeof banner === "string" ? deliverPendingAdOffer(sender, banner) : banner;

  // The full reply, not just its length. Reconstructing replies from the code worked in
  // theory, but reviewing the first test run meant guessing which message each length
  // was — and a reply built from LLM output or live event data can't be rebuilt at all.
  const out = String(full || "");
  logInteraction({ dir: "out", sender, flow, chars: out.length, text: out });
  return full;
}

async function routeMessageInner(sender, text, mediaUrls = [], repliedSid = "", state = {}) {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Expire before reading any state: the periodic sweep may not have run since a restart,
  // and acting on an hours-old draft is exactly what this is meant to prevent.
  expireIdleSessions();
  lastActivity.set(sender, Date.now());
  lastInbound.set(sender, Date.now());
  // An ad offer this old no longer captures a digit; the message is routed normally.
  if (awaitingAdChoice.has(sender) && !adChoiceIsOpen(sender)) {
    awaitingAdChoice.delete(sender);
    saveState();
  }

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
    // A review command is never something a customer would type, so it runs even in
    // customer mode. In customer mode "אשר 42" was forwarded to her as an amendment to
    // event #42 (25/09/2026), and ten taps on the review template's "אשר" button each got
    // the customer menu (16/09/2026) — she tests and reviews on the same phone.
    // An open "ערוך" takes her next message in customer mode too: she asked for it.
    if (adminMode.get(sender) !== "customer" || ADMIN_ONLY_COMMAND_RE.test(trimmed) || awaitingAdminEdit) {
      state.inAdminModeReply = true;
      return handleAdminMessage(text, repliedSid);
    }
    // Customer mode is sticky and survives restarts, so announcing it only at the switch
    // left her guessing hours later — and a silent customer-mode reply looks exactly like
    // a broken admin command. Tag every reply while she is in the mode she opted into;
    // admin mode is the default and needs no banner on each message.
    state.inCustomerModeReply = true;
  }

  // Above every flow: "stop messaging me" must work whatever state they are in.
  if (trimmed === NUDGE_OPT_OUT_KEY) {
    nudgeOptOuts.add(sender);
    saveState();
    return NUDGE_OPT_OUT_TEXT;
  }

  if (CANCEL_EVENT_RE.test(trimmed)) {
    return startCancellation(sender);
  }

  if (CANCEL_KEYWORDS.has(lowerTrimmed) || MENU_KEYWORDS.has(lowerTrimmed)) {
    // Both close an open confirm question. "ביטול" also cancels its event, which would
    // otherwise sit unconfirmed until it expired; "תפריט" leaves it on Stav's list.
    const pending = awaitingConfirmation.get(sender);
    let cancelled = "";
    if (pending) {
      awaitingConfirmation.delete(sender);
      const waiting = storeFindEvent(EVENTS_FILE, pending.eventId);
      if (CANCEL_KEYWORDS.has(lowerTrimmed) && waiting && waiting.status === "awaiting_confirm") {
        await cancelEvent(waiting, sender);
        cancelled = `האירוע "${waiting.event_name}" בוטל ולא יופיע יותר בלוח ובהודעות.\n\n`;
      }
    }
    // Both close an open ad question too, which clearSession leaves alone.
    awaitingAdChoice.delete(sender);
    clearSession(sender);
    saveState();
    return `${cancelled}${MENU_TEXT}`;
  }

  if (awaitingCancelChoice.has(sender)) {
    return handleCancelChoice(sender, trimmed);
  }

  // Directly below the cancel keyword and above every flow branch: while this question is
  // open, "1" and "2" mean what INTENT_CONFIRM_TEXT says they mean, not what the main menu
  // says, so it has to outrank the switch below. It also has to outrank recentlyCompleted,
  // which would otherwise forward a non-digit answer to Stav as an amendment.
  if (awaitingIntentConfirm.has(sender)) {
    const pending = awaitingIntentConfirm.get(sender);
    awaitingIntentConfirm.delete(sender);
    saveState();

    if (trimmed === "1") {
      startInquiry(sender);
      // Re-run their original message rather than asking "what would you like to know?"
      // — they already said.
      return routeMessageInner(sender, pending.text, [], repliedSid, state);
    }
    if (trimmed === "2") {
      startSubmission(sender);
      return handleActiveSubmission(sender, pending.text, []);
    }
    // Anything else: the question is already cleared, so let this message be routed on
    // its own merits below. Asking twice is how the old bug felt.
  }

  if (activeSubmissions.has(sender)) {
    return handleActiveSubmission(sender, text, mediaUrls);
  }

  // Above the publish-choice and recentlyCompleted branches: while this is open, "1" is
  // the confirmation and any other text is a change to the event.
  if (awaitingConfirmation.has(sender)) {
    const reply = await handleConfirmation(sender, text, mediaUrls);
    if (reply !== null) return reply;
  }

  // Below the draft and the confirm question, which outrank it, and above the
  // recentlyCompleted branch: a bare "3" answering the ad question would otherwise be read
  // as a stray follow-up and forwarded to Stav as a correction to the event.
  if (awaitingAdChoice.has(sender)) {
    const reply = await handleAdChoice(sender, text, mediaUrls);
    if (reply !== null) return reply;
  }

  if (activeInquiries.has(sender)) {
    // A bare image mid-inquiry got no reply at all (28/08/2026): the empty text went to
    // the model as the question. A flyer is a submission everywhere else, so here too.
    if (!trimmed && hasUnambiguousSubmissionSignal(mediaUrls)) {
      startSubmission(sender);
      const reply = await handleActiveSubmission(sender, text, mediaUrls);
      return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      return MESSAGE_TOO_LONG_TEXT;
    }

    if (!state.rateCounted && isRateLimited(sender)) {
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
    // A flyer right after a submission was thrown away with a "we already got it". It is
    // the next event.
    if (hasUnambiguousSubmissionSignal(mediaUrls)) {
      startSubmission(sender);
      const reply = await handleActiveSubmission(sender, text, mediaUrls);
      return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
    }
    if (trimmed !== "1" && trimmed !== "2" && trimmed !== "3" && trimmed !== "4") {
      // The message right after a submission is usually about that submission, not a new
      // one. Treating every such message as a duplicate discarded real corrections — a
      // date fix ("תאמת שזה מחר") never reached Stav. Anything with content gets forwarded
      // as an amendment; only an empty/media-only message falls back to the old notice.
      if (lastId && trimmed && !looksLikeQuestion(trimmed)) {
        // Still waiting on Stav: the correction is applied, and she gets the updated
        // notice rather than a fragment to apply by hand. The flag goes back on so a
        // second correction lands the same way. After approval nothing changes on its own.
        const last = storeFindEvent(EVENTS_FILE, lastId);
        if (last && last.status === "submitted") {
          const refused = correctionRefusal(sender, text);
          if (refused) {
            recentlyCompleted.add(sender);
            saveState();
            return refused;
          }
          const { changed, event } = await applyCorrection(lastId, trimmed);
          if (changed.length) {
            await forwardEventToAdmin(lastId, event, sender, [], event.flyer);
            recentlyCompleted.add(sender);
            saveState();
            return amendmentAppliedText(changed);
          }
        }
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
    case "5":
      return startCancellation(sender);
    default: {
      // A flyer is a submission, full stop — no model call, no confirmation.
      if (hasUnambiguousSubmissionSignal(mediaUrls)) {
        startSubmission(sender);
        const reply = await handleActiveSubmission(sender, text, mediaUrls);
        return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
      }

      // Answering a reminder we sent unprompted. Moved above the classifier: it is an
      // exact match against a reminder we know we sent, so it needs no guessing and
      // should not spend a model call.
      {
        const reply = replyToReminder(sender, trimmed);
        if (reply) return reply;
      }

      if (!trimmed) return MENU_TEXT;

      // Length is not intent. The old rule read any message of 40+ characters as an event
      // and dropped the sender into a draft they could not leave — a request for gig
      // recommendations is comfortably over 40 characters, and someone asking "what's on
      // tonight?" is comfortably under it and got the menu instead of an answer. Ask what
      // the person actually wants, and when the model isn't sure, ask the person.
      // Counted here once for the whole message: the flow it lands in does not count it
      // again (it used to, so one forwarded event spent two of the five slots).
      if (isRateLimited(sender)) return RATE_LIMITED_TEXT;
      state.rateCounted = true;
      const submitNow = async () => {
        startSubmission(sender);
        const reply = await handleActiveSubmission(sender, text, mediaUrls, { rateCounted: true });
        return `${LIKELY_EVENT_DETECTED_TEXT}\n\n${reply}`;
      };
      const announcement = looksLikeEventAnnouncement(trimmed);
      // classifyIntent is written never to reject, but this is the one call standing
      // between a stranger and the wrong flow, so it does not get to depend on that.
      // Anything unexpected lands on the menu, which is always recoverable - unless the
      // text is plainly an event, which is never worth losing.
      let intent = "other";
      let confidence = 0;
      try {
        ({ intent, confidence } = await intentModule.classifyIntent(trimmed));
      } catch (err) {
        console.error("intent classification threw, falling back to menu:", err);
        return announcement ? submitNow() : MENU_TEXT;
      }

      if (intent === "cancel" && confidence >= INTENT_CONFIDENCE_THRESHOLD) {
        return startCancellation(sender);
      }

      if (confidence >= INTENT_CONFIDENCE_THRESHOLD) {
        if (intent === "submit") return submitNow();
        if (intent === "inquire") {
          // Answer the question they already asked. Re-entering here lands in the
          // activeInquiries branch above, which cannot route back to this one.
          startInquiry(sender);
          return routeMessageInner(sender, text, mediaUrls, repliedSid, state);
        }
        return announcement ? submitNow() : MENU_TEXT;
      }

      // A forwarded announcement goes straight to the draft, even when the model was
      // unsure. Only a real chance that it is a question still gets asked about.
      if (announcement && intent !== "inquire") return submitNow();

      // Not sure. Anything genuinely ambiguous between the two real flows gets the
      // question; a low-confidence "other" is just noise and gets the menu.
      if (intent === "submit" || intent === "inquire") {
        awaitingIntentConfirm.set(sender, { text: trimmed, at: Date.now() });
        saveState();
        return INTENT_CONFIRM_TEXT;
      }
      return MENU_TEXT;
    }
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

  // The link at the top of the daily board. Not counted: clicks are counted per event,
  // on /e/ and /m/, and this page links on to those.
  if (req.method === "GET" && url.pathname === "/today") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(todayPage(loadEvents(EVENTS_FILE), todayIso()));
    return;
  }

  // The preview card named by /today's og:image.
  if (req.method === "GET" && url.pathname === "/og-card.png") {
    if (!fs.existsSync(OG_CARD_FILE)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    fs.createReadStream(OG_CARD_FILE).pipe(res);
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
  setInterval(sendDueWeeklyNudge, BOARD_CHECK_INTERVAL_MS).unref();
  setInterval(() => {
    sendDueConfirmReminders().catch((err) => console.error("failed to send confirm reminders:", err));
  }, BOARD_CHECK_INTERVAL_MS).unref();
  // Keeps the click and interaction logs from growing without bound on a small volume.
  setInterval(() => {
    pruneOlderThan(LOG_RETENTION_DAYS);
    remindersStore.pruneOlderThan(LOG_RETENTION_DAYS);
  }, LOG_PRUNE_INTERVAL_MS).unref();
}

module.exports = {
  routeMessage,
  applyCorrection,
  sendToSubmitter,
  outbox,
  previewMessages,
  sendDueConfirmReminders,
  formatPendingList,
  expirePastEvents,
  get awaitingConfirmation() { return awaitingConfirmation; },
  buildSlotPosts,
  adPost,
  adsDue,
  lateAds,
  sendLateAds,
  markAdSent,
  todayPage,
  eventLandingPage,
  balanceWarning,
  lowBalanceWarning,
  withBalanceWarning,
  BALANCE_ALERT_USD,
  acknowledgeDuplicate,
  receiveInbound,
  looksLikeEventAnnouncement,
  get awaitingCancelChoice() { return awaitingCancelChoice; },
  recordReminderOptIns,
  sendDueEventReminders,
  replyToReminder,
  get recentlyReminded() { return recentlyReminded; },
  sendDueWeeklyNudge,
  nudgeRecipients,
  get nudgeOptOuts() { return nudgeOptOuts; },
  NUDGE_OPTIONS,
  pickNudgeVariant,
  get lastNudgeVariant() { return lastNudgeVariant; },
  upcomingPublishedEvents,
  get activeSubmissions() { return activeSubmissions; },
  get awaitingIntentConfirm() { return awaitingIntentConfirm; },
  get offeredEscape() { return offeredEscape; },
  get activeSubmissionImages() { return activeSubmissionImages; },
  get activeInquiries() { return activeInquiries; },
  get activeInquiryHistories() { return activeInquiryHistories; },
  get recentlyCompleted() { return recentlyCompleted; },
  get lastSubmittedEventId() { return lastSubmittedEventId; },
  get awaitingAdminEdit() { return awaitingAdminEdit; },
  get undeliveredAdminNotices() { return undeliveredAdminNotices; },
  get adminMode() { return adminMode; },
  get lastActivity() { return lastActivity; },
  get lastInbound() { return lastInbound; },
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
  // Pure, so the schedule can be tested without sending anything.
  isDue,
  slotsDueAt,
  PENDING_REMINDER_SLOT,
  goodbyeText,
  goodbyeMessage,
  mapsUrl,
  mapLink,
  sendGoodbyes,
  get awaitingAdChoice() { return awaitingAdChoice; },
  get pendingAdOffers() { return pendingAdOffers; },
  get pendingBoards() { return pendingBoards; },
  declineAd,
  askForWindow,
  confirmBoardDelivery,
  flushPendingBoards,
  _setAdOfferSender(fn) { adOfferSender = fn; },
  offerFor,
  boardSlotFor,
  DAILY_SLOTS,
  SEND_WINDOW_MINUTES,
  expireIdleSessions,
  IDLE_TIMEOUT_MS,
};
