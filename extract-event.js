const https = require("https");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

const FIELD_KEYS = [
  "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "description",
];

function buildPrompt(conversationText, todayIso) {
  return `אתה עוזר שמחלץ פרטי אירוע תרבות מהודעות טקסט בעברית (או מעורבות עברית/אנגלית) שנשלחות בוואטסאפ.
היום התאריך הוא ${todayIso} (פורמט YYYY-MM-DD).

חלץ את השדות הבאים מהטקסט. אם שדה לא מוזכר, השאר אותו כמחרוזת ריקה "".
- event_name: שם האירוע
- date: תאריך האירוע בפורמט YYYY-MM-DD. אם נאמר יום בשבוע (כמו "יום שישי") ללא תאריך מדויק, חשב את התאריך הקרוב ביותר בעתיד מהיום הנוכחי.
- start_time: שעת התחלה בפורמט HH:MM (24 שעות). אם נאמר "בצהריים" השתמש ב-12:00, "בערב" 19:00, "אחר הצהריים" 16:00, אלא אם צוין אחרת.
- end_time: שעת סיום בפורמט HH:MM, אם צוין.
- location: מיקום/כתובת/שם מקום.
- category: קטגוריה (לדוגמה: מוזיקה, מסיבה, קולנוע, אוכל ויין, קריוקי, מוזיקה חיה, אחר).
- price: מחיר או "כניסה חופשית" אם צוין.
- organizer: שם המארגן, אם צוין.
- contact_link: קישור, מספר טלפון, או איש קשר לפרטים נוספים.
- description: תיאור קצר וחופשי של האירוע, כולל פרטים שלא נכנסו לשדות אחרים.

הטקסט הוא היסטוריית שיחה מלאה עם המשתמש (הודעות מאוחרות עשויות להשלים או לתקן מידע מהודעות קודמות). מזג את כל המידע לטיוטת אירוע אחת עדכנית.

השב אך ורק ב-JSON תקין בפורמט הבא, ללא טקסט נוסף:
{"event_name":"","date":"","start_time":"","end_time":"","location":"","category":"","price":"","organizer":"","contact_link":"","description":""}

טקסט השיחה:
${conversationText}`;
}

function callOpenRouter(prompt) {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const options = {
    hostname: "openrouter.ai",
    path: "/api/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenRouter error ${res.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function emptyEvent() {
  return Object.fromEntries(FIELD_KEYS.map((key) => [key, ""]));
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object found in model response");
  return JSON.parse(match[0]);
}

async function extractEvent(conversationText, todayIso = new Date().toISOString().slice(0, 10)) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const prompt = buildPrompt(conversationText, todayIso);
  const raw = await callOpenRouter(prompt);
  const parsed = JSON.parse(raw);
  const content = parsed.choices?.[0]?.message?.content || "";
  const fields = extractJson(content);

  const event = emptyEvent();
  for (const key of FIELD_KEYS) {
    if (typeof fields[key] === "string") event[key] = fields[key].trim();
  }
  return event;
}

module.exports = { extractEvent, FIELD_KEYS };
