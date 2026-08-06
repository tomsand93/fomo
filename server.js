const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest } = require("./make-digest");
const { appendEvent: storeAppendEvent, updateEvent: storeUpdateEvent, findEvent: storeFindEvent } = require("./events-store");
const extractEventModule = require("./extract-event");
const { addCorrection, buildCorrectionGuidance } = require("./corrections-store");
const answerInquiryModule = require("./answer-inquiry");
const { sendWhatsApp, getMessageStatus } = require("./send-whatsapp");
const { fetchMediaAsDataUrl } = require("./fetch-media");

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
let undeliveredAdminNotices = new Set(); // event ids whose review notice never reached the admin, surfaced on her next message
let askedForClarification = new Set(); // senders already asked a clarifying question this submission, so we never ask twice
let incompleteAttempts = new Map(); // sender -> consecutive turns still missing required fields, so a draft can't loop forever
let noticeSidToEventId = new Map(); // Twilio message sid of a review notice -> event id, so a WhatsApp reply to it resolves without a number
// The admin's phone is also her QA/testing phone, so her role can't be inferred from the
// message text: "2" is both a menu choice and (previously) a reject command. She declares
// which hat she's wearing instead. Anyone who isn't the admin is always a customer.
let adminMode = new Map(); // ADMIN_SENDER -> "admin" | "customer"
let lastActivity = new Map(); // sender -> ms timestamp of last inbound message, for idle expiry
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
    undeliveredAdminNotices = new Set(raw.undeliveredAdminNotices || []);
    askedForClarification = new Set(raw.askedForClarification || []);
    incompleteAttempts = new Map(raw.incompleteAttempts || []);
    noticeSidToEventId = new Map(raw.noticeSidToEventId || []);
    adminMode = new Map(raw.adminMode || []);
    lastActivity = new Map(raw.lastActivity || []);
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
    undeliveredAdminNotices: [...undeliveredAdminNotices],
    askedForClarification: [...askedForClarification],
    incompleteAttempts: [...incompleteAttempts.entries()],
    // Bounded: only recent notices need to stay resolvable by reply.
    noticeSidToEventId: [...noticeSidToEventId].slice(-50),
    adminMode: [...adminMode.entries()],
    lastActivity: [...lastActivity.entries()],
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
const MAX_INQUIRY_HISTORY = 12;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

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

