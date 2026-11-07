const https = require("https");

const BALANCE_TIMEOUT_MS = 10_000;

// The prepaid Twilio balance, in the account's currency (USD). When it hits zero Twilio
// suspends the account and every send fails with 20003 "account is not active" — on
// 05/11/2026 the bot went silent this way, and nothing told anyone until it was noticed.
function fetchBalance() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return Promise.reject(new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN"));

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/Balance.json`,
      auth: `${accountSid}:${authToken}`,
    }, (res) => {
      let response = "";
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Twilio error ${res.statusCode}: ${response}`));
          return;
        }
        try {
          const { balance, currency } = JSON.parse(response);
          const amount = Number(balance);
          if (!Number.isFinite(amount)) throw new Error(`unreadable balance: ${response}`);
          resolve({ balance: amount, currency: currency || "USD" });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(BALANCE_TIMEOUT_MS, () => {
      req.destroy(new Error("Twilio balance fetch timed out"));
    });
  });
}

module.exports = { fetchBalance };
