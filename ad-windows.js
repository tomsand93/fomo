const { addDays, longDate } = require("./clock");
const { runsOn } = require("./events-store");

// The two slots an ad can be booked into. The ad is handed to Stav ten minutes before
// the window opens (sendHour:sendMinute) so it is in her hands when the window starts.
const AD_WINDOWS = [
  { key: "morning", label: "בוקר", start: "10:00", end: "13:00", sendHour: 9, sendMinute: 50 },
  { key: "evening", label: "ערב", start: "18:00", end: "21:00", sendHour: 17, sendMinute: 50 },
];

const pad = (n) => String(n).padStart(2, "0");

// Windows an event can still be offered, in time order. A window counts when it has not
// ended and max(window start, now) is before the event starts - no margin. A multi-day
// event is measured against its start time on its last day.
function availableWindows(event, local) {
  if (!event || !event.date || !/^\d{1,2}:\d{2}$/.test(String(event.start_time || ""))) return [];
  const [h, m] = event.start_time.split(":");
  const last = event.end_date && event.end_date > event.date ? event.end_date : event.date;
  const eventStart = `${last} ${pad(h)}:${m}`;
  const now = `${local.date} ${pad(local.hour)}:${pad(local.minute)}`;
  const out = [];
  for (let date = local.date; date <= last; date = addDays(date, 1)) {
    for (const w of AD_WINDOWS) {
      const start = `${date} ${w.start}`;
      const end = `${date} ${w.end}`;
      if (end <= now) continue;
      if (!((start > now ? start : now) < eventStart)) continue;
      const handoff = `${date} ${pad(w.sendHour)}:${pad(w.sendMinute)}`;
      out.push({ date, key: w.key, label: w.label, start: w.start, end: w.end, openNow: now >= handoff && now < end });
    }
  }
  return out;
}

// The bold date line of an ad posted on postDate. Same day (or a running multi-day
// event) reads as today/tonight depending on the start time; the day before reads
// "tomorrow"; anything further out carries the full date.
function adDateLine(event, postDate, windowKey) {
  if (runsOn(event, postDate)) {
    return windowKey === "evening" || event.start_time >= "17:00" ? "*הערב!*" : "*היום!*";
  }
  if (addDays(postDate, 1) === event.date) return `*מחר!* ${longDate(event.date)}`;
  return `*${longDate(event.date)}*`;
}

// "היום בערב", "מחר בבוקר", or "יום שבת 7.11 בערב" - how a window is named to the organiser.
function windowPhrase(window, today) {
  const when = window.date === today ? "היום" : window.date === addDays(today, 1) ? "מחר" : longDate(window.date);
  return `${when} ${window.key === "morning" ? "בבוקר" : "בערב"}`;
}

module.exports = { AD_WINDOWS, availableWindows, adDateLine, windowPhrase };
