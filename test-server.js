const fs = require("fs");
const path = require("path");

const TEST_EVENTS_FILE = path.join(__dirname, "test-events.csv");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;

const { routeMessage, activeSubmissions } = require("./server");

async function demo() {
  if (fs.existsSync(TEST_EVENTS_FILE)) fs.unlinkSync(TEST_EVENTS_FILE);

  const sender = "whatsapp:+972500000000";

  const menuReply = await routeMessage(sender, "");
  if (!menuReply.includes("מה תרצו לעשות")) throw new Error("first message should show menu");

  const askReply = await routeMessage(sender, "1");
  if (!askReply.includes("שלחו את פרטי האירוע")) throw new Error("option 1 should ask for event details");
  if (!activeSubmissions.has(sender)) throw new Error("sender should have an active submission after choosing 1");

  const eventText = "שם האירוע: מסיבת בדיקה\nתאריך: 2026-07-10\nשעה: 21:00\nמיקום: חיפה\nקטגוריה: מסיבה\nקישור: https://example.com";
  const submitReply = await routeMessage(sender, eventText);
  if (!submitReply.includes("קיבלנו את האירוע")) throw new Error("complete event should be accepted");
  if (activeSubmissions.has(sender)) throw new Error("active submission should be cleared after submission");
  if (!fs.existsSync(TEST_EVENTS_FILE)) throw new Error("event should be appended to csv");
  const csvContent = fs.readFileSync(TEST_EVENTS_FILE, "utf8");
  if (!csvContent.includes("מסיבת בדיקה")) throw new Error("csv should contain the submitted event");

  const priceReply = await routeMessage(sender, "2");
  if (!priceReply.includes("מחיר הפרסום")) throw new Error("option 2 should reply with price placeholder");

  const contactReply = await routeMessage(sender, "3");
  if (!contactReply.includes("972528762432")) throw new Error("option 3 should reply with Stav's contact");

  const garbageReply = await routeMessage(sender, "asdf");
  if (!garbageReply.includes("מה תרצו לעשות")) throw new Error("garbage input should show menu again");

  // Regression test: partial info followed by a correction should merge, not loop back to the menu.
  await routeMessage(sender, "1");
  const partialReply = await routeMessage(sender, "מסיבת שאול 60, ביום שישי בערב");
  if (!partialReply.includes("חסרים עדיין פרטים")) throw new Error("partial event should ask for missing fields, not reset");
  if (!activeSubmissions.has(sender)) throw new Error("active submission should persist across a follow-up message");

  const followUpReply = await routeMessage(sender, "זה יהיה בקרן, חיפה. הקישור: https://example.com/shaul60");
  if (followUpReply.includes("מה תרצו לעשות")) throw new Error("follow-up should not reset to menu");
  if (activeSubmissions.has(sender) && followUpReply.includes("קיבלנו את האירוע")) {
    throw new Error("active submission should be cleared once the event is complete");
  }

  // Message length guard should reject before ever calling the LLM.
  const longSender = "whatsapp:+972500000001";
  await routeMessage(longSender, "1");
  const tooLongReply = await routeMessage(longSender, "א".repeat(1001));
  if (!tooLongReply.includes("ארוכה מדי")) throw new Error("overly long message should be rejected");
  if (!activeSubmissions.has(longSender)) throw new Error("active submission should persist after a rejected long message");

  // Rate limit guard: 5 calls/minute allowed, the 6th within the window should be blocked.
  const spamSender = "whatsapp:+972500000002";
  await routeMessage(spamSender, "1");
  let sawRateLimit = false;
  for (let i = 0; i < 6; i += 1) {
    const reply = await routeMessage(spamSender, `הודעה מספר ${i}`);
    if (reply.includes("הרבה הודעות ברצף")) {
      sawRateLimit = true;
      break;
    }
  }
  if (!sawRateLimit) throw new Error("rapid-fire messages should eventually trigger the rate limit");

  fs.unlinkSync(TEST_EVENTS_FILE);
  console.log("all tests passed");
}

if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
