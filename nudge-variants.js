// The weekly publisher nudge: the pool of wordings, and the buttons every one shares.
//
// Read by server.js (what is sent), send-interactive.js (which buttons each template
// carries) and submit-nudge-template.js (what is submitted to Meta), so the three can
// never drift apart.
//
// Each Wednesday one wording is drawn at random, never last week's. Most publishers
// have not written in 24h by then, so a wording only reaches them once its template is
// approved by Meta; until then it goes out only to the few whose window is open.
//
// To change the pool:
//   - add:    append an entry with a new `id` and a new `template`, then run
//             `node submit-nudge-template.js` to submit it.
//   - remove: delete the entry. Its template can stay in Twilio; nothing sends it.
//   - edit:   change `text` AND give it a new `template` name (e.g. add _v2), then
//             submit. An approved template's body is fixed, so the old name would keep
//             sending the old words.
// `id` is what the state file remembers as "last week's", so keep it stable across edits.

const NUDGE_OPT_OUT_KEY = "הסר";

// "2" is the main menu's "publish an event", so a tap starts a submission exactly as
// typing it would. The opt-out is a button too: a weekly unsolicited message has to be
// one tap away from stopping.
const NUDGE_OPTIONS = [
  { key: "2", label: "יש לי אירוע לפרסם" },
  { key: NUDGE_OPT_OUT_KEY, label: "להסיר אותי" },
];

const NUDGE_VARIANTS = [
  {
    id: "worth",
    template: "fomo_nudge_worth",
    text: "יש לכם אירוע שווה? שלחו לנו אותו, ואנחנו נדאג שיגיע לאנשים הנכונים. ✨",
  },
  {
    id: "dont_keep",
    template: "fomo_nudge_dont_keep",
    text: "משהו טוב קורה בעיר? אל תשמרו את זה לעצמכם. שלחו לנו את האירוע. 🪩",
  },
  {
    id: "hard_to_define",
    template: "fomo_nudge_hard_to_define",
    text: "מסיבה, הופעה, תערוכה או משהו שקשה להגדיר? אנחנו בעניין. שלחו לנו. 👀",
  },
  {
    id: "tell_us",
    template: "fomo_nudge_tell_us",
    text: "אתם עושים משהו שווה בחיפה? אנחנו רוצים לשמוע על זה. 💌",
  },
  {
    id: "friends_group",
    template: "fomo_nudge_friends_group",
    text: "יש אירוע שחייב לצאת מהקבוצה של החברים? שלחו לנו אותו.",
  },
  {
    id: "spread_word",
    template: "fomo_nudge_spread_word",
    text: "קורה משהו מעניין בחיפה? תנו לנו להפיץ את הבשורה. ✨",
  },
];

module.exports = { NUDGE_OPT_OUT_KEY, NUDGE_OPTIONS, NUDGE_VARIANTS };
