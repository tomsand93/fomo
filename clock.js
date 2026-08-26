// The one place that decides what "today" is.
//
// Before this module, two clocks disagreed: sendDueBoards read Israel-local time,
// while todayIso(), the /weekly and /digest routes, and the formatters' default
// parameters all used UTC. Between 21:00 (or 22:00, depending on DST) and midnight
// Israel time those two are a day apart. That was survivable when the board went out
// twice a week at a fixed hour, but the rolling board is defined by "today", so a
// board built at 22:10 on Tuesday would roll to Wednesday and drop Tuesday's
// remaining events. Everything that asks for a date asks here.
const ISRAEL_TZ = "Asia/Jerusalem";

const WEEKDAY_INDEX = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6],
]);

// Israel switches between UTC+2 and UTC+3, so the conversion goes through the IANA
// zone rather than a fixed offset â€” a hardcoded offset is silently an hour off for
// half the year.
const israelParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ISRAEL_TZ,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Israel-local wall-clock reading of an instant: { day, hour, minute, date } where
// day is 0..6 (Sunday-first) and date is the local YYYY-MM-DD.
function israelClock(now = new Date()) {
  const parts = Object.fromEntries(
    israelParts.formatToParts(now).map((part) => [part.type, part.value])
  );
  return {
    day: WEEKDAY_INDEX.get(parts.weekday),
    // "24" appears at midnight in some ICU versions; normalise it to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function todayIso(now = new Date()) {
  return israelClock(now).date;
}

// Calendar arithmetic on YYYY-MM-DD strings. Anchored at UTC midnight deliberately:
// these operate on a date that has already been resolved to Israel-local by the
// functions above, so the anchor only has to be consistent, never local.
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

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// How far ahead of an event its reminder goes out. A window, not an instant: the check
// runs every few minutes, so an exact match would miss whenever a tick landed a minute
// off â€” the same reason isDue() uses a window rather than an exact minute.
//
// Wide end first: a reminder is due once the event is within LEAD_MAX and not yet
// within LEAD_MIN. Three hours' notice is enough to change plans and get there; less
// than two is a notification, not a reminder.
const REMINDER_LEAD_MAX_MINUTES = 3 * 60;
const REMINDER_LEAD_MIN_MINUTES = 2 * 60;

// Minutes from `now` until an event starts, both read as Israel-local wall clock.
//
// Both sides go through israelClock so the comparison is between two local readings,
// never a local date against a UTC instant â€” the bug clock.js exists to prevent.
// Returns null for an unparseable or missing time, so a malformed row is skipped
// rather than firing at an arbitrary moment.
function minutesUntilEvent(isoDate, startTime, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return null;
  const match = String(startTime || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const local = israelClock(now);
  const dayDiff = Math.round(
    (new Date(`${isoDate}T00:00:00Z`) - new Date(`${local.date}T00:00:00Z`)) / 86_400_000
  );
  const eventMinutes = dayDiff * 24 * 60 + hour * 60 + minute;
  const nowMinutes = local.hour * 60 + local.minute;
  return eventMinutes - nowMinutes;
}

// Is this event inside its reminder window right now?
function isReminderDue(isoDate, startTime, now = new Date()) {
  const minutes = minutesUntilEvent(isoDate, startTime, now);
  if (minutes === null) return false;
  return minutes <= REMINDER_LEAD_MAX_MINUTES && minutes > REMINDER_LEAD_MIN_MINUTES;
}

// An event whose window has already passed can never fire again â€” either it was sent,
// or the machine was asleep through the whole window. Used to close out stale opt-ins
// instead of leaving them pending forever.
function isReminderMissed(isoDate, startTime, now = new Date()) {
  const minutes = minutesUntilEvent(isoDate, startTime, now);
  if (minutes === null) return true;
  return minutes <= REMINDER_LEAD_MIN_MINUTES;
}

module.exports = {
  ISRAEL_TZ,
  israelClock,
  todayIso,
  dayOfWeek,
  addDays,
  shortDate,
  DAY_NAMES,
  REMINDER_LEAD_MAX_MINUTES,
  REMINDER_LEAD_MIN_MINUTES,
  minutesUntilEvent,
  isReminderDue,
  isReminderMissed,
};


