const https = require("https");
const { URLSearchParams } = require("url");

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
    req.end(payload);
  });
}

module.exports = { sendWhatsApp };
