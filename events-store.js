const fs = require("fs");
const path = require("path");

// Adding a name here is the whole migration: migrateIfNeeded checks that every one of
// these exists in the file's own header row, and rewrites in this order when one
// doesn't. Existing rows get "" for the new column.
//   contact_person - the person to ask, kept apart from contact_link (a URL or phone)
//                    because the long format shows both
//   slug           - this event's short-link id, stable from submission onward
//   daily_days     - comma-separated YYYY-MM-DD the submitter chose for the group
//                    message. Empty means they have not been asked yet; the literal
//                    "decline" means they were asked and said no, which is why the two
//                    are not the same value
const CSV_HEADERS = [
  "id", "status", "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "contact_person", "description",
  "source", "published_at", "notes", "submitter", "flyer", "slug", "daily_days",
];

function csv(value) {
  const text = String(value == null ? "" : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

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

// Splitting the file on newlines before parsing quotes tears any field that contains one.
// WhatsApp submissions are routinely multi-line, and csv() quotes those correctly on write,
// so the round-trip silently shifted every column after the break: one event became two
// rows, and the flyer name landed in a column nothing reads. Newlines are only row
// separators outside quotes, so the split has to track quoting itself.
function splitCsvRows(content) {
  const rows = [];
  let row = "";
  let quoted = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '"' && quoted && content[i + 1] === '"') {
      row += '""';
      i += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;

    if (!quoted && (char === "\n" || char === "\r")) {
      // Consume CRLF as a single separator.
      if (char === "\r" && content[i + 1] === "\n") i += 1;
      rows.push(row);
      row = "";
      continue;
    }
    row += char;
  }
  if (row !== "") rows.push(row);
  return rows;
}

function rowsToEvents(rows, headers) {
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] || ""])));
}

function eventsToCsv(events, headers) {
  const lines = [headers.join(",")];
  for (const event of events) {
    lines.push(headers.map((header) => csv(event[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function extractSubmitterFromNotes(notes) {
  const match = notes.match(/(whatsapp:\+\d+)/);
  return match ? match[1] : "";
}

function migrateIfNeeded(filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return;
  const rows = splitCsvRows(content).map(parseCsvLine);
  const headers = rows.shift();

  // Check every expected header, not just a couple: each new column added over time needs
  // the rewrite below to run once, and keying on an older column silently skips it.
  if (CSV_HEADERS.every((header) => headers.includes(header))) return;

  const events = rowsToEvents(rows, headers);
  const migrated = events.map((event, i) => ({
    ...event,
    id: event.id || String(i + 1),
    submitter: event.submitter || extractSubmitterFromNotes(event.notes || ""),
  }));

  fs.writeFileSync(filePath, eventsToCsv(migrated, CSV_HEADERS), "utf8");
}

function seedIfMissing(filePath) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bundled = path.join(__dirname, "events.csv");
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, filePath);
  } else {
    fs.writeFileSync(filePath, `${CSV_HEADERS.join(",")}\n`, "utf8");
  }
}

const readyFilePaths = new Set();

function ensureReady(filePath) {
  if (readyFilePaths.has(filePath)) return;
  seedIfMissing(filePath);
  migrateIfNeeded(filePath);
  readyFilePaths.add(filePath);
}

const eventsCache = new Map(); // filePath -> { mtimeMs, events }

function parseEventsFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  const rows = splitCsvRows(content).map(parseCsvLine);
  const headers = rows.shift();
  return rowsToEvents(rows, headers);
}

function loadEvents(filePath) {
  ensureReady(filePath);
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = eventsCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.events;

  const events = parseEventsFile(filePath);
  eventsCache.set(filePath, { mtimeMs, events });
  return events;
}

// Short-link ids. The alphabet drops 0/O/1/l/I so a slug read aloud or copied off a
// phone screen cannot land on the wrong event: ~923k combinations from four characters,
// which is far more than this ever needs.
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 4;
const MAX_SLUG_ATTEMPTS = 50;

function randomSlug() {
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i += 1) {
    slug += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return slug;
}

// Bounded, never a bare do/while: on a saturated alphabet an unbounded retry loop hangs
// the process. Falling back to a longer slug keeps links working past that point.
function makeSlug(taken, generate = randomSlug) {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = generate();
    if (!taken.has(slug)) return slug;
  }
  let slug = `${generate()}${generate()}`;
  while (taken.has(slug)) slug += generate();
  return slug;
}

function nextId(events) {
  const ids = events.map((e) => Number(e.id)).filter((n) => Number.isFinite(n));
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

function appendEvent(filePath, event, source, sender, missing) {
  const events = loadEvents(filePath);
  const status = missing.length ? "needs_info" : "submitted";
  const id = nextId(events);

  const row = {
    id,
    status,
    event_name: event.event_name,
    date: event.date,
    start_time: event.start_time,
    end_time: event.end_time,
    location: event.location,
    category: event.category,
    price: event.price,
    organizer: event.organizer,
    contact_link: event.contact_link,
    contact_person: event.contact_person || "",
    description: event.description,
    source,
    published_at: "",
    notes: [sender, missing.length ? `חסר: ${missing.join(", ")}` : ""].filter(Boolean).join(" | "),
    submitter: sender,
    flyer: "",
    // Assigned now rather than at approval, so the link in the receipt is the same one
    // that ends up in the board and the group message. A rejected event just has a slug
    // nobody ever publishes.
    slug: makeSlug(new Set(events.map((e) => e.slug).filter(Boolean))),
    daily_days: "",
  };

  events.push(row);
  fs.writeFileSync(filePath, eventsToCsv(events, CSV_HEADERS), "utf8");
  return id;
}

function updateEvent(filePath, id, changes) {
  const events = loadEvents(filePath);
  const index = events.findIndex((e) => e.id === String(id));
  if (index === -1) return null;

  events[index] = { ...events[index], ...changes };
  fs.writeFileSync(filePath, eventsToCsv(events, CSV_HEADERS), "utf8");
  return events[index];
}

function findEvent(filePath, id) {
  const events = loadEvents(filePath);
  return events.find((e) => e.id === String(id)) || null;
}

module.exports = {
  CSV_HEADERS,
  loadEvents,
  appendEvent,
  updateEvent,
  findEvent,
  parseCsvLine,
  makeSlug,
  randomSlug,
  SLUG_ALPHABET,
};
