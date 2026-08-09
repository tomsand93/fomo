const fs = require("fs");
const { loadEvents } = require("./events-store");
const { makeWeekly, BOARDS } = require("./make-weekly");
const { sendWhatsApp } = require("./send-whatsapp");

function loadEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

loadEnv();

const board = process.argv[2] || "midweek";
if (!BOARDS[board]) {
  console.error(`unknown board "${board}". use one of: ${Object.keys(BOARDS).join(", ")}`);
  process.exit(1);
}

const fromDate = process.argv[3] || new Date().toISOString().slice(0, 10);
const post = makeWeekly(loadEvents(process.env.EVENTS_FILE || "events.csv"), board, fromDate);
const to = process.env.TWILIO_DIGEST_TO || "whatsapp:+972525676445";

// The board goes to Stav, not to the group: WhatsApp's API can't post into a normal
// group (see channels.md), so she forwards it. Sending it to her also means she sees
// the post before the group does and can fix anything odd.
sendWhatsApp(to, post)
  .then((result) => console.log(`sent ${board} board ${result.sid} to ${result.to}`))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
