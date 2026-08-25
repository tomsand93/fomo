const fs = require("fs");
const { loadEvents } = require("./events-store");
const { makeWeekly } = require("./make-weekly");
const { todayIso } = require("./clock");
const { sendWhatsApp } = require("./send-whatsapp");

function loadEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

loadEnv();

// The board rolls, so there is only one of them now — the day it starts from is the
// only argument left.
const fromDate = process.argv[2] || todayIso();
const post = makeWeekly(loadEvents(process.env.EVENTS_FILE || "events.csv"), fromDate);
const to = process.env.TWILIO_DIGEST_TO || "whatsapp:+972525676445";

// The board goes to Stav, not to the group: WhatsApp's API can't post into a normal
// group (see channels.md), so she forwards it. Sending it to her also means she sees
// the post before the group does and can fix anything odd.
sendWhatsApp(to, post)
  .then((result) => console.log(`sent the board ${result.sid} to ${result.to}`))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
