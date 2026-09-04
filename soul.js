// Loads the one shared voice/purpose excerpt from soul.md, so extract-event.js,
// answer-inquiry.js, and classify-intent.js all build on the same definition of who
// FOMO is, instead of three independently-written framings that could quietly drift.
//
// soul.md is prose for a human to read and edit; this pulls out only the blockquote
// under "The excerpt every prompt shares" — the rest of the file (purpose, boundaries,
// language notes) is context for a maintainer, not text sent to the model.
const fs = require("fs");
const path = require("path");

const SOUL_PATH = path.join(__dirname, "soul.md");

function loadSoulCore() {
  const raw = fs.readFileSync(SOUL_PATH, "utf8");
  const match = raw.match(/## The excerpt every prompt shares[^\n]*\n\n>([^\n]+)/);
  if (!match) {
    throw new Error("soul.js: could not find the shared excerpt block in soul.md — did its heading or blockquote format change?");
  }
  // The blockquote is one wrapped paragraph, each line prefixed with "> ". Strip the
  // markers and rejoin as a single sentence-flow paragraph.
  const lines = raw.slice(raw.indexOf(match[0])).split("\n");
  const quoted = [];
  for (const line of lines) {
    if (line.startsWith(">")) quoted.push(line.replace(/^>\s?/, ""));
    else if (quoted.length) break;
  }
  return quoted.join(" ").trim();
}

// Read once at module load. soul.md changing requires a restart to take effect, same as
// every other prompt-building constant in this codebase — none of them are hot-reloaded.
const SOUL_CORE = loadSoulCore();

module.exports = { SOUL_CORE };
