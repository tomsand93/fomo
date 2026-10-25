// Creates fomo_slot_ready and submits it to Meta for WhatsApp approval.
//
//   node submit-slot-ready-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: it refuses to
// create a second copy if the template already exists, because a duplicate friendly name
// is how approvedTemplateSid ends up picking the wrong one.
//
// This is what sendSlotReadyPing (server.js) sends when a daily slot comes back 63016:
// Stav had not written in 24h, so the boards were dropped. A template is the only thing
// a closed window lets through; her tap on its button reopens the window, and the queued
// boards go out. Until this is approved, a closed window still loses the slot.
//
// Two steps, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
//
// The name and button are read from server.js rather than retyped, so what is submitted
// is exactly what the code sends.
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
// sendSlotReadyPing actually sends.
const code = fs.readFileSync(path.join(dir, "server.js"), "utf8");
const NAME = (code.match(/const SLOT_READY_TEMPLATE = "([^"]+)"/) || [])[1];
const optionsBlock = (code.match(/const SLOT_READY_OPTIONS = \[([\s\S]*?)\];/) || [])[1];
if (!NAME || !optionsBlock) {
  console.error("Could not read the template name or button from server.js");
  process.exit(1);
}
const BUTTONS = [...optionsBlock.matchAll(/key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)]
  .map(([, key, label]) => ({ key, label }));
if (BUTTONS.length !== 1) {
  console.error("Could not parse the slot-ready button from server.js");
  process.exit(1);
}
// {{1}} is the slot time ("12:00"). Meta rejects a variable at either end of the body,
// so it sits inside the sentence. Worded without a gendered imperative.
const BODY = `ההודעות להעברה לקבוצה ב-{{1}} מוכנות. לחיצה על הכפתור תשלח אותן לכאן.`;

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

  // The button `id` becomes the ButtonPayload a tap sends back — set to SLOT_READY_KEY,
  // which handleAdminMessage answers by flushing the queued boards.
  const create = await request("POST", "/v1/Content", {
    friendly_name: NAME,
    language: "he",
    variables: { 1: "12:00" },
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

  // Utility, not Marketing: an operational notice for the admin, not promotional.
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: NAME,
    category: "UTILITY",
  });
  console.log("\nsubmit HTTP", approve.status);
  console.log(approve.body.slice(0, 600));
  console.log(
    "\nOnce it reads approved, sendSlotReadyPing will start using it automatically " +
    "(server.js checks approvedTemplateSid before every send)."
  );
})();
