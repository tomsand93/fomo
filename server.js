const http = require("http");
const fs = require("fs");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest } = require("./make-digest");
const { extractEvent } = require("./extract-event");

const CSV_HEADERS = [
  "id", "status", "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "description", "source",
  "published_at", "notes",
];

const PORT = Number(process.env.PORT || 3000);
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "+972528762432";

const activeSubmissions = new Map(); // sender -> array of message texts collected while drafting an event
const llmCallTimestamps = new Map(); // sender -> array of ms timestamps of recent LLM calls

const MAX_MESSAGE_LENGTH = 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CALLS = 5;

const MESSAGE_TOO_LONG_TEXT = "ההודעה ארוכה מדי. נסו לשלוח תיאור קצר יותר של האירוע.";
const RATE_LIMITED_TEXT = "שלחתם הרבה הודעות ברצף. חכו דקה ונסו שוב.";

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

1. לפרסם אירוע
2. לראות מחירון פרסום
3. שירות לקוחות`;

const ASK_EVENT_DETAILS_TEXT = "שלחו את פרטי האירוע בפורמט חופשי.";

const PRICE_PLACEHOLDER_TEXT = "מחיר הפרסום: יעודכן בקרוב, פנו אלינו לפרטים.";

const CUSTOMER_SERVICE_TEXT = "לשירות לקוחות פנו לסתיו: +972528762432";

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

async function routeMessage(sender, text) {
  if (activeSubmissions.has(sender)) {
    const trimmed = text.trim();
    if (trimmed === "ביטול" || trimmed === "cancel") {
      activeSubmissions.delete(sender);
      return MENU_TEXT;
    }

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
    return "קיבלנו את האירוע. הוא נכנס לבדיקה לפני פרסום.";
  }

  switch (text.trim()) {
    case "1":
      activeSubmissions.set(sender, []);
      return ASK_EVENT_DETAILS_TEXT;
    case "2":
      return PRICE_PLACEHOLDER_TEXT;
    case "3":
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

module.exports = { missingFields, routeMessage, activeSubmissions };
