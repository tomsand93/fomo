// One event, two renderings.
//
// The board and the daily message used to build their own lines from their own copy
// of the icon map, which drifted. Both now come from here, so a change to how an
// event reads happens once.
//
//   SHORT - the rolling board. One glance per event, 1-2 lines.
//   LONG  - the daily message. The full pitch, 5-7 lines plus the flyer as media.
const { shortDate } = require("./clock");

const CATEGORY_ICONS = {
  "קולנוע": "🎬",
  "אוכל ויין": "🍷",
  "מסיבה": "🎧",
  "קריוקי": "🎤",
  "מוזיקה חיה": "🎸",
  "מוזיקה": "🎸",
};
const DEFAULT_ICON = "🎈";

// The two entrance emojis. Free needs no words; a price does.
const FREE_ICON = "🆓";
const PAID_ICON = "🎟️";

// Matches how submitters actually write "free" — moved here byte-identical from
// server.js, because each alternative was added for a real submission.
const FREE_ENTRY_RE = /(כניסה\s*(חופשית|חינם|ללא\s*תשלום|ללא\s*עלות)|חופשית|חינם|ללא\s*תשלום|ללא\s*עלות|הופעת\s*כובע|תרומה\s*חופשית|free\s*(entry|admission)?)/i;

function isFreeEntry(event) {
  return FREE_ENTRY_RE.test(String(event.price || ""));
}

function iconFor(event) {
  return CATEGORY_ICONS[event.category] || DEFAULT_ICON;
}

// Three states, not two: free, priced, and unknown. An event with no stated price
// renders no entrance line at all — inferring "free" from silence would put a
// factual error in front of the whole group, and the submitter is the only one who
// knows the answer.
function entranceLabel(event) {
  if (isFreeEntry(event)) return `${FREE_ICON} כניסה חופשית`;
  if (event.price) return `${PAID_ICON} ${event.price}`;
  return "";
}

// Compact form for SHORT, where the line is already carrying location and a link.
function entranceBadge(event) {
  if (isFreeEntry(event)) return FREE_ICON;
  if (event.price) return `${PAID_ICON} ${event.price}`;
  return "";
}

// The extractor sometimes echoes the raw submission into description; that guard
// predates this module and is kept because it still fires.
function usableDescription(event, limit = 200) {
  const text = (event.description || "").trim();
  if (!text || text.includes("שם האירוע:")) return "";
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// linkFor is injected so the caller decides whether an event shows its raw
// contact_link or a tracked short link, without this module knowing about either.
function defaultLinkFor(event) {
  return event.contact_link || "";
}

// SHORT: name and time on line one, everything else on an indented second line.
// Both lines are assembled from whatever exists — an event missing location, price
// and link is still a valid one-line entry.
function formatShort(event, { linkFor = defaultLinkFor } = {}) {
  const head = [`${iconFor(event)} ${event.start_time} ${event.event_name}`];
  if (event.category) head.push(`· ${event.category}`);

  const details = [];
  if (event.location) details.push(`📍 ${event.location}`);
  const badge = entranceBadge(event);
  if (badge) details.push(badge);
  const link = linkFor(event);
  if (link) details.push(link);

  const lines = [head.join(" ")];
  if (details.length) lines.push(`   ${details.join(" · ")}`);
  return lines.join("\n");
}

// LONG: the full pitch. Returns the flyer separately rather than as a text line —
// Twilio carries it as MediaUrl on the same message, so the caller never has to
// re-derive it.
//
// No date line: both the daily message and the weekly board carry the date in a
// heading above the event, so repeating it per event was noise. `withDate` puts it
// back for the one case that has no heading — a single event forwarded on its own,
// where dropping it would lose the date entirely.
//
// Time and entrance share a line: they are the two things someone checks together
// when deciding whether they can go.
function formatLong(event, { linkFor = defaultLinkFor, flyerUrl = () => "", withDate = false } = {}) {
  const head = [`${iconFor(event)} ${event.event_name}`];
  if (event.category) head.push(`· ${event.category}`);

  const when = [];
  if (withDate && event.date) when.push(`📅 ${shortDate(event.date)}`);
  if (event.start_time) {
    when.push(`🕗 ${event.start_time}${event.end_time ? `-${event.end_time}` : ""}`);
  }
  const entrance = entranceLabel(event);
  if (entrance) when.push(entrance);

  const description = usableDescription(event);
  const link = linkFor(event);

  const lines = [
    head.join(" "),
    when.length ? when.join(" · ") : "",
    event.location ? `📍 ${event.location}` : "",
    description,
    event.contact_person ? `👤 ${event.contact_person}` : "",
    link ? `🔗 ${link}` : "",
  ].filter(Boolean);

  return { text: lines.join("\n"), mediaUrl: flyerUrl(event) || "" };
}

module.exports = {
  CATEGORY_ICONS,
  DEFAULT_ICON,
  FREE_ICON,
  PAID_ICON,
  FREE_ENTRY_RE,
  isFreeEntry,
  iconFor,
  entranceLabel,
  entranceBadge,
  usableDescription,
  formatShort,
  formatLong,
};
