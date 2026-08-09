const { loadEvents } = require("./events-store");

// Two boards rather than one weekly post, because the group plans in two different
// rhythms: what to do midweek, and what to do over the weekend.
//   midweek - Sunday..Wednesday, published Sunday 18:00
//   weekend - Thursday..Saturday, published Thursday 17:00
const BOARDS = {
  midweek: { label: 'אמצע"ש', days: [0, 1, 2, 3], title: "מה עושים השבוע בחיפה? 🎈" },
  weekend: { label: 'סופ"ש', days: [4, 5, 6], title: "מה עושים בסופ״ש בחיפה? 🎈" },
};

// Reused from make-digest.js's vocabulary so both posts speak the same visual language.
const icons = {
  "קולנוע": "🎬",
  "אוכל ויין": "🍷",
  "מסיבה": "🎧",
  "קריוקי": "🎤",
  "מוזיקה חיה": "🎸",
  "מוזיקה": "🎸",
};

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function dayOfWeek(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function addDays(isoDate, count) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function shortDate(isoDate) {
  const [, , month, day] = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return `${Number(day)}.${Number(month)}`;
}

// The window always starts on the board's first day. Running the midweek board on
// Tuesday still yields that week's Sunday..Wednesday, so a late or re-run send covers
// the same days the audience was promised rather than silently shifting.
function windowFor(board, fromDate) {
  const { days } = BOARDS[board];
  const startDay = days[0];
  const offset = (dayOfWeek(fromDate) - startDay + 7) % 7;
  const start = addDays(fromDate, -offset);
  return days.map((_, i) => addDays(start, i));
}

// Name, time and link only. Stav asked for a summary, not a second copy of the daily
// digest: the point of the board is scanning a whole stretch of days at a glance, and
// location/price/description belong to the per-event daily post.
function eventLine(event) {
  const icon = icons[event.category] || "🎈";
  const parts = [`${icon} ${event.start_time} ${event.event_name}`];
  if (event.contact_link) parts.push(`   ${event.contact_link}`);
  return parts.join("\n");
}

function makeWeekly(events, board = "midweek", fromDate = new Date().toISOString().slice(0, 10)) {
  if (!BOARDS[board]) throw new Error(`unknown board: ${board}`);
  const dates = windowFor(board, fromDate);

  const byDate = new Map(dates.map((date) => [date, []]));
  for (const event of events) {
    if (event.status !== "published") continue;
    if (!event.start_time || !event.event_name) continue;
    const bucket = byDate.get(event.date);
    if (bucket) bucket.push(event);
  }
  for (const bucket of byDate.values()) {
    bucket.sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  const range = `${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}`;
  const lines = [BOARDS[board].title, "", `📅 ${range}`, ""];

  const total = [...byDate.values()].reduce((sum, bucket) => sum + bucket.length, 0);
  if (!total) {
    return [...lines, "אין אירועים מאושרים לימים האלה עדיין."].join("\n");
  }

  for (const date of dates) {
    const bucket = byDate.get(date);
    // Days with nothing approved are skipped rather than printed empty: a board full of
    // "אין אירועים" reads as a dead city, which is the opposite of the point.
    if (!bucket.length) continue;
    lines.push(`— יום ${DAY_NAMES[dayOfWeek(date)]} ${shortDate(date)} —`);
    for (const event of bucket) lines.push(eventLine(event));
    lines.push("");
  }

  lines.push("❤️ המלצה חמה: לשים את הקבוצה על שקט ולהכנס כשרוצים לעשות משהו בעיר ולא יודעים מה");
  return lines.join("\n").trim();
}

module.exports = { makeWeekly, windowFor, BOARDS };

if (require.main === module) {
  const board = process.argv[2] || "midweek";
  const fromDate = process.argv[3] || new Date().toISOString().slice(0, 10);
  console.log(makeWeekly(loadEvents(process.env.EVENTS_FILE || "events.csv"), board, fromDate));
}
