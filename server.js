const http = require("http");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest } = require("./make-digest");
const { appendEvent: storeAppendEvent, updateEvent: storeUpdateEvent, findEvent: storeFindEvent } = require("./events-store");
const { extractEvent } = require("./extract-event");
const { answerInquiry } = require("./answer-inquiry");
const { sendWhatsApp } = require("./send-whatsapp");
const { fetchMediaAsDataUrl } = require("./fetch-media");

const PORT = Number(process.env.PORT || 3000);
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "+972528762432";
const ADMIN_SENDER = `whatsapp:${ADMIN_PHONE}`;
const STATE_FILE = process.env.STATE_FILE || path.join(path.dirname(EVENTS_FILE), "state.json");

let activeSubmissions = new Map(); // sender -> array of message texts collected while drafting an event
let activeSubmissionImages = new Map(); // sender -> array of image data URLs collected while drafting an event
let activeInquiries = new Set(); // senders currently in the "ask about events" flow
let recentlyCompleted = new Set(); // senders whose last action was a completed submission, for a softer follow-up
const llmCallTimestamps = new Map(); // sender -> array of ms timestamps of recent LLM calls

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    activeSubmissions = new Map(raw.activeSubmissions || []);
    activeSubmissionImages = new Map(raw.activeSubmissionImages || []);
    activeInquiries = new Set(raw.activeInquiries || []);
    recentlyCompleted = new Set(raw.recentlyCompleted || []);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("failed to load state:", err);
  }
}

function saveState() {
  const payload = {
    activeSubmissions: [...activeSubmissions.entries()],
    activeSubmissionImages: [...activeSubmissionImages.entries()],
    activeInquiries: [...activeInquiries],
    recentlyCompleted: [...recentlyCompleted],
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload), "utf8");
  } catch (err) {
    console.error("failed to save state:", err);
  }
}

const MAX_MESSAGE_LENGTH = 1000;
const MAX_IMAGES_PER_EVENT = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CALLS = 5;

const MESSAGE_TOO_LONG_TEXT = "ההודעה ארוכה מדי. נסו לשלוח תיאור קצר יותר של האירוע.";
const RATE_LIMITED_TEXT = "שלחתם הרבה הודעות ברצף. חכו דקה ונסו שוב.";
const MEDIA_FETCH_FAILED_TEXT = "לא הצלחנו לקרוא את התמונה ששלחתם. נסו לשלוח אותה שוב, או המשיכו עם טקסט בלבד.";

const KNOWN_CATEGORIES = ["קולנוע", "אוכל ויין", "מסיבה", "קריוקי", "מוזיקה חיה", "מוזיקה"];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function filterEventsForInquiry(question, events) {
  const published = events.filter((event) => event.status === "published");
  const text = question.trim();

  let dateFilter = null;
  if (text.includes("היום")) dateFilter = todayIso();
  else if (text.includes("מחר")) dateFilter = addDays(todayIso(), 1);

  const matchedCategory = KNOWN_CATEGORIES.find((category) => text.includes(category));

  return published.filter((event) => {
    if (dateFilter && event.date !== dateFilter) return false;
    if (matchedCategory) {
      const related = event.category.includes(matchedCategory) || matchedCategory.includes(event.category);
      if (!related) return false;
    }
    return true;
  });
}

