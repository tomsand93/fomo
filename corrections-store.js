const fs = require("fs");
const path = require("path");

// Admin corrections are the only signal we get about what the extractor gets wrong.
// They're stored verbatim and replayed into later extraction prompts as worked examples,
// which is as close to "learning" as a stateless model gets: the model doesn't change,
// but the instructions it sees accumulate real cases it previously fumbled.

const MAX_CORRECTIONS = 100; // keep the prompt bounded; oldest fall off first
const MAX_SNIPPET_LENGTH = 200;

function correctionsPath(eventsFile) {
  return path.join(path.dirname(path.resolve(eventsFile)), "corrections.json");
}

function loadCorrections(eventsFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(correctionsPath(eventsFile), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    if (err.code !== "ENOENT") console.error("failed to load corrections:", err);
    return [];
  }
}

function saveCorrections(eventsFile, corrections) {
  const file = correctionsPath(eventsFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(corrections, null, 2), "utf8");
  } catch (err) {
    console.error("failed to save corrections:", err);
  }
}

function addCorrection(eventsFile, { field, wrongValue, rightValue, sourceText }) {
  const corrections = loadCorrections(eventsFile);
  corrections.push({
    field,
    wrongValue: String(wrongValue || "").slice(0, MAX_SNIPPET_LENGTH),
    rightValue: String(rightValue || "").slice(0, MAX_SNIPPET_LENGTH),
    sourceText: String(sourceText || "").slice(0, MAX_SNIPPET_LENGTH),
    correctedAt: new Date().toISOString().slice(0, 10),
  });
  const trimmed = corrections.slice(-MAX_CORRECTIONS);
  saveCorrections(eventsFile, trimmed);
  return trimmed.length;
}

// Only the most recent corrections per field are worth showing: repeated mistakes in the
// same field are what we most want to suppress, and a bounded list keeps prompts small.
function buildCorrectionGuidance(eventsFile, maxExamples = 8) {
  const corrections = loadCorrections(eventsFile);
  if (!corrections.length) return "";

  const byField = new Map();
  for (const correction of corrections) {
    if (!byField.has(correction.field)) byField.set(correction.field, []);
    byField.get(correction.field).push(correction);
  }

  const selected = [];
  for (const entries of byField.values()) {
    selected.push(...entries.slice(-2)); // two most recent per field
  }
  const examples = selected.slice(-maxExamples);
  if (!examples.length) return "";

  const lines = examples.map((c) => {
    const wrong = c.wrongValue || '(ריק)';
    const right = c.rightValue || '(ריק)';
    const from = c.sourceText ? ` — מתוך: "${c.sourceText}"` : "";
    return `- שדה ${c.field}: חולץ "${wrong}" אך הנכון הוא "${right}"${from}`;
  });

  return `\nתיקונים קודמים של מנהלת המערכת (למד מהם ואל תחזור על אותן טעויות):\n${lines.join("\n")}\n`;
}

module.exports = {
  addCorrection,
  loadCorrections,
  buildCorrectionGuidance,
  correctionsPath,
};
