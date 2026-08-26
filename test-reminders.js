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
const { windowIsOpen, reminderText } = require("./send-reminder");

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
  const docBody = fs.readFileSync(path.join(__dirname, "reminder-template.md"), "utf8")
    .match(/```\n(היי![^\n]*)\n```/);
  checkTrue("the submission doc still carries the body", Boolean(docBody));
  check(
    "and it matches what the code sends",
    docBody[1].replace("{{1}}", "מסיבת גג").replace("{{2}}", "20:00"),
    sentence
  );
  // The repo's guard: a variation selector makes an emoji vanish on some clients.
  checkTrue(
    "no emoji carries a variation selector",
    !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}/u.test(docBody[1])
  );
  // Meta rejects a body that is only parameters.
  checkTrue(
    "the body has literal text around its variables",
    docBody[1].replace(/\{\{\d\}\}/g, "").trim().length > 10
  );

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
  const events = [
    { id: "7", event_name: "מסיבה", date: EVENT_DATE, start_time: "20:00" },
    { id: "8", event_name: "הופעה", date: EVENT_DATE, start_time: "23:00" },
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
