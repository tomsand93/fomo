const fs = require("fs");
const { loadEvents, makeDigest } = require("./make-digest");
const { sendWhatsApp } = require("./send-whatsapp");

function loadEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

loadEnv();

const targetDate = process.argv[2] || new Date().toISOString().slice(0, 10);
const digest = makeDigest(loadEvents(process.env.EVENTS_FILE || "events.csv"), targetDate);
const to = process.env.TWILIO_DIGEST_TO || "whatsapp:+972525676445";

sendWhatsApp(to, digest)
  .then((result) => console.log(`sent ${result.sid} to ${result.to}`))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
