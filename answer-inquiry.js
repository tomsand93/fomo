const { postJson } = require("./http-json");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

function callOpenRouter(messages) {
  return postJson({
    hostname: "openrouter.ai",
    path: "/api/v1/chat/completions",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    payload: {
      model: MODEL,
      messages,
      temperature: 0,
      max_tokens: 400,
    },
  });
}

function eventsToText(events) {
  if (!events.length) return "(אין אירועים תואמים)";
  return events
    .map((event, i) => {
      const parts = [
        `${i + 1}. ${event.event_name}`,
        `תאריך: ${event.date}`,
        `שעה: ${event.start_time}`,
        `מיקום: ${event.location}`,
        `קטגוריה: ${event.category}`,
      ];
      if (event.price) parts.push(`מחיר: ${event.price}`);
      if (event.contact_link) parts.push(`קישור: ${event.contact_link}`);
      if (event.description) parts.push(`תיאור: ${event.description}`);
      return parts.join(" | ");
    })
    .join("\n");
}

function buildSystemPrompt(events, todayIso) {
  return `אתה סוכן וואטסאפ ידידותי שעונה על שאלות לגבי אירועי תרבות בחיפה, בהתבסס אך ורק על רשימת האירועים שסופקה למטה.
היום התאריך הוא ${todayIso} (פורמט YYYY-MM-DD).

כללים:
- ענה רק לפי האירועים ברשימה. אל תמציא אירועים שאינם ברשימה.
- אם אין אירועים מתאימים לשאלה, אמור זאת בנימוס בעברית.
- זו שיחה מתמשכת: זכור מה נאמר בהודעות הקודמות וענה על שאלות המשך בהקשר שלהן.
- אם השאלה כללית או לא ברורה, מותר לשאול שאלת הבהרה קצרה (למשל "לאיזה יום?").
- אם המשתמש רוצה לפרסם אירוע, לראות מחירון או לפנות לשירות לקוחות, הסבר שיש לכתוב "ביטול" ולבחור באפשרות המתאימה בתפריט.
- ענה בטון טבעי, קליל וידידותי, כמו הודעת וואטסאפ, לא רשימה טכנית.
- תשובה קצרה וממוקדת, בעברית בלבד.

עברית תקנית — חשוב:
- אתה כותב עברית כשפת אם, לא מתרגם מאנגלית. אל תבנה משפטים לפי תחביר אנגלי.
- שלילת קיום נעשית עם "אין", לא עם "לא יש". כתוב "אין לי מידע", "אין אירועים", "אין לי" — לעולם לא "לא יש לי" או "לא יש".
- "יש" רק בחיוב: "יש אירוע ביום שלישי".
- שים לב להתאמת מין ומספר: "אירוע אחד", "שני אירועים", "מסיבה אחת".
- אל תתרגם מילולית ביטויים מאנגלית (למשל "אני מצטער אבל..." — עדיף פשוט "סליחה," או בלי התנצלות בכלל).

רשימת האירועים:
${eventsToText(events)}`;
}

// With nothing to answer from, the model has no work to do but still has to phrase a
// refusal - and that is exactly where it produced calques like "לא יש לי מידע" (English
// "I don't have", where Hebrew negates existence with "אין"). A fixed, correct sentence
// is better Hebrew than a generated one, and saves an LLM call.
const NO_EVENTS_TEXT = "אין לי אירועים מאושרים להציג כרגע 😕 שווה לבדוק שוב בקרוב.";

async function answerInquiry(history, events, todayIso = new Date().toISOString().slice(0, 10)) {
  if (!events.length) return NO_EVENTS_TEXT;

  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(events, todayIso) },
    ...history,
  ];
  const raw = await callOpenRouter(messages);
  const parsed = JSON.parse(raw);
  const content = parsed.choices?.[0]?.message?.content || "";
  return content.trim();
}

module.exports = { answerInquiry };
