const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
// The feature ships gated off; these tests exist to verify it when it is on.
// The gate itself is tested explicitly at the end.
process.env.REMINDERS_ENABLED = "1";

// Own data files, like test-server.js: a test run must never touch the real volume.
const TEST_EVENTS_FILE = path.join(__dirname, "test-reminder-events.csv");
const TEST_REMINDERS_FILE = path.join(__dirname, "test-reminders.jsonl");
const TEST_STATE_FILE = path.join(__dirname, "test-reminder-state.json");
process.env.EVENTS_FILE = TEST_EVENTS_FILE;
process.env.REMINDERS_FILE = TEST_REMINDERS_FILE;
process.env.STATE_FILE = TEST_STATE_FILE;
for (const file of [TEST_REMINDERS_FILE, TEST_STATE_FILE]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const EVENT_HEADER = "id,event_name,date,start_time,end_time,location,category,price,organizer,contact_link,description,flyer,status,submitted_by,submitted_at";

function writeEvents(rows) {
  const lines = [EVENT_HEADER];
  for (const row of rows) {
    lines.push([
      row.id, row.event_name, row.date, row.start_time, "", row.location || "חיפה",
      row.category || "מוזיקה", "", "", "", "", "", row.status || "published", "", "",
    ].join(","));
  }
  fs.writeFileSync(TEST_EVENTS_FILE, `${lines.join("\n")}\n`, "utf8");
}

const clock = require("./clock");
const remindersStore = require("./reminders-store");
const { extractReminderRequest } = require("./answer-inquiry");
const { windowIsOpen, reminderText, REMINDER_TEMPLATES } = require("./send-reminder");

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
  console.log(`  ok  ${label}`);
}

function checkTrue(label, value) {
  if (!value) throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
  console.log(`  ok  ${label}`);
}

