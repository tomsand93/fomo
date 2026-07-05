const http = require("http");
const fs = require("fs");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest } = require("./make-digest");
const { extractEvent } = require("./extract-event");
const { answerInquiry } = require("./answer-inquiry");
const { sendWhatsApp } = require("./send-whatsapp");

const CSV_HEADERS = [
  "id", "status", "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "description", "source",
  "published_at", "notes",
];

const PORT = Number(process.env.PORT || 3000);
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "+972528762432";

const activeSubmissions = new Map(); // sender -> array of message texts collected while drafting an event
const activeInquiries = new Set(); // senders currently in the "ask about events" flow
const recentlyCompleted = new Set(); // senders whose last action was a completed submission, for a softer follow-up
const llmCallTimestamps = new Map(); // sender -> array of ms timestamps of recent LLM calls

const MAX_MESSAGE_LENGTH = 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CALLS = 5;

const MESSAGE_TOO_LONG_TEXT = "ההודעה ארוכה מדי. נסו לשלוח תיאור קצר יותר של האירוע.";
const RATE_LIMITED_TEXT = "שלחתם הרבה הודעות ברצף. חכו דקה ונסו שוב.";

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

const REVIEW_COMMAND = "סקירה";
const REVIEWABLE_STATUS = "submitted";

function csv(value) {
  const text = String(value || "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function missingFields(event) {
  return [
    ["event_name", "שם האירוע"],
    ["date", "תאריך"],
    ["start_time", "שעה"],
    ["location", "מיקום"],
    ["category", "קטגוריה"],
    ["contact_link", "קישור / איש קשר"],
  ].filter(([key]) => !event[key]).map(([, label]) => label);
}

function appendEvent(event, source, sender) {
  const missing = missingFields(event);
  const status = missing.length ? "needs_info" : "submitted";
  const row = [
    status,
    event.event_name,
    event.date,
    event.start_time,
    event.end_time,
    event.location,
    event.category,
    event.price,
    event.organizer,
    event.contact_link,
    event.description,
    source,
    "",
    [sender, missing.length ? `חסר: ${missing.join(", ")}` : ""].filter(Boolean).join(" | "),
  ];
  fs.appendFileSync(EVENTS_FILE, `${row.map(csv).join(",")}\n`, "utf8");
  return missing;
}

function formatEventForReview(event, sender) {
  return [
    "אירוע חדש לבדיקה:",
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
  ].filter(Boolean).join("\n");
}

async function forwardEventToAdmin(event, sender) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await sendWhatsApp(`whatsapp:${ADMIN_PHONE}`, formatEventForReview(event, sender));
  } catch (err) {
    console.error("failed to forward event to admin:", err);
  }
}

function twiml(message) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

async function handleTwilio(req, res, body) {
  const params = new URLSearchParams(body);
  const text = params.get("Body") || "";
  const sender = params.get("From") || "";

  let reply;
  try {
    reply = await routeMessage(sender, text);
  } catch (err) {
    console.error("routeMessage failed:", err);
    reply = "מצטערים, קרתה תקלה. נסו שוב בעוד רגע.";
  }

  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(twiml(reply));
}

const MENU_KEYWORDS = new Set(["תפריט", "/menu", "menu"]);
const CANCEL_KEYWORDS = new Set(["ביטול", "/cancel", "cancel"]);

async function routeMessage(sender, text) {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (CANCEL_KEYWORDS.has(lowerTrimmed) || MENU_KEYWORDS.has(lowerTrimmed)) {
    activeSubmissions.delete(sender);
    activeInquiries.delete(sender);
    recentlyCompleted.delete(sender);
    return MENU_TEXT;
  }

  if (activeSubmissions.has(sender)) {
    if (text.length > MAX_MESSAGE_LENGTH) {
      return MESSAGE_TOO_LONG_TEXT;
    }

    if (isRateLimited(sender)) {
      return RATE_LIMITED_TEXT;
    }

    const messages = activeSubmissions.get(sender);
    messages.push(text);
    const conversationText = messages.map((line, i) => `הודעה ${i + 1}: ${line}`).join("\n");

    const event = await extractEvent(conversationText);
    const missing = missingFields(event);

    if (missing.length) {
      return `חסרים עדיין פרטים: ${missing.join(", ")}\nשלחו את הפרטים החסרים, או "ביטול" כדי לצאת.`;
    }

    activeSubmissions.delete(sender);
    appendEvent(event, "Twilio WhatsApp", sender);
    recentlyCompleted.add(sender);
    await forwardEventToAdmin(event, sender);
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
    if (trimmed !== "1" && trimmed !== "2" && trimmed !== "3" && trimmed !== "4") {
      return FOLLOW_UP_AFTER_SUBMISSION_TEXT;
    }
  }

  switch (trimmed) {
    case "1":
      activeInquiries.add(sender);
      return ASK_INQUIRY_TEXT;
    case "2":
      activeSubmissions.set(sender, []);
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

if (require.main === module) {
  server.listen(PORT, () => console.log(`listening on ${PORT}`));
}

module.exports = { missingFields, routeMessage, activeSubmissions, activeInquiries, recentlyCompleted };