const PENDING_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Events don't chase themselves: without a nudge a submission can sit unreviewed until its
// date passes (as #3 and #5 did). Re-send the pending list once a day until it's empty.
async function sendPendingReminder() {
  if (process.env.NODE_ENV === "test") return;
  const events = loadEvents(EVENTS_FILE);
  const pending = events.filter((e) => e.status === "submitted");
  if (!pending.length) return;

  const today = todayIso();
  const upcoming = pending.filter((e) => !e.date || e.date >= today);
  const expired = pending.filter((e) => e.date && e.date < today);

  const lines = [`יש ${pending.length} אירועים שממתינים לאישור:`, ""];
  for (const e of upcoming) {
    lines.push(`#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`);
  }
  if (expired.length) {
    lines.push("", "עברו כבר (אפשר לדחות):");
    for (const e of expired) lines.push(`#${e.id} ${e.event_name} — ${e.date}`);
  }
  lines.push("", 'ענו על הודעת האירוע עם "אשר" או "דחה", או כתבו "אשר <מספר>".');

  try {
    // Deliberately not bound to an event id: a reply to a *list* has no single referent,
    // and binding it to one (even when only one is pending) is how "דחה" in reply to a
    // reminder rejected an unrelated event. Replies must target a specific event notice.
    await sendWhatsApp(ADMIN_SENDER, lines.join("\n"));
  } catch (err) {
    console.error("failed to send pending reminder:", err);
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
}

// A conversation that goes quiet is abandoned, not paused. Without this a half-finished
// draft survives forever (it's persisted to state.json, so even a restart won't clear it)
// and the next unrelated message gets answered in the context of a stale one.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function hasSessionState(sender) {
  return (
    activeSubmissions.has(sender) ||
    activeInquiries.has(sender) ||
    recentlyCompleted.has(sender)
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

const FOLLOW_UP_AFTER_SUBMISSION_TEXT = `האירוע האחרון שלכם כבר נשלח לבדיקה, אין צורך לשלוח שוב.

היי! מה תרצו לעשות?

1. לברר בנוגע לאירועים
2. לפרסם אירוע
3. לראות מחירון פרסום
4. שירות לקוחות`;

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

function fieldIsValid(key, value) {
  if (!value) return true; // emptiness is handled by missingFields, not here
  if (key === "date") return isValidDate(value);
  if (key === "start_time" || key === "end_time") return TIME_RE.test(value);
  if (key === "contact_link") return CONTACT_LINK_RE.test(value.trim());
  return true;
}

function missingFields(event) {
  const required = [
    ["event_name", "שם האירוע"],
    ["date", "תאריך"],
    ["start_time", "שעה"],
    ["location", "מיקום"],
    ["category", "קטגוריה"],
    ["contact_link", "קישור / איש קשר"],
  ];
  return required
    .filter(([key]) => !event[key] || !fieldIsValid(key, event[key]))
    .map(([, label]) => label);
}

function appendEvent(event, source, sender) {
  const missing = missingFields(event);
  const id = storeAppendEvent(EVENTS_FILE, event, source, sender, missing);
  return { missing, id };
}

function formatEventForReview(id, event, sender, unresolved = []) {
  // Surface anything the submitter couldn't clear up, so Stav reviews with the same
  // doubt the extractor had rather than trusting a silently guessed value.
  const uncertaintyNote = unresolved.length
    ? `\n⚠️ לא הובהר: ${unresolved.join(" | ")}\n`
    : "";
  return [
    `אירוע חדש לבדיקה #${id}:`,
    `שם: ${event.event_name}`,
    `תאריך: ${event.date}`,
    `שעה: ${event.start_time}${event.end_time ? ` - ${event.end_time}` : ""}`,
    `מיקום: ${event.location}`,
    `קטגוריה: ${event.category}`,
    event.price ? `מחיר: ${event.price}` : null,
    event.organizer ? `מארגן: ${event.organizer}` : null,
    `קישור/איש קשר: ${event.contact_link}`,
    event.description ? `תיאור: ${event.description}` : null,
    `נשלח מ: ${sender}`,
    uncertaintyNote || null,
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

async function forwardEventToAdmin(id, event, sender, unresolved = []) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const result = await sendWhatsApp(ADMIN_SENDER, formatEventForReview(id, event, sender, unresolved));
    rememberNotice(result.sid, id);
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

async function notifySubmitter(sender, text) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await sendWhatsApp(sender, text);
  } catch (err) {
    console.error("failed to notify submitter:", err);
  }
}

const ADMIN_HELP_TEXT = `פקודות ניהול:
הכי פשוט: ענו על הודעת האירוע עצמה עם "אשר" או "דחה"

אשר <מספר> - לאשר ולפרסם אירוע
דחה <מספר> [סיבה] - לדחות אירוע
ממתינים - רשימת אירועים ממתינים לבדיקה
תקן <מספר> <שדה>: <ערך> - לתקן פרט באירוע (הבוט ילמד מהתיקון)

שדות לתיקון: שם, תאריך, שעה, שעת סיום, מיקום, קטגוריה, מחיר, מארגן, קישור, תיאור
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
  const pending = events.filter((e) => e.status === "submitted");
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
// asks which event instead of picking one.
function resolveEventId(explicitId, repliedSid) {
  if (explicitId) return String(explicitId);
  if (repliedSid && noticeSidToEventId.has(repliedSid)) return noticeSidToEventId.get(repliedSid);
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
  return `⚠️ אירועים שההודעה עליהם לא הגיעה אליך:\n${lines}\n\n`;
}

async function handleAdminMessage(text, repliedSid = "") {
  const trimmed = text.trim();
  const banner = missedNoticesBanner(loadEvents(EVENTS_FILE));

  if (trimmed === "ממתינים") {
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
    return `${banner}לא ברור לאיזה אירוע הכוונה — לא שיניתי כלום.\nענו על הודעת האירוע עם "${action}", או כתבו "${action} <מספר>".\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

  const existing = storeFindEvent(EVENTS_FILE, id);
  if (!existing) {
    return `${banner}לא נמצא אירוע #${id}.\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

  // Acting on an event means it was seen; stop flagging it as a missed notice.
  if (undeliveredAdminNotices.delete(String(id))) saveState();

  if (action === "אשר") {
    if (existing.status === "published") {
      return `אירוע #${id} כבר מאושר ומפורסם.`;
    }
    storeUpdateEvent(EVENTS_FILE, id, { status: "published", published_at: todayIso() });
    if (existing.submitter) {
      await notifySubmitter(existing.submitter, `האירוע שלכם "${existing.event_name}" אושר ויפורסם 🎉`);
    }
    return `אירוע #${id} אושר ופורסם.`;
  }

  // action === "דחה"
  if (existing.status === "rejected") {
    return `אירוע #${id} כבר נדחה.`;
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
  const text = params.get("Body") || "";
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

  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(twiml(reply));
}

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
      return `חסרים עדיין פרטים: ${missing.join(", ")}\nשלחו את הפרטים החסרים, או "ביטול" כדי לצאת.`;
    }

    const unresolvedMissing = [`חסרים פרטים שלא הצלחנו לקבל: ${missing.join(", ")}`];
    clearSession(sender);
    recentlyCompleted.add(sender);
    saveState();
    const { id } = appendEvent(event, "Twilio WhatsApp", sender);
    await forwardEventToAdmin(id, event, sender, unresolvedMissing);
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

  const unresolved = questions.length ? questions : [];

  clearSession(sender);
  recentlyCompleted.add(sender);
  saveState();
  const { id } = appendEvent(event, "Twilio WhatsApp", sender);
  await forwardEventToAdmin(id, event, sender, unresolved);
  return "קיבלנו את האירוע. הוא נכנס לבדיקה לפני פרסום.";
}

