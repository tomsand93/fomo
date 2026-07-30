const https = require("https");
const { URLSearchParams } = require("url");

const SEND_TIMEOUT_MS = 10_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function sendWhatsApp(to, body) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_WHATSAPP_FROM");
  const payload = new URLSearchParams({ From: from, To: to, Body: body }).toString();

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

module.exports = { sendWhatsApp, getMessageStatus };
