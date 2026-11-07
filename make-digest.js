const { loadEvents, runsOn, withoutDuplicates } = require("./events-store");
const { longDate, todayIso } = require("./clock");
const { formatShort } = require("./format-event");

// Today's events. A multi-day event counts as today's on every day it runs.
//
// No location is not a reason to leave an approved event out: Last Summer Sunset (#80)
// was approved without one and silently missed its own day's message (23/10/2026),
// while the board, which never required it, listed it. formatShort omits the line.
function digestEvents(events, targetDate) {
  return withoutDuplicates(events
    .filter((event) =>
      event.status === "published" &&
      event.start_time &&
      runsOn(event, targetDate)
    ))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
}

// The daily board: today's events only, in the short form. A later event whose
// submitter picked today (daily_days) is not on it. Returns "" for a day with nothing,
// so the caller can skip the post.
function makeBoard(events, targetDate, { linkFor, todayUrl } = {}) {
  const today = digestEvents(events, targetDate);
  if (!today.length) return "";
  const lines = ["*מה עושים היום בחיפה?* 🎈", `*${longDate(targetDate)}*`];
  if (todayUrl) lines.push(todayUrl);
  lines.push("");
  for (const event of today) lines.push(formatShort(event, { linkFor }), "");
  return lines.join("\n").trim();
}

if (require.main === module) {
  const dateArg = process.argv[2] || todayIso();
  console.log(makeBoard(loadEvents(process.env.EVENTS_FILE || "events.csv"), dateArg) || "אין אירועים היום.");
}

module.exports = { loadEvents, makeBoard, digestEvents };