const ADMIN_MODE_KEYWORDS = new Set(["ניהול", "admin"]);
const CUSTOMER_MODE_KEYWORDS = new Set(["לקוח", "customer", "qa"]);

const ADMIN_MODE_TEXT = `🛠 מצב ניהול. כתבו "לקוח" כדי לבדוק כמו משתמש רגיל.

${ADMIN_HELP_TEXT}`;

const CUSTOMER_MODE_TEXT = `👤 מצב לקוח (בדיקות) — פקודות הניהול כבויות. כתבו "ניהול" כדי לחזור.

${MENU_TEXT}`;

async function routeMessage(sender, text, mediaUrls = [], repliedSid = "") {
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
  }

  if (CANCEL_KEYWORDS.has(lowerTrimmed) || MENU_KEYWORDS.has(lowerTrimmed)) {
    clearSession(sender);
    saveState();
    return MENU_TEXT;
  }

  if (activeSubmissions.has(sender)) {
    return handleActiveSubmission(sender, text, mediaUrls);
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
    const answer = await answerInquiryModule.answerInquiry(history, events);

    history.push({ role: "assistant", content: answer });
    activeInquiryHistories.set(sender, history.slice(-MAX_INQUIRY_HISTORY));
    saveState();

    return isFirstExchange ? `${answer}\n\n(כתבו "ביטול" כדי לחזור לתפריט)` : answer;
  }

  if (recentlyCompleted.has(sender)) {
    recentlyCompleted.delete(sender);
    saveState();
    if (trimmed !== "1" && trimmed !== "2" && trimmed !== "3" && trimmed !== "4") {
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
      return MENU_TEXT;
  }
}

const PAYPLUS_LOG_FILE = "payplus-webhooks.log";
const PAYPLUS_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB, rotate past this

function handlePayPlus(req, res, body) {
  fs.stat(PAYPLUS_LOG_FILE, (statErr, stats) => {
    const rotate = !statErr && stats.size > PAYPLUS_LOG_MAX_BYTES;
    const line = `${new Date().toISOString()} ${body}\n`;
    const write = rotate
      ? fs.promises.writeFile(PAYPLUS_LOG_FILE, line, "utf8")
      : fs.promises.appendFile(PAYPLUS_LOG_FILE, line, "utf8");
    write.catch((err) => console.error("failed to write PayPlus log:", err));
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
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

  if (req.method === "POST" && req.url === "/webhook/payplus") {
    requestBody(req, (body) => handlePayPlus(req, res, body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/digest") {
    const targetDate = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const digest = makeDigest(loadEvents(EVENTS_FILE), targetDate);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(digest);
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
  server.listen(PORT, () => console.log(`listening on ${PORT}`));
  setInterval(sweepStaleRateLimitEntries, RATE_LIMIT_SWEEP_INTERVAL_MS).unref();
  setInterval(sendPendingReminder, PENDING_REMINDER_INTERVAL_MS).unref();
  setInterval(expireIdleSessions, IDLE_SWEEP_INTERVAL_MS).unref();
}

module.exports = {
  missingFields,
  routeMessage,
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
  expireIdleSessions,
  IDLE_TIMEOUT_MS,
};
