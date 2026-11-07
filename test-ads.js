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
console.log("ad tests passed");