function isRateLimited(sender) {
  const now = Date.now();
  const timestamps = (llmCallTimestamps.get(sender) || []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  llmCallTimestamps.set(sender, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_CALLS;
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
const CONTACT_LINK_RE = /^(https?:\/\/\S+|\+?\d[\d\s-]{6,}\d|@\w+)$/i;

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

function formatEventForReview(id, event, sender) {
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
    "",
    `לאישור: אשר ${id}`,
    `לדחייה: דחה ${id} [סיבה]`,
  ].filter((line) => line !== null).join("\n");
}

async function forwardEventToAdmin(id, event, sender) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await sendWhatsApp(ADMIN_SENDER, formatEventForReview(id, event, sender));
  } catch (err) {
    console.error("failed to forward event to admin:", err);
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
אשר <מספר> - לאשר ולפרסם אירוע
דחה <מספר> [סיבה] - לדחות אירוע
ממתינים - רשימת אירועים ממתינים לבדיקה`;

function formatPendingList(events) {
  const pending = events.filter((e) => e.status === "submitted");
  if (!pending.length) return "אין אירועים ממתינים כרגע.";
  return pending
    .map((e) => `#${e.id} ${e.event_name} — ${e.date} ${e.start_time}`)
    .join("\n");
}

const ADMIN_COMMAND_RE = /^(אשר|דחה)\s*#?(\d+)\s*(.*)$/;

async function handleAdminMessage(text) {
  const trimmed = text.trim();

  if (trimmed === "ממתינים") {
    return formatPendingList(loadEvents(EVENTS_FILE));
  }

  const match = trimmed.match(ADMIN_COMMAND_RE);
  if (!match) return ADMIN_HELP_TEXT;

  const [, action, id, reason] = match;
  const existing = storeFindEvent(EVENTS_FILE, id);
  if (!existing) {
    return `לא נמצא אירוע #${id}.\n\n${formatPendingList(loadEvents(EVENTS_FILE))}`;
  }

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

function twiml(message) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const params = new URLSearchParams(body);
  const text = params.get("Body") || "";
  const sender = params.get("From") || "";
  const mediaUrls = extractMediaUrls(params);

  let reply;
  try {
    reply = await routeMessage(sender, text, mediaUrls);
  } catch (err) {
    console.error("routeMessage failed:", err);
    reply = "מצטערים, קרתה תקלה. נסו שוב בעוד רגע.";
  }

  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(twiml(reply));
}

const MENU_KEYWORDS = new Set(["תפריט", "/menu", "menu"]);
const CANCEL_KEYWORDS = new Set(["ביטול", "/cancel", "cancel"]);

async function routeMessage(sender, text, mediaUrls = []) {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (sender === ADMIN_SENDER) {
    return handleAdminMessage(text);
  }

  if (CANCEL_KEYWORDS.has(lowerTrimmed) || MENU_KEYWORDS.has(lowerTrimmed)) {
    activeSubmissions.delete(sender);
    activeSubmissionImages.delete(sender);
    activeInquiries.delete(sender);
    recentlyCompleted.delete(sender);
    saveState();
    return MENU_TEXT;
  }

  if (activeSubmissions.has(sender)) {
    if (text.length > MAX_MESSAGE_LENGTH) {
      return MESSAGE_TOO_LONG_TEXT;
    }

    if (isRateLimited(sender)) {
      return RATE_LIMITED_TEXT;
    }

    const images = activeSubmissionImages.get(sender) || [];
    if (mediaUrls.length) {
      try {
        const fetched = await Promise.all(mediaUrls.map(fetchMediaAsDataUrl));
        images.push(...fetched);
        activeSubmissionImages.set(sender, images.slice(0, MAX_IMAGES_PER_EVENT));
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

    const event = await extractEvent(conversationText, undefined, images);
    const missing = missingFields(event);

    if (missing.length) {
      return `חסרים עדיין פרטים: ${missing.join(", ")}\nשלחו את הפרטים החסרים, או "ביטול" כדי לצאת.`;
    }

    activeSubmissions.delete(sender);
    activeSubmissionImages.delete(sender);
    recentlyCompleted.add(sender);
    saveState();
    const { id } = appendEvent(event, "Twilio WhatsApp", sender);
    await forwardEventToAdmin(id, event, sender);
    return "קיבלנו את האירוע. הוא נכנס לבדיקה לפני פרסום.";
  }

  if (activeInquiries.has(sender)) {
    if (text.length > MAX_MESSAGE_LENGTH) {
      return MESSAGE_TOO_LONG_TEXT;
    }

    if (isRateLimited(sender)) {
      return RATE_LIMITED_TEXT;
    }

    const allEvents = loadEvents(EVENTS_FILE);
    const relevant = filterEventsForInquiry(text, allEvents);
    const answer = await answerInquiry(text, relevant);
    return `${answer}\n\n(כתבו "ביטול" כדי לחזור לתפריט)`;
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
      saveState();
      return ASK_INQUIRY_TEXT;
    case "2":
      activeSubmissions.set(sender, []);
      activeSubmissionImages.delete(sender);
      saveState();
      return ASK_EVENT_DETAILS_TEXT;
    case "3":
      return PRICE_PLACEHOLDER_TEXT;
    case "4":
      return CUSTOMER_SERVICE_TEXT;
    default:
      return MENU_TEXT;
  }
}

function handlePayPlus(req, res, body) {
  fs.appendFileSync("payplus-webhooks.log", `${new Date().toISOString()} ${body}\n`, "utf8");
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
}

module.exports = {
  missingFields,
  routeMessage,
  get activeSubmissions() { return activeSubmissions; },
  get activeSubmissionImages() { return activeSubmissionImages; },
  get activeInquiries() { return activeInquiries; },
  get recentlyCompleted() { return recentlyCompleted; },
};
