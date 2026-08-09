const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test"; // skip real Twilio calls (admin forwarding) during tests

const TEST_EVENTS_FILE = path.join(__dirname, "test-events.csv");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;

// Tests must never read or write the real state.json: a leaked flag (recentlyCompleted,
// say) silently changes what the next run sees, and a test run would clobber live sessions.
const TEST_STATE_FILE = path.join(__dirname, "test-state.json");
process.env.STATE_FILE = TEST_STATE_FILE;
if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);

const { routeMessage, activeSubmissions, activeInquiries, activeInquiryHistories, recentlyCompleted, upcomingPublishedEvents, undeliveredAdminNotices, adminMode, lastActivity, IDLE_TIMEOUT_MS } = require("./server");

const ADMIN = `whatsapp:${process.env.ADMIN_PHONE || "+972528762432"}`;

// Stub the inquiry LLM so conversation tests are deterministic and offline.
const answerInquiryModule = require("./answer-inquiry");
const answerInquiryCalls = [];
answerInquiryModule.answerInquiry = async (history, events) => {
  answerInquiryCalls.push({ history: history.map((m) => ({ ...m })), events });
  return `תשובה ${answerInquiryCalls.length}`;
};

// Stub the extractor too: the suite must run offline and deterministically, without
// spending real OpenRouter calls. It parses the "field: value" shape the tests use and
// merges across turns, which is the behaviour the routing logic actually depends on.
const extractEventModule = require("./extract-event");
const STUB_FIELD_LABELS = new Map([
  ["שם האירוע", "event_name"], ["תאריך", "date"], ["שעה", "start_time"],
  ["מיקום", "location"], ["קטגוריה", "category"], ["קישור", "contact_link"],
]);

function stubExtract(conversationText) {
  const event = {
    event_name: "", date: "", start_time: "", end_time: "", location: "",
    category: "", price: "", organizer: "", contact_link: "", description: "",
  };
  for (const [label, key] of STUB_FIELD_LABELS) {
    const match = conversationText.match(new RegExp(`${label}:\\s*(.+)`));
    if (match) event[key] = match[1].trim();
  }
  const url = conversationText.match(/https?:\/\/\S+/);
  if (url && !event.contact_link) event.contact_link = url[0];
  Object.defineProperty(event, "_questions", { value: [], enumerable: false });
  return event;
}

extractEventModule.extractEvent = async (conversationText) => stubExtract(conversationText);

