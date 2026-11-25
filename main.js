'use strict';
/*
 * Obsidian Mac Agenda — a calm day view for Obsidian on macOS.
 * Shows the day's Apple Calendar events and Apple Reminders next to a
 * dedicated daily note. Reminders can be ticked off; nothing else is written
 * back to Calendar or Reminders.
 *
 * Plain CommonJS, no build step needed.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, normalizePath, moment, Platform, setIcon } = obsidian;

const VIEW_TYPE = 'mac-agenda-view';
const DAY_MS = 86400000;

const DEFAULT_SETTINGS = {
  // Daily notes
  useCoreDailyNotes: true,
  folder: 'Daily',
  format: 'YYYY-MM-DD',
  template: '',
  openNoteOnNavigate: true,
  createNoteOnNavigate: false,
  openOnStartup: true,
  // Data source: 'eventkit' (fast helper app) or 'applescript' (slow fallback)
  dataSource: 'eventkit',
  // Agenda
  weekStart: 1, // 0 = Sunday, 1 = Monday
  showOverdueToday: true,
  showUndatedToday: false,
  showCompleted: true,
  dimPastEvents: true,
  refreshMinutes: 5,
  eventsPastDays: 30,
  eventsFutureDays: 90,
  completedLookbackDays: 7,
  // Sources (names that should be hidden; new calendars/lists show by default)
  hiddenCalendars: [],
  hiddenLists: [],
  knownCalendars: [],
  knownLists: [],
};

/* ------------------------------------------------------------------ */
/* Recurrence (RRULE) expansion                                        */
/* ------------------------------------------------------------------ */

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseICalDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v || '');
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  if (m[7]) return Date.UTC(y, mo, d, +m[4], +m[5], +m[6]);
  if (m[4] !== undefined) return new Date(y, mo, d, +m[4], +m[5], +m[6]).getTime();
  return new Date(y, mo, d, 23, 59, 59).getTime(); // date-only UNTIL is inclusive
}

function parseRRule(str) {
  const raw = {};
  String(str || '').replace(/^RRULE:/i, '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) raw[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  });
  const list = (v) => (v ? v.split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x)) : null);
  return {
    freq: (raw.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(raw.INTERVAL || '1', 10) || 1),
    count: raw.COUNT ? parseInt(raw.COUNT, 10) : null,
    until: raw.UNTIL ? parseICalDate(raw.UNTIL) : null,
    byday: raw.BYDAY
      ? raw.BYDAY.split(',').map((x) => {
          const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(x.trim());
          return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2].toUpperCase()] } : null;
        }).filter(Boolean)
      : null,
    bymonthday: list(raw.BYMONTHDAY),
    bymonth: list(raw.BYMONTH),
    bysetpos: list(raw.BYSETPOS),
    wkst: raw.WKST && WEEKDAYS[raw.WKST.toUpperCase()] !== undefined ? WEEKDAYS[raw.WKST.toUpperCase()] : 1,
  };
}

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function monthCandidates(rule, y, m, ds, t) {
  const dim = daysInMonth(y, m);
  let days = [];
  if (rule.bymonthday) {
    for (const md of rule.bymonthday) {
      const d = md > 0 ? md : dim + md + 1;
      if (d >= 1 && d <= dim) days.push(d);
    }
  }
  if (rule.byday) {
    const set = [];
    for (const b of rule.byday) {
      const matches = [];
      for (let d = 1; d <= dim; d++) if (new Date(y, m, d).getDay() === b.wd) matches.push(d);
      if (b.n === 0) set.push(...matches);
      else {
        const idx = b.n > 0 ? b.n - 1 : matches.length + b.n;
        if (matches[idx] !== undefined) set.push(matches[idx]);
      }
    }
    days = rule.bymonthday ? days.filter((d) => set.includes(d)) : set;
  }
  if (!rule.bymonthday && !rule.byday) {
    const d = ds.getDate();
    if (d <= dim) days.push(d); // RFC 5545: invalid dates (e.g. 31 Feb) are skipped
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => new Date(y, m, d, t.h, t.mi, t.s));
}

function periodBase(rule, k, ds) {
  switch (rule.freq) {
    case 'DAILY': return new Date(ds.getFullYear(), ds.getMonth(), ds.getDate() + k * rule.interval).getTime();
    case 'WEEKLY': {
      const off = (ds.getDay() - rule.wkst + 7) % 7;
      return new Date(ds.getFullYear(), ds.getMonth(), ds.getDate() - off + 7 * k * rule.interval).getTime();
    }
    case 'MONTHLY': return new Date(ds.getFullYear(), ds.getMonth() + k * rule.interval, 1).getTime();
    case 'YEARLY': return new Date(ds.getFullYear() + k * rule.interval, 0, 1).getTime();
  }
  return Infinity;
}

function periodCandidates(rule, k, ds) {
  const t = { h: ds.getHours(), mi: ds.getMinutes(), s: ds.getSeconds() };
  let out = [];
  const monthOk = (d) => !rule.bymonth || rule.bymonth.includes(d.getMonth() + 1);
  switch (rule.freq) {
    case 'DAILY': {
      const d = new Date(ds.getFullYear(), ds.getMonth(), ds.getDate() + k * rule.interval, t.h, t.mi, t.s);
      const dayOk = !rule.byday || rule.byday.some((b) => b.wd === d.getDay());
      const mdOk = !rule.bymonthday || rule.bymonthday.includes(d.getDate());
      if (dayOk && mdOk && monthOk(d)) out.push(d);
      break;
    }
    case 'WEEKLY': {
      const ws = new Date(periodBase(rule, k, ds));
      const days = rule.byday ? rule.byday.map((b) => b.wd) : [ds.getDay()];
      for (let i = 0; i < 7; i++) {
        const d = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i, t.h, t.mi, t.s);
        if (days.includes(d.getDay()) && monthOk(d)) out.push(d);
      }
      break;
    }
    case 'MONTHLY': {
      const base = new Date(periodBase(rule, k, ds));
      if (monthOk(base)) out = monthCandidates(rule, base.getFullYear(), base.getMonth(), ds, t);
      break;
    }
    case 'YEARLY': {
      const y = ds.getFullYear() + k * rule.interval;
      const months = rule.bymonth ? rule.bymonth.map((x) => x - 1) : [ds.getMonth()];
      for (const m of months) {
        const r = rule.bymonth || rule.byday || rule.bymonthday ? rule : { ...rule, bymonthday: [ds.getDate()] };
        out.push(...monthCandidates(r, y, m, ds, t));
      }
      break;
    }
  }
  out.sort((a, b) => a - b);
  if (rule.bysetpos && out.length) {
    const picked = [];
    for (const p of rule.bysetpos) {
      const d = p > 0 ? out[p - 1] : out[out.length + p];
      if (d) picked.push(d);
    }
    out = picked.sort((a, b) => a - b);
  }
  return out;
}

function dateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Returns the start timestamps of all occurrences of `ev` that overlap [rangeStart, rangeEnd). */
function occurrencesInRange(ev, rangeStart, rangeEnd) {
  const dur = Math.max(0, (ev.end || ev.start) - ev.start);
  const overlaps = (s) => (dur === 0 ? s >= rangeStart && s < rangeEnd : s < rangeEnd && s + dur > rangeStart);
  if (!ev.rrule) return overlaps(ev.start) ? [ev.start] : [];
  const rule = ev._rule || (ev._rule = parseRRule(ev.rrule));
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return overlaps(ev.start) ? [ev.start] : [];

  const ds = new Date(ev.start);
  if (!ev._ex) {
    ev._ex = new Set((ev.exdates || []).map((x) => (ev.allDay ? dateKey(x) : Math.round(x / 60000))));
  }
  const isExcluded = (ts) => ev._ex.has(ev.allDay ? dateKey(ts) : Math.round(ts / 60000));

  let k = 0;
  if (!rule.count) {
    const days = (rangeStart - dur - ev.start) / DAY_MS;
    const per = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval;
    k = Math.max(0, Math.floor(days / per) - 2);
  }
  const res = [];
  let count = 0;
  for (let guard = 0; guard < 200000; guard++, k++) {
    if (periodBase(rule, k, ds) >= rangeEnd) break;
    let stop = false;
    for (const d of periodCandidates(rule, k, ds)) {
      const ts = d.getTime();
      if (ts < ev.start) continue;
      if (rule.until !== null && ts > rule.until) { stop = true; break; }
      count++;
      if (rule.count && count > rule.count) { stop = true; break; }
      if (ts >= rangeEnd) { stop = true; break; }
      if (isExcluded(ts)) continue;
      if (overlaps(ts)) res.push(ts);
    }
    if (stop) break;
  }
  return res;
}

/** Collects the events of one day from fetched calendar data. */
function eventsForDay(calendars, dayStart) {
  const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1).getTime();
  const start = dayStart.getTime();
  const out = [];
  for (const cal of calendars) {
    // Single (non-recurring) events with a uid on this day: used to suppress
    // the master copy of a moved/edited occurrence of a recurring event.
    const singles = new Set();
    for (const ev of cal.events) {
      if (!ev.rrule && ev.start < dayEnd && Math.max(ev.end, ev.start + 1) > start) singles.add(ev.uid);
    }
    for (const ev of cal.events) {
      let occ;
      try { occ = occurrencesInRange(ev, start, dayEnd); } catch (e) { occ = []; }
      for (const s of occ) {
        if (ev.rrule && singles.has(ev.uid)) continue;
        const dur = Math.max(0, ev.end - ev.start);
        out.push({
          title: ev.title || '(No title)',
          location: ev.location,
          allDay: ev.allDay,
          start: s,
          end: s + dur,
          calendar: cal.name,
          color: cal.color,
          uid: ev.uid,
        });
      }
    }
  }
  out.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start - b.start || a.end - b.end || a.title.localeCompare(b.title)));
  return out;
}

