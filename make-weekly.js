const { loadEvents } = require("./events-store");
const { dayOfWeek, addDays, shortDate, todayIso, DAY_NAMES } = require("./clock");
const { formatShort } = require("./format-event");

// One rolling board, rebuilt every day, instead of two fixed ones. The old midweek
// and weekend boards both snapped backward to their first day, so a board sent on
// Tuesday still led with Sunday — days the reader can no longer act on. This window
// starts today and runs to Saturday, so it only ever shows what is still ahead. It
// deliberately does not roll into next week: the title promises this week.
function rollingWindow(fromDate) {
  const daysLeft = 6 - dayOfWeek(fromDate); // Saturday = 6
  return Array.from({ length: daysLeft + 1 }, (_, i) => addDays(fromDate, i));
}

function boardTitle(dates) {
  // On Saturday the window is a single day, and "what's on this week" would be a lie.
  return dates.length === 1 ? "מה עושים היום בחיפה? 🎈" : "מה עושים השבוע בחיפה? 🎈";
}

function makeWeekly(events, fromDate = todayIso()) {
  const dates = rollingWindow(fromDate);

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

  const range = dates.length === 1
    ? shortDate(dates[0])
    : `${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}`;
  const lines = [boardTitle(dates), "", `📅 ${range}`, ""];

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
    for (const event of bucket) lines.push(formatShort(event));
    lines.push("");
  }

  // The board ends on the last event. The standing "put the group on mute" recommendation
  // was dropped: it repeated on every board and said nothing about this week.
  return lines.join("\n").trim();
}

module.exports = { makeWeekly, rollingWindow, boardTitle };

if (require.main === module) {
  const fromDate = process.argv[2] || todayIso();
  console.log(makeWeekly(loadEvents(process.env.EVENTS_FILE || "events.csv"), fromDate));
}
