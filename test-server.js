const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test"; // skip real Twilio calls (admin forwarding) during tests

const TEST_EVENTS_FILE = path.join(__dirname, "test-events.csv");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;

const { routeMessage, activeSubmissions, activeInquiries, recentlyCompleted } = require("./server");

async function demo() {
  if (fs.existsSync(TEST_EVENTS_FILE)) fs.unlinkSync(TEST_EVENTS_FILE);

  const sender = "whatsapp:+972500000000";

  const menuReply = await routeMessage(sender, "");
  if (!menuReply.includes("מה תרצו לעשות")) throw new Error("first message should show menu");

  const askReply = await routeMessage(sender, "2");
  if (!askReply.includes("שלחו את פרטי האירוע")) throw new Error("option 2 should ask for event details");
  if (!activeSubmissions.has(sender)) throw new Error("sender should have an active submission after choosing 2");

  const eventText = "שם האירוע: מסיבת בדיקה\nתאריך: 2026-07-10\nשעה: 21:00\nמיקום: חיפה\nקטגוריה: מסיבה\nקישור: https://example.com";
  const submitReply = await routeMessage(sender, eventText);
  if (!submitReply.includes("קיבלנו את האירוע")) throw new Error("complete event should be accepted");
  if (activeSubmissions.has(sender)) throw new Error("active submission should be cleared after submission");
  if (!fs.existsSync(TEST_EVENTS_FILE)) throw new Error("event should be appended to csv");
  const csvContent = fs.readFileSync(TEST_EVENTS_FILE, "utf8");
  if (!csvContent.includes("מסיבת בדיקה")) throw new Error("csv should contain the submitted event");

  // Regression test: right after a submission completes, a non-menu follow-up should
  // acknowledge the situation instead of silently resetting with no context.
  if (!recentlyCompleted.has(sender)) throw new Error("sender should be flagged as recently completed after submission");
  const followUpAfterSubmit = await routeMessage(sender, "תודה, מתי זה יפורסם?");
  if (!followUpAfterSubmit.includes("כבר נשלח לבדיקה")) {
    throw new Error("a stray follow-up right after submission should acknowledge the prior submission");
  }
  if (recentlyCompleted.has(sender)) throw new Error("recentlyCompleted flag should be consumed after one follow-up");

  const priceReply = await routeMessage(sender, "3");
  if (!priceReply.includes("מחיר הפרסום")) throw new Error("option 3 should reply with price placeholder");

  const contactReply = await routeMessage(sender, "4");
  if (!contactReply.includes("972528762432")) throw new Error("option 4 should reply with Stav's contact");

  const garbageReply = await routeMessage(sender, "asdf");
  if (!garbageReply.includes("מה תרצו לעשות")) throw new Error("garbage input should show menu again");

  // Regression test: partial info followed by a correction should merge, not loop back to the menu.
  await routeMessage(sender, "2");
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
  await routeMessage(longSender, "2");
  const tooLongReply = await routeMessage(longSender, "א".repeat(1001));
  if (!tooLongReply.includes("ארוכה מדי")) throw new Error("overly long message should be rejected");
  if (!activeSubmissions.has(longSender)) throw new Error("active submission should persist after a rejected long message");

  // Rate limit guard: 5 calls/minute allowed, the 6th within the window should be blocked.
  const spamSender = "whatsapp:+972500000002";
  await routeMessage(spamSender, "2");
  let sawRateLimit = false;
  for (let i = 0; i < 6; i += 1) {
    const reply = await routeMessage(spamSender, `הודעה מספר ${i}`);
    if (reply.includes("הרבה הודעות ברצף")) {
      sawRateLimit = true;
      break;
    }
  }
  if (!sawRateLimit) throw new Error("rapid-fire messages should eventually trigger the rate limit");

  // Inquiry flow: option 1 opens the Q&A mode, and "cancel" returns to the menu.
  const inquirySender = "whatsapp:+972500000003";
  const inquiryAsk = await routeMessage(inquirySender, "1");
  if (!inquiryAsk.includes("מה תרצו לדעת")) throw new Error("option 1 should open the inquiry flow");
  if (!activeInquiries.has(inquirySender)) throw new Error("sender should be in activeInquiries after choosing 1");

  const inquiryCancel = await routeMessage(inquirySender, "ביטול");
  if (!inquiryCancel.includes("מה תרצו לעשות")) throw new Error("cancel should exit the inquiry flow back to the menu");
  if (activeInquiries.has(inquirySender)) throw new Error("activeInquiries should be cleared after cancel");

  // Global escape hatch: /menu and /cancel should work from any state, mid-submission included.
  const escapeSender = "whatsapp:+972500000004";
  await routeMessage(escapeSender, "2");
  if (!activeSubmissions.has(escapeSender)) throw new Error("sender should be mid-submission before testing escape hatch");
  const menuEscape = await routeMessage(escapeSender, "/menu");
  if (!menuEscape.includes("מה תרצו לעשות")) throw new Error("/menu should return to the main menu from any state");
  if (activeSubmissions.has(escapeSender)) throw new Error("/menu should clear an in-progress submission");

  await routeMessage(escapeSender, "1");
  if (!activeInquiries.has(escapeSender)) throw new Error("sender should be mid-inquiry before testing escape hatch");
  const cancelEscape = await routeMessage(escapeSender, "/cancel");
  if (!cancelEscape.includes("מה תרצו לעשות")) throw new Error("/cancel should return to the main menu from any state");
  if (activeInquiries.has(escapeSender)) throw new Error("/cancel should clear an in-progress inquiry");

  fs.unlinkSync(TEST_EVENTS_FILE);
  console.log("all tests passed");
}

if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
