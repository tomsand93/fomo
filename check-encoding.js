// Guard against the 2026-08-26 corruption: a scripted rewrite of server.js read the
// file as Latin-1 and silently turned all 3018 Hebrew characters into mojibake. Any
// file that carries Hebrew copy is checked here, so damage surfaces on the next test
// run rather than in production Hebrew nobody on the team can proofread.
const fs = require("fs");

const FILES = ["server.js", "classify-intent.js", "extract-event.js", "answer-inquiry.js"];
const MOJIBAKE = /[\u00C2-\u00DF][\u0080-\u00BF]/g;
const HEBREW = /[\u0590-\u05FF]/g;

let failed = false;
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  const mojibake = (text.match(MOJIBAKE) || []).length;
  const hebrew = (text.match(HEBREW) || []).length;
  if (mojibake) {
    console.error(`${file}: ${mojibake} mojibake sequences — Hebrew was corrupted`);
    failed = true;
  }
  if (text.includes("\uFFFD")) {
    console.error(`${file}: contains U+FFFD replacement characters`);
    failed = true;
  }
  console.log(`${file}: ${hebrew} Hebrew chars, ${mojibake} mojibake`);
}
if (failed) process.exit(1);
