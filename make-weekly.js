const { loadEvents } = require("./events-store");
const { dayOfWeek, addDays, shortDate, longDate, todayIso, DAY_NAMES } = require("./clock");
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

function makeWeekly(events, fromDate = todayIso(), options = {}) {
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

  const total = [...byDate.values()].reduce((sum, bucket) => sum + bucket.length, 0);

  // No events means no date line, as in the digest: do not announce days there is
  // nothing for. The title and the sentence stay so the send is still a visible
  // "I ran and found nothing" rather than silence.
  if (!total) {
    return [boardTitle(dates), "", "אין אירועים מאושרים לימים האלה עדיין."].join("\n");
  }

  // The range spans days that have events, not the whole window: with the empty days
  // skipped below, a header reading 26.8-29.8 over a board whose last entry is the
  // 28th promises a day that is not there.
  const withEvents = dates.filter((date) => byDate.get(date).length);
  const range = withEvents.length === 1
    ? longDate(withEvents[0])
    : `${longDate(withEvents[0])} - ${longDate(withEvents[withEvents.length - 1])}`;
  const lines = [boardTitle(dates), "", `📅 ${range}`, ""];

  for (const date of dates) {
    const bucket = byDate.get(date);
    // Days with nothing approved are skipped rather than printed empty: a board full of
    // "אין אירועים" reads as a dead city, which is the opposite of the point.
    if (!bucket.length) continue;
    // With only one day left in the window, the range header already names it and a
    // day header would repeat the same words two lines apart.
    if (withEvents.length > 1) lines.push(`— ${longDate(date)} —`);
    for (const event of bucket) lines.push(formatShort(event, options));
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
