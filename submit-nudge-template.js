// Creates fomo_weekly_nudge and submits it to Meta for WhatsApp approval.
//
//   node submit-nudge-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: it refuses to
// create a second copy if the template already exists, because a duplicate friendly name
// is how approvedTemplateSid ends up picking the wrong one.
//
// This is what sendDueWeeklyNudge (server.js) sends publishers every Wednesday at 18:00.
// Most of them have not written in 24h by then, so until this is approved only the few
// with an open window get the nudge, as plain text.
//
// Two steps, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
//
// The name, body and buttons are read from server.js rather than retyped, so what is
// submitted is exactly what the code sends.
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

// Single source of truth: read straight from server.js so this cannot drift from what
// sendDueWeeklyNudge actually sends.
const code = fs.readFileSync(path.join(dir, "server.js"), "utf8");
const NAME = (code.match(/const NUDGE_TEMPLATE = "([^"]+)"/) || [])[1];
const OPT_OUT_KEY = (code.match(/const NUDGE_OPT_OUT_KEY = "([^"]+)"/) || [])[1];
const BODY = (code.match(/const NUDGE_TEXT = `([^`]+)`;/) || [])[1];
const optionsBlock = (code.match(/const NUDGE_OPTIONS = \[([\s\S]*?)\];/) || [])[1];
if (!NAME || !OPT_OUT_KEY || !BODY || !optionsBlock) {
  console.error("Could not read the template name, body or buttons from server.js");
  process.exit(1);
}
// The opt-out button's key is the NUDGE_OPT_OUT_KEY constant, not a literal.
const BUTTONS = [...optionsBlock.matchAll(/key:\s*(?:"([^"]+)"|NUDGE_OPT_OUT_KEY),\s*label:\s*"([^"]+)"/g)]
  .map(([, key, label]) => ({ key: key || OPT_OUT_KEY, label }));
if (BUTTONS.length !== 2) {
  console.error("Could not parse the two nudge buttons from server.js");
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
  console.log("buttons:", BUTTONS.map((b) => `${b.key} -> ${b.label}`).join(", "));

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

  // The button `id` becomes the ButtonPayload a tap sends back: "2" starts a submission
  // like the menu option, and the opt-out key is caught at the top of routeMessageInner.
  const create = await request("POST", "/v1/Content", {
    friendly_name: NAME,
    language: "he",
    types: {
      "twilio/quick-reply": {
        body: BODY,
        actions: BUTTONS.map((b) => ({ id: b.key, title: b.label })),
      },
    },
  });
  console.log("\ncreate HTTP", create.status);
  if (create.status < 200 || create.status >= 300) {
    console.error(create.body.slice(0, 600));
    process.exit(1);
  }
  const sid = JSON.parse(create.body).sid;
  console.log("created:", sid);

  // Marketing, honestly: it invites people to publish, and Meta re-categorised the far
  // more transactional reminder as marketing anyway (see send-reminder.js).
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: NAME,
    category: "MARKETING",
  });
  console.log("\nsubmit HTTP", approve.status);
  console.log(approve.body.slice(0, 600));
  console.log(
    "\nOnce it reads approved, sendDueWeeklyNudge will start using it automatically " +
    "(server.js checks approvedTemplateSid before every send)."
  );
})();