/** Collects the reminders that belong on one day. */
function remindersForDay(lists, dayStart, opts) {
  const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1).getTime();
  const start = dayStart.getTime();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const isToday = start === todayStart;
  const inDay = (ts) => ts !== null && ts !== undefined && ts >= start && ts < dayEnd;
  const out = [];
  for (const list of lists) {
    for (const r of list.items) {
      const due = r.due ?? r.allDayDue ?? null;
      let kind = null;
      if (r.completed) {
        if (opts.showCompleted && (inDay(r.completedAt) || inDay(due))) kind = 'done';
      } else if (inDay(due)) kind = 'due';
      else if (isToday && due !== null && due < start && opts.showOverdueToday) kind = 'overdue';
      else if (isToday && due === null && opts.showUndatedToday) kind = 'undated';
      if (kind) out.push({ ...r, dueTs: due, hasTime: r.due != null && r.allDayDue == null, kind, list: list.name, color: list.color });
    }
  }
  const rank = { overdue: 0, due: 1, undated: 2, done: 3 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.dueTs ?? Infinity) - (b.dueTs ?? Infinity) || (a.title || '').localeCompare(b.title || ''));
  return out;
}

/* ------------------------------------------------------------------ */
/* Apple Calendar / Reminders bridge (JavaScript for Automation)       */
/* ------------------------------------------------------------------ */

// Each script does one small job so a slow calendar or list can't block everything,
// and every call has its own timeout.

const JXA_CAL_NAMES = `
function run() {
  const C = Application('Calendar');
  const names = C.calendars.name();
  let colors = []; try { colors = C.calendars.color(); } catch (e) {}
  return JSON.stringify(names.map((n, i) => ({ name: n, color: colors[i] || null })));
}`;

// Events of one calendar inside [from, to), plus every recurring series that
// started before `to` (the plugin expands those itself).
const JXA_CAL_ONE = `
function run() {
  const P = __PARAMS__;
  const C = Application('Calendar');
  let cal = C.calendars[P.index];
  try { if (cal.name() !== P.name) cal = C.calendars.byName(P.name); } catch (e) { cal = C.calendars.byName(P.name); }
  const from = new Date(P.from), to = new Date(P.to);
  const events = [], seen = {}, notes = [], ms = [];
  function grab(spec) {
    const uid = spec.uid();
    if (!uid.length) return 0;
    const summary = spec.summary(), start = spec.startDate(), end = spec.endDate(), allday = spec.alldayEvent();
    let rec = []; try { rec = spec.recurrence(); } catch (e) {}
    let loc = []; try { loc = spec.location(); } catch (e) {}
    let ex = null;
    for (let i = 0; i < uid.length; i++) {
      if (!start[i]) continue;
      const s = start[i].getTime();
      const key = uid[i] + '|' + s;
      if (seen[key]) continue;
      seen[key] = 1;
      const item = { uid: uid[i], title: summary[i] || '', start: s, end: end[i] ? end[i].getTime() : s,
        allDay: !!allday[i], rrule: rec[i] || null, location: loc[i] || null };
      if (item.rrule) {
        if (ex === null) { try { ex = spec.excludedDates(); } catch (e) { ex = []; } }
        item.exdates = ((ex && ex[i]) || []).map((d) => d.getTime());
      }
      events.push(item);
    }
    return uid.length;
  }
  let t = Date.now();
  grab(cal.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] }));
  ms.push(Date.now() - t); t = Date.now();
  if (P.recurring) {
    try { grab(cal.events.whose({ _and: [{ startDate: { _lessThan: to } }, { recurrence: { _contains: 'FREQ' } }] })); }
    catch (e) { notes.push('recurring events could not be queried: ' + e); }
  }
  ms.push(Date.now() - t);
  return JSON.stringify({ events, ms, notes });
}`;

const JXA_REM_LISTS = `
function run() {
  const R = Application('Reminders');
  const names = R.lists.name();
  let colors = []; try { colors = R.lists.color(); } catch (e) {}
  return JSON.stringify(names.map((n, i) => ({ name: n, color: colors[i] || null })));
}`;

// Open (or recently completed) reminders of one list.
const JXA_REM_ONE = `
function run() {
  const P = __PARAMS__;
  const R = Application('Reminders');
  let list = R.lists[P.index];
  try { if (list.name() !== P.name) list = R.lists.byName(P.name); } catch (e) { list = R.lists.byName(P.name); }
  const t = Date.now();
  const spec = P.completed
    ? list.reminders.whose({ _and: [{ completed: true }, { completionDate: { _greaterThan: new Date(P.since) } }] })
    : list.reminders.whose({ completed: false });
  const ids = spec.id();
  const items = [];
  if (ids.length) {
    const names = spec.name();
    let due = [], allday = [], comp = [], prio = [], body = [];
    try { due = spec.dueDate(); } catch (e) {}
    try { allday = spec.alldayDueDate(); } catch (e) {}
    if (P.completed) { try { comp = spec.completionDate(); } catch (e) {} }
    try { prio = spec.priority(); } catch (e) {}
    try { body = spec.body(); } catch (e) {}
    for (let i = 0; i < ids.length; i++) {
      items.push({ id: ids[i], title: names[i] || '',
        due: due[i] ? due[i].getTime() : null, allDayDue: allday[i] ? allday[i].getTime() : null,
        completed: !!P.completed, completedAt: comp[i] ? comp[i].getTime() : null,
        priority: prio[i] || 0, notes: body[i] || null });
    }
  }
  return JSON.stringify({ items, ms: Date.now() - t });
}`;

const JXA_TOGGLE = `
function run() {
  const P = __PARAMS__;
  const R = Application('Reminders');
  const r = R.reminders.byId(P.id);
  r.completed = P.completed;
  return JSON.stringify({ ok: true, completed: r.completed() });
}`;

const JXA_PING = `function run() { return JSON.stringify({ ok: true }); }`;

function runJXA(source, params, opts = {}) {
  const script = source.replace('__PARAMS__', JSON.stringify(params || {}));
  const timeout = opts.timeout || 60000;
  const label = opts.label || 'AppleScript';
  return new Promise((resolve, reject) => {
    let cp;
    try { cp = require('child_process'); } catch (e) { reject(new Error('Node child_process unavailable (desktop only).')); return; }
    cp.execFile('osascript', ['-l', 'JavaScript', '-e', script], { maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(
          err.killed || err.signal
            ? `${label}: no answer after ${Math.round(timeout / 1000)} s (timed out). If macOS showed a permission prompt, allow it and refresh.`
            : `${label}: ${String(stderr || '').trim() || 'osascript exited with code ' + err.code}`);
        e.timedOut = !!(err.killed || err.signal);
        reject(e);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`${label}: could not read script output: ` + String(stdout).slice(0, 200))); }
    });
  });
}

function cssColor(c) {
  if (!c) return null;
  if (typeof c === 'string') return /^#?[0-9a-f]{6}$/i.test(c) ? (c[0] === '#' ? c : '#' + c) : c;
  if (Array.isArray(c) && c.length >= 3) {
    const scale = c.some((x) => x > 255) ? 257 : 1;
    return `rgb(${c.slice(0, 3).map((x) => Math.round(x / scale)).join(',')})`;
  }
  return null;
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/-1743|not authori[sz]ed/i.test(m)) {
    return 'Obsidian is not allowed to control Calendar/Reminders. Open System Settings → Privacy & Security → Automation → Obsidian and enable Calendar and Reminders, then refresh.';
  }
  if (/access (denied|restricted|write-only)/i.test(m)) {
    return m + ' — open System Settings → Privacy & Security → Calendars / Reminders and give "Mac Agenda Helper" full access, then refresh.';
  }
  if (/-600|isn.t running/i.test(m)) return 'Calendar or Reminders could not be started. Try opening the app once, then refresh.';
  if (/-1712/.test(m)) return m.split(':')[0] + ': the app took too long to answer (AppleEvent timed out).';
  return m.split('\n')[0].slice(0, 300);
}


/* ------------------------------------------------------------------ */
/* EventKit helper app (fast path)                                     */
/* ------------------------------------------------------------------ */

function helperDir() {
  return require('path').join(require('os').homedir(), 'Library', 'Application Support', 'Mac Agenda');
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function sh(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args, { timeout: timeout || 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(err.killed || err.signal ? `${cmd}: timed out` : `${cmd}: ${String(stderr || err.message).trim()}`);
        e.timedOut = !!(err.killed || err.signal);
        reject(e);
      } else resolve(stdout);
    });
  });
}

