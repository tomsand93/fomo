const fs = require("fs");
const https = require("https");
const { loadEvents, makeDigest } = require("./make-digest");

function loadEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
}

function sendWhatsApp(body, callback) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_WHATSAPP_FROM");
  const to = process.env.TWILIO_DIGEST_TO || "whatsapp:+972525676445";
  const payload = new URLSearchParams({ From: from, To: to, Body: body }).toString();

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
    res.on("end", () => callback(null, res, response));
  });

  req.on("error", callback);
  req.end(payload);
}

loadEnv();

const targetDate = process.argv[2] || new Date().toISOString().slice(0, 10);
const digest = makeDigest(loadEvents(process.env.EVENTS_FILE || "events.csv"), targetDate);

sendWhatsApp(digest, (error, res, response) => {
  if (error) throw error;
  if (res.statusCode < 200 || res.statusCode >= 300) {
    console.error(response);
    process.exit(1);
  }
  const result = JSON.parse(response);
  console.log(`sent ${result.sid} to ${result.to}`);
});
