const fs = require("fs");
const path = require("path");

const CSV_HEADERS = [
  "id", "status", "event_name", "date", "start_time", "end_time", "location",
  "category", "price", "organizer", "contact_link", "description", "source",
  "published_at", "notes", "submitter",
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
  const rows = content.split(/\r?\n/).map(parseCsvLine);
  const headers = rows.shift();

  if (headers.includes("id") && headers.includes("submitter")) return;

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

function ensureReady(filePath) {
  seedIfMissing(filePath);
  migrateIfNeeded(filePath);
}

function loadEvents(filePath) {
  ensureReady(filePath);
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  const rows = content.split(/\r?\n/).map(parseCsvLine);
  const headers = rows.shift();
  return rowsToEvents(rows, headers);
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
    description: event.description,
    source,
    published_at: "",
    notes: [sender, missing.length ? `חסר: ${missing.join(", ")}` : ""].filter(Boolean).join(" | "),
    submitter: sender,
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
};