async function demo() {
  if (fs.existsSync(TEST_EVENTS_FILE)) fs.unlinkSync(TEST_EVENTS_FILE);

  const sender = "whatsapp:+972500000000";

  const menuReply = await routeMessage(sender, "");
  if (!menuReply.includes("מה תרצו לעשות")) throw new Error("first message should show menu");

  const askReply = await routeMessage(sender, "2");
  if (!askReply.includes("שלחו את פרטי האירוע")) throw new Error("option 2 should ask for event details");
  if (!activeSubmissions.has(sender)) throw new Error("sender should have an active submission after choosing 2");

  // Dated relative to today: past-dated submissions now expire themselves, so a hardcoded
  // date silently turns this into an expiry test the moment it slips into the past.
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const eventText = `שם האירוע: מסיבת בדיקה\nתאריך: ${futureDate}\nשעה: 21:00\nמיקום: חיפה\nקטגוריה: מסיבה\nקישור: https://example.com`;
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
  // The draft is reopened each turn because an incomplete one now force-completes after a
  // few attempts rather than looping forever - the limiter is what's under test here.
  const spamSender = "whatsapp:+972500000002";
  let sawRateLimit = false;
  for (let i = 0; i < 8; i += 1) {
    if (!activeSubmissions.has(spamSender)) await routeMessage(spamSender, "2");
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
  // The CSV is seeded from the bundled events.csv, so ids aren't predictable - find the
  // event this run actually submitted rather than assuming it is #1.
  const submittedNow = require("./events-store")
    .loadEvents(TEST_EVENTS_FILE)
    .filter((e) => e.status === "submitted");
  const missedId = submittedNow[submittedNow.length - 1].id;
  undeliveredAdminNotices.add(missedId);
  const adminWithMissed = await routeMessage(ADMIN, "ממתינים");
  if (!adminWithMissed.includes("לא הגיעה אליך")) {
    throw new Error("admin should be warned about review notices that were never delivered");
  }
  if (!adminWithMissed.includes(`#${missedId}`)) {
    throw new Error("the missed-notice warning should name the undelivered event");
  }

  // Acting on the event clears the flag, so it isn't reported forever.
  const adminApprove = await routeMessage(ADMIN, `אשר ${missedId}`);
  if (!adminApprove.includes("אושר ופורסם")) throw new Error("admin approval should publish the event");
  if (undeliveredAdminNotices.has(missedId)) {
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

  // REGRESSION (chat_history.txt:71-73): Stav replied a bare "דחה" to a reminder listing
  // #3 and #5, and event #8 - approved one message earlier - was rejected instead. A bare
  // command with no reply context must now refuse to act rather than guess a target.
  const bareReject = await routeMessage(ADMIN, "דחה");
  if (!bareReject.includes("לא ברור לאיזה אירוע")) {
    throw new Error('bare "דחה" with no replied-to notice must ask which event, not guess');
  }
  if (eventsStore.findEvent(TEST_EVENTS_FILE, targetId).status !== "submitted") {
    throw new Error("an ambiguous bare command must not change any event's status");
  }

  const bareApprove = await routeMessage(ADMIN, "אשר");
  if (!bareApprove.includes("לא ברור לאיזה אירוע")) {
    throw new Error('bare "אשר" with no replied-to notice must ask which event, not guess');
  }
  if (eventsStore.findEvent(TEST_EVENTS_FILE, targetId).status !== "submitted") {
    throw new Error("an ambiguous bare approval must not publish anything");
  }

  // Replying to a specific notice is unambiguous, so it still works.
  server.rememberNotice("SMnewer", "999"); // a newer notice must not steal the target
  const repliedApprove = await routeMessage(ADMIN, "אשר", [], "SMtest123");
  if (!repliedApprove.includes(`#${targetId}`)) throw new Error("replying to a notice should target that event");
  if (eventsStore.findEvent(TEST_EVENTS_FILE, targetId).status !== "published") {
    throw new Error("reply-based approval should publish the replied-to event");
  }

  // An explicit id is unambiguous too.
  await routeMessage(replySubmitter, "2");
  await routeMessage(replySubmitter, "ערב יין שני, 6.6, כניסה חופשית");
  const pending2 = eventsStore.loadEvents(TEST_EVENTS_FILE).filter((e) => e.status === "submitted");
  const explicitId = pending2[pending2.length - 1].id;
  const explicitApprove = await routeMessage(ADMIN, `אשר ${explicitId}`);
  if (!explicitApprove.includes("אושר ופורסם")) throw new Error('"אשר <id>" should approve the named event');

  // REGRESSION (chat_history.txt:148-149): "2" meant the menu's "publish an event", but was
  // read as the reject shortcut and silently rejected event #10. Digits must never act.
  await routeMessage(replySubmitter, "2");
  await routeMessage(replySubmitter, "ערב יין שלישי, 7.7, כניסה חופשית");
  const pending3 = eventsStore.loadEvents(TEST_EVENTS_FILE).filter((e) => e.status === "submitted");
  const shortcutId = pending3[pending3.length - 1].id;
  server.rememberNotice("SMshortcut", shortcutId);

  const digitTwo = await routeMessage(ADMIN, "2");
  if (digitTwo.includes("נדחה")) throw new Error('"2" must never reject an event');
  if (eventsStore.findEvent(TEST_EVENTS_FILE, shortcutId).status !== "submitted") {
    throw new Error('"2" must leave every event untouched');
  }
  const digitOne = await routeMessage(ADMIN, "1");
  if (digitOne.includes("אושר ופורסם")) throw new Error('"1" must never approve an event');

  // Explicit role switching: the admin's number is also her QA number.
  const toCustomer = await routeMessage(ADMIN, "לקוח");
  if (!toCustomer.includes("מצב לקוח")) throw new Error('"לקוח" should switch to customer mode');
  if (adminMode.get(ADMIN) !== "customer") throw new Error("customer mode should be recorded");

  // In customer mode "2" means the menu option, and admin commands are inert.
  const customerTwo = await routeMessage(ADMIN, "2");
  if (!customerTwo.includes("שלחו את פרטי האירוע")) throw new Error('"2" in customer mode should open a submission');
  if (!activeSubmissions.has(ADMIN)) throw new Error("customer-mode admin should get a real submission draft");

  const adminDraft = "שם האירוע: ערב הופעות\nתאריך: 2099-09-09\nשעה: 21:00\nמיקום: שוק תלפיות\nקטגוריה: מוזיקה חיה\nקישור: https://example.com/gig";
  const adminSubmits = await routeMessage(ADMIN, adminDraft);
  if (adminSubmits.includes("פקודות ניהול")) throw new Error("a QA submission must not hit the admin handler");
  if (!adminSubmits.includes("קיבלנו את האירוע")) throw new Error("a QA submission should be accepted like any other");

  const backToAdmin = await routeMessage(ADMIN, "ניהול");
  if (!backToAdmin.includes("מצב ניהול")) throw new Error('"ניהול" should switch back to admin mode');
  const adminPending = await routeMessage(ADMIN, "ממתינים");
  if (adminPending.includes("מה תרצו לעשות")) throw new Error("admin commands should work again after switching back");

  // Idle expiry: an abandoned draft is forgotten rather than resumed 30+ minutes later.
  const idleSender = "whatsapp:+972500000008";
  await routeMessage(idleSender, "2");
  if (!activeSubmissions.has(idleSender)) throw new Error("idle sender should start with an open draft");
  lastActivity.set(idleSender, Date.now() - IDLE_TIMEOUT_MS - 1000);
  const afterIdle = await routeMessage(idleSender, "שלום");
  if (activeSubmissions.has(idleSender)) throw new Error("an idle draft should be discarded, not resumed");
  if (!afterIdle.includes("מה תרצו לעשות")) throw new Error("a message after idle expiry should start fresh at the menu");

  // A recent session must NOT be expired. Use an incomplete draft so the submission stays
  // open across turns and it's the expiry sweep, not completion, that's being tested.
  const activeSender = "whatsapp:+972500000009";
  extractModule.extractEvent = async () => {
    const draft = { ...completeDraft, event_name: "", date: "", contact_link: "" };
    Object.defineProperty(draft, "_questions", { value: [], enumerable: false });
    return draft;
  };
  await routeMessage(activeSender, "2");
  const stillActive = await routeMessage(activeSender, "מסיבה בחיפה");
  if (!activeSubmissions.has(activeSender)) throw new Error("a fresh session must not be expired");
  if (stillActive.includes("מה תרצו לעשות")) throw new Error("an active draft should not be reset to the menu");
  if (!stillActive.includes("חסרים עדיין פרטים")) throw new Error("an incomplete draft should ask for the missing fields");

  // Past-dated submissions close themselves: Stav was being nagged daily about events
  // (#3, #5) that could no longer be published whatever she decided.
  const pastEvent = {
    id: "", status: "submitted", event_name: "אירוע שעבר", date: "2020-01-01",
    start_time: "20:00", location: "חיפה", category: "מסיבה", contact_link: "https://e.com",
  };
  const pastId = eventsStore.appendEvent(TEST_EVENTS_FILE, pastEvent, "test", "whatsapp:+972500000088", []);

  const pendingAfterExpiry = await routeMessage(ADMIN, "ממתינים");
  if (pendingAfterExpiry.includes(`#${pastId}`)) {
    throw new Error("a past-dated event must not be listed as awaiting review");
  }
  if (eventsStore.findEvent(TEST_EVENTS_FILE, pastId).status !== "expired") {
    throw new Error("a past-dated event should be closed automatically");
  }
  // "expired", not "rejected": nobody judged it, it just ran out of time.
  if (eventsStore.findEvent(TEST_EVENTS_FILE, pastId).status === "rejected") {
    throw new Error("expiry must be distinguishable from a real rejection");
  }

  // Reaching an expired event by explicit id explains itself instead of acting silently.
  const approveExpired = await routeMessage(ADMIN, `אשר ${pastId}`);
  if (!approveExpired.includes("כבר עבר")) throw new Error("approving an expired event should explain why it can't publish");
  if (eventsStore.findEvent(TEST_EVENTS_FILE, pastId).status === "published") {
    throw new Error("an expired event must never be published with a past date");
  }
  const rejectExpired = await routeMessage(ADMIN, `דחה ${pastId}`);
  if (!rejectExpired.includes("נסגר אוטומטית")) throw new Error("rejecting an expired event should say it already closed");

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
