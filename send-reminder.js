// Delivering a reminder, which is harder than it looks.
//
// A reminder fires 2-3h before an event, but the user opted in whenever they last
// asked about events - often days earlier. WhatsApp only permits free-form messages
// within 24h of the recipient's last INBOUND message, so by the time a reminder is due
// that window is usually closed. Outside it, Twilio accepts the API call, returns a
// SID, and then silently drops the message with error 63016. A resolved promise is not
// delivery. Three weekly boards were lost exactly this way (server.js, 16-23 Aug 2026).
//
// So there are two send paths, chosen by whether the window is provably open:
//
//   open   -> free text, which reads naturally and needs no Meta approval
//   closed -> an approved Content template, the only thing Meta will deliver
//
// And crucially: when the window is closed and no template is approved, this does NOT
// fall back to text the way sendChoice does. That fallback is right for a question
// asked mid-conversation and wrong here - it would send something Twilio accepts and
// never delivers, which is the exact failure this module exists to prevent. It reports
// a failure instead, so the reminder is surfaced rather than silently lost.
const { sendWhatsApp, getMessageStatus, postForm } = require("./send-whatsapp");
const { approvedTemplateSid, ensureTemplates, buildVariables } = require("./send-interactive");

// Meta's rule, and the reason this module exists.
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Leave room for clock skew and for the minutes between deciding to send and Twilio
// processing it. A message that races the window boundary is treated as outside.
const WINDOW_SAFETY_MS = 15 * 60 * 1000;

const WHATSAPP_OUTSIDE_WINDOW_ERROR = 63016;
const UNDELIVERED_STATUSES = new Set(["undelivered", "failed"]);

// The template that carries a reminder when the window is closed.
//
// Body, as submitted to Meta - literal text around every variable, because a body that
// is only a parameter is rejected ("only have parameters"):
//
//   היי! 👋 עוד קצת ומתחיל {{1}}, ב-{{2}}. תהנו! 🎈
//
// Two variables only. Location is not one of them: it arrives as a full address, so
// it makes the sentence long, and fewer variables is a safer approval shape. No buttons:
// button titles cannot contain variables, and a reminder has nothing to ask - adding
// buttons would only risk rejection and pin sendChoice's fixed-key matching to it.
// Two approved templates, tried in order, because the category matters more than the
// wording. Meta re-categorised the friendly version as MARKETING despite the request
// for UTILITY: the greeting and sign-off that make it warm are the same things that
// make it read as a promotion. Marketing messages are throttled, count against a
// recipient's marketing limits, and are suppressed outright for anyone who opted out
// of marketing - so a reminder sent as Marketing can silently never arrive, which is
// precisely what this module exists to prevent.
//
// v3 is the transactional rewrite, submitted as UTILITY with category change refused:
//
//   ביקשת תזכורת ל{{1}}. האירוע מתחיל היום בשעה {{2}}, נתראה.
//   "You asked for a reminder for {{1}}. The event starts today at {{2}}, see you."
//
// v2 was the same idea but ended "...ב-{{2}}." and was rejected: a variable may not
// sit at the start or end of a body, and a trailing period does not count as text.
// Hence the closing clause after the last variable - it is load-bearing, not styling.
//
// v3 is preferred when approved. The friendly one stays as a fallback because a
// throttled reminder still beats no reminder, and it is already approved.
const REMINDER_TEMPLATES = ["fomo_event_reminder_v3", "fomo_event_reminder"];
// Kept for the admin failure notice and for tests, which name the template directly.
const REMINDER_TEMPLATE = REMINDER_TEMPLATES[0];

// The first of the two that Meta has actually approved, or "" if neither is.
function reminderTemplateSid() {
  for (const name of REMINDER_TEMPLATES) {
    const sid = approvedTemplateSid(name);
    if (sid) return { sid, name };
  }
  return { sid: "", name: "" };
}

// Was this recipient's 24h window open at `now`?
//
// lastActivity is the server's record of each sender's last inbound message, which is
// exactly what Meta measures the window from. Unknown counts as closed: assuming open
// is the failure mode that loses messages silently.
function windowIsOpen(lastInboundMs, now = Date.now()) {
  if (!lastInboundMs) return false;
  return now - lastInboundMs < WINDOW_MS - WINDOW_SAFETY_MS;
}

// The free-text path, worded identically to the template above so a user cannot tell
// which one they got. Location is deliberately absent from both: it arrives as a full
// address, which makes the sentence long, and the user already has it from the
// conversation where they opted in.
function reminderText({ eventName, startTime }) {
  return `היי! 👋 עוד קצת ומתחיל ${eventName}, ב-${startTime}. תהנו! 🎈`;
}

// Sends and then verifies, because accepted is not delivered. Returns a plain result
// rather than throwing, so one user's failed reminder never stops the rest of the run.
// `location` is accepted and ignored: the caller passes the whole event, and dropping
// the field here rather than at the call site keeps that side unchanged if the wording
// ever wants the address back.
async function deliverReminder({ to, eventName, startTime, lastInboundMs = 0, now = Date.now() }) {
  const open = windowIsOpen(lastInboundMs, now);

  let result;
  let via;
  try {
    if (open) {
      via = "text";
      result = await sendWhatsApp(to, reminderText({ eventName, startTime }));
    } else {
      via = "template";
      await ensureTemplates();
      const { sid, name } = reminderTemplateSid();
      if (name) via = `template:${name}`;
      if (!sid) {
        // Deliberately not falling back to text: see the header. Text here would be
        // accepted and dropped, and the user was promised this message.
        return {
          ok: false,
          via,
          reason: "no-template",
          detail: `neither ${REMINDER_TEMPLATES.join(" nor ")} is approved, and the 24h window is closed`,
        };
      }
      result = await postForm({
        To: to,
        ContentSid: sid,
        ContentVariables: buildVariables({ 1: eventName, 2: startTime }),
      });
    }
  } catch (err) {
    return { ok: false, via, reason: "send-failed", detail: err.message };
  }

  const sid = result && result.sid;
  if (!sid) return { ok: false, via, reason: "no-sid", detail: "Twilio returned no message sid" };

  // Polling takes several seconds, so callers run this detached from any webhook reply.
  try {
    const status = await getMessageStatus(sid);
    const outsideWindow = Number(status.error_code) === WHATSAPP_OUTSIDE_WINDOW_ERROR;
    if (UNDELIVERED_STATUSES.has(status.status) || outsideWindow) {
      return {
        ok: false,
        via,
        sid,
        reason: outsideWindow ? "outside-window" : "undelivered",
        detail: `status=${status.status} error=${status.error_code}`,
      };
    }
    return { ok: true, via, sid, status: status.status };
  } catch (err) {
    // Could not verify. Reported as unverified rather than ok, so it is never
    // recorded as delivered on the strength of a promise that merely resolved.
    return { ok: false, via, sid, reason: "unverified", detail: err.message };
  }
}

module.exports = {
  REMINDER_TEMPLATE,
  REMINDER_TEMPLATES,
  reminderTemplateSid,
  WINDOW_MS,
  WINDOW_SAFETY_MS,
  windowIsOpen,
  reminderText,
  deliverReminder,
};
