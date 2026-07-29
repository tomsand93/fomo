const https = require("https");

const DEFAULT_TIMEOUT_MS = 10_000;

function postJson({ hostname, path, headers, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);

  const options = {
    hostname,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`request to ${hostname}${path} failed with ${res.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request to ${hostname}${path} timed out after ${timeoutMs}ms`));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { postJson, DEFAULT_TIMEOUT_MS };
