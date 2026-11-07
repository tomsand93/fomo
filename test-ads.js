const assert = require("assert");
const { formatShort, formatLong } = require("./format-event");
const { makeBoard, digestEvents } = require("./make-digest");
const wine = { status: "published", event_name: "ערב יין", date: "2026-11-07", start_time: "20:00",
  location: "לוי'ס, שמריהו לוין 10", category: "אוכל ויין", price: "60 ₪", description: "טעימות", slug: "w" };
const linkFor = () => "https://x/e/w";

// short: three lines, bold head, no category
assert.deepStrictEqual(formatShort(wine, { linkFor }).split("\n"),
  ["🍷 *20:00 · ערב יין*", "📍 לוי'ס, שמריהו לוין 10 · 🎫 60 ₪", "🔗 https://x/e/w"]);
// missing location, price and link: head only
assert.strictEqual(formatShort({ ...wine, location: "", price: "" }, {}).split("\n").length, 1);
// long: bold name, and the date line it is given
const long = formatLong(wine, { linkFor, dateLine: "*מחר!* יום שבת 7.11" }).text;
assert.ok(long.startsWith("🍷 *ערב יין* · אוכל ויין"));
assert.ok(long.includes("📅 *מחר!* יום שבת 7.11"));
// board: today only, ignores daily_days, bold title, today link third
const other = { ...wine, event_name: "מחר", date: "2026-11-08", daily_days: "2026-11-07" };
const board = makeBoard([wine, other], "2026-11-07", { linkFor, todayUrl: "https://x/today" });
const lines = board.split("\n");
assert.ok(lines[0].startsWith("*מה עושים היום בחיפה?*"));
assert.ok(lines[1].startsWith("*") && lines[1].includes("7.11"));
assert.strictEqual(lines[2], "https://x/today");
assert.ok(!board.includes("מחר"));
assert.ok(!board.includes("/m/"));
assert.strictEqual(makeBoard([], "2026-11-07", {}), "");
assert.strictEqual(digestEvents([other], "2026-11-07").length, 0);
const { availableWindows, adDateLine, windowPhrase } = require("./ad-windows");
const at = (date, hour, minute = 0) => ({ date, hour, minute, day: new Date(`${date}T12:00:00Z`).getUTCDay() });
const keys = (list) => list.map((w) => `${w.date}:${w.key}`);
const ev = (date, start_time, extra = {}) => ({ date, start_time, ...extra });

assert.deepStrictEqual(keys(availableWindows(ev("2026-11-07", "20:00"), at("2026-11-05", 14, 30))), [
  "2026-11-05:evening", "2026-11-06:morning", "2026-11-06:evening", "2026-11-07:morning", "2026-11-07:evening"]);
// the 21:01 case
assert.deepStrictEqual(availableWindows(ev("2026-11-05", "22:00"), at("2026-11-05", 21, 1)), []);
// a window opening exactly at the start time does not count; 18:30 does
assert.deepStrictEqual(keys(availableWindows(ev("2026-11-05", "18:00"), at("2026-11-05", 9))), ["2026-11-05:morning"]);
assert.strictEqual(availableWindows(ev("2026-11-05", "18:30"), at("2026-11-05", 9)).length, 2);
// open now: from the handoff until the end
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 18, 40))[0].openNow, true);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 9, 55))[0].openNow, true);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 9, 49))[0].openNow, false);
assert.strictEqual(availableWindows(ev("2026-11-06", "21:00"), at("2026-11-05", 13, 0))[0].key, "evening");
// multi-day runs to the last day; no start time means no windows
assert.ok(keys(availableWindows(ev("2026-11-05", "20:00", { end_date: "2026-11-07" }), at("2026-11-06", 12))).includes("2026-11-07:evening"));
assert.deepStrictEqual(availableWindows(ev("2026-11-07", ""), at("2026-11-05", 9)), []);

const sat = ev("2026-11-07", "20:00");
assert.strictEqual(adDateLine(ev("2026-11-05", "19:00"), "2026-11-05", "evening"), "*הערב!*");
assert.strictEqual(adDateLine(ev("2026-11-05", "19:00"), "2026-11-05", "morning"), "*הערב!*");
assert.strictEqual(adDateLine(ev("2026-11-05", "12:00"), "2026-11-05", "morning"), "*היום!*");
assert.ok(adDateLine(sat, "2026-11-06", "evening").startsWith("*מחר!* "));
assert.ok(adDateLine(sat, "2026-11-05", "evening").startsWith("*יום"));
assert.strictEqual(adDateLine(ev("2026-11-05", "20:00", { end_date: "2026-11-07" }), "2026-11-06", "evening"), "*הערב!*");

assert.strictEqual(windowPhrase({ date: "2026-11-05", key: "evening" }, "2026-11-05"), "היום בערב");
assert.strictEqual(windowPhrase({ date: "2026-11-06", key: "morning" }, "2026-11-05"), "מחר בבוקר");
assert.ok(windowPhrase({ date: "2026-11-07", key: "evening" }, "2026-11-05").endsWith("בערב"));
console.log("ad tests passed");