const HELPER_SOURCE = "// Mac Agenda Helper — compiled into a tiny background app by the plugin.\n// Reads request.json next to the app, answers via EventKit, writes response-<id>.json.\nObjC.import('Foundation');\nObjC.import('EventKit');\nObjC.import('AppKit');\n\nvar HELPER_VERSION = '__HELPER_VERSION__';\n\nfunction readText(p) {\n  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);\n  if (!s || s.isNil()) return null;\n  return ObjC.unwrap(s);\n}\nfunction writeText(p, t) {\n  $(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);\n}\nfunction spin(cond, secs) {\n  var until = Date.now() + secs * 1000;\n  while (!cond() && Date.now() < until) {\n    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05));\n  }\n}\nfunction str(x) {\n  if (x === undefined || x === null) return null;\n  try { if (x.isNil && x.isNil()) return null; } catch (e) {}\n  var v = ObjC.unwrap(x);\n  return v === undefined || v === null ? null : String(v);\n}\nfunction ms(d) {\n  if (!d) return null;\n  try { if (d.isNil && d.isNil()) return null; } catch (e) {}\n  return Math.round(d.timeIntervalSince1970 * 1000);\n}\nfunction nsdate(t) { return $.NSDate.dateWithTimeIntervalSince1970(t / 1000); }\nfunction hex(color) {\n  try {\n    var c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);\n    var h = function (v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; };\n    return '#' + h(c.redComponent) + h(c.greenComponent) + h(c.blueComponent);\n  } catch (e) { return null; }\n}\n// EKAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized/fullAccess, 4 writeOnly\nfunction status(type) { return Number($.EKEventStore.authorizationStatusForEntityType(type)); }\nfunction ensureAccess(store, type) {\n  var st = status(type);\n  if (st === 0) {\n    var done = false;\n    var cb = function () { done = true; };\n    try {\n      if (type === 0) store.requestFullAccessToEventsWithCompletion(cb);\n      else store.requestFullAccessToRemindersWithCompletion(cb);\n    } catch (e) {\n      store.requestAccessToEntityTypeCompletion(type, cb);\n    }\n    spin(function () { return done; }, 170);\n    st = status(type);\n    try { store.reset; } catch (e) {}\n  }\n  return st;\n}\nfunction accessText(st) {\n  return ({ 0: 'not decided', 1: 'restricted', 2: 'denied', 3: 'granted', 4: 'write-only' })[st] || String(st);\n}\nfunction calendars(store, type) {\n  var arr = store.calendarsForEntityType(type);\n  var out = [];\n  for (var i = 0; i < arr.count; i++) {\n    var c = arr.objectAtIndex(i);\n    out.push({ obj: c, id: str(c.calendarIdentifier), name: str(c.title), color: hex(c.color) });\n  }\n  return out;\n}\nfunction toNSArray(list) {\n  var a = $.NSMutableArray.array;\n  list.forEach(function (c) { a.addObject(c.obj); });\n  return a;\n}\nfunction fetchReminders(store, pred) {\n  var done = false, result = null;\n  store.fetchRemindersMatchingPredicateCompletion(pred, function (arr) { result = arr; done = true; });\n  spin(function () { return done; }, 60);\n  if (!done) throw new Error('Reminders did not answer within 60 s');\n  return result;\n}\nvar NOTES = [];\nfunction note(msg) { if (NOTES.length < 5 && NOTES.indexOf(msg) < 0) NOTES.push(msg); }\nfunction reminderDue(r) {\n  var comps = null;\n  try { comps = r.dueDateComponents; } catch (e) { note('dueDateComponents: ' + e); }\n  if (!comps) return null;\n  try { if (comps.isNil()) return null; } catch (e) {}\n  var d = null;\n  try { d = comps.date; if (d && d.isNil()) d = null; } catch (e) { d = null; }\n  if (!d) {\n    try { d = $.NSCalendar.currentCalendar.dateFromComponents(comps); if (d && d.isNil()) d = null; } catch (e) { note('dateFromComponents: ' + e); }\n  }\n  if (!d) {\n    // Build it by hand from year/month/day (+hour/minute).\n    try {\n      var y = Number(comps.year), m = Number(comps.month), dd = Number(comps.day);\n      if (y > 0 && y < 10000 && m >= 1 && m <= 12 && dd >= 1 && dd <= 31) {\n        var hh = Number(comps.hour), mi = Number(comps.minute);\n        var timed = hh >= 0 && hh < 24;\n        return { t: new Date(y, m - 1, dd, timed ? hh : 0, timed && mi >= 0 && mi < 60 ? mi : 0).getTime(), timed: timed };\n      }\n    } catch (e) { note('components: ' + e); }\n    note('a due date could not be read');\n    return null;\n  }\n  var hour = NaN;\n  try { hour = Number(comps.hour); } catch (e) {}\n  return { t: ms(d), timed: hour >= 0 && hour < 24 };\n}\nfunction reminderItem(r) {\n  var due = null, allDayDue = null;\n  var dd = reminderDue(r);\n  if (dd && dd.t !== null) { if (dd.timed) due = dd.t; else allDayDue = dd.t; }\n  var completed = false;\n  try { completed = !!r.isCompleted; } catch (e) { note('isCompleted: ' + e); }\n  if (!completed) { try { completed = !!r.completed; } catch (e) {} }\n  return {\n    id: str(r.calendarItemIdentifier),\n    title: str(r.title) || '',\n    due: due,\n    allDayDue: allDayDue,\n    completed: completed,\n    completedAt: ms(r.completionDate),\n    priority: Number(r.priority) || 0,\n    notes: str(r.notes),\n  };\n}\n\nfunction handle(req) {\n  var store = $.EKEventStore.alloc.init;\n  var res = { version: HELPER_VERSION, errors: [] };\n\n  if (req.action === 'status') {\n    res.calendarAccess = accessText(status(0));\n    res.reminderAccess = accessText(status(1));\n    return res;\n  }\n\n  if (req.action === 'toggle') {\n    if (ensureAccess(store, 1) !== 3) throw new Error('No access to Reminders');\n    var rid = req.reminderId;\n    var item = null;\n    try { item = store.calendarItemWithIdentifier(rid); if (item && item.isNil()) item = null; } catch (e) { item = null; }\n    if (!item) {\n      // Fallback: search all reminders (EventKit sometimes needs a fetch first).\n      var all = fetchReminders(store, store.predicateForRemindersInCalendars(null));\n      if (all && !all.isNil()) {\n        for (var k = 0; k < all.count; k++) {\n          var cand = all.objectAtIndex(k);\n          if (str(cand.calendarItemIdentifier) === rid) { item = cand; break; }\n        }\n      }\n    }\n    if (!item) throw new Error('Reminder not found');\n    item.setCompleted(!!req.completed);\n    var ok = store.saveReminderCommitError(item, true, null);\n    if (!ok) throw new Error('Reminders refused the change');\n    res.ok = true;\n    return res;\n  }\n\n  if (req.action === 'sources' || req.action === 'fetch') {\n    var wantEvents = req.events !== false, wantRems = req.reminders !== false;\n    var hiddenC = req.hiddenCalendars || [], hiddenL = req.hiddenLists || [];\n\n    if (wantEvents) {\n      var cst = ensureAccess(store, 0);\n      res.calendarAccess = accessText(cst);\n      if (cst === 3) {\n        var cals = calendars(store, 0);\n        res.knownCalendars = cals.map(function (c) { return { name: c.name, color: c.color }; });\n        if (req.action === 'fetch') {\n          var vis = cals.filter(function (c) { return hiddenC.indexOf(c.name) < 0; });\n          var byId = {};\n          res.calendars = vis.map(function (c) { var g = { name: c.name, color: c.color, events: [] }; byId[c.id] = g; return g; });\n          if (vis.length) {\n            var t0 = Date.now();\n            var pred = store.predicateForEventsWithStartDateEndDateCalendars(nsdate(req.from), nsdate(req.to), toNSArray(vis));\n            var evs = store.eventsMatchingPredicate(pred);\n            for (var i = 0; i < evs.count; i++) {\n              var e = evs.objectAtIndex(i);\n              var g = byId[str(e.calendar.calendarIdentifier)];\n              if (!g) continue;\n              g.events.push({\n                uid: str(e.calendarItemExternalIdentifier) || str(e.eventIdentifier),\n                title: str(e.title) || '',\n                start: ms(e.startDate),\n                end: ms(e.endDate),\n                allDay: !!e.isAllDay,\n                location: str(e.location),\n                rrule: null,\n              });\n            }\n            res.eventsMs = Date.now() - t0;\n          }\n        }\n      } else res.errors.push('Calendar access ' + accessText(cst));\n    }\n\n    if (wantRems) {\n      var rst = ensureAccess(store, 1);\n      res.reminderAccess = accessText(rst);\n      if (rst === 3) {\n        var lists = calendars(store, 1);\n        res.knownLists = lists.map(function (c) { return { name: c.name, color: c.color }; });\n        if (req.action === 'fetch') {\n          var visL = lists.filter(function (c) { return hiddenL.indexOf(c.name) < 0; });\n          var byIdL = {};\n          res.lists = visL.map(function (c) { var g = { name: c.name, color: c.color, items: [] }; byIdL[c.id] = g; return g; });\n          if (visL.length) {\n            var t1 = Date.now();\n            res.reminderRaw = [];\n            var add = function (arr) {\n              if (!arr) { res.reminderRaw.push('none'); return; }\n              try { if (arr.isNil()) { res.reminderRaw.push('nil'); return; } } catch (e) {}\n              res.reminderRaw.push(Number(arr.count));\n              for (var j = 0; j < arr.count; j++) {\n                var r = arr.objectAtIndex(j);\n                var gl = byIdL[str(r.calendar.calendarIdentifier)];\n                if (gl) gl.items.push(reminderItem(r));\n              }\n            };\n            // Open reminders. Passing \"no date\" from JXA doesn't always arrive as nil,\n            // so if this comes back empty, fetch everything and keep the open ones.\n            var openArr = null;\n            try {\n              openArr = fetchReminders(store, store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars(null, null, toNSArray(visL)));\n            } catch (e) { note('incomplete query: ' + e); }\n            var openCount = 0;\n            try { openCount = openArr && !openArr.isNil() ? Number(openArr.count) : 0; } catch (e) { openCount = 0; }\n            if (openCount > 0) add(openArr);\n            else {\n              res.reminderRaw.push(openArr === null ? 'none' : 'empty');\n              var allArr = fetchReminders(store, store.predicateForRemindersInCalendars(toNSArray(visL)));\n              var openOnly = $.NSMutableArray.array;\n              if (allArr && !allArr.isNil()) {\n                for (var k = 0; k < allArr.count; k++) {\n                  var rr = allArr.objectAtIndex(k);\n                  var isDone = false;\n                  try { isDone = !!rr.isCompleted; } catch (e) {}\n                  if (!isDone) openOnly.addObject(rr);\n                }\n                res.reminderAllCount = Number(allArr.count);\n              }\n              add(openOnly);\n            }\n            if (req.completedSince) {\n              add(fetchReminders(store, store.predicateForCompletedRemindersWithCompletionDateStartingEndingCalendars(\n                nsdate(req.completedSince), $.NSDate.date, toNSArray(visL))));\n            }\n            res.remindersMs = Date.now() - t1;\n            res.reminderNotes = NOTES;\n          }\n        }\n      } else res.errors.push('Reminders access ' + accessText(rst));\n    }\n    return res;\n  }\n  throw new Error('Unknown action ' + req.action);\n}\n\nfunction run() {\n  var dir = ObjC.unwrap($.NSBundle.mainBundle.bundlePath.stringByDeletingLastPathComponent);\n  var req = null, res;\n  try {\n    req = JSON.parse(readText(dir + '/request.json'));\n    res = handle(req);\n  } catch (e) {\n    res = { error: String(e) };\n  }\n  var id = req && req.id ? req.id : 'unknown';\n  try { writeText(dir + '/response-' + id + '.json', JSON.stringify(res)); } catch (e) {}\n}\n";

