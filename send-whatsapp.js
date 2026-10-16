const https = require("https");
const { URLSearchParams } = require("url");

const SEND_TIMEOUT_MS = 10_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// Posts to the Messages endpoint. Shared so the interactive sender can reach the same
// endpoint with different fields (ContentSid instead of Body) without a second copy of
// the auth, timeout and error handling.
// Every message the bot sends on its own initiative (review notices, reminders, digests,
// button prompts) passes through here, so this is where it is logged. Webhook replies go
// back as TwiML instead and are logged in routeMessage. Required lazily: the CLI senders
// load this module too, and a logging problem must never block a send.
function logPush(fields, outcome) {
  try {
    require("./clicks-store").logInteraction({
      dir: "push",
      sender: fields.To,
      text: fields.Body || "",
      template: fields.ContentSid || undefined,
      variables: fields.ContentVariables || undefined,
      media: fields.MediaUrl ? 1 : 0,
      ...outcome,
    });
  } catch (err) {
    console.error("failed to log outbound message:", err.message);
  }
}

function postForm(fields) {
  return postFormUnlogged(fields).then(
    (result) => { logPush(fields, { sid: result.sid }); return result; },
    (err) => { logPush(fields, { error: String(err.message).slice(0, 300) }); throw err; }
  );
}

function postFormUnlogged(fields) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_WHATSAPP_FROM");
  const payload = new URLSearchParams({ From: from, ...fields }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "POST",
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      auth: `${accountSid}:${authToken}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let response = "";
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Twilio error ${res.statusCode}: ${response}`));
          return;
        }
        resolve(JSON.parse(response));
      });
    });
    req.on("error", reject);
    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy(new Error("Twilio send message timed out"));
    });
    req.end(payload);
  });
}

// Twilio rejects a body over 1600 characters outright (error 21617), so the send throws
// and nothing is queued for retry. The 15 Oct 2026 18:00 board (2338 chars) was lost
// this way. Kept under the cap with a margin, since Twilio's count and JS's can differ.
const MAX_BODY_CHARS = 1500;

// Breaks at blank lines so an event never straddles two messages; a single paragraph
// longer than the cap falls back to line breaks, and a single line to a hard cut.
function splitBody(body, max = MAX_BODY_CHARS) {
  if (body.length <= max) return [body];
  const parts = [];
  let current = "";
  const push = (piece, sep) => {
    if (!current) { current = piece; return; }
    if (current.length + sep.length + piece.length <= max) { current += sep + piece; return; }
    parts.push(current);
    current = piece;
  };
  for (const paragraph of body.split("\n\n")) {
    if (paragraph.length <= max) { push(paragraph, "\n\n"); continue; }
    for (const line of paragraph.split("\n")) {
      for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max), "\n");
    }
  }
  if (current) parts.push(current);
  return parts;
}

// mediaUrl must be publicly reachable — Twilio fetches it itself, so a local path or a
// base64 data URL will not work. A long body goes out as several messages in order; the
// image rides on the first, and the first result is returned so callers' delivery checks
// still have a sid (a closed 24h window drops every part alike).
async function sendWhatsApp(to, body, mediaUrl = "") {
  const [first, ...rest] = splitBody(body);
  const fields = { To: to, Body: first };
  if (mediaUrl) fields.MediaUrl = mediaUrl;
  const result = await postForm(fields);
  for (const part of rest) await postForm({ To: to, Body: part });
  return result;
}

// Twilio reports WhatsApp delivery failures (notably error 63016, "outside the 24h
// window") asynchronously, after the send call has already returned 201. Poll the
// message resource briefly so callers can tell a real delivery from an accepted-then-
// dropped one.
const STATUS_POLL_DELAY_MS = 3_000;
const STATUS_POLL_ATTEMPTS = 3;
const PENDING_STATUSES = new Set(["queued", "accepted", "sending"]);

function fetchMessage(sid) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
      auth: `${accountSid}:${authToken}`,
    }, (res) => {
      let response = "";
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Twilio error ${res.statusCode}: ${response}`));
          return;
        }
        resolve(JSON.parse(response));
      });
    });
    req.on("error", reject);
    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy(new Error("Twilio message status fetch timed out"));
    });
  });
}

async function getMessageStatus(sid) {
  let message = { status: "unknown", error_code: null };
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_DELAY_MS));
    try {
      message = await fetchMessage(sid);
    } catch (err) {
      console.error("failed to read Twilio message status:", err.message);
      return message;
    }
    if (!PENDING_STATUSES.has(message.status)) break;
  }
  return message;
}

module.exports = { sendWhatsApp, getMessageStatus, postForm, splitBody };
