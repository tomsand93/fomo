const fs = require("fs");
const path = require("path");

const TEST_EVENTS_FILE = path.join(__dirname, "test-events.csv");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;

const { routeMessage, awaitingEventDetails } = require("./server");

function demo() {
  if (fs.existsSync(TEST_EVENTS_FILE)) fs.unlinkSync(TEST_EVENTS_FILE);

  const sender = "whatsapp:+972500000000";

  const menuReply = routeMessage(sender, "");
  if (!menuReply.includes("מה תרצו לעשות")) throw new Error("first message should show menu");

  const askReply = routeMessage(sender, "1");
  if (!askReply.includes("שלחו את פרטי האירוע")) throw new Error("option 1 should ask for event details");
  if (!awaitingEventDetails.has(sender)) throw new Error("sender should be flagged after choosing 1");

  const eventText = "שם האירוע: מסיבת בדיקה\nתאריך: 2026-07-10\nשעה: 21:00\nמיקום: חיפה\nקטגוריה: מסיבה\nקישור: https://example.com";
  const submitReply = routeMessage(sender, eventText);
  if (!submitReply.includes("קיבלנו את האירוע")) throw new Error("complete event should be accepted");
  if (awaitingEventDetails.has(sender)) throw new Error("flag should be cleared after submission");
  if (!fs.existsSync(TEST_EVENTS_FILE)) throw new Error("event should be appended to csv");
  const csvContent = fs.readFileSync(TEST_EVENTS_FILE, "utf8");
  if (!csvContent.includes("מסיבת בדיקה")) throw new Error("csv should contain the submitted event");

  const priceReply = routeMessage(sender, "2");
  if (!priceReply.includes("מחיר הפרסום")) throw new Error("option 2 should reply with price placeholder");

  const contactReply = routeMessage(sender, "3");
  if (!contactReply.includes("972528762432")) throw new Error("option 3 should reply with Stav's contact");

  const garbageReply = routeMessage(sender, "asdf");
  if (!garbageReply.includes("מה תרצו לעשות")) throw new Error("garbage input should show menu again");

  fs.unlinkSync(TEST_EVENTS_FILE);
  console.log("all tests passed");
}

if (require.main === module) {
  demo();
}