/* ------------------------------------------------------------------ */
/* Agenda view                                                         */
/* ------------------------------------------------------------------ */

class AgendaView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.date = moment().startOf('day');
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Agenda'; }
  getIcon() { return 'calendar-days'; }

  async onOpen() {
    this.contentEl.addClass('mca-root');
    this.picker = null; // { month: moment, mode: 'days' | 'months' } while the date picker is open
    // Close the date picker on outside click / Escape.
    this.registerDomEvent(document, 'mousedown', (e) => {
      if (!this.picker) return;
      const t = e.target;
      if (t instanceof Node && (this.contentEl.querySelector('.mca-picker')?.contains(t) || this.contentEl.querySelector('.mca-picker-toggle')?.contains(t))) return;
      this.picker = null;
      this.render();
    });
    this.registerDomEvent(document, 'keydown', (e) => {
      if (this.picker && e.key === 'Escape') { this.picker = null; this.render(); }
    });
    this.render();
    // Keep the "now" marker and past-event dimming current.
    this.registerInterval(window.setInterval(() => this.render(), 60 * 1000));
  }

  setDate(d, opts = {}) {
    const nd = moment(d).startOf('day');
    const changed = !nd.isSame(this.date, 'day');
    this.date = nd;
    this.render();
    if (changed && !opts.fromFile && this.plugin.settings.openNoteOnNavigate) {
      this.plugin.openDailyNote(nd, { create: this.plugin.settings.createNoteOnNavigate, onlyIfExists: !this.plugin.settings.createNoteOnNavigate });
    }
  }

  render() {
    const p = this.plugin;
    const s = p.settings;
    const el = this.contentEl;
    el.empty();
    const root = el.createDiv({ cls: 'mca-agenda' });
    const date = this.date;
    const isToday = date.isSame(moment(), 'day');

    // Header
    const header = root.createDiv({ cls: 'mca-header' });
    const title = header.createDiv({ cls: 'mca-title' });
    title.createDiv({ cls: 'mca-weekday', text: date.format('dddd') + (isToday ? ' · Today' : '') });
    title.createDiv({ cls: 'mca-fulldate', text: date.format('LL') });
    const nav = header.createDiv({ cls: 'mca-nav' });
    const btn = (icon, label, fn) => {
      const b = nav.createEl('button', { cls: 'mca-btn clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = fn;
      return b;
    };
    btn('chevron-left', 'Previous day', () => this.setDate(date.clone().subtract(1, 'day')));
    const t = nav.createEl('button', { cls: 'mca-btn mca-today', text: 'Today' });
    t.onclick = () => this.setDate(moment());
    const pick = btn('calendar', 'Jump to date', () => {
      this.picker = this.picker ? null : { month: date.clone().startOf('month'), mode: 'days' };
      this.render();
    });
    pick.addClass('mca-picker-toggle');
    if (this.picker) pick.addClass('is-active');
    btn('chevron-right', 'Next day', () => this.setDate(date.clone().add(1, 'day')));
    const r = btn('refresh-cw', 'Refresh Calendar & Reminders', () => p.refresh(true));
    if (p.loading) r.addClass('mca-spin');

    if (this.picker) this.renderPicker(root);

    // Week strip
    const ws = date.clone().subtract((date.day() - s.weekStart + 7) % 7, 'days');
    const weekRow = root.createDiv({ cls: 'mca-weekrow' });
    weekRow.createSpan({ cls: 'mca-weeknum', text: 'Week ' + this.weekNumber(ws) });
    const we = ws.clone().add(6, 'days');
    weekRow.createSpan({ cls: 'mca-weekmonth', text: ws.isSame(we, 'month') ? ws.format('MMMM YYYY') : ws.format(ws.isSame(we, 'year') ? 'MMM' : 'MMM YYYY') + ' – ' + we.format('MMM YYYY') });
    const week = root.createDiv({ cls: 'mca-week' });
    for (let i = 0; i < 7; i++) {
      const d = ws.clone().add(i, 'days');
      const cell = week.createDiv({ cls: 'mca-weekday-cell' });
      if (d.isSame(date, 'day')) cell.addClass('is-selected');
      if (d.isSame(moment(), 'day')) cell.addClass('is-today');
      cell.createDiv({ cls: 'mca-wd', text: d.format('dd') });
      cell.createDiv({ cls: 'mca-dn', text: d.format('D') });
      const dot = cell.createDiv({ cls: 'mca-dot' });
      if (p.getDailyNoteFile(d)) dot.addClass('has-note');
      cell.onclick = () => this.setDate(d);
    }

    // Daily note link
    const noteRow = root.createDiv({ cls: 'mca-note-row' });
    const file = p.getDailyNoteFile(date);
    const noteBtn = noteRow.createDiv({ cls: 'mca-note-link' });
    const ic = noteBtn.createSpan({ cls: 'mca-note-icon' });
    setIcon(ic, file ? 'file-text' : 'file-plus');
    noteBtn.createSpan({ text: file ? file.basename : 'Create note for this day' });
    if (!file) noteBtn.addClass('is-missing');
    noteBtn.onclick = () => p.openDailyNote(date, { create: true });

    if (!Platform.isMacOS) {
      root.createDiv({ cls: 'mca-message', text: 'Calendar and Reminders can only be read when Obsidian runs on a Mac. The daily note still works here.' });
      return;
    }

    const data = p.data;
    p.ensureWindow(date);
    if (!data) {
      root.createDiv({ cls: 'mca-message', text: p.loading ? 'Loading Calendar and Reminders…' : 'No data yet. Press refresh.' });
      this.renderStatus(root);
      return;
    }

    const now = Date.now();
    const events = eventsForDay(data.calendars || [], date.toDate());
    const allDay = events.filter((e) => e.allDay);
    const timed = events.filter((e) => !e.allDay);

    // All-day
    if (allDay.length) {
      const sec = this.section(root, 'All day');
      for (const e of allDay) {
        const row = sec.createDiv({ cls: 'mca-event mca-allday' });
        this.colorBar(row, e.color);
        const body = row.createDiv({ cls: 'mca-event-body' });
        body.createDiv({ cls: 'mca-event-title', text: e.title });
        const meta = [e.calendar];
        const days = Math.round((e.end - e.start) / DAY_MS);
        if (days > 1) {
          const n = Math.round((date.valueOf() - moment(e.start).startOf('day').valueOf()) / DAY_MS) + 1;
          meta.unshift(`Day ${n} of ${days}`);
        }
        body.createDiv({ cls: 'mca-event-meta', text: meta.join(' · ') });
      }
    }

    // Timed events
    const sec = this.section(root, 'Schedule');
    if (!timed.length) sec.createDiv({ cls: 'mca-empty', text: 'Nothing scheduled.' });
    let nowShown = !isToday;
    for (const e of timed) {
      if (!nowShown && e.start > now) {
        sec.createDiv({ cls: 'mca-now-line', text: moment(now).format('LT') });
        nowShown = true;
      }
      const row = sec.createDiv({ cls: 'mca-event' });
      if (s.dimPastEvents && e.end <= now) row.addClass('is-past');
      if (e.start <= now && e.end > now) row.addClass('is-current');
      const time = row.createDiv({ cls: 'mca-time' });
      const startsBefore = e.start < date.valueOf();
      const endsAfter = e.end > date.clone().add(1, 'day').valueOf();
      time.createDiv({ text: startsBefore ? '…' : moment(e.start).format('LT') });
      if (e.end > e.start) time.createDiv({ cls: 'mca-time-end', text: endsAfter ? '…' : moment(e.end).format('LT') });
      this.colorBar(row, e.color);
      const body = row.createDiv({ cls: 'mca-event-body' });
      body.createDiv({ cls: 'mca-event-title', text: e.title });
      const meta = [e.location, e.calendar].filter(Boolean).join(' · ');
      if (meta) body.createDiv({ cls: 'mca-event-meta', text: meta });
    }
    if (!nowShown && timed.length) sec.createDiv({ cls: 'mca-now-line', text: moment(now).format('LT') });

    // Reminders
    const rems = remindersForDay(data.lists || [], date.toDate(), s);
    const rsec = this.section(root, 'Reminders');
    if (!rems.length) rsec.createDiv({ cls: 'mca-empty', text: 'No reminders.' });
    for (const rem of rems) {
      const row = rsec.createDiv({ cls: 'mca-reminder mca-kind-' + rem.kind });
      const cb = row.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox mca-check' });
      cb.checked = !!rem.completed;
      if (rem.color) cb.style.setProperty('--mca-list-color', cssColor(rem.color));
      cb.onclick = (ev) => { ev.preventDefault(); p.toggleReminder(rem.id, !rem.completed); };
      const body = row.createDiv({ cls: 'mca-event-body' });
      const titleEl = body.createDiv({ cls: 'mca-event-title', text: rem.title || '(Untitled)' });
      if (rem.priority && rem.priority > 0 && !rem.completed) {
        // AppleScript: 1–4 high, 5 medium, 6–9 low
        const bang = rem.priority <= 4 ? '!!!' : rem.priority === 5 ? '!!' : '!';
        titleEl.prepend(createSpan({ cls: 'mca-prio', text: bang + ' ' }));
      }
      const meta = [];
      if (rem.kind === 'overdue') meta.push('Overdue · ' + moment(rem.dueTs).format(rem.hasTime ? 'll LT' : 'll'));
      else if (rem.hasTime && rem.dueTs != null && rem.kind !== 'undated') meta.push(moment(rem.dueTs).format('LT'));
      meta.push(rem.list);
      body.createDiv({ cls: 'mca-event-meta', text: meta.join(' · ') });
      if (rem.notes) body.createDiv({ cls: 'mca-reminder-notes', text: rem.notes });
    }

    this.renderStatus(root);
  }

  /** ISO week (Monday start) or locale week (Sunday start) for the week beginning at `ws`. */
  weekNumber(ws) {
    return this.plugin.settings.weekStart === 1 ? ws.isoWeek() : ws.clone().add(3, 'days').week();
  }

  renderPicker(root) {
    const p = this.plugin;
    const s = p.settings;
    const st = this.picker;
    const box = root.createDiv({ cls: 'mca-picker' });
    const head = box.createDiv({ cls: 'mca-picker-head' });
    const hbtn = (icon, label, fn) => {
      const b = head.createEl('button', { cls: 'mca-btn clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = (e) => { e.stopPropagation(); fn(); this.render(); };
      return b;
    };
    if (st.mode === 'days') {
      hbtn('chevrons-left', 'Previous year', () => st.month.subtract(1, 'year'));
      hbtn('chevron-left', 'Previous month', () => st.month.subtract(1, 'month'));
      const title = head.createEl('button', { cls: 'mca-picker-title', text: st.month.format('MMMM YYYY'), attr: { 'aria-label': 'Choose month' } });
      title.onclick = () => { st.mode = 'months'; this.render(); };
      hbtn('chevron-right', 'Next month', () => st.month.add(1, 'month'));
      hbtn('chevrons-right', 'Next year', () => st.month.add(1, 'year'));

      const grid = box.createDiv({ cls: 'mca-picker-grid' });
      grid.createDiv({ cls: 'mca-picker-wk mca-picker-label', text: 'Wk' });
      for (let i = 0; i < 7; i++) {
        grid.createDiv({ cls: 'mca-picker-label', text: moment().day((s.weekStart + i) % 7).format('dd') });
      }
      const first = st.month.clone().startOf('month');
      let cur = first.clone().subtract((first.day() - s.weekStart + 7) % 7, 'days');
      const today = moment();
      for (let row = 0; row < 6; row++) {
        grid.createDiv({ cls: 'mca-picker-wk', text: String(this.weekNumber(cur)) });
        for (let i = 0; i < 7; i++) {
          const d = cur.clone();
          const cell = grid.createEl('button', { cls: 'mca-picker-day', text: d.format('D') });
          if (!d.isSame(st.month, 'month')) cell.addClass('is-outside');
          if (d.isSame(today, 'day')) cell.addClass('is-today');
          if (d.isSame(this.date, 'day')) cell.addClass('is-selected');
          if (p.getDailyNoteFile(d)) cell.addClass('has-note');
          cell.onclick = () => { this.picker = null; this.setDate(d); };
          cur.add(1, 'day');
        }
        if (!cur.isSame(st.month, 'month') && cur.isAfter(st.month, 'month')) break;
      }
    } else {
      hbtn('chevron-left', 'Previous year', () => st.month.subtract(1, 'year'));
      const title = head.createEl('button', { cls: 'mca-picker-title', text: st.month.format('YYYY'), attr: { 'aria-label': 'Back to days' } });
      title.onclick = () => { st.mode = 'days'; this.render(); };
      hbtn('chevron-right', 'Next year', () => st.month.add(1, 'year'));
      const grid = box.createDiv({ cls: 'mca-picker-months' });
      for (let m = 0; m < 12; m++) {
        const mm = st.month.clone().month(m);
        const cell = grid.createEl('button', { cls: 'mca-picker-month', text: mm.format('MMM') });
        if (mm.isSame(moment(), 'month')) cell.addClass('is-today');
        if (mm.isSame(this.date, 'month')) cell.addClass('is-selected');
        cell.onclick = () => { st.month = mm.startOf('month'); st.mode = 'days'; this.render(); };
      }
    }
    const foot = box.createDiv({ cls: 'mca-picker-foot' });
    const tb = foot.createEl('button', { cls: 'mca-btn mca-today', text: 'Today' });
    tb.onclick = () => { this.picker = null; this.setDate(moment()); };
  }

  renderStatus(root) {
    const p = this.plugin;
    const st = root.createDiv({ cls: 'mca-status' });
    if (p.progress) {
      for (const k of ['calendar', 'reminders']) if (p.progress[k]) st.createDiv({ cls: 'mca-progress', text: p.progress[k] });
    }
    if (p.lastError) st.createDiv({ cls: 'mca-error', text: friendlyError(p.lastError) });
    if (p.data && p.data.errors && p.data.errors.length) {
      const d = st.createEl('details', { cls: 'mca-warnings' });
      d.createEl('summary', { text: `${p.data.errors.length} source warning(s)` });
      for (const e of p.data.errors) d.createDiv({ cls: 'mca-warning', text: friendlyError(e) });
      const diag = d.createEl('button', { text: 'Run diagnostics' });
      diag.onclick = () => p.runDiagnostics();
    }
    if (p.data && p.data.fetchedAt) {
      st.createDiv({ text: (p.loading ? 'Updating… · ' : '') + 'Updated ' + moment(p.data.fetchedAt).format('LT') });
    }
  }

  section(root, label) {
    const sec = root.createDiv({ cls: 'mca-section' });
    sec.createDiv({ cls: 'mca-section-title', text: label });
    return sec;
  }

  colorBar(row, color) {
    const bar = row.createDiv({ cls: 'mca-bar' });
    const c = cssColor(color);
    if (c) bar.style.backgroundColor = c;
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class MacAgendaPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || (await this.importLegacySettings()) || {};
    if (!saved.settingsVersion) { delete saved.completedLookbackDays; delete saved.eventsLookbackDays; }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved, { settingsVersion: 2 });
    this.data = this.loadCache();
    this.loading = false;
    this.lastError = null;

    this.registerView(VIEW_TYPE, (leaf) => new AgendaView(leaf, this));

    this.addRibbonIcon('calendar-days', 'Open today (note + agenda)', () => this.openDay(moment()));

    this.addCommand({ id: 'open-today', name: "Open today's note and agenda", callback: () => this.openDay(moment()) });
    this.addCommand({ id: 'open-agenda', name: 'Show agenda sidebar', callback: () => this.activateView(true) });
    this.addCommand({ id: 'refresh', name: 'Refresh Calendar & Reminders', callback: () => this.refresh(true) });
    this.addCommand({ id: 'next-day', name: 'Go to next day', callback: () => this.shiftDay(1) });
    this.addCommand({ id: 'diagnostics', name: 'Run Calendar & Reminders diagnostics', callback: () => this.runDiagnostics() });
    this.addCommand({ id: 'prev-day', name: 'Go to previous day', callback: () => this.shiftDay(-1) });

    this.addSettingTab(new MacAgendaSettingTab(this.app, this));

    // Follow the open daily note.
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (!file) return;
      const d = this.dateFromFile(file);
      if (d) this.views().forEach((v) => v.setDate(d, { fromFile: true }));
    }));
    // Note dots in the week strip.
    const rerender = (file) => { if (file instanceof TFile && this.dateFromFile(file)) this.renderViews(); };
    this.registerEvent(this.app.vault.on('create', rerender));
    this.registerEvent(this.app.vault.on('delete', rerender));
    this.registerEvent(this.app.vault.on('rename', rerender));

    // Day rollover + periodic refresh.
    this._today = moment().format('YYYY-MM-DD');
    this.registerInterval(window.setInterval(() => {
      const t = moment().format('YYYY-MM-DD');
      if (t !== this._today) {
        const prev = this._today;
        this._today = t;
        this.views().forEach((v) => { if (v.date.format('YYYY-MM-DD') === prev) v.setDate(moment(), { fromFile: true }); });
        this.refresh();
      }
    }, 60 * 1000));
    this.setupRefreshTimer();

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) this.activateView(false);
      this.refresh();
    });
  }

  onunload() {}

  /** One-time import of settings from the earlier "parchsidian" plugin folder. */
  async importLegacySettings() {
    try {
      const legacy = normalizePath(this.app.vault.configDir + '/plugins/parchsidian/data.json');
      if (!(await this.app.vault.adapter.exists(legacy))) return null;
      const data = JSON.parse(await this.app.vault.adapter.read(legacy));
      await this.saveData(data);
      new Notice('Mac Agenda: imported your settings from Parchsidian. You can now remove the old plugin.');
      return data;
    } catch (e) { return null; }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.setupRefreshTimer();
    this.renderViews();
  }

  setupRefreshTimer() {
    if (this._timer) window.clearInterval(this._timer);
    const min = Math.max(1, Number(this.settings.refreshMinutes) || 5);
    this._timer = window.setInterval(() => this.refresh(), min * 60 * 1000);
    this.registerInterval(this._timer);
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v) => v instanceof AgendaView);
  }
  renderViews() { this.views().forEach((v) => v.render()); }

  async activateView(reveal) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
    if (reveal) this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openDay(d) {
    const leaf = await this.activateView(true);
    if (leaf && leaf.view instanceof AgendaView) leaf.view.setDate(d, { fromFile: true });
    await this.openDailyNote(d, { create: true });
  }

  shiftDay(n) {
    const v = this.views()[0];
    const base = v ? v.date : moment();
    const d = base.clone().add(n, 'day');
    if (v) v.setDate(d);
    else this.openDailyNote(d, { create: false, onlyIfExists: true });
  }

  /* ---------- daily notes ---------- */

  getDailyConfig() {
    const s = this.settings;
    if (s.useCoreDailyNotes) {
      try {
        const core = this.app.internalPlugins && this.app.internalPlugins.getPluginById && this.app.internalPlugins.getPluginById('daily-notes');
        if (core && core.enabled) {
          const o = (core.instance && core.instance.options) || {};
          return { folder: (o.folder || '').trim(), format: (o.format || '').trim() || 'YYYY-MM-DD', template: (o.template || '').trim(), core: true };
        }
      } catch (e) { /* fall through */ }
    }
    return { folder: (s.folder || '').trim(), format: (s.format || '').trim() || 'YYYY-MM-DD', template: (s.template || '').trim(), core: false };
  }

  dailyNotePath(d) {
    const { folder, format } = this.getDailyConfig();
    const name = moment(d).format(format);
    return normalizePath((folder ? folder.replace(/\/+$/, '') + '/' : '') + name + '.md');
  }

  getDailyNoteFile(d) {
    const f = this.app.vault.getAbstractFileByPath(this.dailyNotePath(d));
    return f instanceof TFile ? f : null;
  }

  dateFromFile(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    const { folder, format } = this.getDailyConfig();
    let rel = file.path;
    const f = normalizePath(folder || '');
    if (f && f !== '/') {
      if (!rel.startsWith(f + '/')) return null;
      rel = rel.slice(f.length + 1);
    }
    rel = rel.replace(/\.md$/, '');
    const m = moment(rel, format, true);
    return m.isValid() ? m.startOf('day') : null;
  }

  async openDailyNote(d, opts = {}) {
    let file = this.getDailyNoteFile(d);
    if (!file) {
      if (opts.onlyIfExists || !opts.create) return null;
      file = await this.createDailyNote(d);
    }
    const ws = this.app.workspace;
    let leaf = null;
    try { leaf = ws.getMostRecentLeaf(ws.rootSplit); } catch (e) { leaf = null; }
    if (!leaf || (leaf.getViewState && leaf.getViewState().pinned)) leaf = ws.getLeaf('tab');
    await leaf.openFile(file, { active: !opts.background });
    return file;
  }

  async createDailyNote(d) {
    const date = moment(d);
    const { template, format } = this.getDailyConfig();
    const path = this.dailyNotePath(date);
    // Ensure parent folders exist.
    const parts = path.split('/').slice(0, -1);
    let acc = '';
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        try { await this.app.vault.createFolder(acc); } catch (e) { /* exists */ }
      }
    }
    let content = '';
    if (template) {
      const tpath = normalizePath(template);
      let tfile = this.app.vault.getAbstractFileByPath(tpath) || this.app.vault.getAbstractFileByPath(tpath + '.md');
      if (!(tfile instanceof TFile)) tfile = this.app.metadataCache.getFirstLinkpathDest(template, '');
      if (tfile instanceof TFile) content = await this.app.vault.read(tfile);
      else new Notice(`Mac Agenda: template "${template}" not found.`);
    }
    const title = date.format(format).split('/').pop();
    content = content
      .replace(/{{\s*(date|time)\s*:\s*([^}]+?)\s*}}/gi, (_, kind, fmt) => (kind.toLowerCase() === 'time' ? moment() : date).format(fmt))
      .replace(/{{\s*date\s*}}/gi, date.format(format))
      .replace(/{{\s*time\s*}}/gi, moment().format('HH:mm'))
      .replace(/{{\s*title\s*}}/gi, title)
      .replace(/{{\s*yesterday\s*}}/gi, date.clone().subtract(1, 'day').format(format))
      .replace(/{{\s*tomorrow\s*}}/gi, date.clone().add(1, 'day').format(format));
    return await this.app.vault.create(path, content);
  }

  /* ---------- data ---------- */

  cacheKey() { return 'mac-agenda-cache-' + this.app.vault.getName(); }

  loadCache() {
    try {
      const raw = window.localStorage.getItem(this.cacheKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  saveCache() {
    try {
      const strip = (k, v) => (k === '_rule' || k === '_ex' ? undefined : v);
      window.localStorage.setItem(this.cacheKey(), JSON.stringify(this.data, strip));
    } catch (e) { /* quota exceeded — fine, cache is optional */ }
  }

  eventWindow(center) {
    const s = this.settings;
    const c = moment(center || undefined).startOf('day');
    return {
      from: c.clone().subtract(Math.max(1, Number(s.eventsPastDays) || 30), 'days').valueOf(),
      to: c.clone().add(Math.max(1, Number(s.eventsFutureDays) || 90), 'days').valueOf(),
    };
  }

  /** Called by the view: reload events if the shown day is outside the loaded window. */
  ensureWindow(date) {
    const w = this.data && this.data.window;
    const t = moment(date).valueOf();
    if (this.loading || !w) return;
    if (t < w.from || t >= w.to - DAY_MS) this.refresh(false, date);
  }

  setProgress(key, text) {
    if (!this.progress) this.progress = {};
    this.progress[key] = text;
    this.renderViews();
  }

  async refresh(manual, center) {
    if (!Platform.isMacOS) { if (manual) new Notice('Mac Agenda: Calendar and Reminders need Obsidian on a Mac.'); return; }
    if (this.loading) { this._again = true; return; }
    this.loading = true;
    this.lastError = null;
    const prev = this.data || {};
    const errors = [];
    this.data = { fetchedAt: prev.fetchedAt || null, calendars: prev.calendars || [], lists: prev.lists || [], errors, window: prev.window || null };
    this.progress = {};
    this.renderViews();
    const win = this.eventWindow(center);
    if (this.settings.dataSource === 'applescript') {
      await Promise.all([
        this.refreshCalendars(win, errors).catch((e) => errors.push('Calendar: ' + e.message)),
        this.refreshReminders(errors).catch((e) => errors.push('Reminders: ' + e.message)),
      ]);
    } else {
      await this.refreshEventKit(win, errors).catch((e) => errors.push('Helper: ' + e.message));
    }
    this.data.fetchedAt = Date.now();
    this.loading = false;
    this.progress = null;
    this.saveCache();
    this.renderViews();
    if (manual && errors.length) new Notice('Mac Agenda: ' + friendlyError(errors[0]));
    if (this._again) { this._again = false; this.refresh(); }
  }

  /** Builds the helper app once (and again when its code changes). */
  ensureHelper() {
    if (this._helperReady) return this._helperReady;
    this._helperReady = (async () => {
      const fs = require('fs');
      const path = require('path');
      const dir = helperDir();
      const app = path.join(dir, 'Mac Agenda Helper.app');
      const vfile = path.join(dir, 'helper-version');
      const version = hashString(HELPER_SOURCE);
      fs.mkdirSync(dir, { recursive: true });
      let cur = null;
      try { cur = fs.readFileSync(vfile, 'utf8').trim(); } catch (e) { /* first run */ }
      if (cur === version && fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) return app;
      const src = path.join(dir, 'helper.js');
      fs.writeFileSync(src, HELPER_SOURCE.replace('__HELPER_VERSION__', version));
      fs.rmSync(app, { recursive: true, force: true });
      await sh('osacompile', ['-l', 'JavaScript', '-o', app, src]);
      const plist = path.join(app, 'Contents', 'Info.plist');
      const set = async (key, type, value) => {
        try { await sh('plutil', ['-replace', key, type, value, plist]); }
        catch (e) { await sh('plutil', ['-insert', key, type, value, plist]); }
      };
      await set('CFBundleIdentifier', '-string', 'app.macagenda.helper');
      await set('CFBundleName', '-string', 'Mac Agenda Helper');
      await set('LSUIElement', '-bool', 'YES');
      const why = 'Mac Agenda shows your calendar events and reminders in Obsidian and lets you tick reminders off.';
      for (const k of ['NSCalendarsUsageDescription', 'NSCalendarsFullAccessUsageDescription', 'NSRemindersUsageDescription', 'NSRemindersFullAccessUsageDescription']) {
        await set(k, '-string', why);
      }
      await sh('codesign', ['--force', '--deep', '--sign', '-', app]);
      fs.writeFileSync(vfile, version);
      return app;
    })();
    this._helperReady.catch(() => { this._helperReady = null; });
    return this._helperReady;
  }

  /** Runs one request through the helper app. Calls are queued. */
  callHelper(req, timeout) {
    const run = async () => {
      const fs = require('fs');
      const path = require('path');
      const app = await this.ensureHelper();
      const dir = helperDir();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const out = path.join(dir, `response-${id}.json`);
      fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(Object.assign({}, req, { id })));
      try {
        await sh('open', ['-W', '-g', '-n', app], timeout || 60000);
      } catch (e) {
        if (!fs.existsSync(out)) {
          throw new Error(e.timedOut
            ? `no answer after ${Math.round((timeout || 60000) / 1000)} s. If macOS is asking for Calendar or Reminders access for "Mac Agenda Helper", allow it and refresh.`
            : e.message);
        }
      }
      let raw;
      try { raw = fs.readFileSync(out, 'utf8'); } catch (e) { throw new Error('the helper app gave no answer.'); }
      try { fs.unlinkSync(out); } catch (e) { /* ignore */ }
      const res = JSON.parse(raw);
      if (res.error) throw new Error(res.error);
      return res;
    };
    const p = (this._hq || Promise.resolve()).catch(() => {}).then(run);
    this._hq = p.catch(() => {});
    return p;
  }

  async refreshEventKit(win, errors) {
    const s = this.settings;
    this.setProgress('calendar', 'Loading Calendar and Reminders…');
    const since = s.showCompleted ? moment().startOf('day').subtract(Math.max(1, Number(s.completedLookbackDays) || 7), 'days').valueOf() : null;
    try {
      const res = await this.callHelper({
        action: 'fetch', from: win.from, to: win.to,
        hiddenCalendars: s.hiddenCalendars || [], hiddenLists: s.hiddenLists || [], completedSince: since,
      }, 180000);
      if (res.knownCalendars) s.knownCalendars = res.knownCalendars;
      if (res.knownLists) s.knownLists = res.knownLists;
      this.saveData(s);
      if (res.calendars) { this.data.calendars = res.calendars; this.data.window = win; }
      if (res.lists) this.data.lists = res.lists;
      (res.errors || []).forEach((e) => errors.push(e));
    } finally {
      this.setProgress('calendar', null);
    }
  }

  async refreshCalendars(win, errors) {
    const s = this.settings;
    this.setProgress('calendar', 'Connecting to Calendar…');
    let names;
    try {
      names = await runJXA(JXA_CAL_NAMES, {}, { timeout: 60000, label: 'Calendar' });
    } catch (e) {
      errors.push(e.message);
      this.setProgress('calendar', null);
      return;
    }
    this.settings.knownCalendars = names;
    this.saveData(this.settings);
    const hidden = s.hiddenCalendars || [];
    const visible = names.map((c, i) => ({ ...c, index: i })).filter((c) => !hidden.includes(c.name));
    const old = new Map((this.data.calendars || []).map((c) => [c.name, c]));
    const done = [];
    for (let n = 0; n < visible.length; n++) {
      const c = visible[n];
      this.setProgress('calendar', `Calendar “${c.name}” (${n + 1}/${visible.length})…`);
      try {
        const r = await runJXA(JXA_CAL_ONE, { index: c.index, name: c.name, from: win.from, to: win.to, recurring: true },
          { timeout: 90000, label: `Calendar “${c.name}”` });
        done.push({ name: c.name, color: c.color, events: r.events || [] });
        (r.notes || []).forEach((x) => errors.push(`Calendar “${c.name}”: ${x}`));
      } catch (e) {
        errors.push(e.message);
        if (old.has(c.name)) done.push(old.get(c.name)); // keep last known data
      }
      this.data.calendars = [...done, ...visible.slice(n + 1).map((v) => old.get(v.name)).filter(Boolean)];
      this.data.window = win;
    }
    this.setProgress('calendar', null);
  }

  async refreshReminders(errors) {
    const s = this.settings;
    this.setProgress('reminders', 'Connecting to Reminders…');
    let names;
    try {
      names = await runJXA(JXA_REM_LISTS, {}, { timeout: 60000, label: 'Reminders' });
    } catch (e) {
      errors.push(e.message);
      this.setProgress('reminders', null);
      return;
    }
    this.settings.knownLists = names;
    this.saveData(this.settings);
    const hidden = s.hiddenLists || [];
    const visible = names.map((c, i) => ({ ...c, index: i })).filter((c) => !hidden.includes(c.name));
    const old = new Map((this.data.lists || []).map((l) => [l.name, l]));
    const lists = visible.map((v) => ({ name: v.name, color: v.color, items: (old.get(v.name) || { items: [] }).items }));
    this.data.lists = lists;
    // Pass 1: open reminders (what matters most).
    for (let n = 0; n < visible.length; n++) {
      const v = visible[n];
      this.setProgress('reminders', `Reminders “${v.name}” (${n + 1}/${visible.length})…`);
      try {
        const r = await runJXA(JXA_REM_ONE, { index: v.index, name: v.name, completed: false }, { timeout: 60000, label: `Reminders “${v.name}”` });
        const keepDone = lists[n].items.filter((x) => x.completed);
        lists[n].items = [...(r.items || []), ...keepDone];
      } catch (e) { errors.push(e.message); }
      this.renderViews();
    }
    // Pass 2: recently completed (best effort — can be slow with long histories).
    if (s.showCompleted) {
      const since = moment().startOf('day').subtract(Math.max(1, Number(s.completedLookbackDays) || 7), 'days').valueOf();
      for (let n = 0; n < visible.length; n++) {
        const v = visible[n];
        this.setProgress('reminders', `Completed reminders “${v.name}” (${n + 1}/${visible.length})…`);
        try {
          const r = await runJXA(JXA_REM_ONE, { index: v.index, name: v.name, completed: true, since }, { timeout: 45000, label: `Completed reminders “${v.name}”` });
          lists[n].items = [...lists[n].items.filter((x) => !x.completed), ...(r.items || [])];
        } catch (e) { errors.push(e.message); }
        this.renderViews();
      }
    }
    this.setProgress('reminders', null);
  }

  findReminder(id) {
    for (const l of (this.data && this.data.lists) || []) for (const r of l.items) if (r.id === id) return r;
    return null;
  }

  async toggleReminder(id, completed) {
    const r = this.findReminder(id);
    if (!r) return;
    const before = { completed: r.completed, completedAt: r.completedAt };
    r.completed = completed;
    r.completedAt = completed ? Date.now() : null;
    this.renderViews();
    try {
      if (this.settings.dataSource === 'applescript') await runJXA(JXA_TOGGLE, { id, completed }, { timeout: 30000, label: 'Reminders' });
      else await this.callHelper({ action: 'toggle', reminderId: id, completed }, 30000);
      this.saveCache();
    } catch (e) {
      Object.assign(r, before);
      this.renderViews();
      new Notice('Mac Agenda: could not update reminder. ' + friendlyError(e.message));
    }
  }

  async loadSources() {
    const out = { errors: [] };
    if (this.settings.dataSource !== 'applescript') {
      try {
        const res = await this.callHelper({ action: 'sources' }, 180000);
        if (res.knownCalendars) this.settings.knownCalendars = res.knownCalendars;
        if (res.knownLists) this.settings.knownLists = res.knownLists;
        out.errors.push(...(res.errors || []));
      } catch (e) { out.errors.push('Helper: ' + e.message); }
      await this.saveData(this.settings);
      return out;
    }
    try { this.settings.knownCalendars = await runJXA(JXA_CAL_NAMES, {}, { timeout: 60000, label: 'Calendar' }); } catch (e) { out.errors.push(e.message); }
    try { this.settings.knownLists = await runJXA(JXA_REM_LISTS, {}, { timeout: 60000, label: 'Reminders' }); } catch (e) { out.errors.push(e.message); }
    await this.saveData(this.settings);
    return out;
  }

  /** Step-by-step check with timings; writes a report note. */
  async runDiagnostics() {
    if (!Platform.isMacOS) { new Notice('Mac Agenda: diagnostics need a Mac.'); return; }
    const notice = new Notice('Mac Agenda: running diagnostics… (can take a few minutes)', 0);
    const lines = ['# Mac Agenda diagnostics', '', `Run: ${moment().format('YYYY-MM-DD HH:mm')}`, ''];
    const step = async (label, fn) => {
      notice.setMessage('Mac Agenda diagnostics: ' + label + '…');
      const t = Date.now();
      try {
        const r = await fn();
        lines.push(`- ✅ ${label} — ${((Date.now() - t) / 1000).toFixed(1)} s${r ? ' — ' + r : ''}`);
        return true;
      } catch (e) {
        lines.push(`- ❌ ${label} — ${((Date.now() - t) / 1000).toFixed(1)} s — ${String(e.message).split('\n')[0]}`);
        return false;
      }
    };
    await step('osascript works', () => runJXA(JXA_PING, {}, { timeout: 20000, label: 'osascript' }).then(() => ''));
    const win = this.eventWindow();
    lines.push('', `Data source: ${this.settings.dataSource === 'applescript' ? 'AppleScript' : 'EventKit helper'}`, '', '## EventKit helper');
    let helperOk = await step('Build helper app', async () => { const app = await this.ensureHelper(); return app; });
    let lastFetch = null;
    if (helperOk) {
      await step('Access', async () => { const r = await this.callHelper({ action: 'status' }, 60000); return `calendars: ${r.calendarAccess}, reminders: ${r.reminderAccess}`; });
      await step('Fetch everything', async () => {
        const r = await this.callHelper({ action: 'fetch', from: win.from, to: win.to, hiddenCalendars: [], hiddenLists: [],
          completedSince: moment().startOf('day').subtract(7, 'days').valueOf() }, 180000);
        const ev = (r.calendars || []).reduce((n, c) => n + c.events.length, 0);
        const rem = (r.lists || []).reduce((n, l) => n + l.items.length, 0);
        lastFetch = r;
        return `${(r.calendars || []).length} calendars / ${ev} events (${r.eventsMs ?? '–'} ms), ${(r.lists || []).length} lists / ${rem} reminders (${r.remindersMs ?? '–'} ms)` +
          (r.errors && r.errors.length ? ' — ' + r.errors.join('; ') : '');
      });
      if (lastFetch && lastFetch.lists) {
        const all = [].concat(...lastFetch.lists.map((l) => l.items));
        const t0 = moment().startOf('day').valueOf();
        const t1 = t0 + DAY_MS;
        const dueOf = (x) => x.due ?? x.allDayDue ?? null;
        const open = all.filter((x) => !x.completed);
        const done = all.filter((x) => x.completed);
        const c = (arr, f) => arr.filter(f).length;
        lines.push('', '### Reminders breakdown',
          `- Raw counts from Reminders: ${JSON.stringify(lastFetch.reminderRaw || [])}${lastFetch.reminderAllCount != null ? ` (fallback scanned ${lastFetch.reminderAllCount} reminders)` : ''}`,
          `- Open: ${open.length} — due today ${c(open, (x) => dueOf(x) !== null && dueOf(x) >= t0 && dueOf(x) < t1)}, overdue ${c(open, (x) => dueOf(x) !== null && dueOf(x) < t0)}, later ${c(open, (x) => dueOf(x) !== null && dueOf(x) >= t1)}, no due date ${c(open, (x) => dueOf(x) === null)}`,
          `- Open with a time: ${c(open, (x) => x.due !== null)}, all-day: ${c(open, (x) => x.allDayDue !== null)}`,
          `- Completed (last 7 days): ${done.length} — completed today ${c(done, (x) => x.completedAt !== null && x.completedAt >= t0 && x.completedAt < t1)}, without completion date ${c(done, (x) => x.completedAt === null)}`,
          `- Shown on today with current settings: ${remindersForDay(lastFetch.lists, new Date(t0), this.settings).length}`,
          `- Helper notes: ${(lastFetch.reminderNotes || []).join(' | ') || 'none'}`);
        lines.push('', '### Per list (open / completed)');
        for (const l of lastFetch.lists) lines.push(`- “${l.name}”: ${l.items.filter((x) => !x.completed).length} / ${l.items.filter((x) => x.completed).length}`);
      }
    }
    if (this.settings.dataSource !== 'applescript') {
      lines.push('', '> Only names, counts and timings are listed here — no event or reminder contents.');
      notice.hide();
      return this.writeDiagnostics(lines);
    }
    let cals = [];
    lines.push('', '## Calendar');
    if (await step('List calendars', async () => { cals = await runJXA(JXA_CAL_NAMES, {}, { timeout: 90000, label: 'Calendar' }); return cals.length + ' calendars'; })) {
      for (let i = 0; i < cals.length; i++) {
        const c = cals[i];
        await step(`“${c.name}”`, async () => {
          const r = await runJXA(JXA_CAL_ONE, { index: i, name: c.name, from: win.from, to: win.to, recurring: true }, { timeout: 90000, label: c.name });
          const rec = (r.events || []).filter((e) => e.rrule).length;
          return `${(r.events || []).length} events (${rec} recurring); range query ${(r.ms[0] / 1000).toFixed(1)} s, recurring query ${(r.ms[1] / 1000).toFixed(1)} s${r.notes && r.notes.length ? '; ' + r.notes.join('; ') : ''}`;
        });
      }
    }
    let lists = [];
    lines.push('', '## Reminders');
    if (await step('List reminder lists', async () => { lists = await runJXA(JXA_REM_LISTS, {}, { timeout: 90000, label: 'Reminders' }); return lists.length + ' lists'; })) {
      const since = moment().startOf('day').subtract(Math.max(1, Number(this.settings.completedLookbackDays) || 7), 'days').valueOf();
      for (let i = 0; i < lists.length; i++) {
        const l = lists[i];
        await step(`“${l.name}” open`, async () => {
          const r = await runJXA(JXA_REM_ONE, { index: i, name: l.name, completed: false }, { timeout: 90000, label: l.name });
          return `${r.items.length} open`;
        });
        await step(`“${l.name}” completed since ${moment(since).format('ll')}`, async () => {
          const r = await runJXA(JXA_REM_ONE, { index: i, name: l.name, completed: true, since }, { timeout: 90000, label: l.name });
          return `${r.items.length} completed`;
        });
      }
    }
    lines.push('', '> Only names, counts and timings are listed here — no event or reminder contents.');
    notice.hide();
    return this.writeDiagnostics(lines);
  }

  async writeDiagnostics(lines) {
    const path = 'Mac Agenda diagnostics.md';
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file;
    if (existing instanceof TFile) { await this.app.vault.modify(existing, lines.join('\n')); file = existing; }
    else file = await this.app.vault.create(path, lines.join('\n'));
    await this.app.workspace.getLeaf('tab').openFile(file);
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class MacAgendaSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Daily note' });
    const cfg = p.getDailyConfig();
    new Setting(containerEl)
      .setName('Use the core Daily notes settings')
      .setDesc(cfg.core
        ? `Using Daily notes: folder "${cfg.folder || '/'}", format "${cfg.format}"${cfg.template ? `, template "${cfg.template}"` : ''}.`
        : 'If the core Daily notes plugin is enabled, its folder, format and template are used. Otherwise the settings below apply.')
      .addToggle((t) => t.setValue(s.useCoreDailyNotes).onChange(async (v) => { s.useCoreDailyNotes = v; await p.saveSettings(); this.display(); }));

    if (!cfg.core) {
      new Setting(containerEl).setName('Folder').setDesc('Where daily notes live.')
        .addText((t) => t.setPlaceholder('Daily').setValue(s.folder).onChange(async (v) => { s.folder = v; await p.saveSettings(); }));
      new Setting(containerEl).setName('Date format').setDesc('Moment.js format for the file name. Slashes create subfolders, e.g. YYYY/MM/YYYY-MM-DD.')
        .addText((t) => t.setPlaceholder('YYYY-MM-DD').setValue(s.format).onChange(async (v) => { s.format = v; await p.saveSettings(); }));
      new Setting(containerEl).setName('Template').setDesc('Optional template file. Supports {{date}}, {{date:FORMAT}}, {{title}}, {{time}}, {{yesterday}}, {{tomorrow}}.')
        .addText((t) => t.setPlaceholder('Templates/Daily').setValue(s.template).onChange(async (v) => { s.template = v; await p.saveSettings(); }));
    }
    new Setting(containerEl).setName('Open the note when changing days')
      .setDesc('Browsing days in the agenda opens that day\'s note in the editor.')
      .addToggle((t) => t.setValue(s.openNoteOnNavigate).onChange(async (v) => { s.openNoteOnNavigate = v; await p.saveSettings(); }));
    new Setting(containerEl).setName('Create missing notes while browsing')
      .setDesc('Off: missing notes are only created when you click "Create note". On: every day you visit gets a note.')
      .addToggle((t) => t.setValue(s.createNoteOnNavigate).onChange(async (v) => { s.createNoteOnNavigate = v; await p.saveSettings(); }));
    new Setting(containerEl).setName('Show agenda on startup')
      .addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await p.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Agenda' });
    new Setting(containerEl).setName('Read Calendar & Reminders via')
      .setDesc('EventKit helper: a small background app ("Mac Agenda Helper") that macOS asks you to give Calendar and Reminders access once. Fast. AppleScript: no helper, but very slow with larger calendars.')
      .addDropdown((d) => d.addOption('eventkit', 'EventKit helper (fast)').addOption('applescript', 'AppleScript (slow)')
        .setValue(s.dataSource).onChange(async (v) => { s.dataSource = v; await p.saveSettings(); p.refresh(true); }));
    new Setting(containerEl).setName('Week starts on')
      .addDropdown((d) => d.addOption('1', 'Monday').addOption('0', 'Sunday').setValue(String(s.weekStart))
        .onChange(async (v) => { s.weekStart = Number(v); await p.saveSettings(); }));
    new Setting(containerEl).setName('Show overdue reminders on today')
      .addToggle((t) => t.setValue(s.showOverdueToday).onChange(async (v) => { s.showOverdueToday = v; await p.saveSettings(); }));
    new Setting(containerEl).setName('Show reminders without a due date on today')
      .addToggle((t) => t.setValue(s.showUndatedToday).onChange(async (v) => { s.showUndatedToday = v; await p.saveSettings(); }));
    new Setting(containerEl).setName('Show completed reminders')
      .setDesc('Shown ticked on the day they were due or completed.')
      .addToggle((t) => t.setValue(s.showCompleted).onChange(async (v) => { s.showCompleted = v; await p.saveSettings(); p.refresh(); }));
    new Setting(containerEl).setName('Dim past events')
      .addToggle((t) => t.setValue(s.dimPastEvents).onChange(async (v) => { s.dimPastEvents = v; await p.saveSettings(); }));
    new Setting(containerEl).setName('Refresh every (minutes)')
      .addText((t) => t.setValue(String(s.refreshMinutes)).onChange(async (v) => { s.refreshMinutes = Math.max(1, parseInt(v, 10) || 5); await p.saveSettings(); }));
    new Setting(containerEl).setName('Events loaded: days back')
      .setDesc('Smaller windows load faster. Browsing outside the window loads that period automatically.')
      .addText((t) => t.setValue(String(s.eventsPastDays)).onChange(async (v) => { s.eventsPastDays = Math.max(1, parseInt(v, 10) || 30); await p.saveSettings(); }));
    new Setting(containerEl).setName('Events loaded: days ahead')
      .addText((t) => t.setValue(String(s.eventsFutureDays)).onChange(async (v) => { s.eventsFutureDays = Math.max(1, parseInt(v, 10) || 90); await p.saveSettings(); }));
    new Setting(containerEl).setName('Completed reminders: days back')
      .setDesc('Loading completed reminders is slow in Reminders; keep this small.')
      .addText((t) => t.setValue(String(s.completedLookbackDays)).onChange(async (v) => { s.completedLookbackDays = Math.max(1, parseInt(v, 10) || 7); await p.saveSettings(); }));
    new Setting(containerEl).setName('Diagnostics')
      .setDesc('Checks Calendar and Reminders step by step and writes timings to the note "Mac Agenda diagnostics".')
      .addButton((b) => b.setButtonText('Run diagnostics').onClick(() => p.runDiagnostics()));

    containerEl.createEl('h3', { text: 'Calendars & reminder lists' });
    new Setting(containerEl)
      .setName('Load from Calendar and Reminders')
      .setDesc('The first time, macOS asks whether Obsidian may control Calendar and Reminders — allow both.')
      .addButton((b) => b.setButtonText('Load').setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText('Loading…');
        try {
          const res = await p.loadSources();
          if (res.errors && res.errors.length) new Notice('Mac Agenda: ' + friendlyError(res.errors[0]));
        } catch (e) { new Notice('Mac Agenda: ' + friendlyError(e.message)); }
        this.display();
      }));

    const toggles = (title, known, key) => {
      if (!known.length) return;
      containerEl.createEl('h4', { text: title });
      for (const item of known) {
        const st = new Setting(containerEl).setName(item.name);
        const c = cssColor(item.color);
        if (c) st.nameEl.prepend(createSpan({ cls: 'mca-swatch', attr: { style: `background:${c}` } }));
        st.addToggle((t) => t.setValue(!s[key].includes(item.name)).onChange(async (v) => {
          s[key] = v ? s[key].filter((n) => n !== item.name) : [...s[key].filter((n) => n !== item.name), item.name];
          await p.saveSettings();
          p.refresh();
        }));
      }
    };
    toggles('Calendars', s.knownCalendars || [], 'hiddenCalendars');
    toggles('Reminder lists', s.knownLists || [], 'hiddenLists');
  }
}

module.exports = MacAgendaPlugin;
module.exports.default = MacAgendaPlugin;
module.exports._internals = { parseRRule, occurrencesInRange, eventsForDay, remindersForDay, cssColor, friendlyError };
