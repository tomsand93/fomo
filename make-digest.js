const { loadEvents, runsOn, withoutDuplicates } = require("./events-store");
const { longDate, todayIso } = require("./clock");
const { formatLong, formatShort } = require("./format-event");

const TODAY_TITLE = "מה עושים היום בחיפה? 🎈";
const SOON_TITLE = "מה עושים בקרוב בחיפה? 🎈";

// The slot sends these as separate messages, so Stav can forward each on its own and
// no title has to cover both: events happening today, and later events whose submitter
// picked today. Either is "" when it has nothing in it.
function makeDailyParts(events, targetDate, options = {}) {
  const publishable = digestEvents(events, targetDate);
  const today = publishable.filter((event) => runsOn(event, targetDate));
  const promoted = publishable.filter((event) => !runsOn(event, targetDate));

  let todayText = "";
  if (today.length) {
    const lines = [TODAY_TITLE, "", `📅 ${longDate(targetDate)}`, ""];
    for (const event of today) lines.push(formatLong(event, options).text, "");
    todayText = lines.join("\n").trim();
  }

  let promotedText = "";
  if (promoted.length) {
    const lines = [SOON_TITLE, ""];
    let currentDate = "";
    for (const event of promoted) {
      if (event.date !== currentDate) {
        currentDate = event.date;
        lines.push(`— ${longDate(currentDate)} —`);
      }
      lines.push(formatLong(event, options).text, "");
    }
    promotedText = lines.join("\n").trim();
  }

  return { today: todayText, promoted: promotedText };
}

// The daily message carries the LONG form: the full pitch for events happening today,
// where the board only has to say enough to recognise one. Flyers are attached per
// event by the caller, so this returns text only.
function makeDigest(events, targetDate, options = {}) {
  const publishable = digestEvents(events, targetDate);
  const today = publishable.filter((event) => runsOn(event, targetDate));
  const promoted = publishable.filter((event) => !runsOn(event, targetDate));

  // "Today" only when something is on today. A day with only promoted later events read
  // as if those were happening today: Sunday 18/10 went out under "what's on today"
  // with nothing but a Saturday event in it.
  const title = today.length || !promoted.length ? "מה עושים היום בחיפה? 🎈" : "מה עושים בקרוב בחיפה? 🎈";

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
// so a day with several flyers cannot be a single send. A flyer goes out once ever
// (flyer_sent_at); after that the event is in the text only.
function digestFlyerEvents(events, targetDate) {
  return digestEvents(events, targetDate).filter((event) => event.flyer && !event.flyer_sent_at);
}

// Today's events. A multi-day event counts as today's on every day it runs.
//
// No location is not a reason to leave an approved event out: Last Summer Sunset (#80)
// was approved without one and silently missed its own day's message (23/10/2026),
// while the board, which never required it, listed it. formatLong omits the line.
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

module.exports = { loadEvents, makeDigest, makeBoard, makeDailyParts, digestEvents, digestFlyerEvents };
