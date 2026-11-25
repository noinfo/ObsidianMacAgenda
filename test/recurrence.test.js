const assert=require('assert');
const P=require('../main.js');
const {occurrencesInRange:occ,eventsForDay,remindersForDay}=P._internals;
const d=(y,m,dd,h=0,mi=0)=>new Date(y,m-1,dd,h,mi).getTime();
const day=(y,m,dd)=>[d(y,m,dd),d(y,m,dd+1)];
const on=(ev,y,m,dd)=>occ(ev,...day(y,m,dd)).length>0;
// weekly MO,WE since 2020, 1h
let ev={uid:'a',start:d(2020,1,6,9),end:d(2020,1,6,10),rrule:'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE'};
assert(on(ev,2026,11,25)); assert(on(ev,2026,11,23)); assert(!on(ev,2026,11,24));
assert.equal(occ(ev,...day(2026,11,25))[0], d(2026,11,25,9));
// DST crossing keeps 9:00 local
assert.equal(new Date(occ(ev,...day(2026,7,1))[0]).getHours(),9);
// biweekly
ev={uid:'b',start:d(2026,11,2,10),end:d(2026,11,2,11),rrule:'FREQ=WEEKLY;INTERVAL=2'};
assert(on(ev,2026,11,16)); assert(!on(ev,2026,11,9)); assert(on(ev,2027,3,8));
// count
ev={uid:'c',start:d(2026,11,1,8),end:d(2026,11,1,9),rrule:'FREQ=DAILY;COUNT=3'};
assert(on(ev,2026,11,3)); assert(!on(ev,2026,11,4));
// until date-only inclusive
ev={uid:'c2',start:d(2026,11,1,8),end:d(2026,11,1,9),rrule:'FREQ=DAILY;UNTIL=20261105'};
assert(on(ev,2026,11,5)); assert(!on(ev,2026,11,6));
// monthly last friday
ev={uid:'d',start:d(2026,1,30,14),end:d(2026,1,30,15),rrule:'FREQ=MONTHLY;BYDAY=-1FR'};
assert(on(ev,2026,11,27)); assert(!on(ev,2026,11,20));
// monthly 2nd tuesday
ev={uid:'e',start:d(2026,1,13,14),end:d(2026,1,13,15),rrule:'FREQ=MONTHLY;BYDAY=2TU'};
assert(on(ev,2026,11,10));
// monthly on 31st skips Nov
ev={uid:'f',start:d(2026,1,31,9),end:d(2026,1,31,10),rrule:'FREQ=MONTHLY'};
assert(!on(ev,2026,11,30)); assert(on(ev,2026,12,31));
// yearly all-day birthday
ev={uid:'g',start:d(1990,11,25),end:d(1990,11,26),allDay:true,rrule:'FREQ=YEARLY'};
assert(on(ev,2026,11,25)); assert(!on(ev,2026,11,24)); assert(!on(ev,2026,11,26));
// exdate
ev={uid:'h',start:d(2026,11,2,9),end:d(2026,11,2,10),rrule:'FREQ=DAILY',exdates:[d(2026,11,25,9)]};
assert(!on(ev,2026,11,25)); assert(on(ev,2026,11,26));
// weekdays via weekly
ev={uid:'i',start:d(2026,1,5,8),end:d(2026,1,5,8,30),rrule:'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'};
assert(on(ev,2026,11,27)); assert(!on(ev,2026,11,28));
// multi-day non recurring
ev={uid:'j',start:d(2026,11,24,0),end:d(2026,11,27,0),allDay:true};
assert(on(ev,2026,11,25)); assert(!on(ev,2026,11,27));
// eventsForDay with moved occurrence dedupe
const cals=[{name:'Work',color:[65535,0,0],events:[
 {uid:'m',title:'Standup',start:d(2026,11,2,9),end:d(2026,11,2,9,15),rrule:'FREQ=DAILY'},
 {uid:'m',title:'Standup (moved)',start:d(2026,11,25,11),end:d(2026,11,25,11,15)},
 {uid:'n',title:'Holiday',start:d(2026,11,25),end:d(2026,11,26),allDay:true}]}];
const evs=eventsForDay(cals,new Date(2026,10,25));
assert.deepEqual(evs.map(e=>e.title),['Holiday','Standup (moved)']);
// perf: daily since 2000
ev={uid:'p',start:d(2000,1,1,7),end:d(2000,1,1,8),rrule:'FREQ=DAILY'};
let t=Date.now(); for(let i=0;i<200;i++) {delete ev._rule; occ(ev,...day(2026,11,25));} console.log('perf ms',Date.now()-t);
// count-based long (no skip-ahead) still fine
ev={uid:'q',start:d(2000,1,1,7),end:d(2000,1,1,8),rrule:'FREQ=DAILY;COUNT=20000'};
assert(on(ev,2026,11,25));
// reminders
const today=new Date(); today.setHours(0,0,0,0); const T=today.getTime();
const lists=[{name:'Inbox',color:'#ff0000',items:[
 {id:1,title:'due today',due:T+10*3600e3,completed:false},
 {id:2,title:'overdue',due:T-2*86400e3,completed:false},
 {id:3,title:'done today',due:T-5*86400e3,completed:true,completedAt:T+3600e3},
 {id:4,title:'undated',due:null,completed:false},
 {id:5,title:'allday',due:null,allDayDue:T,completed:false},
 {id:6,title:'tomorrow',due:T+30*3600e3,completed:false}]}];
const r=remindersForDay(lists,today,{showOverdueToday:true,showUndatedToday:false,showCompleted:true});
console.log(r.map(x=>x.title+':'+x.kind+':'+x.hasTime));
assert.deepEqual(r.map(x=>x.id),[2,5,1,3]);
console.log('all tests passed');
