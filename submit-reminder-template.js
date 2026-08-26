// Creates fomo_event_reminder and submits it to Meta for WhatsApp approval.
//
//   node submit-reminder-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: it refuses
// to create a second copy if the template already exists, because duplicate friendly
// names are how approvedTemplateSid ends up picking the wrong one.
//
// Two steps, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
//
// The body is read from send-reminder.js rather than retyped, so what is submitted is
// exactly what the code sends. See reminder-template.md for the reasoning behind the
// wording, the two variables, and why there are no buttons.
const fs = require("fs");
const path = require("path");
const https = require("https");

const dir = __dirname;

function loadEnv() {
  const env = {};
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID || env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN;
if (!ACCOUNT || !TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  process.exit(1);
}
const auth = Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64");

// Single source of truth: the comment in send-reminder.js showing the submitted body.
const code = fs.readFileSync(path.join(dir, "send-reminder.js"), "utf8");
const BODY = (code.match(/\/\/\s+(היי![^\n\r]*)/) || [])[1];
const NAME = (code.match(/REMINDER_TEMPLATE = "([^"]+)"/) || [])[1];
if (!BODY || !NAME) {
  console.error("Could not read the template body or name from send-reminder.js");
  process.exit(1);
}
if (!/\{\{1\}\}/.test(BODY) || !/\{\{2\}\}/.test(BODY)) {
  console.error("The body lost its variables - refusing to submit");
  process.exit(1);
}

function request(method, path_, payload) {
  const data = payload ? JSON.stringify(payload) : "";
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: "content.twilio.com",
      path: path_,
      headers: {
        Authorization: `Basic ${auth}`,
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.end(data || undefined);
  });
}

(async () => {
  console.log("name:", NAME);
  console.log("body:", BODY);

  const listing = await request("GET", "/v1/Content?PageSize=50");
  if (listing.status !== 200) {
    console.error("could not list templates:", listing.status, listing.body.slice(0, 300));
    process.exit(1);
  }
  const existing = (JSON.parse(listing.body).contents || [])
    .find((c) => c.friendly_name === NAME);
  if (existing) {
    console.log(`\n${NAME} already exists (${existing.sid}); not creating a second copy.`);
    const status = await request("GET", `/v1/Content/${existing.sid}/ApprovalRequests`);
    console.log("approval status:", status.body.slice(0, 400));
    return;
  }

  const create = await request("POST", "/v1/Content", {
    friendly_name: NAME,
    language: "he",
    variables: { 1: "מסיבת גג", 2: "20:00" },
    types: { "twilio/text": { body: BODY } },
  });
  console.log("\ncreate HTTP", create.status);
  if (create.status < 200 || create.status >= 300) {
    console.error(create.body.slice(0, 600));
    process.exit(1);
  }
  const sid = JSON.parse(create.body).sid;
  console.log("created:", sid);

  // Utility, not Marketing: this is a reminder the user asked for, and Utility has
  // better delivery and a lower rejection rate for this shape.
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: NAME,
    category: "UTILITY",
  });
  console.log("\nsubmit HTTP", approve.status);
  console.log(approve.body.slice(0, 600));
  console.log(
    "\nWhen it reads approved, turn the feature on:\n" +
    "  fly secrets set REMINDERS_ENABLED=1 -a fomo-qe2gha"
  );
})();
