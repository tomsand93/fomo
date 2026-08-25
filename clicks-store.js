// Append-only logs on the same volume as events.csv.
//
//   clicks.jsonl       - one line per visit to a short link
//   interactions.jsonl - one line per message in or out of the bot
//
// JSONL rather than CSV because these are write-once records with no editing, and one
// malformed line never costs more than that line. Written synchronously: a click is a
// few hundred bytes and they arrive at human pace, so the cost is irrelevant next to
// removing every interleaving concern.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const DATA_DIR = path.dirname(path.resolve(EVENTS_FILE));
const CLICKS_FILE = process.env.CLICKS_FILE || path.join(DATA_DIR, "clicks.jsonl");
const INTERACTIONS_FILE = process.env.INTERACTIONS_FILE || path.join(DATA_DIR, "interactions.jsonl");

// Distinguishing two visitors does not require knowing who they are. The salt makes the
// hash useless to anyone who gets the file, and a short prefix is plenty to tell a
// handful of daily visitors apart.
const IP_SALT = process.env.IP_SALT || "fomo-local-dev-salt";

function hashIp(ip) {
  if (!ip) return "";
  return crypto.createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 12);
}

// WhatsApp, Twilio and every link-preview crawler fetch a URL the moment it appears in
// a message, long before a person taps it. Those are logged but flagged, so the number
// shown to a publisher is about people. The raw user-agent is kept so the data can be
// re-filtered later if this list turns out to be wrong.
const BOT_UA_RE = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|twitterbot|slackbot|telegram|curl|wget|python-requests|headless/i;

function looksLikeBot(userAgent) {
  return BOT_UA_RE.test(String(userAgent || ""));
}

function appendLine(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    // Losing a log line must never break the thing being logged.
    console.error(`failed to append to ${path.basename(file)}:`, err);
  }
}

function logClick({ slug, eventId, userAgent = "", referer = "", ip = "" }) {
  appendLine(CLICKS_FILE, {
    ts: new Date().toISOString(),
    slug,
    eventId: String(eventId || ""),
    ua: String(userAgent || "").slice(0, 300),
    ref: String(referer || "").slice(0, 300),
    ip: hashIp(ip),
    bot: looksLikeBot(userAgent),
  });
}

// Inbound text is stored verbatim: it is the raw material for improving the extractor,
// and it is the same text already sitting in activeSubmissions. Outbound keeps only a
// length, since the reply can be reconstructed from the code.
function logInteraction(record) {
  appendLine(INTERACTIONS_FILE, { ts: new Date().toISOString(), ...record });
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`failed to read ${path.basename(file)}:`, err);
    return [];
  }
}

// Full scan. At the volume this bot sees — hundreds of clicks a month — that is both
// correct and simpler than any index.
function clickStats({ slug = "", eventId = "", since = "" } = {}) {
  const visitors = new Set();
  const byDay = new Map();
  let total = 0;
  let bots = 0;

  for (const line of readLines(CLICKS_FILE)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // one bad line costs one line
    }
    if (slug && row.slug !== slug) continue;
    if (eventId && row.eventId !== String(eventId)) continue;
    if (since && row.ts < since) continue;
    if (row.bot) {
      bots += 1;
      continue;
    }
    total += 1;
    if (row.ip) visitors.add(row.ip);
    const day = row.ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  return { total, unique: visitors.size, bots, byDay: Object.fromEntries(byDay) };
}

// Keeps the logs from growing without bound on a small volume. Rewrites rather than
// truncating so a partial line can never be left behind.
function pruneOlderThan(days = 90, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  for (const file of [CLICKS_FILE, INTERACTIONS_FILE]) {
    const lines = readLines(file);
    if (!lines.length) continue;
    const kept = lines.filter((line) => {
      try {
        return JSON.parse(line).ts >= cutoff;
      } catch {
        return false;
      }
    });
    if (kept.length === lines.length) continue;
    try {
      fs.writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    } catch (err) {
      console.error(`failed to prune ${path.basename(file)}:`, err);
    }
  }
}

module.exports = {
  CLICKS_FILE,
  INTERACTIONS_FILE,
  logClick,
  logInteraction,
  clickStats,
  looksLikeBot,
  hashIp,
  pruneOlderThan,
};
