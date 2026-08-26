// Where do the reminder templates stand with Meta?
//
//   node check-reminder-template.js
//
// Read-only. Prints the approval status of every template the sender prefers, in the
// order send-reminder.js tries them, so it doubles as "would a reminder be delivered
// right now, and as what category".
const fs = require("fs");
const path = require("path");
const https = require("https");

const dir = __dirname;
const env = {};
const envFile = path.join(dir, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
}
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID || env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN;
if (!ACCOUNT || !TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  process.exit(1);
}
const auth = Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64");

// The order the sender actually tries, read from the code so the two cannot drift.
const code = fs.readFileSync(path.join(dir, "send-reminder.js"), "utf8");
const NAMES = (code.match(/const REMINDER_TEMPLATES = \[([^\]]+)\]/) || [])[1]
  .split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

function get(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: "content.twilio.com", path: p, headers: { Authorization: `Basic ${auth}` } },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }).on("error", reject);
  });
}

(async () => {
  const listing = await get("/v1/Content?PageSize=50");
  if (listing.status !== 200) {
    console.error("could not list templates:", listing.status);
    process.exit(1);
  }
  const contents = JSON.parse(listing.body).contents || [];

  let usable = null;
  for (const name of NAMES) {
    const found = contents.find((c) => c.friendly_name === name);
    if (!found) {
      console.log(`${name.padEnd(26)} not created`);
      continue;
    }
    const a = await get(`/v1/Content/${found.sid}/ApprovalRequests`);
    const w = (JSON.parse(a.body).whatsapp) || {};
    const line = `${name.padEnd(26)} ${String(w.status).padEnd(9)} ${w.category || ""}`;
    console.log(line + (w.rejection_reason ? `\n  rejected: ${w.rejection_reason}` : ""));
    if (w.status === "approved" && !usable) usable = { name, category: w.category };
  }

  console.log("");
  if (!usable) {
    console.log("No approved template. Out-of-window reminders would be reported as failed,");
    console.log("never silently dropped. Keep REMINDERS_ENABLED unset.");
    return;
  }
  console.log(`A reminder would send via ${usable.name} (${usable.category}).`);
  if (usable.category === "MARKETING") {
    console.log("MARKETING is throttled and suppressed for users opted out of marketing,");
    console.log("so some reminders would not arrive. Prefer waiting for a UTILITY one.");
  } else {
    console.log("UTILITY - good delivery. Turn the feature on:");
    console.log("  fly secrets set REMINDERS_ENABLED=1 -a fomo-qe2gha");
  }
})();
