// Mac Agenda Helper — compiled into a tiny background app by the plugin.
// Reads request.json next to the app, answers via EventKit, writes response-<id>.json.
ObjC.import('Foundation');
ObjC.import('EventKit');
ObjC.import('AppKit');

var HELPER_VERSION = '__HELPER_VERSION__';

function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (!s || s.isNil()) return null;
  return ObjC.unwrap(s);
}
function writeText(p, t) {
  $(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
}
function spin(cond, secs) {
  var until = Date.now() + secs * 1000;
  while (!cond() && Date.now() < until) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
}
function str(x) {
  if (x === undefined || x === null) return null;
  try { if (x.isNil && x.isNil()) return null; } catch (e) {}
  var v = ObjC.unwrap(x);
  return v === undefined || v === null ? null : String(v);
}
function ms(d) {
  if (!d) return null;
  try { if (d.isNil && d.isNil()) return null; } catch (e) {}
  return Math.round(d.timeIntervalSince1970 * 1000);
}
function nsdate(t) { return $.NSDate.dateWithTimeIntervalSince1970(t / 1000); }
function hex(color) {
  try {
    var c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
    var h = function (v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; };
    return '#' + h(c.redComponent) + h(c.greenComponent) + h(c.blueComponent);
  } catch (e) { return null; }
}
// EKAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized/fullAccess, 4 writeOnly
function status(type) { return Number($.EKEventStore.authorizationStatusForEntityType(type)); }
function ensureAccess(store, type) {
  var st = status(type);
  if (st === 0) {
    var done = false;
    var cb = function () { done = true; };
    try {
      if (type === 0) store.requestFullAccessToEventsWithCompletion(cb);
      else store.requestFullAccessToRemindersWithCompletion(cb);
    } catch (e) {
      store.requestAccessToEntityTypeCompletion(type, cb);
    }
    spin(function () { return done; }, 170);
    st = status(type);
    try { store.reset; } catch (e) {}
  }
  return st;
}
function accessText(st) {
  return ({ 0: 'not decided', 1: 'restricted', 2: 'denied', 3: 'granted', 4: 'write-only' })[st] || String(st);
}
function calendars(store, type) {
  var arr = store.calendarsForEntityType(type);
  var out = [];
  for (var i = 0; i < arr.count; i++) {
    var c = arr.objectAtIndex(i);
    out.push({ obj: c, id: str(c.calendarIdentifier), name: str(c.title), color: hex(c.color) });
  }
  return out;
}
function toNSArray(list) {
  var a = $.NSMutableArray.array;
  list.forEach(function (c) { a.addObject(c.obj); });
  return a;
}
function fetchReminders(store, pred) {
  var done = false, result = null;
  store.fetchRemindersMatchingPredicateCompletion(pred, function (arr) { result = arr; done = true; });
  spin(function () { return done; }, 60);
  if (!done) throw new Error('Reminders did not answer within 60 s');
  return result;
}
var NOTES = [];
function note(msg) { if (NOTES.length < 5 && NOTES.indexOf(msg) < 0) NOTES.push(msg); }
function reminderDue(r) {
  var comps = null;
  try { comps = r.dueDateComponents; } catch (e) { note('dueDateComponents: ' + e); }
  if (!comps) return null;
  try { if (comps.isNil()) return null; } catch (e) {}
  var d = null;
  try { d = comps.date; if (d && d.isNil()) d = null; } catch (e) { d = null; }
  if (!d) {
    try { d = $.NSCalendar.currentCalendar.dateFromComponents(comps); if (d && d.isNil()) d = null; } catch (e) { note('dateFromComponents: ' + e); }
  }
  if (!d) {
    // Build it by hand from year/month/day (+hour/minute).
    try {
      var y = Number(comps.year), m = Number(comps.month), dd = Number(comps.day);
      if (y > 0 && y < 10000 && m >= 1 && m <= 12 && dd >= 1 && dd <= 31) {
        var hh = Number(comps.hour), mi = Number(comps.minute);
        var timed = hh >= 0 && hh < 24;
        return { t: new Date(y, m - 1, dd, timed ? hh : 0, timed && mi >= 0 && mi < 60 ? mi : 0).getTime(), timed: timed };
      }
    } catch (e) { note('components: ' + e); }
    note('a due date could not be read');
    return null;
  }
  var hour = NaN;
  try { hour = Number(comps.hour); } catch (e) {}
  return { t: ms(d), timed: hour >= 0 && hour < 24 };
}
function reminderItem(r) {
  var due = null, allDayDue = null;
  var dd = reminderDue(r);
  if (dd && dd.t !== null) { if (dd.timed) due = dd.t; else allDayDue = dd.t; }
  var completed = false;
  try { completed = !!r.isCompleted; } catch (e) { note('isCompleted: ' + e); }
  if (!completed) { try { completed = !!r.completed; } catch (e) {} }
  return {
    id: str(r.calendarItemIdentifier),
    title: str(r.title) || '',
    due: due,
    allDayDue: allDayDue,
    completed: completed,
    completedAt: ms(r.completionDate),
    priority: Number(r.priority) || 0,
    notes: str(r.notes),
  };
}

function handle(req) {
  var store = $.EKEventStore.alloc.init;
  var res = { version: HELPER_VERSION, errors: [] };

  if (req.action === 'status') {
    res.calendarAccess = accessText(status(0));
    res.reminderAccess = accessText(status(1));
    return res;
  }

  if (req.action === 'toggle') {
    if (ensureAccess(store, 1) !== 3) throw new Error('No access to Reminders');
    var rid = req.reminderId;
    var item = null;
    try { item = store.calendarItemWithIdentifier(rid); if (item && item.isNil()) item = null; } catch (e) { item = null; }
    if (!item) {
      // Fallback: search all reminders (EventKit sometimes needs a fetch first).
      var all = fetchReminders(store, store.predicateForRemindersInCalendars(null));
      if (all && !all.isNil()) {
        for (var k = 0; k < all.count; k++) {
          var cand = all.objectAtIndex(k);
          if (str(cand.calendarItemIdentifier) === rid) { item = cand; break; }
        }
      }
    }
    if (!item) throw new Error('Reminder not found');
    item.setCompleted(!!req.completed);
    var ok = store.saveReminderCommitError(item, true, null);
    if (!ok) throw new Error('Reminders refused the change');
    res.ok = true;
    return res;
  }

  if (req.action === 'sources' || req.action === 'fetch') {
    var wantEvents = req.events !== false, wantRems = req.reminders !== false;
    var hiddenC = req.hiddenCalendars || [], hiddenL = req.hiddenLists || [];

    if (wantEvents) {
      var cst = ensureAccess(store, 0);
      res.calendarAccess = accessText(cst);
      if (cst === 3) {
        var cals = calendars(store, 0);
        res.knownCalendars = cals.map(function (c) { return { name: c.name, color: c.color }; });
        if (req.action === 'fetch') {
          var vis = cals.filter(function (c) { return hiddenC.indexOf(c.name) < 0; });
          var byId = {};
          res.calendars = vis.map(function (c) { var g = { name: c.name, color: c.color, events: [] }; byId[c.id] = g; return g; });
          if (vis.length) {
            var t0 = Date.now();
            var pred = store.predicateForEventsWithStartDateEndDateCalendars(nsdate(req.from), nsdate(req.to), toNSArray(vis));
            var evs = store.eventsMatchingPredicate(pred);
            for (var i = 0; i < evs.count; i++) {
              var e = evs.objectAtIndex(i);
              var g = byId[str(e.calendar.calendarIdentifier)];
              if (!g) continue;
              g.events.push({
                uid: str(e.calendarItemExternalIdentifier) || str(e.eventIdentifier),
                title: str(e.title) || '',
                start: ms(e.startDate),
                end: ms(e.endDate),
                allDay: !!e.isAllDay,
                location: str(e.location),
                rrule: null,
              });
            }
            res.eventsMs = Date.now() - t0;
          }
        }
      } else res.errors.push('Calendar access ' + accessText(cst));
    }

    if (wantRems) {
      var rst = ensureAccess(store, 1);
      res.reminderAccess = accessText(rst);
      if (rst === 3) {
        var lists = calendars(store, 1);
        res.knownLists = lists.map(function (c) { return { name: c.name, color: c.color }; });
        if (req.action === 'fetch') {
          var visL = lists.filter(function (c) { return hiddenL.indexOf(c.name) < 0; });
          var byIdL = {};
          res.lists = visL.map(function (c) { var g = { name: c.name, color: c.color, items: [] }; byIdL[c.id] = g; return g; });
          if (visL.length) {
            var t1 = Date.now();
            res.reminderRaw = [];
            var add = function (arr) {
              if (!arr) { res.reminderRaw.push('none'); return; }
              try { if (arr.isNil()) { res.reminderRaw.push('nil'); return; } } catch (e) {}
              res.reminderRaw.push(Number(arr.count));
              for (var j = 0; j < arr.count; j++) {
                var r = arr.objectAtIndex(j);
                var gl = byIdL[str(r.calendar.calendarIdentifier)];
                if (gl) gl.items.push(reminderItem(r));
              }
            };
            // Open reminders. Passing "no date" from JXA doesn't always arrive as nil,
            // so if this comes back empty, fetch everything and keep the open ones.
            var openArr = null;
            try {
              openArr = fetchReminders(store, store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars(null, null, toNSArray(visL)));
            } catch (e) { note('incomplete query: ' + e); }
            var openCount = 0;
            try { openCount = openArr && !openArr.isNil() ? Number(openArr.count) : 0; } catch (e) { openCount = 0; }
            if (openCount > 0) add(openArr);
            else {
              res.reminderRaw.push(openArr === null ? 'none' : 'empty');
              var allArr = fetchReminders(store, store.predicateForRemindersInCalendars(toNSArray(visL)));
              var openOnly = $.NSMutableArray.array;
              if (allArr && !allArr.isNil()) {
                for (var k = 0; k < allArr.count; k++) {
                  var rr = allArr.objectAtIndex(k);
                  var isDone = false;
                  try { isDone = !!rr.isCompleted; } catch (e) {}
                  if (!isDone) openOnly.addObject(rr);
                }
                res.reminderAllCount = Number(allArr.count);
              }
              add(openOnly);
            }
            if (req.completedSince) {
              add(fetchReminders(store, store.predicateForCompletedRemindersWithCompletionDateStartingEndingCalendars(
                nsdate(req.completedSince), $.NSDate.date, toNSArray(visL))));
            }
            res.remindersMs = Date.now() - t1;
            res.reminderNotes = NOTES;
          }
        }
      } else res.errors.push('Reminders access ' + accessText(rst));
    }
    return res;
  }
  throw new Error('Unknown action ' + req.action);
}

function run() {
  var dir = ObjC.unwrap($.NSBundle.mainBundle.bundlePath.stringByDeletingLastPathComponent);
  var req = null, res;
  try {
    req = JSON.parse(readText(dir + '/request.json'));
    res = handle(req);
  } catch (e) {
    res = { error: String(e) };
  }
  var id = req && req.id ? req.id : 'unknown';
  try { writeText(dir + '/response-' + id + '.json', JSON.stringify(res)); } catch (e) {}
}
