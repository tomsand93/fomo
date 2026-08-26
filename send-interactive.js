// Buttons when WhatsApp will render them, a numbered list when it won't.
//
// Quick replies need an approved Content template, and approval is Meta's to grant on
// their own schedule. So nothing here is allowed to depend on one existing: every
// choice falls back to the same numbered text the bot has always sent, and a template
// turning up later changes how a message looks without changing how it works.
//
// The other half is inbound. A tap arrives as ButtonPayload rather than Body, so each
// button's id is set to the option's key — the same "1", "2", "3" a person would type.
// Downstream, a tap and a typed digit are the same message.
const https = require("https");
// Referenced through the module rather than destructured, so a test can replace
// postForm without this module holding a stale binding to the original.
const sendWhatsAppModule = require("./send-whatsapp");

const CONTENT_HOST = "content.twilio.com";
// WhatsApp renders at most three quick-reply buttons; more than that has to be a list.
const MAX_QUICK_REPLY_BUTTONS = 3;
const TEMPLATE_REFRESH_MS = 60 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function contentGet(path) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: CONTENT_HOST, path, headers: { Authorization: `Basic ${auth}` } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`content api ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("content api timed out")));
  });
}

// name -> sid, for templates Meta has actually approved. Anything unsubmitted,
// pending or rejected is deliberately absent, so approvedTemplateSid returns nothing
// and the caller falls back to text.
let approvedTemplates = new Map();
let lastRefresh = 0;
let refreshing = null;

async function refreshTemplates() {
  const listing = await contentGet("/v1/Content?PageSize=50");
  const next = new Map();

  for (const content of listing.contents || []) {
    try {
      const approvals = await contentGet(`/v1/Content/${content.sid}/ApprovalRequests`);
      if (approvals.whatsapp && approvals.whatsapp.status === "approved") {
        next.set(content.friendly_name, content.sid);
      }
    } catch (err) {
      // One template's approval lookup failing must not hide the others.
      console.error(`failed to read approval for ${content.friendly_name}:`, err.message);
    }
  }

  approvedTemplates = next;
  lastRefresh = Date.now();
  return approvedTemplates;
}

// Refreshed at most hourly, and never more than once at a time. A failure leaves the
// previous map in place rather than emptying it, so a blip in the API does not turn
// every button back into text.
function ensureTemplates() {
  if (Date.now() - lastRefresh < TEMPLATE_REFRESH_MS) return Promise.resolve(approvedTemplates);
  if (refreshing) return refreshing;
  refreshing = refreshTemplates()
    .catch((err) => {
      console.error("failed to refresh content templates:", err.message);
      return approvedTemplates;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

function approvedTemplateSid(name) {
  return approvedTemplates.get(name) || "";
}

// What each approved template's buttons actually send back, in order. Buttons are fixed
// when Meta approves a template, so a template can only be used when the caller's
// options line up with it exactly — otherwise the person taps "day before" and the bot
// reads it as something else entirely. Kept here beside the send so the two cannot
// drift apart silently.
const TEMPLATE_BUTTON_KEYS = new Map([
  ["fomo_publish_day_v2", ["1", "2", "3"]],
  ["fomo_publish_day", ["1", "2", "3"]],
  ["fomo_main_menu", ["1", "2", "4"]],
  ["fomo_review_event", ["אשר", "דחה", "ממתינים"]],
]);

function templateButtonKeys(name) {
  return TEMPLATE_BUTTON_KEYS.get(name) || [];
}

// The fallback, and the thing every test compares against: one numbered line per
// option, in the same order the buttons would appear.
function renderNumbered(text, options) {
  const list = options.map((option) => `${option.key}. ${option.label}`).join("\n");
  return list ? `${text}\n\n${list}` : text;
}

// Twilio substitutes {{1}}, {{2}}... positionally.
//
// The caller supplies these, because only the caller knows what its template's body
// says. An earlier version derived them here — passing the whole question as {{1}} and
// each option label after it — which assumed a body of bare "{{1}}". Meta rejects that
// shape ("only have parameters"), so every approved template has literal text with the
// variables standing for values inside it, and the derived version produced sentences
// nested inside themselves.
function buildVariables(variables = {}) {
  return JSON.stringify(variables);
}

async function sendContentTemplate(to, contentSid, variables) {
  return sendWhatsAppModule.postForm({
    To: to,
    ContentSid: contentSid,
    ContentVariables: variables,
  });
}

// A choice, however it ends up being rendered. `template` names a Content template;
// when it is missing, unapproved, or the send fails, the caller still gets a numbered
// list rather than an error.
// `variables` are the template's own {{1}}, {{2}}... values — the caller knows what its
// body says, so it supplies them. `text` is only ever the fallback wording, which is why
// the two are separate: the template renders its own sentence, the fallback renders the
// full question plus a numbered list.
async function sendChoice(to, { text, options = [], template = "", variables = {} }) {
  const numbered = renderNumbered(text, options);
  if (!template || !options.length) return sendWhatsAppText(to, numbered);

  // A template's buttons are fixed at approval time, so it can only be used when the
  // options match it exactly. A shorter list (dates already past) or a longer one would
  // show the wrong choices, and the numbered fallback is correct in every case.
  const buttons = templateButtonKeys(template);
  const matches = buttons.length === options.length
    && buttons.every((key, i) => key === options[i].key);
  if (options.length > MAX_QUICK_REPLY_BUTTONS || !matches) {
    return sendWhatsAppText(to, numbered);
  }

  try {
    await ensureTemplates();
    const sid = approvedTemplateSid(template);
    if (!sid) return sendWhatsAppText(to, numbered);
    return await sendContentTemplate(to, sid, buildVariables(variables));
  } catch (err) {
    const wanted = template;
    // Never lose a message to a template problem.
    console.error(`content send failed for ${wanted}, falling back to text:`, err.message);
    return sendWhatsAppText(to, numbered);
  }
}

function sendWhatsAppText(to, body) {
  return sendWhatsAppModule.postForm({ To: to, Body: body });
}

module.exports = {
  sendChoice,
  renderNumbered,
  buildVariables,
  approvedTemplateSid,
  templateButtonKeys,
  TEMPLATE_BUTTON_KEYS,
  refreshTemplates,
  ensureTemplates,
  MAX_QUICK_REPLY_BUTTONS,
  // Test seam: lets the suite pretend a template is approved without touching Twilio.
  _setApprovedTemplates(map) { approvedTemplates = map; lastRefresh = Date.now(); },
};
