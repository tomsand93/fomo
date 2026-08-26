// Opt-in event reminders: one line per user-per-event on the same volume as events.csv.
//
//   reminders.jsonl - append-only, one record per opt-in and one per state change
//
// Append-only rather than a rewritten table, for the same reason clicks.jsonl is: these
// are write-once records at human pace, and one malformed line never costs more than
// that line. State changes (sent, failed, cancelled) are appended as new records and the
// latest one wins, so a crash mid-write can never leave a half-edited row behind.
//
// Deliberately not a column on the event row: a reminder is per-user-per-event, so it
// does not fit one row per event, and the event row is already wide.
const fs = require("fs");
const path = require("path");

const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const DATA_DIR = path.dirname(path.resolve(EVENTS_FILE));
const REMINDERS_FILE = process.env.REMINDERS_FILE || path.join(DATA_DIR, "reminders.jsonl");

// A reminder's life: asked for, then exactly one terminal outcome.
const STATUS_PENDING = "pending";
const STATUS_SENT = "sent";
const STATUS_FAILED = "failed";
const STATUS_CANCELLED = "cancelled";

function appendLine(record) {
  try {
    fs.mkdirSync(path.dirname(REMINDERS_FILE), { recursive: true });
    fs.appendFileSync(REMINDERS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    // Unlike a click, losing this line loses a promise made to a user, so it is logged
    // loudly and the caller is told rather than silently swallowed.
    console.error("failed to append to reminders.jsonl:", err);
    return false;
  }
  return true;
}

function readLines() {
  try {
    return fs.readFileSync(REMINDERS_FILE, "utf8").split("\n").filter(Boolean);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("failed to read reminders.jsonl:", err);
    return [];
  }
}

// Latest record per (sender, eventId) wins. Full scan, like clickStats: at this bot's
// volume that is both correct and simpler than any index.
function currentReminders() {
  const latest = new Map();
  for (const line of readLines()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // one bad line costs one line
    }
    if (!row.sender || !row.eventId) continue;
    latest.set(`${row.sender}:${row.eventId}`, row);
  }
  return latest;
}

// Recording an opt-in is idempotent per user-per-event: asking twice for the same event
// must not produce two reminders. Returns whether this was a new opt-in, so the caller
// can tell "you're signed up" from "you're already signed up".
function addReminder({ sender, eventId, eventName = "", eventDate = "", eventTime = "" }) {
  const key = `${String(sender)}:${String(eventId)}`;
  const existing = currentReminders().get(key);
  if (existing && existing.status === STATUS_PENDING) return { added: false, already: true };

  const ok = appendLine({
    ts: new Date().toISOString(),
    sender: String(sender),
    eventId: String(eventId),
    eventName: String(eventName),
    eventDate: String(eventDate),
    eventTime: String(eventTime),
    status: STATUS_PENDING,
  });
  return { added: ok, already: false };
}

function markReminder(sender, eventId, status, detail = "") {
  return appendLine({
    ts: new Date().toISOString(),
    sender: String(sender),
    eventId: String(eventId),
    status,
    detail: String(detail).slice(0, 300),
  });
}

function pendingReminders() {
  return [...currentReminders().values()].filter((row) => row.status === STATUS_PENDING);
}

function remindersFor(sender) {
  return [...currentReminders().values()].filter(
    (row) => row.sender === String(sender) && row.status === STATUS_PENDING
  );
}

// Keeps the log from growing without bound on a small volume, mirroring
// clicks-store's pruneOlderThan: rewrite rather than truncate, so a partial line
// can never be left behind.
function pruneOlderThan(days = 90, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const lines = readLines();
  if (!lines.length) return;
  const kept = lines.filter((line) => {
    try {
      return JSON.parse(line).ts >= cutoff;
    } catch {
      return false;
    }
  });
  if (kept.length === lines.length) return;
  try {
    fs.writeFileSync(REMINDERS_FILE, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  } catch (err) {
    console.error("failed to prune reminders.jsonl:", err);
  }
}

module.exports = {
  REMINDERS_FILE,
  STATUS_PENDING,
  STATUS_SENT,
  STATUS_FAILED,
  STATUS_CANCELLED,
  addReminder,
  markReminder,
  pendingReminders,
  remindersFor,
  currentReminders,
  pruneOlderThan,
};
