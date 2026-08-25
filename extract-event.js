const { postJson } = require("./http-json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

const FIELD_KEYS = [
  "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "contact_person", "description",
];

function buildPreviouslyExtractedNote(previousEvent) {
  if (!previousEvent) return "";
  const knownFields = FIELD_KEYS
    .filter((key) => previousEvent[key])
    .map((key) => `${key}: ${previousEvent[key]}`)
    .join(", ");
  if (!knownFields) return "";
  return `\nמהודעה קודמת (כולל תמונה שכבר לא מצורפת כעת) כבר חולצו הפרטים הבאים: ${knownFields}.\nשמור על הפרטים האלה אלא אם הטקסט החדש סותר או מעדכן אותם.\n`;
}

function buildPrompt(conversationText, todayIso, hasImages, previousEvent, correctionGuidance = "") {
  const imageNote = hasImages
    ? "\nבנוסף לטקסט צורפו תמונה/ות של פלייר האירוע. חלץ מידע גם מהטקסט המופיע בתמונה (שם האירוע, תאריך, שעה, מיקום וכו').\n"
    : "\n";
  const previouslyExtractedNote = buildPreviouslyExtractedNote(previousEvent);
  return `אתה עוזר שמחלץ פרטי אירוע תרבות מהודעות טקסט בעברית (או מעורבות עברית/אנגלית) שנשלחות בוואטסאפ.
היום התאריך הוא ${todayIso} (פורמט YYYY-MM-DD).
${imageNote}${previouslyExtractedNote}
חלץ את השדות הבאים מהטקסט (ומהתמונה אם צורפה). אם שדה לא מוזכר בשום מקום, השאר אותו כמחרוזת ריקה "".
- event_name: שם האירוע. אם אין כותרת מפורשת (כמו "שם האירוע:"), הסק שם קצר וברור מהשורה הראשונה או מהתיאור הכללי של האירוע. השאר ריק רק אם באמת אי אפשר להסיק שם כלשהו.
- date: תאריך האירוע בפורמט YYYY-MM-DD. אם נאמר יום בשבוע (כמו "יום שישי") ללא תאריך מדויק, חשב את התאריך הקרוב ביותר בעתיד מהיום הנוכחי.
- start_time: שעת התחלה בפורמט HH:MM (24 שעות). אם נאמר "בצהריים" השתמש ב-12:00, "בערב" 19:00, "אחר הצהריים" 16:00, אלא אם צוין אחרת.
- end_time: שעת סיום בפורמט HH:MM, אם צוין.
- location: מיקום/כתובת/שם מקום.
- category: קטגוריה (לדוגמה: מוזיקה, מסיבה, קולנוע, אוכל ויין, קריוקי, מוזיקה חיה, אחר). אם הקטגוריה לא נאמרת במפורש, הסק אותה מהתיאור (למשל אירוע שירה/נגינה/הופעה -> מוזיקה חיה).
- price: אך ורק מחיר הכניסה לאירוע (דמי כניסה / כרטיס), או "כניסה חופשית" אם נאמר שהכניסה חינם.
  חשוב: אל תשים כאן מחירים של דברים שנמכרים באירוע — אוכל, שתייה, יין, כרטיסי הגרלה, סדנאות בתשלום וכו'.
  לדוגמה: "ערב יין, פלייט של 3 יינות ב-180 ש\"ח" — זה מחיר של מוצר שנמכר, לא מחיר כניסה, ולכן price נשאר ריק (""), והפרט הזה שייך ל-description.
  אם לא נאמר במפורש מה עולה הכניסה, השאר את price ריק ("") — אל תנחש ואל תשתמש במחיר אחר שמופיע בטקסט.
  אם מופיע בטקסט מחיר כלשהו אך לא ברור אם הוא דמי כניסה או מחיר של מוצר שנמכר באירוע — השאר price ריק וגם הוסף שאלה על כך ל-_questions.
- organizer: שם המארגן, אם צוין.
- contact_link: קישור או מספר טלפון לפרטים נוספים.
- contact_person: שם האדם שאפשר לפנות אליו לפרטים, אם צוין שם. רק שם של אדם — לא קישור, לא מספר טלפון, ולא שם של מקום או ארגון (אלה שייכים ל-organizer).
- description: תיאור קצר וחופשי של האירוע, כולל פרטים שלא נכנסו לשדות אחרים.

הטקסט הוא היסטוריית שיחה מלאה עם המשתמש (הודעות מאוחרות עשויות להשלים או לתקן מידע מהודעות קודמות). מזג את כל המידע לטיוטת אירוע אחת עדכנית.
${correctionGuidance}
אם משהו באמת דו-משמעי ואי אפשר להכריע ממה שנכתב, אל תנחש: השאר את השדה ריק ("") והוסף שאלה קצרה וברורה בעברית ל-_questions.
שאל רק כשבאמת לא ברור ויש יותר מפירוש סביר אחד — לא על פרטים שפשוט לא הוזכרו ולא חשובים.
לדוגמה: אם מופיע מחיר בטקסט אבל לא ברור אם הוא דמי כניסה או מחיר של משהו שנמכר באירוע, שאל: "המחיר 180 ש\"ח הוא דמי כניסה או מחיר של הפלייט?"
לכל היותר 2 שאלות. אם הכול ברור, החזר _questions כרשימה ריקה [].

השב אך ורק ב-JSON תקין בפורמט הבא, ללא טקסט נוסף:
{"event_name":"","date":"","start_time":"","end_time":"","location":"","category":"","price":"","organizer":"","contact_link":"","contact_person":"","description":"","_questions":[]}

טקסט השיחה:
${conversationText}`;
}

function buildUserContent(prompt, imageDataUrls) {
  if (!imageDataUrls || !imageDataUrls.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

function callOpenRouter(content) {
  return postJson({
    hostname: "openrouter.ai",
    path: "/api/v1/chat/completions",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    payload: {
      model: MODEL,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 500,
    },
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

async function extractEvent(conversationText, todayIso = new Date().toISOString().slice(0, 10), imageDataUrls = [], previousEvent = null, correctionGuidance = "") {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const prompt = buildPrompt(conversationText, todayIso, imageDataUrls.length > 0, previousEvent, correctionGuidance);
  const userContent = buildUserContent(prompt, imageDataUrls);
  const raw = await callOpenRouter(userContent);
  const parsed = JSON.parse(raw);
  const content = parsed.choices?.[0]?.message?.content || "";
  const fields = extractJson(content);

  const event = emptyEvent();
  for (const key of FIELD_KEYS) {
    if (typeof fields[key] === "string") event[key] = fields[key].trim();
  }

  // Questions ride along with the draft but must never reach the CSV, so keep them
  // off the enumerable surface that FIELD_KEYS/serialization walk over.
  Object.defineProperty(event, "_questions", {
    value: normalizeQuestions(fields._questions),
    enumerable: false,
  });
  return event;
}

const MAX_QUESTIONS = 2;
const MAX_QUESTION_LENGTH = 200;

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => typeof q === "string" && q.trim())
    .map((q) => q.trim().slice(0, MAX_QUESTION_LENGTH))
    .slice(0, MAX_QUESTIONS);
}

module.exports = { extractEvent, FIELD_KEYS };