async function run() {
  // Israel is UTC+3 in August, so a 20:00 local start is 17:00Z.
  const EVENT_DATE = "2026-08-27";
  const at = (hhmm) => new Date(`${EVENT_DATE}T${hhmm}:00Z`);
  const SENDER = "whatsapp:+972500000001";

  console.log("the reminder window");
  check("3h before is due", clock.isReminderDue(EVENT_DATE, "20:00", at("14:00")), true);
  check("2h55 before is due", clock.isReminderDue(EVENT_DATE, "20:00", at("14:05")), true);
  check("3h01 before is too early", clock.isReminderDue(EVENT_DATE, "20:00", at("13:59")), false);
  check("2h before is past the window", clock.isReminderDue(EVENT_DATE, "20:00", at("15:00")), false);
  check("after the start is not due", clock.isReminderDue(EVENT_DATE, "20:00", at("17:30")), false);
  // The bug clock.js exists to prevent: a fixed offset is an hour wrong for half the year.
  check(
    "winter reads Israel local, not UTC",
    clock.isReminderDue("2026-01-15", "20:00", new Date("2026-01-15T15:05:00Z")),
    true
  );
  check(
    "winter does not fire at the naive-UTC time",
    clock.isReminderDue("2026-01-15", "20:00", new Date("2026-01-15T14:05:00Z")),
    false
  );
  check("a missing start time never fires", clock.isReminderDue(EVENT_DATE, "", at("14:05")), false);

  console.log("the opt-in marker");
  check(
    "a marker is stripped and its id returned",
    extractReminderRequest("יש מסיבה ב-20:00.\n[[REMIND:7]]"),
    { text: "יש מסיבה ב-20:00.", eventIds: ["7"] }
  );
  check(
    "an answer with no marker is untouched",
    extractReminderRequest("יש מסיבה ב-20:00."),
    { text: "יש מסיבה ב-20:00.", eventIds: [] }
  );
  checkTrue(
    "the marker never reaches the user",
    !extractReminderRequest("טקסט [[REMIND:3]] עוד טקסט").text.includes("REMIND")
  );

  console.log("the wording");
  // The two send paths must be indistinguishable to the person receiving them. If the
  // free-text sentence and the approved template ever drift, a user who happens to be
  // inside their 24h window gets a different message from one who is not - and only the
  // template can be changed without a redeploy, so the drift would be invisible here.
  const sentence = reminderText({ eventName: "מסיבת גג", startTime: "20:00" });
  check(
    "the free-text reminder reads as the template does",
    sentence,
    "היי! 👋 עוד קצת ומתחיל מסיבת גג, ב-20:00. תהנו! 🎈"
  );
  // There are two approved bodies now, tried in the order REMINDER_TEMPLATES lists them:
  // the v3 transactional rewrite (submitted as UTILITY) and the friendly original, kept
  // as a fallback. Both are real send paths, so the doc has to carry both — pinning this
  // to one wording broke as soon as v3 landed, and the check that matters is that no
  // approved body drifts away from what the code sends, not which one comes first.
  const templateDoc = fs.readFileSync(path.join(__dirname, "reminder-template.md"), "utf8");
  // The file is CRLF, so match either ending and keep the \r out of the captured body.
  const docBodies = [...templateDoc.matchAll(/```\r?\n([^\r\n`]*\{\{1\}\}[^\r\n]*)\r?\n```/g)].map((m) => m[1]);
  checkTrue("the submission doc still carries a body per approved template", docBodies.length >= REMINDER_TEMPLATES.length);
  // The friendly body is the one reminderText() renders inside the 24h window, so that
  // one must match character for character.
  const friendlyBody = docBodies.find((b) => b.startsWith("היי!"));
  checkTrue("the doc still carries the free-text body", Boolean(friendlyBody));
  check(
    "and it matches what the code sends",
    friendlyBody.replace("{{1}}", "מסיבת גג").replace("{{2}}", "20:00"),
    sentence
  );
  // v3 is a deliberate rewrite rather than the same sentence, so it is not compared to
  // reminderText. What it must do is name the event and the time, in that order — a
  // reminder that lost either one would still read as a sentence and still be wrong.
  const v3Body = docBodies.find((b) => !b.startsWith("היי!"));
  checkTrue("the doc carries the v3 body", Boolean(v3Body));
  checkTrue(
    "and v3 still names the event before the time",
    Boolean(v3Body) && v3Body.indexOf("{{1}}") < v3Body.indexOf("{{2}}")
  );
  // The repo's guard: a variation selector makes an emoji vanish on some clients.
  checkTrue(
    "no emoji carries a variation selector",
    !docBodies.some((b) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}/u.test(b))
  );
  // Meta rejects a body that is only parameters.
  checkTrue(
    "the body has literal text around its variables",
    docBodies.every((b) => b.replace(/\{\{\d\}\}/g, "").trim().length > 10)
  );

  console.log("template preference");
  // Category beats wording: the friendly template was approved as MARKETING, which is
  // throttled and suppressed for anyone opted out of marketing, so the transactional
  // UTILITY one must win whenever it is available.
  const interactive = require("./send-interactive");
  const { reminderTemplateSid } = require("./send-reminder");
  check("v3 is preferred", REMINDER_TEMPLATES[0], "fomo_event_reminder_v3");

  interactive._setApprovedTemplates(new Map([
    ["fomo_event_reminder", "HXmarketing"],
    ["fomo_event_reminder_v3", "HXutility"],
  ]));
  check("the utility template wins when both are approved",
    reminderTemplateSid(), { sid: "HXutility", name: "fomo_event_reminder_v3" });

  interactive._setApprovedTemplates(new Map([["fomo_event_reminder", "HXmarketing"]]));
  check("the marketing one is used when it is all there is",
    reminderTemplateSid(), { sid: "HXmarketing", name: "fomo_event_reminder" });

  interactive._setApprovedTemplates(new Map());
  check("neither approved means no sid", reminderTemplateSid(), { sid: "", name: "" });

  console.log("the 24h window check");
  const now = Date.now();
  check("a message an hour ago leaves it open", windowIsOpen(now - 60 * 60 * 1000, now), true);
  check("a message two days ago leaves it closed", windowIsOpen(now - 48 * 60 * 60 * 1000, now), false);
  check("23h59 is treated as closed, for safety", windowIsOpen(now - (24 * 60 - 1) * 60 * 1000, now), false);
  check("an unknown last message is closed", windowIsOpen(0, now), false);

  console.log("the store");
  const first = remindersStore.addReminder({
    sender: SENDER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00",
  });
  check("a new opt-in is recorded", first, { added: true, already: false });
  const second = remindersStore.addReminder({
    sender: SENDER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00",
  });
  check("asking twice does not double-book", second, { added: false, already: true });
  check("one pending reminder", remindersStore.pendingReminders().length, 1);

  // The point of append-only: state survives a restart because it is on disk, not in memory.
  delete require.cache[require.resolve("./reminders-store")];
  const reloaded = require("./reminders-store");
  check("a pending reminder survives a restart", reloaded.pendingReminders().length, 1);

  reloaded.markReminder(SENDER, "7", reloaded.STATUS_SENT, "text delivered");
  check("a sent reminder leaves the pending set", reloaded.pendingReminders().length, 0);
  delete require.cache[require.resolve("./reminders-store")];
  check(
    "and stays sent across a restart",
    require("./reminders-store").pendingReminders().length,
    0
  );

  console.log("firing");
  fs.unlinkSync(TEST_REMINDERS_FILE);
  delete require.cache[require.resolve("./reminders-store")];
  delete require.cache[require.resolve("./server")];
  writeEvents([
    { id: "7", event_name: "מסיבה", date: EVENT_DATE, start_time: "20:00" },
    { id: "8", event_name: "הופעה", date: EVENT_DATE, start_time: "23:00" },
    { id: "9", event_name: "הרצאה", date: EVENT_DATE, start_time: "21:00", status: "rejected" },
  ]);
  const store = require("./reminders-store");
  const server = require("./server");

  const sent = [];
  const okDeliver = async (payload) => {
    sent.push(payload);
    return { ok: true, via: "text", sid: `SM${sent.length}`, status: "delivered" };
  };

  store.addReminder({ sender: SENDER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00" });
  store.addReminder({ sender: SENDER, eventId: "8", eventName: "הופעה", eventDate: EVENT_DATE, eventTime: "23:00" });

  // 17:00 local: event 7 (20:00) is 3h away, event 8 (23:00) is 6h away.
  await server.sendDueEventReminders(at("14:00"), okDeliver);
  check("only the event inside its window fires", sent.map((s) => s.eventName), ["מסיבה"]);

  // Running again in the same window must not send a second time.
  await server.sendDueEventReminders(at("14:10"), okDeliver);
  check("a reminder fires exactly once", sent.length, 1);
  check("and is not left pending", store.pendingReminders().map((r) => r.eventId), ["8"]);

  // An unpublished event must not produce a reminder to attend it.
  store.addReminder({ sender: SENDER, eventId: "9", eventName: "הרצאה", eventDate: EVENT_DATE, eventTime: "21:00" });
  await server.sendDueEventReminders(at("15:00"), okDeliver);
  check("an unpublished event does not fire", sent.length, 1);
  checkTrue(
    "and it is cancelled, not left pending",
    !store.pendingReminders().some((r) => r.eventId === "9")
  );

  console.log("failure is never silent");
  const failDeliver = async () => ({ ok: false, via: "template", reason: "no-template", detail: "not approved" });
  // Event 8 starts 23:00 local = 20:00Z, so 3h before it is 17:00Z.
  await server.sendDueEventReminders(at("17:00"), failDeliver);
  const failed = store.currentReminders().get(`${SENDER}:8`);
  check("a failed send is recorded as failed", failed.status, store.STATUS_FAILED);
  checkTrue("with the reason kept", failed.detail.includes("no-template"));
  checkTrue("and it is not left pending to retry blindly", !store.pendingReminders().some((r) => r.eventId === "8"));

  console.log("a missed window is closed out");
  fs.unlinkSync(TEST_REMINDERS_FILE);
  delete require.cache[require.resolve("./reminders-store")];
  delete require.cache[require.resolve("./server")];
  const store2 = require("./reminders-store");
  const server2 = require("./server");
  store2.addReminder({ sender: SENDER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00" });
  // The machine was asleep through the window and wakes after the event started.
  await server2.sendDueEventReminders(at("18:00"), okDeliver);
  const missed = store2.currentReminders().get(`${SENDER}:7`);
  check("a missed reminder is failed, not left pending forever", missed.status, store2.STATUS_FAILED);
  checkTrue("with the reason kept", missed.detail.includes("window passed"));

  console.log("opt-in recording");
  // recordReminderOptIns has no injectable clock — it checks isReminderMissed against
  // real wall-clock time — so EVENT_DATE (fixed, for the window-math tests above, which
  // do pass an explicit `now`) would eventually land in the past and this section would
  // start failing for a reason unrelated to the code. A date computed from today can't.
  const FUTURE_EVENT_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const events = [
    { id: "7", event_name: "מסיבה", date: FUTURE_EVENT_DATE, start_time: "20:00" },
    { id: "8", event_name: "הופעה", date: FUTURE_EVENT_DATE, start_time: "23:00" },
  ];
  fs.unlinkSync(TEST_REMINDERS_FILE);
  delete require.cache[require.resolve("./reminders-store")];
  delete require.cache[require.resolve("./server")];
  const store3 = require("./reminders-store");
  const server3 = require("./server");

  const confirmation = server3.recordReminderOptIns(SENDER, ["7"], events);
  checkTrue("the user is told the reminder is set", confirmation.includes("מסיבה"));
  check("and it is stored", store3.pendingReminders().length, 1);
  check(
    "an unknown id is ignored rather than stored",
    server3.recordReminderOptIns(SENDER, ["999"], events),
    ""
  );
  check("nothing extra was stored", store3.pendingReminders().length, 1);
  check("no marker means no confirmation", server3.recordReminderOptIns(SENDER, [], events), "");
  checkTrue(
    "asking again says it is already set",
    server3.recordReminderOptIns(SENDER, ["7"], events).includes("כבר")
  );

  console.log("never twice, and a reply keeps its context");
  // Two requirements from Tom: send only once, and let the user answer.
  fs.unlinkSync(TEST_REMINDERS_FILE);
  delete require.cache[require.resolve("./reminders-store")];
  delete require.cache[require.resolve("./server")];
  const store4 = require("./reminders-store");
  const server4 = require("./server");
  const REPLIER = "whatsapp:+972500000055";
  store4.addReminder({ sender: REPLIER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00" });

  const fired = [];
  const countingDeliver = async (p) => {
    fired.push(p);
    return { ok: true, via: "template", sid: `SM${fired.length}`, status: "delivered" };
  };
  // The tick runs every 5 minutes and the window is a full hour, so the same reminder
  // is examined a dozen times. It must send on exactly one of them.
  for (const minute of ["14:00", "14:05", "14:10", "14:20", "14:40", "14:55"]) {
    await server4.sendDueEventReminders(at(minute), countingDeliver);
  }
  check("a reminder fires once across the whole window", fired.length, 1);

  // Overlapping ticks: delivery polls Twilio for seconds, so a slow send can still be
  // in flight when the next tick begins.
  fs.unlinkSync(TEST_REMINDERS_FILE);
  delete require.cache[require.resolve("./reminders-store")];
  delete require.cache[require.resolve("./server")];
  const store5 = require("./reminders-store");
  const server5 = require("./server");
  store5.addReminder({ sender: REPLIER, eventId: "7", eventName: "מסיבה", eventDate: EVENT_DATE, eventTime: "20:00" });
  const slowFired = [];
  const slowDeliver = async (p) => {
    slowFired.push(p);
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, via: "template", sid: "SM1", status: "delivered" };
  };
  await Promise.all([
    server5.sendDueEventReminders(at("14:05"), slowDeliver),
    server5.sendDueEventReminders(at("14:05"), slowDeliver),
  ]);
  check("overlapping ticks cannot double-send", slowFired.length, 1);

  // The reply. It arrives hours later with no session left, so without this it lands
  // on the main menu — a robotic answer to a thank-you.
  checkTrue("the sender is remembered after a reminder", server5.recentlyReminded.has(REPLIER));
  const warm = await server5.routeMessage(REPLIER, "תודה");
  checkTrue("a thank-you gets a warm reply", warm.includes("בכיף"));
  checkTrue("and the reply names the event", warm.includes("מסיבה"));
  checkTrue("not the menu", !warm.includes("מה תרצו"));
  // Answered once: a later "תודה" has no reminder behind it.
  const secondThanks = await server5.routeMessage(REPLIER, "תודה");
  checkTrue("a second thank-you falls through to the menu", secondThanks.includes("מה תרצו"));

  // A real question must never be swallowed as a pleasantry.
  store5.addReminder({ sender: REPLIER, eventId: "8", eventName: "הופעה", eventDate: EVENT_DATE, eventTime: "23:00" });
  await server5.sendDueEventReminders(at("17:00"), countingDeliver);
  const question = server5.replyToReminder(REPLIER, "תודה אבל מה השעה המדויקת?");
  check("a question containing thanks is not treated as thanks", question, "");

  console.log("the REMINDERS_ENABLED gate");
  // This is what stands between a user and a promise the bot cannot keep while the
  // template is unapproved, so it is tested in both directions.
  const inquiry = require("./answer-inquiry");

  process.env.REMINDERS_ENABLED = "";
  check("unset means off", inquiry.remindersEnabled(), false);
  check("no opt-in is recorded while off", server3.recordReminderOptIns(SENDER, ["8"], events), "");
  checkTrue("and nothing was written", !store3.pendingReminders().some((r) => r.eventId === "8"));

  // A reminder recorded while on must not fire while off - and must survive to fire
  // later, so it is left pending rather than closed out.
  const before = store3.pendingReminders().length;
  const sentWhileOff = [];
  await server3.sendDueEventReminders(at("14:00"), async (p) => {
    sentWhileOff.push(p);
    return { ok: true, via: "text", sid: "SMx", status: "delivered" };
  });
  check("nothing fires while off", sentWhileOff.length, 0);
  check("and pending reminders are untouched", store3.pendingReminders().length, before);

  for (const on of ["1", "true", "yes", "ON"]) {
    process.env.REMINDERS_ENABLED = on;
    check(`"${on}" turns it on`, inquiry.remindersEnabled(), true);
  }
  for (const off of ["0", "false", "no", "", "maybe"]) {
    process.env.REMINDERS_ENABLED = off;
    check(`"${off}" leaves it off`, inquiry.remindersEnabled(), false);
  }
  process.env.REMINDERS_ENABLED = "1";

  console.log("\nthe weekly publisher nudge");
  // The real header: the nudge reads `submitter`, which writeEvents above leaves out.
  const PUBLISHER_A = "whatsapp:+972500000011";
  const PUBLISHER_B = "whatsapp:+972500000012";
  const PUBLISHER_C = "whatsapp:+972500000013";
  const PUBLISHER_D = "whatsapp:+972500000014";
  fs.writeFileSync(TEST_EVENTS_FILE, [
    "id,status,event_name,date,start_time,end_time,location,category,price,organizer,contact_link,description,source,published_at,notes,submitter,flyer",
    `1,published,ערב ג'אז,2026-08-20,20:00,,חיפה,מוזיקה,,,,,,,,${PUBLISHER_A},`,
    `2,published,עוד ערב,2026-08-21,20:00,,חיפה,מוזיקה,,,,,,,,${PUBLISHER_A},`,
    `3,published,שלו,2026-08-22,18:00,,חיפה,סדנה,,,,,,,,${PUBLISHER_B},`,
    // Only ever submitted, rejected, expired: none of these make someone a publisher.
    `6,rejected,סדנה,2026-08-22,18:00,,חיפה,סדנה,,,,,,,,${PUBLISHER_C},`,
    `7,submitted,סדנה,2026-08-22,18:00,,חיפה,סדנה,,,,,,,,${PUBLISHER_C},`,
    `8,expired,סדנה,2026-08-22,18:00,,חיפה,סדנה,,,,,,,,${PUBLISHER_C},`,
    // Published and later cancelled still counts.
    `9,cancelled,בוטל,2026-08-22,18:00,,חיפה,סדנה,,,,,,2026-08-10,,${PUBLISHER_D},`,
    "4,published,של סתיו,2026-08-23,18:00,,חיפה,סדנה,,,,,,,,whatsapp:+972528762432,",
    "5,published,בלי שולח,2026-08-24,18:00,,חיפה,סדנה,,,,,,,,,",
  ].join("\n") + "\n", "utf8");
  if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);
  delete require.cache[require.resolve("./server")];
  const server6 = require("./server");
  const { NUDGE_VARIANTS } = require("./nudge-variants");

  // 2026-08-26 is a Wednesday; Israel is UTC+3, so 18:00 local is 15:00Z.
  const wed = (hhmm, day = 26) => new Date(`2026-08-${day}T${hhmm}:00Z`);
  const nudged = [];
  const wordings = [];
  const recordNudge = async (sender, _lastInbound, variant) => { nudged.push(sender); wordings.push(variant.id); };
  const allApproved = () => true;

  await server6.sendDueWeeklyNudge(wed("14:55"), recordNudge, allApproved);
  check("not before 18:00", nudged.length, 0);
  await server6.sendDueWeeklyNudge(new Date("2026-08-25T15:00:00Z"), recordNudge, allApproved);
  check("not on a Tuesday at 18:00", nudged.length, 0);
  await server6.sendDueWeeklyNudge(wed("15:00"), recordNudge, allApproved);
  check("every publisher once, never Stav, a blank, or a never-published submitter",
    nudged, [PUBLISHER_A, PUBLISHER_B, PUBLISHER_D]);
  check("everyone gets the same wording that week", new Set(wordings).size, 1);
  checkTrue("and it is one of the pool", NUDGE_VARIANTS.some((v) => v.id === wordings[0]));
  await server6.sendDueWeeklyNudge(wed("15:05"), recordNudge, allApproved);
  check("only once per Wednesday", nudged.length, 3);

  delete require.cache[require.resolve("./server")];
  const server7 = require("./server");
  await server7.sendDueWeeklyNudge(wed("15:10"), recordNudge, allApproved);
  check("not again after a restart", nudged.length, 3);
  check("last week's wording survives a restart", server7.lastNudgeVariant, wordings[0]);

  // Ten weeks in a row: never the same wording twice running.
  let previous = wordings[0];
  let repeats = 0;
  const seen = new Set([previous]);
  for (let week = 1; week <= 10; week++) {
    // 18:00 local: UTC+3 until the clocks go back on 2026-10-25, UTC+2 after.
    const day = new Date(Date.UTC(2026, 7, 26 + 7 * week));
    const date = new Date(day.getTime() + (day < new Date("2026-10-25") ? 15 : 16) * 3600_000);
    wordings.length = 0;
    await server7.sendDueWeeklyNudge(date, recordNudge, allApproved);
    check(`week ${week} went out`, wordings.length > 0, true);
    if (wordings[0] === previous) repeats++;
    seen.add(wordings[0]);
    previous = wordings[0];
  }
  check("no wording two weeks running", repeats, 0);
  checkTrue("and the draw actually varies", seen.size > 2);

  // The draw itself, with the randomness pinned.
  const [v1, v2, v3] = NUDGE_VARIANTS;
  const onlyApproved = (...ids) => (v) => ids.includes(v.id);
  check("prefers an approved wording",
    server7.pickNudgeVariant("", onlyApproved(v3.id), () => 0).id, v3.id);
  check("never last week's, even if it is the only approved one",
    server7.pickNudgeVariant(v1.id, onlyApproved(v1.id), () => 0).id, v2.id);
  check("with nothing approved it still draws from the pool",
    server7.pickNudgeVariant(v1.id, () => false, () => 0.999).id, NUDGE_VARIANTS[NUDGE_VARIANTS.length - 1].id);

  const optOut = await server7.routeMessage(PUBLISHER_B, server7.NUDGE_OPTIONS[1].key);
  checkTrue("opting out is confirmed", optOut.includes("הסרנו"));
  check("next week skips whoever opted out",
    server7.nudgeRecipients(require("./make-digest").loadEvents(TEST_EVENTS_FILE)), [PUBLISHER_A, PUBLISHER_D]);
  delete require.cache[require.resolve("./server")];
  check("the opt-out survives a restart", require("./server").nudgeOptOuts.has(PUBLISHER_B), true);

  console.log("the wording pool");
  check("ids are unique", new Set(NUDGE_VARIANTS.map((v) => v.id)).size, NUDGE_VARIANTS.length);
  check("template names are unique", new Set(NUDGE_VARIANTS.map((v) => v.template)).size, NUDGE_VARIANTS.length);
  for (const variant of NUDGE_VARIANTS) {
    check(`${variant.template}'s buttons match the options`,
      require("./send-interactive").templateButtonKeys(variant.template),
      server7.NUDGE_OPTIONS.map((option) => option.key));
    checkTrue(`${variant.template} is a valid template name`, /^[a-z0-9_]+$/.test(variant.template));
    checkTrue(`${variant.id} has text`, variant.text.trim().length > 0);
  }

  for (const file of [TEST_EVENTS_FILE, TEST_REMINDERS_FILE, TEST_STATE_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log("\nall reminder tests passed");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
