const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test"; // skip real Twilio calls (admin forwarding) during tests

const TEST_EVENTS_FILE = path.join(__dirname, "test-events.csv");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;

const { routeMessage, activeSubmissions, activeInquiries, activeInquiryHistories, recentlyCompleted, upcomingPublishedEvents, undeliveredAdminNotices } = require("./server");

const ADMIN = `whatsapp:${process.env.ADMIN_PHONE || "+972528762432"}`;

// Stub the inquiry LLM so conversation tests are deterministic and offline.
const answerInquiryModule = require("./answer-inquiry");
const answerInquiryCalls = [];
answerInquiryModule.answerInquiry = async (history, events) => {
  answerInquiryCalls.push({ history: history.map((m) => ({ ...m })), events });
  return `תשובה ${answerInquiryCalls.length}`;
};

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

  // First question: answered by the (stubbed) agent, with the cancel hint shown once.
  const firstAnswer = await routeMessage(inquirySender, "מה יש בסופ״ש?");
  if (!firstAnswer.includes("תשובה 1")) throw new Error("inquiry message should be answered by the agent");
  if (!firstAnswer.includes("ביטול")) throw new Error("first inquiry answer should include the cancel hint");
  if (answerInquiryCalls[0].history.length !== 1) throw new Error("first agent call should see only the first user message");

  // Follow-up question: the agent should receive the full conversation so far.
  const secondAnswer = await routeMessage(inquirySender, "וכמה עולה הראשון?");
  if (!secondAnswer.includes("תשובה 2")) throw new Error("follow-up inquiry should be answered by the agent");
  if (secondAnswer.includes("ביטול")) throw new Error("cancel hint should only appear on the first answer");
  const followUpHistory = answerInquiryCalls[1].history;
  if (followUpHistory.length !== 3) throw new Error("follow-up call should carry user, assistant, user turns");
  if (followUpHistory[0].content !== "מה יש בסופ״ש?") throw new Error("follow-up history should start with the first question");
  if (followUpHistory[1].role !== "assistant") throw new Error("follow-up history should include the previous answer");

  const inquiryCancel = await routeMessage(inquirySender, "ביטול");
  if (!inquiryCancel.includes("מה תרצו לעשות")) throw new Error("cancel should exit the inquiry flow back to the menu");
  if (activeInquiries.has(inquirySender)) throw new Error("activeInquiries should be cleared after cancel");
  if (activeInquiryHistories.has(inquirySender)) throw new Error("inquiry history should be cleared after cancel");

  // Re-entering inquiry mode starts a fresh conversation.
  await routeMessage(inquirySender, "1");
  await routeMessage(inquirySender, "שאלה חדשה");
  if (answerInquiryCalls[2].history.length !== 1) throw new Error("re-entering inquiry mode should start with empty history");
  await routeMessage(inquirySender, "ביטול");

  // The agent should only see published upcoming events.
  const filterSample = [
    { event_name: "עבר", status: "published", date: "2020-01-01" },
    { event_name: "ממתין", status: "submitted", date: "2099-01-02" },
    { event_name: "עתידי", status: "published", date: "2099-01-03" },
    { event_name: "קרוב", status: "published", date: "2099-01-01" },
  ];
  const upcoming = upcomingPublishedEvents(filterSample, "2098-12-31");
  if (upcoming.length !== 2) throw new Error("only published upcoming events should reach the agent");
  if (upcoming[0].event_name !== "קרוב") throw new Error("upcoming events should be sorted by date");

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

  // Regression test for the silent-drop bug: when a review notice never reached the admin
  // (WhatsApp error 63016, outside the 24h window), her next message must surface it.
  // Event #1 was submitted at the top of this run and is still "submitted".
  undeliveredAdminNotices.add("1");
  const adminWithMissed = await routeMessage(ADMIN, "ממתינים");
  if (!adminWithMissed.includes("לא הגיעה אליך")) {
    throw new Error("admin should be warned about review notices that were never delivered");
  }
  if (!adminWithMissed.includes("#1")) {
    throw new Error("the missed-notice warning should name the undelivered event");
  }

  // Acting on the event clears the flag, so it isn't reported forever.
  const adminApprove = await routeMessage(ADMIN, "אשר 1");
  if (!adminApprove.includes("אושר ופורסם")) throw new Error("admin approval should publish the event");
  if (undeliveredAdminNotices.has("1")) {
    throw new Error("acting on an event should clear its missed-notice flag");
  }
  const adminAfterAction = await routeMessage(ADMIN, "ממתינים");
  if (adminAfterAction.includes("לא הגיעה אליך")) {
    throw new Error("missed-notice warning should not persist after the event was handled");
  }

  // Admin corrections: Stav fixes a field, the event updates, and the correction is
  // recorded so later extractions can be told about it.
  const { buildCorrectionGuidance, correctionsPath, loadCorrections } = require("./corrections-store");
  const CORRECTIONS_FILE = correctionsPath(TEST_EVENTS_FILE);
  if (fs.existsSync(CORRECTIONS_FILE)) fs.unlinkSync(CORRECTIONS_FILE);

  const badFieldReply = await routeMessage(ADMIN, "תקן 2 גובה: 3 מטר");
  if (!badFieldReply.includes("לא מכיר את השדה")) throw new Error("unknown correction field should be rejected");

  const correctReply = await routeMessage(ADMIN, "תקן 2 מחיר: כניסה חופשית");
  if (!correctReply.includes("עודכן")) throw new Error("valid correction should be applied");
  const correctedEvent = require("./events-store").findEvent(TEST_EVENTS_FILE, "2");
  if (correctedEvent.price !== "כניסה חופשית") throw new Error("correction should update the stored event");

  const stored = loadCorrections(TEST_EVENTS_FILE);
  if (stored.length !== 1) throw new Error("the correction should be recorded for future extractions");
  if (stored[0].field !== "price") throw new Error("correction should record which field was wrong");

  // The whole point: recorded corrections must actually reach the extraction prompt.
  const guidance = buildCorrectionGuidance(TEST_EVENTS_FILE);
  if (!guidance.includes("price")) throw new Error("correction guidance should mention the corrected field");
  if (!guidance.includes("כניסה חופשית")) throw new Error("correction guidance should carry the corrected value");

  // Invalid values are rejected rather than silently written.
  const badValue = await routeMessage(ADMIN, "תקן 2 תאריך: מחר בערב");
  if (!badValue.includes("לא בפורמט הנכון")) throw new Error("malformed correction values should be rejected");

  // Clarifying questions: when the extractor is genuinely unsure, ask the submitter who
  // actually knows the answer - but only once, so an unhelpful reply can't trap them.
  const extractModule = require("./extract-event");
  const realExtract = extractModule.extractEvent;
  const completeDraft = {
    event_name: "ערב יין", date: "2099-05-05", start_time: "20:00", end_time: "",
    location: "השועל והכרם", category: "אוכל ויין", price: "", organizer: "",
    contact_link: "https://example.com/wine", description: "פלייט של 3 יינות ב-180 שח",
  };
  function draftWithQuestions(questions) {
    const draft = { ...completeDraft };
    Object.defineProperty(draft, "_questions", { value: questions, enumerable: false });
    return draft;
  }

  const askSender = "whatsapp:+972500000005";
  extractModule.extractEvent = async () => draftWithQuestions(["המחיר 180 ש\"ח הוא דמי כניסה או מחיר הפלייט?"]);

  await routeMessage(askSender, "2");
  const askedReply = await routeMessage(askSender, "ערב יין בשועל והכרם, 5.5, פלייט 180 שח");
  if (!askedReply.includes("שאלה קטנה")) throw new Error("an ambiguous draft should ask the submitter, not guess");
  if (!askedReply.includes("דמי כניסה")) throw new Error("the clarifying question itself should be shown");
  if (!activeSubmissions.has(askSender)) throw new Error("submission should stay open while awaiting clarification");

  // Even if the model stays unsure, the second pass must complete rather than re-ask.
  const resolvedReply = await routeMessage(askSender, "לא יודע");
  if (resolvedReply.includes("שאלה קטנה")) throw new Error("the submitter must never be asked twice");
  if (!resolvedReply.includes("קיבלנו את האירוע")) throw new Error("an unresolved question should still let the event through");
  if (activeSubmissions.has(askSender)) throw new Error("submission should close after the single clarification round");

  // A confident draft should not interrogate the submitter at all.
  const quietSender = "whatsapp:+972500000006";
  extractModule.extractEvent = async () => draftWithQuestions([]);
  await routeMessage(quietSender, "2");
  const quietReply = await routeMessage(quietSender, "ערב יין בשועל והכרם, 5.5, כניסה חופשית");
  if (quietReply.includes("שאלה קטנה")) throw new Error("a confident draft should not ask anything");
  if (!quietReply.includes("קיבלנו את האירוע")) throw new Error("a confident complete draft should be accepted directly");

  // Stav asked "why can't I just press 1" - bare/shortcut approval on the last notice.
  const server = require("./server");
  const eventsStore = require("./events-store");

  // Submit an event as a normal user so there's something pending to act on.
  const replySubmitter = "whatsapp:+972500000007";
  extractModule.extractEvent = async () => draftWithQuestions([]);
  await routeMessage(replySubmitter, "2");
  await routeMessage(replySubmitter, "ערב יין, 5.5, כניסה חופשית");
  const pendingEvents = eventsStore.loadEvents(TEST_EVENTS_FILE).filter((e) => e.status === "submitted");
  const targetId = pendingEvents[pendingEvents.length - 1].id;

  // NODE_ENV=test skips the real send, so simulate the notice bookkeeping directly.
  server.rememberNotice("SMtest123", targetId);

  const bareApprove = await routeMessage(ADMIN, "אשר");
  if (!bareApprove.includes("אושר ופורסם")) throw new Error('bare "אשר" should approve the most recent event');
  if (eventsStore.findEvent(TEST_EVENTS_FILE, targetId).status !== "published") {
    throw new Error("bare approval should actually publish the event");
  }

  // Replying to a specific notice targets that event even when it isn't the latest.
  await routeMessage(replySubmitter, "2");
  await routeMessage(replySubmitter, "ערב יין שני, 6.6, כניסה חופשית");
  const pending2 = eventsStore.loadEvents(TEST_EVENTS_FILE).filter((e) => e.status === "submitted");
  const olderId = pending2[pending2.length - 1].id;
  server.rememberNotice("SMolder", olderId);
  server.rememberNotice("SMnewer", "999"); // newest notice points elsewhere
  const repliedApprove = await routeMessage(ADMIN, "אשר", [], "SMolder");
  if (!repliedApprove.includes(`#${olderId}`)) throw new Error("replying to a notice should target that event, not the latest");

  // The "1" shortcut behaves like אשר.
  await routeMessage(replySubmitter, "2");
  await routeMessage(replySubmitter, "ערב יין שלישי, 7.7, כניסה חופשית");
  const pending3 = eventsStore.loadEvents(TEST_EVENTS_FILE).filter((e) => e.status === "submitted");
  const shortcutId = pending3[pending3.length - 1].id;
  server.rememberNotice("SMshortcut", shortcutId);
  const shortcutApprove = await routeMessage(ADMIN, "1");
  if (!shortcutApprove.includes("אושר ופורסם")) throw new Error('"1" should work as an approve shortcut');

  // Regression: the admin must be able to submit events too, not have them eaten as commands.
  const adminDraft = "ערב הופעות בשוק תלפיות, יום שישי 21:00, כניסה חופשית, https://example.com/gig";
  const adminSubmits = await routeMessage(ADMIN, adminDraft);
  if (adminSubmits.includes("פקודות ניהול")) {
    throw new Error("an admin forwarding an event should not get the command help text");
  }

  extractModule.extractEvent = realExtract;

  fs.unlinkSync(CORRECTIONS_FILE);
  fs.unlinkSync(TEST_EVENTS_FILE);
  console.log("all tests passed");
}

if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
