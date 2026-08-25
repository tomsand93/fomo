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

// Flyers are real files, so give the suite its own directory rather than writing into
// the one a running instance serves from.
const TEST_FLYER_DIR = path.join(__dirname, "test-flyers");
process.env.FLYER_DIR = TEST_FLYER_DIR;
fs.rmSync(TEST_FLYER_DIR, { recursive: true, force: true });

const { routeMessage, slotsDueAt, activeSubmissions, activeInquiries, activeInquiryHistories, recentlyCompleted, upcomingPublishedEvents, undeliveredAdminNotices, adminMode, lastActivity, IDLE_TIMEOUT_MS } = require("./server");

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

  // Flyers: stored on disk for Twilio to fetch, then swept once the event date passes.
  const flyerStore = require("./flyer-store");
  const pngBytes = fs.readFileSync(path.join(__dirname, "file.jpg"));
  const flyerDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

  const savedName = flyerStore.saveFlyer(flyerDataUrl, "999");
  if (!savedName) throw new Error("a valid image should be stored as a flyer");
  if (!flyerStore.flyerPath(savedName)) throw new Error("a stored flyer should be readable back");
  if (!fs.readFileSync(flyerStore.flyerPath(savedName)).equals(pngBytes)) {
    throw new Error("a stored flyer must round-trip byte-for-byte");
  }
  // The name is content-addressed, so resending the same image must not pile up copies.
  if (flyerStore.saveFlyer(flyerDataUrl, "999") !== savedName) {
    throw new Error("the same image should resolve to the same stored flyer");
  }
  // The served name reaches flyerPath from the CSV, which a person edits by hand.
  for (const bad of ["../events.csv", "..\\events.csv", "/etc/passwd", "nope.png"]) {
    if (flyerStore.flyerPath(bad)) throw new Error(`flyerPath must refuse ${bad}`);
  }
  if (flyerStore.saveFlyer("data:text/html;base64,PHNjcmlwdD4=", "999")) {
    throw new Error("a non-image upload must not be stored as a flyer");
  }
  flyerStore.deleteFlyer(savedName);
  if (flyerStore.flyerPath(savedName)) throw new Error("a deleted flyer should be gone");

  // A free event has nothing to buy, so a link or contact isn't required — demanding one
  // trapped submitters who had nothing to give (the ג'אם שישי / הופעת כובע shape).
  const { missingFields: mf } = require("./server");
  const freeBase = {
    event_name: "ג'אם", date: "2099-08-14", start_time: "12:00",
    location: "חיפה", category: "מוזיקה חיה", contact_link: "",
  };
  const wantsLink = (price) => mf({ ...freeBase, price }).some((f) => f.includes("קישור"));

  for (const price of ["כניסה חופשית", "הכניסה חופשית", "חינם", "ללא תשלום", "הופעת כובע", "תרומה חופשית", "free"]) {
    if (wantsLink(price)) throw new Error(`a free event (${price}) must not require a link`);
  }
  // Paid events still need somewhere to buy a ticket.
  for (const price of ["45 שח", "50 שח לפני 01:00 / 80 שח אחרי", "₪120"]) {
    if (!wantsLink(price)) throw new Error(`a paid event (${price}) must still require a link`);
  }
  // An unknown price is not the same as free — it must not open the exemption.
  if (!wantsLink("")) throw new Error("an unpriced event must still require a link");
  // The exemption is scoped to contact_link; everything else stays required.
  const stillMissing = mf({ ...freeBase, price: "כניסה חופשית", event_name: "", location: "" });
  if (!stillMissing.includes("שם האירוע") || !stillMissing.includes("מיקום")) {
    throw new Error("the free-entry exemption must not relax the other required fields");
  }

  extractModule.extractEvent = realExtract;

  // REGRESSION (לילה לבן #2, 23/08/2026): a submitter sent an event, then "תאמת שזה מחר"
  // to correct the date. The bot answered "already sent, no need to resend", dropped the
  // correction, and printed the menu twice. Three separate faults, asserted here together
  // because they only appear in this exact sequence.
  const amendSender = "whatsapp:+972500007777";
  await routeMessage(amendSender, "2");
  const receipt = await routeMessage(
    amendSender,
    'שם האירוע: לילה לבן\nתאריך: 2026-09-20\nשעה: 18:00\nמיקום: חיפה\nקטגוריה: תרבות\nקישור: https://haifa.muni.il/x'
  );

  // The receipt must echo the captured fields: a bare "we got it" gave the submitter
  // nothing to check, so a misread date only surfaced after publication.
  if (!receipt.includes("לילה לבן")) throw new Error("receipt should echo the event name");
  if (!receipt.includes("20.9")) throw new Error("receipt should echo the parsed date so a wrong one is visible");
  if (!receipt.includes("18:00")) throw new Error("receipt should echo the start time");

  // A correction must reach Stav, not be discarded as a duplicate submission.
  const correction = await routeMessage(amendSender, "תאמת שזה מחר");
  if (correction.includes("אין צורך לשלוח שוב")) {
    throw new Error("a correction after submission must not be dismissed as a duplicate");
  }
  if (!correction.includes("העברנו")) throw new Error("a correction should be forwarded to the admin");

  // ...and the menu must appear exactly once across the follow-up and the message after it.
  if (correction.includes("1. לברר בנוגע לאירועים")) {
    throw new Error("the follow-up reply must not append the menu (it printed twice)");
  }
  const afterCorrection = await routeMessage(amendSender, "אוקיי");
  if (!afterCorrection.includes("1. לברר בנוגע לאירועים")) {
    throw new Error("the message after a correction should fall through to the menu");
  }

  // A question is not a correction: it must keep the standing acknowledgement rather than
  // forwarding noise to Stav.
  await routeMessage(amendSender, "2");
  await routeMessage(
    amendSender,
    'שם האירוע: בדיקת שאלה\nתאריך: 2026-09-21\nשעה: 20:00\nמיקום: חיפה\nקטגוריה: מוזיקה\nקישור: https://x.co/1'
  );
  const question = await routeMessage(amendSender, "מתי זה יפורסם?");
  if (!question.includes("כבר נשלח לבדיקה")) {
    throw new Error("a question after submission should be acknowledged, not forwarded as an amendment");
  }

  // REGRESSION: a multi-line description (every real WhatsApp submission) was split on
  // newlines before quotes were parsed, so one event became two rows and the flyer name
  // landed in a column nothing reads.
  const multiline = "שורה ראשונה\nשורה שנייה, עם פסיק\n\n🤍 MADONNA LILY על גג 21";
  const before = eventsStore.loadEvents(TEST_EVENTS_FILE).length;
  const mlId = eventsStore.appendEvent(
    TEST_EVENTS_FILE,
    { event_name: "רב-שורות", date: "2026-09-22", start_time: "21:00", end_time: "", location: "חיפה", category: "מוזיקה", price: "", organizer: "", contact_link: "https://x.co/2", description: multiline },
    "Twilio WhatsApp",
    "whatsapp:+972500008888",
    []
  );
  eventsStore.updateEvent(TEST_EVENTS_FILE, mlId, { flyer: `${mlId}-abc123.jpg` });
  const after = eventsStore.loadEvents(TEST_EVENTS_FILE);
  if (after.length !== before + 1) {
    throw new Error(`a multi-line description must stay one row (got ${after.length - before} rows)`);
  }
  const mlRow = after.find((e) => e.id === String(mlId));
  if (mlRow.description !== multiline) throw new Error("a multi-line description must round-trip unchanged");
  if (mlRow.flyer !== `${mlId}-abc123.jpg`) throw new Error("the flyer name must survive a multi-line description");
  if (mlRow.submitter !== "whatsapp:+972500008888") throw new Error("columns after a multi-line field must not shift");

  // REGRESSION: the weekly boards fire on Sunday 18:00 and Thursday 17:00, when Stav's 24h
  // WhatsApp window is usually closed. Twilio accepted the send and reported 63016 without
  // delivering, and the code treated a resolved promise as success — every board from
  // 16 Aug to 23 Aug 2026 was lost silently. The board must be held until delivery is
  // confirmed, and both board maps must survive a restart (Fly suspends the machine).
  const stateAfter = JSON.parse(fs.readFileSync(TEST_STATE_FILE, "utf8"));
  if (!("sentBoards" in stateAfter)) {
    throw new Error("sentBoards must be persisted, or a restart re-sends the board");
  }
  if (!("pendingBoards" in stateAfter)) {
    throw new Error("pendingBoards must be persisted, or an undelivered board is lost on restart");
  }

  // Customer mode is sticky and survives restarts, so announcing it only at the switch left
  // Stav guessing which mode she was in hours later — and a customer-mode reply to an admin
  // command looks identical to a broken command. Every customer-mode reply must say so.
  await routeMessage(ADMIN, "לקוח");
  const inCustomerMode = await routeMessage(ADMIN, "3");
  if (!inCustomerMode.includes("מצב לקוח")) {
    throw new Error("every customer-mode reply must state the mode, not just the switch message");
  }
  const stillTagged = await routeMessage(ADMIN, "4");
  if (!stillTagged.includes("מצב לקוח")) {
    throw new Error("the customer-mode banner must persist across messages, not appear once");
  }
  // Back in admin mode the banner must not appear: it is the default and would be noise.
  await routeMessage(ADMIN, "ניהול");
  const backInAdmin = await routeMessage(ADMIN, "ממתינים");
  if (backInAdmin.includes("מצב לקוח")) {
    throw new Error("admin-mode replies must not carry the customer-mode banner");
  }

  // The weekly board carries the location, because "where" is the first thing someone
  // scanning the week asks. An event without one must simply omit the line rather than
  // print an empty marker. Neither the board nor the digest carries the standing
  // "put the group on mute" recommendation any more.
  const { makeWeekly } = require("./make-weekly");
  const { makeDigest } = require("./make-digest");
  const boardFile = path.join(__dirname, "test-board.csv");
  if (fs.existsSync(boardFile)) fs.unlinkSync(boardFile);
  fs.writeFileSync(boardFile, eventsStore.CSV_HEADERS.join(",") + "\n", "utf8");
  const boardRows = [
    { event_name: "עם מיקום", date: "2026-09-20", start_time: "21:00", location: "סילביה, החלוץ 27", category: "מוזיקה", contact_link: "https://x.co/1" },
    { event_name: "בלי מיקום", date: "2026-09-21", start_time: "19:30", location: "", category: "קולנוע", contact_link: "https://x.co/2" },
  ];
  for (const r of boardRows) {
    const rid = eventsStore.appendEvent(
      boardFile,
      { end_time: "", price: "", organizer: "", description: "", ...r },
      "Twilio WhatsApp",
      "whatsapp:+972500009999",
      []
    );
    eventsStore.updateEvent(boardFile, rid, { status: "published" });
  }
  const boardEvents = eventsStore.loadEvents(boardFile);
  const board = makeWeekly(boardEvents, "2026-09-20");
  if (!board.includes("📍 סילביה, החלוץ 27")) {
    throw new Error("the weekly board must show the location of an event that has one");
  }
  if (board.includes("📍 \n") || board.includes("📍 המלצה")) {
    throw new Error("an event without a location must omit the line, not print an empty marker");
  }
  if (board.includes("המלצה חמה")) {
    throw new Error("the weekly board must not carry the standing recommendation any more");
  }
  if (makeDigest(boardEvents, "2026-09-20").includes("המלצה חמה")) {
    throw new Error("the daily digest must not carry the standing recommendation any more");
  }
  fs.unlinkSync(boardFile);

  // --- Phase 1: shared formatter, Israel clock, contact_person ---
  const fmt = require("./format-event");
  const clock = require("./clock");

  // One clock. todayIso used to be UTC while the board scheduler read Israel-local,
  // which put them a day apart between 21:00 Israel and midnight UTC — survivable for
  // a twice-weekly board, wrong for one keyed on "today".
  if (clock.todayIso() !== clock.israelClock().date) {
    throw new Error("todayIso must be the Israel-local date, not UTC");
  }
  const lateEvening = new Date("2026-08-24T21:30:00Z"); // 00:30 next day in Israel
  if (clock.todayIso(lateEvening) === lateEvening.toISOString().slice(0, 10)) {
    throw new Error("todayIso must differ from the UTC date late in the Israel evening");
  }
  if (clock.israelClock().minute === undefined) {
    throw new Error("israelClock must expose minute — the 10-min-prior slots need it");
  }

  const freeEvent = {
    event_name: "ג׳אם", category: "מוזיקה חיה", date: "2026-09-20", start_time: "21:00",
    location: "סילביה", price: "כניסה חופשית", contact_person: "מאיה",
    contact_link: "https://x.co/1", description: "ג׳אם פתוח", flyer: "9-abc.jpg",
  };
  const paidEvent = { ...freeEvent, price: "70 ₪", flyer: "" };
  const noPriceEvent = { ...freeEvent, price: "", flyer: "", contact_person: "" };

  // The two entrance emojis, and the third state: an unstated price shows neither.
  // Inferring "free" from silence would put a factual error in front of the group.
  const freeShort = fmt.formatShort(freeEvent);
  if (!freeShort.includes("🆓") || freeShort.includes("🎟️")) {
    throw new Error("a free event must show 🆓 and not 🎟️");
  }
  const paidShort = fmt.formatShort(paidEvent);
  if (!paidShort.includes("🎟️") || paidShort.includes("🆓")) {
    throw new Error("a paid event must show 🎟️ and not 🆓");
  }
  const noPriceShort = fmt.formatShort(noPriceEvent);
  if (noPriceShort.includes("🆓") || noPriceShort.includes("🎟️")) {
    throw new Error("an event with no stated price must show neither entrance emoji");
  }

  // SHORT is for scanning: at most two lines however much the event carries.
  for (const [label, ev] of [["free", freeEvent], ["paid", paidEvent], ["unpriced", noPriceEvent]]) {
    const lineCount = fmt.formatShort(ev).split("\n").length;
    if (lineCount > 2) throw new Error(`SHORT (${label}) must be 1-2 lines, got ${lineCount}`);
  }

  // LONG is the full pitch, and the flyer rides as media rather than a text line.
  const freeLong = fmt.formatLong(freeEvent, { flyerUrl: (e) => (e.flyer ? `https://h/${e.flyer}` : "") });
  const longLines = freeLong.text.split("\n").length;
  if (longLines < 5 || longLines > 7) throw new Error(`LONG must be 5-7 lines, got ${longLines}`);
  if (!freeLong.text.includes("👤 מאיה")) throw new Error("LONG must show the contact person");
  if (!freeLong.mediaUrl) throw new Error("LONG must return the flyer as mediaUrl");
  if (freeLong.text.includes("9-abc.jpg")) throw new Error("the flyer must not appear as a text line");
  if (fmt.formatLong(paidEvent).mediaUrl) {
    throw new Error("an event with no flyer must return an empty mediaUrl");
  }

  // contact_person is a real column now, so it must survive a write/read round-trip.
  if (!eventsStore.CSV_HEADERS.includes("contact_person")) {
    throw new Error("contact_person must be a CSV column");
  }
  const cpFile = path.join(__dirname, "test-contact.csv");
  if (fs.existsSync(cpFile)) fs.unlinkSync(cpFile);
  fs.writeFileSync(cpFile, eventsStore.CSV_HEADERS.join(",") + "\n", "utf8");
  const cpId = eventsStore.appendEvent(
    cpFile,
    { event_name: "עם איש קשר", date: "2026-09-22", start_time: "20:00", end_time: "",
      location: "חיפה", category: "מוזיקה", price: "", organizer: "",
      contact_link: "https://x.co/2", contact_person: "רינה", description: "" },
    "Twilio WhatsApp",
    "whatsapp:+972500001234",
    []
  );
  const cpRow = eventsStore.loadEvents(cpFile).find((e) => e.id === String(cpId));
  if (cpRow.contact_person !== "רינה") {
    throw new Error("contact_person must round-trip through the CSV");
  }
  fs.unlinkSync(cpFile);

  // --- Phase 2: rolling board and the daily slots ---
  const weekly = require("./make-weekly");

  // The board starts today and runs to Saturday. The old fixed boards snapped backward
  // to their first day, so a board sent on Wednesday still led with Sunday — days the
  // reader could no longer act on.
  const windowCases = [
    ["2026-08-23", 7], // Sunday
    ["2026-08-26", 4], // Wednesday
    ["2026-08-28", 2], // Friday
    ["2026-08-29", 1], // Saturday
  ];
  for (const [from, expected] of windowCases) {
    const win = weekly.rollingWindow(from);
    if (win.length !== expected) {
      throw new Error(`rollingWindow(${from}) should span ${expected} days, got ${win.length}`);
    }
    if (win[0] !== from) throw new Error(`rollingWindow(${from}) must start on that day`);
  }
  // Never rolls into next week: the title promises this week.
  const satWindow = weekly.rollingWindow("2026-08-29");
  if (satWindow[satWindow.length - 1] !== "2026-08-29") {
    throw new Error("the rolling window must stop at Saturday, not continue into next week");
  }
  // On a one-day window "what's on this week" would be a lie.
  if (!weekly.boardTitle(satWindow).includes("היום")) {
    throw new Error("a single-day board must say today, not this week");
  }
  if (!weekly.boardTitle(weekly.rollingWindow("2026-08-23")).includes("השבוע")) {
    throw new Error("a multi-day board must say this week");
  }

  const rollFile = path.join(__dirname, "test-roll.csv");
  if (fs.existsSync(rollFile)) fs.unlinkSync(rollFile);
  fs.writeFileSync(rollFile, eventsStore.CSV_HEADERS.join(",") + "\n", "utf8");
  for (const [name, date] of [["אתמול", "2026-08-22"], ["מחרתיים", "2026-08-26"]]) {
    const rid = eventsStore.appendEvent(
      rollFile,
      { event_name: name, date, start_time: "20:00", end_time: "", location: "חיפה",
        category: "מוזיקה", price: "", organizer: "", contact_link: "", contact_person: "",
        description: "" },
      "Twilio WhatsApp", "whatsapp:+972500004321", []
    );
    eventsStore.updateEvent(rollFile, rid, { status: "published" });
  }
  const rolled = weekly.makeWeekly(eventsStore.loadEvents(rollFile), "2026-08-23");
  if (rolled.includes("אתמול")) throw new Error("a past event must never appear on the board");
  if (!rolled.includes("מחרתיים")) throw new Error("an upcoming event must appear on the board");
  fs.unlinkSync(rollFile);

  // Slots: weekdays 18:00, weekends also 12:00, sent 10 minutes prior. A window rather
  // than an exact minute, because Fly suspends the machine and timers drift.
  const slotsAt = (day, hour, minute) =>
    slotsDueAt({ day, hour, minute }).map((s) => s.slot).join(",");
  if (slotsAt(1, 17, 50) !== "18:00") throw new Error("Monday 17:50 must be due for the 18:00 slot");
  if (slotsAt(1, 17, 49) !== "") throw new Error("Monday 17:49 must not be due yet");
  if (slotsAt(1, 18, 4) !== "18:00") throw new Error("a late wake inside the window must still send");
  if (slotsAt(1, 18, 6) !== "") throw new Error("past the window it must skip, not send late");
  if (slotsAt(1, 11, 50) !== "") throw new Error("weekdays have no midday slot");
  if (slotsAt(5, 11, 50) !== "12:00") throw new Error("Friday must have the midday slot");
  if (slotsAt(6, 11, 50) !== "12:00") throw new Error("Saturday must have the midday slot");
  if (slotsAt(6, 17, 50) !== "18:00") throw new Error("Saturday must also have the evening slot");

  fs.unlinkSync(CORRECTIONS_FILE);
  fs.unlinkSync(TEST_EVENTS_FILE);
  fs.rmSync(TEST_FLYER_DIR, { recursive: true, force: true });
  console.log("all tests passed");
}

if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
