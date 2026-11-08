// Creates fomo_ad_offer and submits it to Meta for WhatsApp approval.
//
//   node submit-ad-offer-template.js
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env. Safe to re-run: it refuses to
// create a second copy if the template already exists, because a duplicate friendly name
// is how approvedTemplateSid ends up picking the wrong one.
//
// This is what notifyApproved (server.js) sends when Stav approves an event and the
// organizer's 24h window is shut: it carries the approval and the graphic-ad question in
// one message, and a tap on a button answers the question (send-interactive.js maps the
// buttons to 1, 2, 3, the same keys offerFor uses). Until it is approved, the approval
// and the offer wait and go out under the reply to the organizer's next message.
//
// Two steps, because Twilio separates them:
//   1. POST /v1/Content                                   -> creates it, returns a SID
//   2. POST /v1/Content/{sid}/ApprovalRequests/whatsapp    -> asks Meta to approve it
//
// The name is read from server.js so it cannot drift. The body and button titles are
// written out here, because the server's option labels carry the time and are too long
// for a button (WhatsApp allows 20 characters); keep them in step with offerFor.
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

const code = fs.readFileSync(path.join(dir, "server.js"), "utf8");
const NAME = (code.match(/const AD_OFFER_TEMPLATE = "([^"]+)"/) || [])[1];
if (!NAME) {
  console.error("Could not read the template name from server.js");
  process.exit(1);
}

// {{1}} is the event name, {{2}} the as-soon-as-possible time ("היום בערב"-style phrase
// from windowPhrase). Meta rejects a variable at either end of the body, so both sit
// inside sentences. The board's date is not here: it varies, and the organizer gets it
// with the ad's time once they answer.
const BODY =
  `האירוע שלכם "{{1}}" אושר 🎉\n\n` +
  `רוצים שנפרסם גם מודעה גרפית מורחבת? המודעה הקרובה ביותר: {{2}}.`;

// Button ids are the ButtonPayload a tap sends back: 1, 2, 3 as in offerFor's options.
// A button's title is fixed, so 3 can't name the board's day the way offerFor's text
// option does, and "only the daily board" would be wrong once today's has gone out. The
// reply to a tap (declineAd) names the board when there is one.
const BUTTONS = [
  { key: "1", label: "כן, בהקדם האפשרי" },
  { key: "2", label: "כן, אבחר יום וחלון" },
  { key: "3", label: "לא, תודה" },
];

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

  const create = await request("POST", "/v1/Content", {
    friendly_name: NAME,
    language: "he",
    variables: { 1: "ערב יין", 2: "היום בערב" },
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

  // Utility: it confirms an approval the organizer is waiting for and asks about their
  // own event. Meta may recategorise it as Marketing; that is acceptable.
  const approve = await request("POST", `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    name: NAME,
    category: "UTILITY",
  });
  console.log("\nsubmit HTTP", approve.status);
  console.log(approve.body.slice(0, 600));
  console.log(
    "\nOnce it reads approved, notifyApproved will start using it automatically " +
    "(server.js checks approvedTemplateSid before every send)."
  );
})();
