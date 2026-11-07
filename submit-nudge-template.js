// Creates one WhatsApp template per weekly-nudge wording and submits each to Meta.
//
//   node submit-nudge-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: a wording whose
// template already exists is not created again (a duplicate friendly name is how
// approvedTemplateSid ends up picking the wrong one); its approval status is printed
// instead, so a re-run doubles as "where do they stand with Meta".
//
// The wordings and buttons come from nudge-variants.js, the same module server.js sends
// from, so what is submitted is exactly what the code sends. Adding a wording there and
// re-running this submits just the new one.
//
// Two steps per template, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
const fs = require("fs");
const path = require("path");
const https = require("https");
const { NUDGE_OPTIONS, NUDGE_VARIANTS } = require("./nudge-variants");

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

// Every page, not just the first: with more than one page of templates, a wording on
// page two would otherwise look missing and be created a second time.
async function listAll() {
  const all = [];
  let next = "/v1/Content?PageSize=50";
  while (next) {
    const page = await request("GET", next);
    if (page.status !== 200) {
      console.error("could not list templates:", page.status, page.body.slice(0, 300));
      process.exit(1);
    }
    const body = JSON.parse(page.body);
    all.push(...(body.contents || []));
    const url = body.meta && body.meta.next_page_url;
    next = url ? new URL(url).pathname + new URL(url).search : "";
  }
  return all;
}

async function approvalStatus(sid) {
  const res = await request("GET", `/v1/Content/${sid}/ApprovalRequests`);
  const w = (JSON.parse(res.body).whatsapp) || {};
  return `${w.status || "not submitted"}${w.category ? ` ${w.category}` : ""}` +
    (w.rejection_reason ? ` (rejected: ${w.rejection_reason})` : "");
}

async function createAndSubmit(variant) {
  // The button `id` becomes the ButtonPayload a tap sends back: "2" starts a submission
  // like the menu option, and the opt-out key is caught at the top of routeMessageInner.
  const create = await request("POST", "/v1/Content", {
    friendly_name: variant.template,
    language: "he",
    types: {
      "twilio/quick-reply": {
        body: variant.text,
        actions: NUDGE_OPTIONS.map((o) => ({ id: o.key, title: o.label })),
      },
    },
  });
  if (create.status < 200 || create.status >= 300) {
    return `create failed: HTTP ${create.status} ${create.body.slice(0, 300)}`;
  }
  const sid = JSON.parse(create.body).sid;

  // Marketing, honestly: it invites people to publish, and Meta re-categorised the far
  // more transactional reminder as marketing anyway (see send-reminder.js).
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: variant.template,
    category: "MARKETING",
  });
  if (approve.status < 200 || approve.status >= 300) {
    return `created ${sid}, but submitting failed: HTTP ${approve.status} ${approve.body.slice(0, 300)}`;
  }
  return `created ${sid} and submitted to Meta`;
}

(async () => {
  console.log("buttons:", NUDGE_OPTIONS.map((o) => `${o.key} -> ${o.label}`).join(", "));
  const existing = await listAll();
  console.log(`${existing.length} templates in the account\n`);

  let failed = false;
  for (const variant of NUDGE_VARIANTS) {
    const found = existing.find((c) => c.friendly_name === variant.template);
    const result = found
      ? `exists (${found.sid}): ${await approvalStatus(found.sid)}`
      : await createAndSubmit(variant);
    if (/failed/.test(result)) failed = true;
    console.log(`${variant.template.padEnd(28)} ${result}`);
  }

  console.log(
    "\nApproved wordings are picked up automatically: server.js re-checks approvals " +
    "(at most hourly) before every Wednesday send. Re-run this to see where they stand."
  );
  if (failed) process.exitCode = 1;
})();
