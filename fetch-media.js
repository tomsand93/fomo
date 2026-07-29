const https = require("https");

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024; // 2MB

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function get(url, auth, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(get(res.headers.location, auth, redirectsLeft - 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`Twilio media fetch error ${res.statusCode}`));
        return;
      }
      const contentType = res.headers["content-type"] || "image/jpeg";
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_MEDIA_BYTES) {
          res.destroy();
          reject(new Error("media file exceeds maximum allowed size"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const base64 = Buffer.concat(chunks).toString("base64");
        resolve(`data:${contentType};base64,${base64}`);
      });
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error("Twilio media fetch timed out"));
    });
  });
}

function fetchMediaAsDataUrl(mediaUrl) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return get(mediaUrl, auth, 3);
}

module.exports = { fetchMediaAsDataUrl };
