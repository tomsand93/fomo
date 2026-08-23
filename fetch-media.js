const https = require("https");

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024; // 2MB

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// Twilio hands off media to a storage host, so the redirect has to be followed. The
// credentials must not follow it: `auth` is the full account SID and auth token, and
// anything but Twilio's own host receiving them is a total account compromise. Sent
// only while the host is unchanged, dropped for good once it isn't.
function get(url, auth, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { Authorization: `Basic ${auth}` } : {};
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        // Location is allowed to be relative, so resolve it against the URL we just asked.
        const target = new URL(res.headers.location, url);
        const sameHost = target.host === new URL(url).host;
        resolve(get(target.toString(), sameHost ? auth : "", redirectsLeft - 1));
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
