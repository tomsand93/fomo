const fs = require("fs");

const icons = {
  "קולנוע": "🎬",
  "אוכל ויין": "🍷",
  "מסיבה": "🎧",
  "קריוקי": "🎤",
  "מוזיקה חיה": "🎸",
  "מוזיקה": "🎸",
};

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  fields.push(value);
  return fields;
}

function loadEvents(path) {
  const content = fs.readFileSync(path, "utf8").trim();
  if (!content) return [];
  const rows = content.split(/\r?\n/).map(parseCsvLine);
  const headers = rows.shift();
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] || ""])));
}

function eventBlock(event) {
  const icon = icons[event.category] || "🎈";
  const lines = [`${icon} ${event.start_time} | ${event.event_name}`];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.price) lines.push(`💸 ${event.price}`);
  if (event.contact_link) lines.push(`🔗 ${event.contact_link}`);
  if (event.description && !event.description.includes("שם האירוע:")) lines.push(event.description);
  return lines.join("\n");
}

function makeDigest(events, targetDate) {
  const publishable = events
    .filter((event) =>
      event.date === targetDate &&
      ["submitted", "approved", "published"].includes(event.status) &&
      event.start_time &&
      event.location
    )
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const [, , month, day] = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  const lines = ["מה עושים היום בחיפה? 🎈", "", `📅 ${Number(day)}.${Number(month)}`, ""];

  if (!publishable.length) {
    return [...lines, "אין אירועים מוכנים לפרסום היום."].join("\n");
  }

  for (const event of publishable) {
    lines.push(eventBlock(event), "");
  }

  lines.push("❤️ המלצה חמה: לשים את הקבוצה על שקט ולהכנס כשרוצים לעשות משהו בעיר ולא יודעים מה");
  return lines.join("\n").trim();
}

function demo() {
  const digest = makeDigest([
    {
      status: "submitted",
      event_name: "בדיקה",
      date: "2026-06-25",
      start_time: "20:00",
      location: "חיפה",
      category: "מסיבה",
      price: "כניסה חופשית",
      contact_link: "",
      description: "אירוע בדיקה",
    },
  ], "2026-06-25");
  if (!digest.includes("בדיקה") || !digest.includes("📍 חיפה")) {
    throw new Error("demo failed");
  }
}

if (require.main === module) {
  demo();
  const dateArg = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(makeDigest(loadEvents("events.csv"), dateArg));
}

module.exports = { loadEvents, makeDigest };
