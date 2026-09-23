// Creates fomo_review_event and submits it to Meta for WhatsApp approval.
//
//   node submit-review-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: it refuses to
// create a second copy if the template already exists, because a duplicate friendly name
// is how approvedTemplateSid ends up picking the wrong one.
//
// This is the template sendReviewButtons (server.js) sends after every event preview,
// and the ONLY thing that can reach Stav when the 24h window is closed — the preview
// itself (flyer + full description) is free text and can never become a template. Until
// this is approved, sendReviewButtons silently no-ops (server.js checks
// approvedTemplateSid and returns early), so a closed-window event notifies her with
// nothing at all beyond missedNoticesBanner on her next message.
//
// Two steps, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
//
// The body/buttons are read from server.js rather than retyped, so what is submitted is
// exactly what the code sends.
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
// sendReviewButtons actually sends.
const code = fs.readFileSync(path.join(dir, "server.js"), "utf8");
const NAME = (code.match(/const REVIEW_TEMPLATE = "([^"]+)"/) || [])[1];
const optionsBlock = (code.match(/const REVIEW_BUTTON_OPTIONS = \[([\s\S]*?)\];/) || [])[1];
if (!NAME || !optionsBlock) {
  console.error("Could not read the template name or button options from server.js");
  process.exit(1);
}
const BUTTONS = [...optionsBlock.matchAll(/key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)]
  .map(([, key, label]) => ({ key, label }));
if (BUTTONS.length < 2) {
  console.error("Could not parse the review buttons from server.js");
  process.exit(1);
}
// Self-contained on purpose: v1 (fomo_review_event) read "כל הפרטים המלאים מופיעים
// בהודעה שמעל" and told her to reply to that message — but this is the fallback for
// exactly the case where that message failed to send, so the swipe-reply had nothing to
// land on and WhatsApp answered with "אין הודעה מעל" (event #38, 22/09/2026). v2 never
// references another message; the buttons below are the only thing it points at.
const BODY = `אירוע #{{1}} ממתין לאישור. אפשר ללחוץ על אחד הכפתורים למטה.`;

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

  // WhatsApp quick-reply buttons: up to 3, each a short label. The button `id` on the
  // Twilio side becomes the ButtonPayload a tap sends back — set to the same key
  // (אשר/דחה/ממתינים) server.js already expects, so a tap and a typed word land in the
  // same handler with no extra mapping.
  const create = await request("POST", "/v1/Content", {
    friendly_name: NAME,
    language: "he",
    variables: { 1: "37" },
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

  // Utility, not Marketing: this is an operational review request, not promotional.
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: NAME,
    category: "UTILITY",
  });
  console.log("\nsubmit HTTP", approve.status);
  console.log(approve.body.slice(0, 600));
  console.log(
    "\nOnce it reads approved, sendReviewButtons will start using it automatically " +
    "(server.js checks approvedTemplateSid before every send) — no deploy needed beyond " +
    "this being live."
  );
})();
