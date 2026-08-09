const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Twilio can only attach media it can fetch over HTTP — a base64 data URL is not accepted.
// So a submitted flyer has to be written somewhere durable and served back by this app.
// Lives next to the events file, which on Fly is the mounted /data volume.
const EVENTS_FILE = process.env.EVENTS_FILE || "events.csv";
const FLYER_DIR = process.env.FLYER_DIR || path.join(path.dirname(path.resolve(EVENTS_FILE)), "flyers");

const EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(DATA_URL_RE);
  if (!match) return null;
  const [, contentType, base64] = match;
  const extension = EXTENSIONS.get(contentType.toLowerCase());
  if (!extension) return null;
  return { extension, buffer: Buffer.from(base64, "base64") };
}

// The stored name is derived from the content, so the same flyer resent during a draft
// doesn't accumulate copies on the volume.
function saveFlyer(dataUrl, eventId) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return "";

  const digest = crypto.createHash("sha256").update(parsed.buffer).digest("hex").slice(0, 16);
  const name = `${eventId}-${digest}.${parsed.extension}`;
  try {
    fs.mkdirSync(FLYER_DIR, { recursive: true });
    fs.writeFileSync(path.join(FLYER_DIR, name), parsed.buffer);
    return name;
  } catch (err) {
    console.error("failed to save flyer:", err);
    return "";
  }
}

// Guards against a stored name being used to read outside the flyer directory. The names
// this module writes are always safe, but the value reaching flyerPath comes from the CSV,
// which a person edits by hand.
function flyerPath(name) {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return "";
  const resolved = path.join(FLYER_DIR, name);
  if (path.dirname(resolved) !== path.resolve(FLYER_DIR)) return "";
  return fs.existsSync(resolved) ? resolved : "";
}

function contentTypeFor(name) {
  const extension = path.extname(name).slice(1).toLowerCase();
  for (const [type, ext] of EXTENSIONS) {
    if (ext === extension) return type === "image/jpg" ? "image/jpeg" : type;
  }
  return "application/octet-stream";
}

function deleteFlyer(name) {
  const resolved = flyerPath(name);
  if (!resolved) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (err) {
    console.error("failed to delete flyer:", err);
    return false;
  }
}

module.exports = { saveFlyer, flyerPath, contentTypeFor, deleteFlyer, FLYER_DIR };
