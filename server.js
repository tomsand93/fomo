const http = require("http");
const fs = require("fs");
const { URLSearchParams } = require("url");
const { loadEvents, makeDigest } = require("./make-digest");

const CSV_HEADERS = [
  "id", "status", "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "description", "source",
  "published_at", "notes",
];

const PORT = Number(process.env.PORT || 3000);
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "+972528762432";

const awaitingEventDetails = new Set(); // senders who chose "1" and should send free text next

const MENU_TEXT = `היי! מה תרצו לעשות?

1. לפרסם אירוע
2. לראות מחירון פרסום
3. שירות לקוחות`;

const ASK_EVENT_DETAILS_TEXT = "שלחו את פרטי האירוע בפורמט חופשי.";

const PRICE_PLACEHOLDER_TEXT = "מחיר הפרסום: יעודכן בקרוב, פנו אלינו לפרטים.";

const CUSTOMER_SERVICE_TEXT = "לשירות לקוחות פנו לסתיו: +972528762432";

const REVIEW_COMMAND = "סקירה";
const REVIEWABLE_STATUS = "submitted";

const fields = {
  event_name: ["שם האירוע", "event name"],
  date: ["תאריך", "date"],
  start_time: ["שעת התחלה", "שעה", "start time", "time"],
  end_time: ["שעת סיום", "end time"],
  location: ["מיקום", "location"],
  category: ["קטגוריה", "category"],
  price: ["מחיר", "price"],
  organizer: ["מארגן", "organizer"],
  contact_link: ["קישור", "איש קשר", "contact", "link"],
  description: ["תיאור קצר", "תיאור", "description"],
};

function csv(value) {
  const text = String(value || "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseMessage(body) {
  const event = Object.fromEntries(Object.keys(fields).map((key) => [key, ""]));

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim().toLowerCase();
    const value = match[2].trim();
    for (const [key, labels] of Object.entries(fields)) {
      if (labels.some((candidate) => label.includes(candidate.toLowerCase()))) {
        event[key] = value;
      }
    }
  }

  if (!event.description) event.description = body.replace(/\s+/g, " ").trim();
  return event;
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

function handleTwilio(req, res, body) {
  const params = new URLSearchParams(body);
  const text = params.get("Body") || "";
  const sender = params.get("From") || "";

  res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(twiml(routeMessage(sender, text)));
}

function routeMessage(sender, text) {
  if (awaitingEventDetails.has(sender)) {
    awaitingEventDetails.delete(sender);
    const event = parseMessage(text);
    const missing = appendEvent(event, "Twilio WhatsApp", sender);
    return missing.length
      ? `חסרים פרטים כדי לפרסם: ${missing.join(", ")}`
      : "קיבלנו את האירוע. הוא נכנס לבדיקה לפני פרסום.";
  }

  switch (text.trim()) {
    case "1":
      awaitingEventDetails.add(sender);
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

module.exports = { parseMessage, missingFields, routeMessage, awaitingEventDetails };
