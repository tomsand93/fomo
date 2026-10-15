const { loadEvents } = require("./events-store");
const { longDate, todayIso } = require("./clock");
const { formatLong } = require("./format-event");

// The daily message carries the LONG form: the full pitch for events happening today,
// where the board only has to say enough to recognise one. Flyers are attached per
// event by the caller, so this returns text only.
function makeDigest(events, targetDate, options = {}) {
  const publishable = digestEvents(events, targetDate);
  const today = publishable.filter((event) => event.date === targetDate);
  const promoted = publishable.filter((event) => event.date !== targetDate);

  const title = "מה עושים היום בחיפה? 🎈";

  // No events means no date line: Stav asked not to announce a day there is nothing
  // for. The title and the sentence stay, so she can still see the bot ran and simply
  // has nothing to forward - silence would be indistinguishable from a crash.
  if (!publishable.length) {
    return [title, "", "אין אירועים מוכנים לפרסום היום."].join("\n");
  }

  const lines = [title, ""];

  if (today.length) {
    lines.push(`📅 ${longDate(targetDate)}`, "");
    for (const event of today) lines.push(formatLong(event, options).text, "");
  }

  // Events on a later day that the submitter asked to have in today's message. Each day
  // gets the board's "— day —" header, so nobody reads them as happening today.
  let currentDate = "";
  for (const event of promoted) {
    if (event.date !== currentDate) {
      currentDate = event.date;
      lines.push(`— ${longDate(currentDate)} —`);
    }
    lines.push(formatLong(event, options).text, "");
  }

  // Ends on the last event, like the weekly boards: the standing "put the group on mute"
  // recommendation repeated on every post and said nothing about that day.
  return lines.join("\n").trim();
}

// Which of today's events carry a flyer, in the order the digest lists them. The
// caller sends these as follow-up messages: Twilio takes one MediaUrl per message,
// so a day with several flyers cannot be a single send.
function digestFlyerEvents(events, targetDate) {
  return digestEvents(events, targetDate).filter((event) => event.flyer);
}

// Today's events, plus later ones whose submitter picked today for the daily message
// (daily_days). That choice used to be recorded and then ignored: the submitter was told
// "we'll send it in the daily message on X" and it never went out (14/10/2026).
function digestEvents(events, targetDate) {
  return events
    .filter((event) =>
      event.status === "published" &&
      event.start_time &&
      event.location &&
      (event.date === targetDate ||
        (event.date > targetDate && (event.daily_days || "").split(",").includes(targetDate)))
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
}

function demo() {
  const digest = makeDigest([
    {
      status: "published",
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
  const dateArg = process.argv[2] || todayIso();
  console.log(makeDigest(loadEvents(process.env.EVENTS_FILE || "events.csv"), dateArg));
}

module.exports = { loadEvents, makeDigest, digestFlyerEvents };
