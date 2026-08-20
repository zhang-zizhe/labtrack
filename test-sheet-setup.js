/**
 * Assertion-style backend checks: sheet setup and per-unit item targeting.
 *
 * setupNewLab() must build a working sheet from nothing, be safe to re-run, and
 * upgrade a sheet whose header predates a column.
 *
 *   node test-sheet-setup.js
 *
 * Unlike test-storage-layer.js this one asserts rather than snapshots — the
 * expected schema is written out independently below, so a wrong TABLE_HEADERS
 * is caught instead of being compared against itself.
 */
// The backend reads dates on the local clock and the Apps Script project runs in
// America/New_York, so the tests have to as well — otherwise a booking fixture
// written as "2026-08-16 11:00" means a different instant on a laptop in Baltimore
// than on a CI box in UTC, and whether it counts as under way changes with it.
// Set before any Date is constructed; Node reads TZ once.
process.env.TZ = "America/New_York";

const fs = require("fs");
const vm = require("vm");
// Reuse the in-memory sheet stub from the behaviour snapshot test.
const h = fs.readFileSync(__dirname + "/test-storage-layer.js", "utf8");
const makeSheet = new Function("return " + h.match(/function makeSheet[\s\S]*?\n}\n/)[0].replace(/^function makeSheet/, "function"))();

function fresh() {
  const sheets = { Sheet1: makeSheet("Sheet1", []) };
  return {
    __sheets: sheets,
    getId: () => "id",
    getSheets: () => Object.values(sheets),
    getSheetByName: n => sheets[n] || null,
    insertSheet(n) { sheets[n] = makeSheet(n, []); return sheets[n]; },
    deleteSheet(s) { delete sheets[s.__name]; },
    setActiveSheet: () => {},
  };
}

// Bookings are now judged against "now" (nothing may start more than
// MAX_LEAD_DAYS ahead), so a real clock would quietly rot every fixture date.
// Freeze it, and write the fixtures relative to this instant.
const NOW = new Date("2026-08-16T12:00:00Z");
class FrozenDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
  static now() { return NOW.getTime(); }
}

function load(ss) {
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch: () => ({}) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ __text: t, setMimeType() { return this; } }) },
    Utilities: { base64DecodeWebSafe: s => Buffer.from(String(s), "base64"), formatDate: () => "x" },
    Session: { getScriptTimeZone: () => "America/New_York" },
    DriveApp: {}, Logger: { log() {} }, console: { log() {}, error() {} },
    JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error, Date: FrozenDate, parseInt, parseFloat, isNaN,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("/Users/zizhe/labtrack/google-apps-script.js", "utf8"), ctx, { filename: "gas" });
  return ctx;
}

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

const ss = fresh();
const ctx = load(ss);

console.log("first run on an empty spreadsheet");
ctx.setupNewLab();
// Asserted independently of the source, so a wrong TABLE_HEADERS is caught
// rather than compared against itself. Must match SETUP.md's documented schema.
const SCHEMA = {
  Items:      ["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"],
  Deliveries: ["id","item","qty","unit","from","receivedBy","date","tracking","status"],
  Checkouts:  ["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails","qty","fromTime","toTime","notes"],
  Orders:     ["id","store","item","link","qty","unit","price","cat","requestedBy","reason","urgency","date","status","requestedByEmail"],
  Settings:   ["key","value"],
  DeleteLog:  ["date","type","name","details","deletedBy"],
  AuditLog:   ["date","user","email","action","details"],
  SlackQueue: ["time","emoji","title","details","fields"],
};
const expected = Object.keys(SCHEMA);
expected.forEach(n => {
  const s = ss.__sheets[n];
  check(n + " created with documented headers",
        !!s && JSON.stringify(s.__data[0]) === JSON.stringify(SCHEMA[n]));
});
check("stray Sheet1 removed", !ss.__sheets.Sheet1);
const st = ctx.readSettings();
check("categories seeded (8)", JSON.parse(st.categories).length === 8);
// Both, and lowercased: the PI is an admin from the first minute rather than after
// somebody remembers, and two admins means one can always repair the list from
// inside the app if the other is mistyped.
check("admins seeded lowercase", JSON.parse(st.admins)[0] === "zzhan409@jh.edu");
check("the PI is seeded as an admin too", JSON.parse(st.admins).indexOf("hhu49@jh.edu") >= 0);
check("seeded as sign-in names, not mail aliases",
      JSON.parse(st.admins).every(a => a.endsWith("@jh.edu")));
check("members seeded empty",   JSON.parse(st.members).length === 0);
check("slack_mode seeded",      st.slack_mode === "all");
check("isAdmin works for seeded admin", ctx.isAdmin("zzhan409@jh.edu") === true);
check("isAdmin false for stranger",     ctx.isAdmin("nobody@jh.edu") === false);
check("isMember true (empty members)",  ctx.isMember("anyone@jh.edu") === true);

console.log("re-run must not clobber");
ctx.writeSetting("slack_mode", "digest");
ctx.setupNewLab();
check("existing setting preserved", ctx.readSettings().slack_mode === "digest");
check("no duplicate tabs", Object.keys(ss.__sheets).length === expected.length);
check("Settings has no duplicate rows", ss.__sheets.Settings.__data.length === 5); // header + 4

console.log("upgrading a sheet whose header predates a column");
{
  // Checkouts as it existed before qty was added, with a row already in it.
  const old = ["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails"];
  const ss2 = fresh();
  ss2.__sheets.Checkouts = makeSheet("Checkouts", [old.slice(), ["c9","i9","Old Arm","Someone","","","Active","a@jh.edu",""]]);
  const c2 = load(ss2);
  c2.setupNewLab();

  const hdr = ss2.__sheets.Checkouts.__data[0];
  check("every missing column appended", ["qty","fromTime","toTime"].every(h => hdr.indexOf(h) >= 0));
  check("pre-existing row untouched", ss2.__sheets.Checkouts.__data[1][2] === "Old Arm");

  // A write after the upgrade must land under the right heading.
  c2.appendRow("Checkouts", {id:"c10",itemId:"i10",item:"New Arm",user:"Zizhe",out:"",ret:"",
                             status:"Active",checkedOutByEmail:"z@jh.edu",groupEmails:"",qty:3});
  const rows = c2.readTable("Checkouts");
  const added = rows.find(r => r.id === "c10");
  check("qty readable after upgrade", added && Number(added.qty) === 3);
  check("other fields still aligned", added && added.item === "New Arm" && added.status === "Active");
}

console.log("checkout targets one unit, not every item sharing its name");
{
  // Two split units: same name, different ids and labels — what handleSplit produces.
  const ss3 = fresh();
  ss3.__sheets.Items = makeSheet("Items", [
    ["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"],
    ["u1","TEST ROBOT","Robots & Motors",1,"units","H306",0,"","","Available","[]","","RM-000001-001",false,false],
    ["u2","TEST ROBOT","Robots & Motors",1,"units","H306",0,"","","Available","[]","","RM-000001-002",false,false],
  ]);
  const c3 = load(ss3);

  // Check out the SECOND unit. Matching on name would have moved the first.
  c3.updateItemStatus("u2", "TEST ROBOT", "Zizhe", "add");
  const after = c3.readTable("Items");
  const u1 = after.find(r => r.id === "u1"), u2 = after.find(r => r.id === "u2");
  check("picked unit went In Use",       u2.status === "In Use");
  check("its sibling stayed Available",  u1.status === "Available");
  check("usedBy set on the picked unit", JSON.stringify(u2.usedBy) === '["Zizhe"]');
  check("sibling usedBy untouched",      JSON.stringify(u1.usedBy) === "[]");

  // Returning it must also only touch that unit.
  c3.updateItemStatus("u2", "TEST ROBOT", "Zizhe", "remove");
  const back = c3.readTable("Items");
  check("return clears only that unit", back.find(r=>r.id==="u2").status === "Available"
                                     && JSON.stringify(back.find(r=>r.id==="u2").usedBy) === "[]");

  // Legacy rows carry no itemId, so the name is all there is to fall back on.
  c3.updateItemStatus("", "TEST ROBOT", "Zizhe", "add");
  const legacy = c3.readTable("Items");
  check("no itemId falls back to name", legacy.some(r => r.status === "In Use"));
}

console.log("label IDs count per category and stay short");
{
  const ss4 = fresh();
  const c4 = load(ss4);
  c4.setupNewLab();
  c4.verifyToken = () => ({ email: "zzhan409@jh.edu", name: "Z", oid: "o" });

  const add = (name, cat, wanted) => {
    const res = c4.doPost({ postData: { contents: JSON.stringify({ token: "t", action: "addItem",
      item: { id: "x"+Math.abs(name.length*7+cat.length), name, cat, qty: 1, unit: "units", loc: "",
              minQty: 0, img: "", desc: "", status: "Available", usedBy: [], serial: "",
              displayId: wanted, shared: false, consumable: false } }) } });
    return JSON.parse(res.__text).displayId;
  };

  check("first robot is RM-001",        add("Arm",   "Robots & Motors",  "RM-000") === "RM-001");
  check("second robot is RM-002",       add("Base",  "Robots & Motors",  "RM-000") === "RM-002");
  // The bug: a shared counter made this SV-003 because two RM items already existed.
  check("first sensor is SV-001",       add("Cam",   "Sensors & Vision", "SV-000") === "SV-001");
  check("second sensor is SV-002",      add("Lidar", "Sensors & Vision", "SV-000") === "SV-002");
  check("robots keep their own run",    add("Servo", "Robots & Motors",  "RM-000") === "RM-003");

  // Split units hang off a base and use a two-digit suffix.
  check("first split unit is RM-001-01",  add("Arm", "Robots & Motors", "RM-001-01") === "RM-001-01");
  check("second split unit is RM-001-02", add("Arm", "Robots & Motors", "RM-001-01") === "RM-001-02");
  check("a split does not bump the main run", add("Gripper", "Robots & Motors", "RM-000") === "RM-004");
}

console.log("a requester may revise a request, but not after it is approved");
{
  const ss5 = fresh();
  const c5 = load(ss5);
  c5.setupNewLab();
  const asRequester = () => { c5.verifyToken = () => ({ email: "member@jh.edu", name: "Member", oid: "m" }); };
  const asAdmin     = () => { c5.verifyToken = () => ({ email: "zzhan409@jh.edu", name: "Z", oid: "a" }); };

  const post = p => JSON.parse(c5.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: "t" }, p)) } }).__text);

  asRequester();
  post({ action: "addOrder", order: { id: "o1", store: "Amazon", item: "M3 screws", link: "", qty: 2,
         unit: "box", price: "$10", cat: "Tools & Hardware", requestedBy: "Member", reason: "restock",
         urgency: "Normal", date: "2026-08-17", status: "Pending", requestedByEmail: "member@jh.edu" } });

  check("requester can edit while pending",
        post({ action: "updateOrder", order: { id: "o1", qty: 5 } }).ok === true);

  asAdmin();
  check("admin approves", post({ action: "updateOrderStatus", orderId: "o1", status: "Approved" }).ok === true);

  asRequester();
  const blocked = post({ action: "updateOrder", order: { id: "o1", qty: 99 } });
  check("requester blocked once approved", blocked.error === "Forbidden");
  check("the quantity really did not move",
        c5.readTable("Orders").find(o => o.id === "o1").qty === 5);

  asAdmin();
  check("admin can still fix it",
        post({ action: "updateOrder", order: { id: "o1", qty: 6 } }).ok === true);
}

console.log("shared items book by the hour; long holds wait for an admin");
{
  // Frozen "now" is 2026-08-16, so every start below sits inside the 31-day lead
  // window. Each scenario gets its own item — the queue rules make state stick
  // around, and sharing one item between blocks made failures read as cascades.
  const ss6 = fresh();
  const item = (id,name,shared,label) =>
    [id,name,shared?"Compute & Electronics":"Robots & Motors",1,"units","H306",0,"","","Available","[]","",label,shared,false];
  ss6.__sheets.Items = makeSheet("Items", [
    ["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"],
    item("s1","Oscilloscope",   true,  "CE-001"),   // hourly booking
    item("s2","Spare Scope",    true,  "CE-002"),   // shared queue-jumping
    item("s3","Bench Scope",    true,  "CE-003"),   // editing a request
    item("s4","Loan Scope",     true,  "CE-004"),   // withdrawing a request
    item("p1","Franka Arm",     false, "RM-001"),   // approval of a sole-use hold
    item("p2","Spare Arm",      false, "RM-002"),   // sole-use competition
    item("p3","Queue Rig",      false, "RM-003"),   // sole-use queue-jumping
    item("p4","Lead Rig",       false, "RM-004"),   // how far ahead you may book
    item("p5","Reject Rig",     false, "RM-005"),   // rejecting leaves the item alone
    item("p6","Solo Rig",       false, "RM-006"),   // rule 2 on a sole-use item
    item("p7","Range Rig",      false, "RM-007"),   // dates that do not make sense
    item("p8","Group Rig",      false, "RM-008"),   // who is allowed to return it
    item("p9","Long Rig",       false, "RM-009"),   // how long a hold may run
  ]);
  const c6 = load(ss6);
  const asAdmin  = () => { c6.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" }); };
  const asMember = () => { c6.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" }); };
  const post = p => JSON.parse(c6.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const book = (id,user,out,ret,from,to,item,itemId) => post({ action:"addCheckout", checkout:{
    id, itemId: itemId||"s1", item: item||"Oscilloscope", user, out, ret, status:"Active",
    checkedOutByEmail:"x@jh.edu", groupEmails:"", qty:1, fromTime:from||"", toTime:to||"" } });
  const row = id => c6.readTable("Checkouts").find(x => x.id === id);
  const used = id => c6.readTable("Items").find(i => i.id === id).usedBy;

  asAdmin();
  c6.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));

  // ── the daily window ──
  check("morning slot books",
        book("k1","Ann","2026-09-01 09:00","2026-09-03 12:00","09:00","12:00").ok === true);
  check("afternoon slot on the same days books",
        book("k2","Bob","2026-09-01 09:00","2026-09-03 12:00","13:00","17:00").ok === true);
  check("an overlapping window is refused",
        book("k3","Cat","2026-09-02 09:00","2026-09-02 12:00","11:00","14:00").error === "Clash");
  check("all-day clashes with any window",
        book("k4","Dan","2026-09-02 09:00","2026-09-02 12:00","","").error === "Clash");
  check("a later date range is free",
        book("k5","Eve","2026-09-10 09:00","2026-09-11 12:00","10:00","11:00").ok === true);
  check("touching endpoints do not clash",
        book("k6","Fay","2026-09-01 09:00","2026-09-03 12:00","12:00","13:00").ok === true);

  // A sole-use item is clash-checked by date like any other, and a booking that
  // ends before another begins is not a conflict — the two can both stand.
  check("a sole-use booking goes in",
        book("k7","Gil","2026-09-01 09:00","2026-09-02 12:00","","","Franka Arm","p1").ok === true);
  check("and asking for it in a later, clear stretch is not refused",
        book("k7b","Gwen","2026-09-03 09:00","2026-09-04 12:00","","","Franka Arm","p1").ok === true);

  // ── over a week: recorded, but the item stays free until someone agrees ──
  const long = book("k8","Hal","2026-09-05 09:00","2026-09-24 09:00","","","Franka Arm","p1");
  check("a long hold comes back pending", long.pending === true);
  check("and says it was the length", long.reason === "long");
  check("its row is Pending Approval", row("k8").status === "Pending Approval");
  check("and the item is not marked In Use by asking", used("p1").indexOf("Hal") < 0);

  asMember();
  check("a member cannot approve it",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Forbidden");

  asAdmin();
  check("an admin can approve a hold nothing overlaps",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).ok === true);
  check("which makes it Active", row("k8").status === "Active");
  // Approving a booking that starts on the 5th does not take the arm off the shelf
  // on the 16th of August. syncItemStatuses() hands it over when the day comes.
  check("but the arm is not handed over three weeks early", used("p1").indexOf("Hal") < 0);
  check("and the item is still Available today", c6.readTable("Items").find(i=>i.id==="p1").status === "Available");
  check("deciding twice is refused",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Not pending");

  // ── the day arrives ──
  // The sweep derives the flag from the bookings that are live now, so it is safe
  // to run at any time and any number of times.
  const nowBook = book("k8b","Hal","2026-08-15 09:00","2026-08-30 17:00","","","Reject Rig","p5");
  check("a hold that is already under way waits for approval too", nowBook.pending === true);
  post({ action:"decideCheckout", checkoutId:"k8b", approve:true });
  check("approving one that has already started hands it over now",
        used("p5").indexOf("Hal") >= 0 &&
        c6.readTable("Items").find(i=>i.id==="p5").status === "In Use");
  check("the sweep leaves a settled lab alone", c6.syncItemStatuses() === 0);
  check("and it is still In Use afterwards",
        c6.readTable("Items").find(i=>i.id==="p5").status === "In Use");

  // ── asking reserves nothing, so several people may ask ──
  const long2 = book("k9","Ivy","2026-09-06 09:00","2026-09-25 09:00","13:00","16:00");
  check("a long shared hold is pending too", long2.pending === true);
  check("with nobody else in the queue yet", long2.competing.length === 0);
  const long2b = book("k10","Jon","2026-09-08 09:00","2026-09-28 09:00","13:00","16:00");
  check("a second request for the same slot is allowed", long2b.pending === true);
  check("and is told who it is up against",
        long2b.competing.length === 1 && long2b.competing[0].user === "Ivy");
  check("both are still waiting",
        ["k9","k10"].every(id => row(id).status === "Pending Approval"));
  check("a non-overlapping window is unaffected",
        book("k11","Kim","2026-09-08 09:00","2026-09-09 09:00","17:00","18:00").ok === true);
  check("and did not have to wait", !book("k11b","Kim","2026-09-08 09:00","2026-09-09 09:00","18:00","19:00").pending);

  // The admin picks one. The loser is not auto-rejected — it just stops being
  // approvable, which is what tells the admin to reject it or ask for new dates.
  check("the admin can approve either one",
        post({ action:"decideCheckout", checkoutId:"k9", approve:true }).ok === true);
  check("the runner-up can no longer be approved",
        post({ action:"decideCheckout", checkoutId:"k10", approve:true }).error === "Clash");
  check("but it is still there to reject", row("k10").status === "Pending Approval");
  check("rejecting the runner-up works",
        post({ action:"decideCheckout", checkoutId:"k10", approve:false }).ok === true);

  // ── rejecting leaves the item alone ──
  // On its own rig: Franka Arm is held by Hal's approved hold from here on, and
  // rule 2 now covers sole-use items, so a booking across it would be refused
  // rather than queued — which is the point of the checks above, not of these.
  const long3 = book("k12","Lee","2026-09-10 09:00","2026-09-29 09:00","","","Reject Rig","p5");
  check("another long hold is pending", long3.pending === true);
  check("rejecting marks it Rejected",
        post({ action:"decideCheckout", checkoutId:"k12", approve:false }).ok === true &&
        row("k12").status === "Rejected");
  check("a rejected request never touched the item", used("p5").indexOf("Lee") < 0);
  check("a rejected slot frees up for someone else",
        !book("k13","Moe","2026-09-11 09:00","2026-09-12 09:00","","","Reject Rig","p5").pending);

  // ── two people wanting the same sole-use item is the ordinary case, and the
  // one the availability filter cannot catch: a pending request marks nothing In Use.
  const solo1 = book("s20","Pat","2026-09-01 09:00","2026-09-20 09:00","","","Spare Arm","p2");
  const solo2 = book("s21","Quinn","2026-09-10 09:00","2026-09-30 09:00","","","Spare Arm","p2");
  check("both may ask for the same sole-use item", solo1.pending === true && solo2.pending === true);
  check("and the second is told about the first",
        solo2.competing.length === 1 && solo2.competing[0].user === "Pat");
  const solo3 = book("s22","Rex","2026-08-20 09:00","2026-08-31 09:00","","","Spare Arm","p2");
  check("a long hold in a clear stretch competes with nobody",
        solo3.pending === true && solo3.competing.length === 0);

  // ── a short booking must not walk past someone already queuing ──
  const q1 = book("q1","Sam","2026-09-01 09:00","2026-09-25 09:00","","","Queue Rig","p3");
  check("a long request goes in the queue", q1.pending === true && q1.reason === "long");
  const q2 = book("q2","Tess","2026-09-10 09:00","2026-09-12 09:00","","","Queue Rig","p3");
  check("a 2-day booking over that slot waits too", q2.pending === true);
  check("and says why", q2.reason === "queue");
  check("naming who it is up against", q2.competing.length === 1 && q2.competing[0].user === "Sam");
  check("the item is still on the shelf", used("p3").indexOf("Tess") < 0);
  check("a short booking clear of the queue goes straight through",
        !book("q3","Uma","2026-08-18 09:00","2026-08-20 09:00","","","Queue Rig","p3").pending);

  // The queue is transitive: q2 joined it, so it holds the slot open too.
  post({ action:"decideCheckout", checkoutId:"q1", approve:false });
  check("clearing one of two still leaves a queue",
        book("q4","Vic","2026-09-10 09:00","2026-09-12 09:00","","","Queue Rig","p3").pending === true);
  post({ action:"decideCheckout", checkoutId:"q2", approve:false });
  post({ action:"decideCheckout", checkoutId:"q4", approve:false });
  check("an empty queue means a short booking is ordinary again",
        !book("q4b","Vic","2026-09-10 09:00","2026-09-12 09:00","","","Queue Rig","p3").pending);

  // Shared items: only an overlapping window queues, not merely the same days.
  const q5 = book("q5","Wes","2026-09-01 09:00","2026-09-25 09:00","09:00","12:00","Spare Scope","s2");
  check("a long shared request queues", q5.pending === true);
  const q6 = book("q6","Xin","2026-09-05 09:00","2026-09-06 09:00","09:00","12:00","Spare Scope","s2");
  check("a short booking in the same window waits", q6.pending === true && q6.reason === "queue");
  check("a short booking in a different window does not",
        !book("q7","Yan","2026-09-05 09:00","2026-09-06 09:00","14:00","16:00","Spare Scope","s2").pending);

  // ── how far ahead you may book ──
  // Frozen now is 2026-08-16T12:00Z, so the limit falls on 2026-09-16T12:00Z.
  check("a booking just inside the window is fine",
        book("L1","Amy","2026-09-15 09:00","2026-09-16 09:00","","","Lead Rig","p4").ok === true);
  const far = book("L2","Ben","2026-10-20 09:00","2026-10-21 09:00","","","Lead Rig","p4");
  check("one past it is refused", far.error === "Too far ahead");
  check("with a message that says how far is allowed", /31 days/.test(far.detail));
  check("and nothing was written", row("L2") === undefined);
  check("the cap applies to long requests as well, not only short ones",
        book("L3","Cy","2026-11-01 09:00","2026-12-01 09:00","","","Lead Rig","p4").error === "Too far ahead");
  check("a start in the past is still fine — checkouts get logged after the fact",
        book("L4","Dot","2026-08-10 09:00","2026-08-12 09:00","","","Lead Rig","p4").ok === true);

  // ── editing a request that is still waiting ──
  const long4 = book("k14","Ned","2026-09-01 09:00","2026-09-20 09:00","09:00","12:00","Bench Scope","s3");
  check("a fresh request is pending", long4.pending === true);
  check("its owner can move the dates",
        post({ action:"updateCheckout", checkoutId:"k14", checkout:{ out:"2026-09-05 09:00", ret:"2026-09-24 09:00" } }).ok === true);
  check("the move stuck", row("k14").out === "2026-09-05 09:00");
  check("and it is still pending", row("k14").status === "Pending Approval");
  check("the window can be changed too",
        post({ action:"updateCheckout", checkoutId:"k14", checkout:{ fromTime:"14:00", toTime:"16:00" } }).ok === true &&
        row("k14").fromTime === "14:00");
  check("but not past the lead limit",
        post({ action:"updateCheckout", checkoutId:"k14", checkout:{ out:"2026-12-01 09:00", ret:"2026-12-03 09:00" } }).error === "Too far ahead");
  check("so it stays where it was", row("k14").out === "2026-09-05 09:00");

  // A member may not edit someone else's request, nor smuggle in a status.
  asMember();
  check("a stranger cannot edit it",
        post({ action:"updateCheckout", checkoutId:"k14", checkout:{ ret:"2026-09-30 09:00" } }).error === "Forbidden");
  asAdmin();
  const sneaky = post({ action:"updateCheckout", checkoutId:"k14", checkout:{ status:"Active", user:"Someone Else" } });
  check("status cannot be patched in", sneaky.ok === true && row("k14").status === "Pending Approval");
  check("nor can the person", row("k14").user === "Ned");

  // Editing re-runs the rules: shorten it under the limit and it stops needing one.
  const shortened = post({ action:"updateCheckout", checkoutId:"k14", checkout:{ out:"2026-09-05 09:00", ret:"2026-09-07 09:00" } });
  check("shortening it clears the approval", shortened.pending === false);
  check("it becomes a plain checkout", row("k14").status === "Active");
  // Active, not in his hands: the shortened booking starts on 5 September and the
  // clock says 16 August. The sweep hands it over on the day.
  check("but not handed over until the day it starts", used("s3").indexOf("Ned") < 0);
  check("a decided request can no longer be edited",
        post({ action:"updateCheckout", checkoutId:"k14", checkout:{ ret:"2026-09-08 09:00" } }).error === "Not pending");

  // ── withdrawing your own request ──
  const w1 = book("w1","Pia","2026-09-02 09:00","2026-09-21 09:00","09:00","10:00","Loan Scope","s4");
  check("a request to withdraw goes in", w1.pending === true);
  asMember();
  check("a stranger cannot withdraw it",
        post({ action:"cancelCheckout", checkoutId:"w1" }).error === "Forbidden");
  asAdmin();
  check("the owner or an admin can", post({ action:"cancelCheckout", checkoutId:"w1" }).ok === true);
  check("and the row is gone, not just marked", row("w1") === undefined);
  check("the withdrawal is logged",
        c6.readTable("DeleteLog").some(r => r.type === "Request" && r.name === "Loan Scope"));
  check("withdrawing an approved checkout is refused",
        post({ action:"cancelCheckout", checkoutId:"k8" }).error === "Not pending");
  check("withdrawing frees the queue",
        !book("w2","Rue","2026-09-02 09:00","2026-09-03 09:00","09:00","10:00","Loan Scope","s4").pending);

  // Editing into an Active booking is refused just like making one there.
  const long5 = book("k15","Ola","2026-09-08 09:00","2026-09-27 09:00","09:00","12:00","Bench Scope","s3");
  check("another request goes in", long5.pending === true);
  check("moving it onto Ned's active slot is refused",
        post({ action:"updateCheckout", checkoutId:"k15", checkout:{ out:"2026-09-05 09:00", ret:"2026-09-07 09:00", fromTime:"14:00", toTime:"16:00" } }).error === "Clash");
  check("so it stays where it was", row("k15").out === "2026-09-08 09:00");

  // ── rule 2 covers sole-use items too ──
  // It used to skip them, on the grounds that the In Use flag kept them exclusive.
  // The flag is set from a browser copy that is a poll old, and it knows nothing
  // about dates, so it did neither job.
  check("a sole-use booking goes in",
        book("u1","Sam","2026-09-01 09:00","2026-09-03 17:00","","","Solo Rig","p6").ok === true);
  check("a second one across the same days is refused",
        book("u2","Tam","2026-09-02 09:00","2026-09-04 17:00","","","Solo Rig","p6").error === "Clash");
  check("and nothing was written", row("u2") === undefined);
  check("one after it ends is fine",
        book("u3","Uma","2026-09-03 17:00","2026-09-05 17:00","","","Solo Rig","p6").ok === true);
  // Both bookings start in September and the clock says August, so nobody is
  // holding it yet — what stops it going to two people is that Tam's was refused.
  check("nobody is holding it yet, since neither has started", used("p6").length === 0);
  check("and the refused one left no row behind", row("u2") === undefined);
  // Rule 2 refuses before rule 3 decides, so an active booking is not something
  // you may queue behind — only a *pending* one is (rule 4).
  check("a long request across an active booking is refused, not queued",
        book("u4","Vic","2026-09-01 09:00","2026-09-25 09:00","","","Solo Rig","p6").error === "Clash");
  check("a long request in a clear stretch still queues",
        book("u5","Wyn","2026-09-08 09:00","2026-09-28 09:00","","","Solo Rig","p6").pending === true);
  check("and someone else may queue behind it",
        book("u6","Zed","2026-09-10 09:00","2026-09-12 09:00","","","Solo Rig","p6").reason === "queue");

  // ── dates that do not make sense ──
  // Every rule is a comparison, and a comparison against a non-date is false, so
  // these used to slip past all five at once rather than being refused by one.
  const bad = (id,out,ret,from,to) => book(id,"Wes",out,ret,from,to,"Range Rig","p7");
  check("a return before the checkout is refused",
        bad("b1","2026-09-10 09:00","2026-09-08 09:00").error === "Bad dates");
  check("with a message a person can act on",
        /after the checkout date/.test(bad("b2","2026-09-10 09:00","2026-09-08 09:00").detail));
  check("a return equal to the checkout is refused",
        bad("b3","2026-09-10 09:00","2026-09-10 09:00").error === "Bad dates");
  check("a missing return date is refused", bad("b4","2026-09-10 09:00","").error === "Bad dates");
  check("an unparseable date is refused", bad("b5","2026-09-10 09:00","banana").error === "Bad dates");
  check("a window with only one end is refused",
        bad("b6","2026-09-10 09:00","2026-09-11 09:00","09:00","").error === "Bad dates");
  check("a window that ends before it starts is refused",
        bad("b7","2026-09-10 09:00","2026-09-11 09:00","18:00","09:00").error === "Bad dates");
  check("and none of them were written",
        ["b1","b2","b3","b4","b5","b6","b7"].every(id => row(id) === undefined));
  check("an ordinary range still books",
        bad("b8","2026-09-10 09:00","2026-09-11 17:00").ok === true);
  // Rule 3's queue is transitive, so a booking running to next June puts every
  // overlapping one behind an admin. The cap sits past any real hold, to catch a
  // mistyped year rather than to shorten a genuine semester.
  check("a hold longer than the cap is refused",
        bad("b10","2026-09-01 09:00","2027-09-01 09:00").error === "Bad dates");
  check("with a message pointing at the likely cause",
        /check the return date's year/.test(bad("b11","2026-09-01 09:00","2027-09-01 09:00").detail));
  // Its own rig: Range Rig is busy from the checks above, and a clash would refuse
  // these for the wrong reason.
  check("a long-but-plausible hold still goes in",
        book("b12","Wes","2026-09-01 09:00","2026-11-01 09:00","","","Long Rig","p9").pending === true);
  check("and a request cannot be edited into one", (() => {
    const q = book("b13","Yun","2026-09-02 09:00","2026-09-25 09:00","","","Long Rig","p9");
    return q.pending === true &&
      post({ action:"updateCheckout", checkoutId:"b13", checkout:{ ret:"2028-01-01 09:00" } }).error === "Bad dates";
  })());
  check("an editor cannot move a request onto a backwards range", (() => {
    const q = book("b9","Xan","2026-09-12 09:00","2026-10-01 09:00","","","Range Rig","p7");
    return q.pending === true &&
      post({ action:"updateCheckout", checkoutId:"b9", checkout:{ ret:"2026-09-11 09:00" } }).error === "Bad dates";
  })());

  // ── the row says who actually asked ──
  asMember();
  check("a member's booking is filed under their own name", (() => {
    post({ action:"addCheckout", checkout:{ id:"f1", itemId:"p7", item:"Range Rig", user:"Somebody Else",
      out:"2026-09-15 09:00", ret:"2026-09-16 09:00", status:"Active",
      checkedOutByEmail:"victim@jh.edu", groupEmails:"", qty:1, fromTime:"", toTime:"" } });
    const r = row("f1");
    return r.checkedOutByEmail === "member@jh.edu" && r.user === "Member";
  })());
  check("and a member cannot post themselves an approved booking", (() => {
    // Inside the 31-day lead window, on a rig nothing else is holding.
    post({ action:"addCheckout", checkout:{ id:"f2", itemId:"p5", item:"Reject Rig", user:"Member",
      out:"2026-09-13 09:00", ret:"2026-10-13 09:00", status:"Active",
      checkedOutByEmail:"member@jh.edu", groupEmails:"", qty:1, fromTime:"", toTime:"" } });
    return row("f2").status === "Pending Approval";
  })());
  // Returning is the checkout owner's, their listed group, or an admin's. This
  // used to be covered only by test-storage-layer.js's non-admin run, which could
  // exercise it only because addCheckout let the caller forge whose row it was.
  asAdmin();
  post({ action:"addCheckout", checkout:{ id:"g1", itemId:"p8", item:"Group Rig", user:"Yara",
    out:"2026-09-08 09:00", ret:"2026-09-09 09:00", status:"Active",
    checkedOutByEmail:"yara@jh.edu", groupEmails:"pal@jh.edu", qty:1, fromTime:"", toTime:"" } });
  asMember();
  check("a stranger cannot return someone else's checkout",
        post({ action:"returnItem", checkoutId:"g1" }).error === "Forbidden");
  check("someone on the group list can",
        (() => { c6.verifyToken = () => ({ email:"pal@jh.edu", name:"Pal", oid:"p" });
                 return post({ action:"returnItem", checkoutId:"g1" }).ok === true; })());
  check("and the row says Returned", row("g1").status === "Returned");
  // Returning twice used to rewrite the recorded time and pull the item off
  // whoever had picked it up since; and a request still waiting for an admin
  // could be "returned", freeing an item it had never been given.
  check("returning it again is refused",
        post({ action:"returnItem", checkoutId:"g1" }).error === "Not out");
  check("and a request still waiting cannot be returned at all", (() => {
    c6.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });
    post({ action:"addCheckout", checkout:{ id:"g2", itemId:"p8", item:"Group Rig", user:"Zia",
      out:"2026-08-20 09:00", ret:"2026-09-20 09:00", status:"Active",
      checkedOutByEmail:"zia@jh.edu", groupEmails:"", qty:1, fromTime:"", toTime:"" } });
    return row("g2").status === "Pending Approval" &&
           post({ action:"returnItem", checkoutId:"g2" }).error === "Not out" &&
           row("g2").status === "Pending Approval";
  })());

  asAdmin();
  check("an admin may still log a checkout for someone else", (() => {
    post({ action:"addCheckout", checkout:{ id:"f3", itemId:"p6", item:"Solo Rig", user:"Yara",
      out:"2026-09-06 09:00", ret:"2026-09-07 09:00", status:"Active",
      checkedOutByEmail:"yara@jh.edu", groupEmails:"", qty:1, fromTime:"", toTime:"" } });
    const r = row("f3");
    return r.user === "Yara" && r.checkedOutByEmail === "yara@jh.edu";
  })());
}

console.log("purchase approval is the admin's, whichever door you knock on");
{
  const ss7 = fresh();
  const c7 = load(ss7);
  c7.setupNewLab();
  c7.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  const asAdmin  = () => { c7.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" }); };
  const asMember = () => { c7.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" }); };
  const post = p => JSON.parse(c7.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const ord  = id => c7.readTable("Orders").find(o => o.id === id);
  const mkOrder = (id, extra) => Object.assign({ id, store:"Amazon", item:"GPU", link:"", qty:1, unit:"ea",
    price:"$2400", cat:"Tools & Hardware", requestedBy:"Member", reason:"research", date:"2026-08-16",
    urgency:"Normal", status:"Pending", requestedByEmail:"member@jh.edu" }, extra || {});

  asMember();
  check("the guarded door refuses a member",
        post({ action:"addOrder", order:mkOrder("o1") }).ok === true &&
        post({ action:"updateOrderStatus", orderId:"o1", status:"Approved" }).error === "Forbidden");
  // updateOrderStatus is admin-only and says so. updateOrder used to carry `status`
  // in its whitelist, so the same member could walk round the back and set it.
  post({ action:"updateOrder", order:{ id:"o1", status:"Approved" } });
  check("and so does the side door", ord("o1").status === "Pending");
  check("a member may still fix the details of their own request",
        post({ action:"updateOrder", order:{ id:"o1", qty:2, price:"$4800" } }).ok === true &&
        ord("o1").qty === 2 && ord("o1").price === "$4800");
  check("an order cannot be born approved",
        post({ action:"addOrder", order:mkOrder("o2", { status:"Approved" }) }).ok === true &&
        ord("o2").status === "Pending");
  check("nor filed under someone else's name",
        post({ action:"addOrder", order:mkOrder("o3", { requestedByEmail:"pi@jh.edu", requestedBy:"The PI" }) }).ok === true &&
        ord("o3").requestedByEmail === "member@jh.edu" && ord("o3").requestedBy === "Member");

  asAdmin();
  check("an admin approves through the front door",
        post({ action:"updateOrderStatus", orderId:"o1", status:"Approved" }).ok === true &&
        ord("o1").status === "Approved");
  check("and may still edit an approved order",
        post({ action:"updateOrder", order:{ id:"o1", status:"Ordered" } }).ok === true &&
        ord("o1").status === "Ordered");
  asMember();
  check("the requester can no longer touch it once it is decided",
        /already/.test(post({ action:"updateOrder", order:{ id:"o1", qty:9 } }).detail || ""));
}

console.log("what an item IS is an admin's; what it is LIKE is anyone's");
{
  const ssB = fresh();
  const cB = load(ssB);
  cB.setupNewLab();
  cB.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  const asAdmin  = () => { cB.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" }); };
  const asMember = () => { cB.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" }); };
  const post = p => JSON.parse(cB.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const it = () => cB.readTable("Items")[0];

  asAdmin();
  post({ action:"addItem", item:{ id:"x1", name:"Scope", cat:"Compute & Electronics", qty:4, unit:"units",
    loc:"H306", minQty:0, img:"", desc:"", status:"Available", usedBy:[], serial:"SN-1",
    displayId:"CE-001", shared:true, consumable:false } });

  asMember();
  const whole = () => ({ id:"x1", name:it().name, cat:it().cat, qty:it().qty, unit:it().unit, loc:it().loc,
    minQty:it().minQty, img:it().img, desc:it().desc, serial:it().serial,
    status:it().status, displayId:it().displayId, shared:it().shared, consumable:it().consumable });

  const r1 = post({ action:"updateItem", item: Object.assign(whole(), { loc:"H310", qty:3, name:"Bench Scope" }) });
  check("a member may correct the ordinary fields",
        r1.ok === true && it().loc === "H310" && Number(it().qty) === 3 && it().name === "Bench Scope");
  check("and resending the rest untouched is not flagged", r1.ignored.length === 0);

  const r2 = post({ action:"updateItem", item: Object.assign(whole(), {
    status:"In Use", shared:false, consumable:true, displayId:"XX-999" }) });
  check("but the four structural fields do not move",
        it().status === "Available" && it().shared === true &&
        it().consumable === false && it().displayId === "CE-001");
  check("and the response names what it dropped",
        ["status","shared","consumable","displayId"].every(f => r2.ignored.indexOf(f) >= 0));
  check("the audit line names them too",
        cB.readTable("AuditLog").some(a => a.action === "UpdateItem" && /ignored \(admin only\)/.test(a.details)));

  asAdmin();
  post({ action:"updateItem", item: Object.assign(whole(), {
    status:"Maintenance", shared:false, consumable:false, displayId:"CE-042" }) });
  check("an admin may move all four",
        it().status === "Maintenance" && it().shared === false && it().displayId === "CE-042");
}

console.log("the roster is not lab-wide reading");
{
  const ssC = fresh();
  const cC = load(ssC);
  cC.setupNewLab();
  cC.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  cC.writeSetting("cat_prefixes", JSON.stringify({ "Robots & Motors":"RM" }));
  const get = () => JSON.parse(cC.doGet({ parameter:{ token:"t" } }).__text);

  cC.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" });
  const asMember = get().settings;
  check("a member gets what the app needs to draw itself",
        asMember.categories !== undefined && asMember.slack_mode !== undefined &&
        asMember.cat_prefixes !== undefined);
  check("and not the roster",
        asMember.admins === undefined && asMember.members === undefined);

  cC.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });
  const asAdmin = get().settings;
  check("an admin gets the tab", asAdmin.admins !== undefined && asAdmin.categories !== undefined);
  // A key nobody has thought of yet must not be public by default.
  cC.writeSetting("some_future_key", "secret");
  cC.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" });
  check("and a key added later is admin-only until somebody says otherwise",
        get().settings.some_future_key === undefined);
}

console.log("using a consumable is a subtraction, not an assignment");
{
  const ssD = fresh();
  const cD = load(ssD);
  cD.setupNewLab();
  cD.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  cD.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" });
  const post = p => JSON.parse(cD.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const qty = id => cD.readTable("Items").find(i => i.id === id).qty;
  const add = (id,name,extra) => post({ action:"addItem", item: Object.assign({ id, name,
    cat:"Consumables & Supplies", qty:20, unit:"boxes", loc:"H306", minQty:0, img:"", desc:"",
    status:"Available", usedBy:[], serial:"", displayId:"", shared:false, consumable:true }, extra||{}) });

  add("c1","Gloves"); add("c2","Zip Ties",{ qty:"" });

  check("taking three leaves seventeen",
        post({ action:"useConsumable", itemId:"c1", used:3 }).qty === 17 && Number(qty("c1")) === 17);
  // The point of the whole change: the second caller subtracts from what is on the
  // sheet, not from the twenty its browser was still showing.
  check("and taking three more leaves fourteen",
        post({ action:"useConsumable", itemId:"c1", used:3 }).qty === 14);
  check("it never goes below zero",
        post({ action:"useConsumable", itemId:"c1", used:99 }).qty === 0 && Number(qty("c1")) === 0);
  check("a negative is refused", post({ action:"useConsumable", itemId:"c1", used:-5 }).error === "Bad quantity");
  check("zero is refused",       post({ action:"useConsumable", itemId:"c1", used:0 }).error === "Bad quantity");
  check("nonsense is refused",   post({ action:"useConsumable", itemId:"c1", used:"lots" }).error === "Bad quantity");
  check("and none of those moved it", Number(qty("c1")) === 0);
  check("a supply with no count has nothing to deduct",
        post({ action:"useConsumable", itemId:"c2", used:1 }).error === "Not tracked");
  check("and is left alone", qty("c2") === "");
  check("an unknown item is refused",
        post({ action:"useConsumable", itemId:"nope", used:1 }).error === "Item not found");
  check("and equipment is not a consumable", (() => {
    post({ action:"addItem", item:{ id:"e1", name:"Arm", cat:"Robots & Motors", qty:1, unit:"units",
      loc:"H306", minQty:0, img:"", desc:"", status:"Available", usedBy:[], serial:"",
      displayId:"", shared:false, consumable:false } });
    return post({ action:"useConsumable", itemId:"e1", used:1 }).error === "Not a consumable" &&
           Number(cD.readTable("Items").find(i => i.id === "e1").qty) === 1;
  })());
  check("what was taken is logged",
        cD.readTable("AuditLog").some(a => a.action === "UseConsumable" && /used:3/.test(a.details)));
}

console.log("In Use means somebody has it now, not that somebody booked it");
{
  const ssA = fresh();
  const cA = load(ssA);
  cA.setupNewLab();
  cA.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  cA.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });
  const post = p => JSON.parse(cA.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const item = (id,name,extra) => post({ action:"addItem", item: Object.assign({ id, name, cat:"Robots & Motors",
    qty:1, unit:"units", loc:"H306", minQty:0, img:"", desc:"", status:"Available", usedBy:[], serial:"",
    displayId:"", shared:false, consumable:false }, extra||{}) });
  const book = (id,itemId,name,user,out,ret,extra) => post({ action:"addCheckout", checkout: Object.assign(
    { id, itemId, item:name, user, out, ret, status:"Active", checkedOutByEmail:user.toLowerCase()+"@jh.edu",
      groupEmails:"", qty:1, fromTime:"", toTime:"" }, extra||{}) });
  const it  = id => cA.readTable("Items").find(i => i.id === id);

  item("a1","Arm A"); item("a2","Arm B"); item("a3","Arm C");
  item("a4","Bench", { shared:true }); item("a5","Gloves", { consumable:true, qty:9 });
  item("a6","Cracked Arm", { status:"Broken" });

  // now = 2026-08-16 12:00Z
  book("bk-now","a1","Arm A","Nia","2026-08-15 09:00","2026-08-20 17:00");
  book("bk-soon","a2","Arm B","Oli","2026-09-01 09:00","2026-09-03 17:00");
  book("bk-past","a3","Arm C","Pia","2026-08-01 09:00","2026-08-05 17:00");

  check("a booking under way takes the item now", it("a1").status === "In Use" && it("a1").usedBy[0] === "Nia");
  check("a booking for next month does not", it("a2").status === "Available" && it("a2").usedBy.length === 0);
  // Past its return date and still Active is not a finished loan, it is an overdue
  // one — the case where somebody most likely still has the thing. Returning it is
  // what puts it back, not the clock running out.
  check("one whose return date has passed still holds it", it("a3").status === "In Use" && it("a3").usedBy[0] === "Pia");
  check("and the overdue alert agrees", cA.getOverdueCheckouts_().length === 1);

  // Nothing to correct: the sweep must agree with what addCheckout already did.
  check("the sweep changes nothing on a settled lab", cA.syncItemStatuses() === 0);
  check("and leaves the live hold alone", it("a1").status === "In Use");

  // Hand-set the flags wrong, the way a stale browser or an admin override would.
  cA.updateRow("Items", "a1", { status: "Available", usedBy: [] });
  cA.updateRow("Items", "a2", { status: "In Use", usedBy: ["Oli"] });
  cA.updateRow("Items", "a3", { status: "Available", usedBy: [] });
  check("the sweep corrects all three", cA.syncItemStatuses() === 3);
  check("the live hold is back", it("a1").status === "In Use" && it("a1").usedBy[0] === "Nia");
  check("the future one is free again", it("a2").status === "Available" && it("a2").usedBy.length === 0);
  check("and the overdue one is put back in the borrower's hands",
        it("a3").status === "In Use" && it("a3").usedBy[0] === "Pia");
  check("the sweep never contradicts the overdue alert it runs beside",
        cA.getOverdueCheckouts_().every(function (c) {
          const item = cA.readTable("Items").find(function (i) { return i.id === c.itemId; });
          return !item || item.usedBy.indexOf(c.user) >= 0;
        }));

  // A shared item under way stays Available — several people hold it at once.
  book("bk-shared","a4","Bench","Quin","2026-08-15 09:00","2026-08-20 17:00");
  cA.syncItemStatuses();
  check("a shared item stays Available while held", it("a4").status === "Available");
  check("but records who has it", it("a4").usedBy.indexOf("Quin") >= 0);

  check("consumables are left out of it", it("a5").status === "Available");
  check("and Broken is not overwritten by the sweep", it("a6").status === "Broken");

  // A row written before itemId was populated carries only the name, and an item
  // can easily have one of each kind.
  {
    const co = ssA.__sheets.Checkouts;
    const h = co.__data[0];
    const row = h.map(function (k) {
      return ({ id:"bk-legacy", itemId:"", item:"Bench", user:"Rex", out:"2026-08-15 09:00",
                ret:"2026-08-20 17:00", status:"Active", checkedOutByEmail:"rex@jh.edu",
                groupEmails:"", qty:1, fromTime:"", toTime:"", notes:"" })[k];
    });
    co.__data.push(row);
  }
  cA.syncItemStatuses();
  check("a row matched only by name is counted too", it("a4").usedBy.indexOf("Rex") >= 0);
  check("alongside the one matched by id", it("a4").usedBy.indexOf("Quin") >= 0);
  check("and the sweep has settled again", cA.syncItemStatuses() === 0);

  // Split units share a name. A name-only booking is one loan of one unit, and
  // must not take every sibling off the shelf.
  item("s1","Twin Rig"); item("s2","Twin Rig");
  {
    const co = ssA.__sheets.Checkouts, h = co.__data[0];
    co.__data.push(h.map(function (k) {
      return ({ id:"bk-twin", itemId:"", item:"Twin Rig", user:"Sam", out:"2026-08-15 09:00",
                ret:"2026-08-20 17:00", status:"Active", checkedOutByEmail:"sam@jh.edu",
                groupEmails:"", qty:1, fromTime:"", toTime:"", notes:"" })[k];
    }));
  }
  cA.syncItemStatuses();
  check("one legacy loan takes one unit", it("s1").status === "In Use" && it("s1").usedBy[0] === "Sam");
  check("and leaves its twin on the shelf", it("s2").status === "Available" && it("s2").usedBy.length === 0);

  // A returned booking releases the item whether or not the sweep has run.
  post({ action:"returnItem", checkoutId:"bk-now" });
  check("returning frees it", it("a1").status === "Available" && it("a1").usedBy.length === 0);
  check("and the sweep agrees", cA.syncItemStatuses() === 0 && it("a1").status === "Available");
}

console.log("returning one booking does not free what another is holding");
{
  const ssE = fresh();
  const cE = load(ssE);
  cE.setupNewLab();
  cE.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  cE.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });
  const post = p => JSON.parse(cE.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const it = id => cE.readTable("Items").find(i => i.id === id);
  const mk = (id,name,extra) => post({ action:"addItem", item: Object.assign({ id, name,
    cat:"Robots & Motors", qty:1, unit:"units", loc:"H306", minQty:0, img:"", desc:"",
    status:"Available", usedBy:[], serial:"", displayId:"", shared:false, consumable:false }, extra||{}) });
  const book = (id,itemId,name,user,out,ret) => post({ action:"addCheckout", checkout:{ id, itemId,
    item:name, user, out, ret, status:"Active", checkedOutByEmail:user.toLowerCase()+"@jh.edu",
    groupEmails:"", qty:1, fromTime:"", toTime:"" } });

  mk("e1","Arm"); mk("e2","Rig"); mk("e3","Cracked Arm", { status:"Broken" });

  // now = 2026-08-16. One live hold and one for next month, on the same item —
  // which rule 2 allows because the ranges do not overlap.
  book("h-now","e1","Arm","Ann","2026-08-15 09:00","2026-08-18 17:00");
  book("h-later","e1","Arm","Bo","2026-09-01 09:00","2026-09-03 17:00");
  check("only the live one holds it", it("e1").status === "In Use" && it("e1").usedBy.join() === "Ann");
  post({ action:"returnItem", checkoutId:"h-later" });
  check("returning the future one leaves Ann holding it",
        it("e1").status === "In Use" && it("e1").usedBy.join() === "Ann");
  post({ action:"returnItem", checkoutId:"h-now" });
  check("and returning hers puts it back", it("e1").status === "Available" && it("e1").usedBy.length === 0);

  // An admin marks something Broken while it is out; giving it back must not
  // quietly put it in the picker again.
  book("h-broken","e3","Cracked Arm","Cy","2026-08-15 09:00","2026-08-18 17:00");
  check("a Broken item stays Broken while out", it("e3").status === "Broken");
  post({ action:"returnItem", checkoutId:"h-broken" });
  check("and returning it does not un-break it", it("e3").status === "Broken");
  check("though the borrower is no longer holding it", it("e3").usedBy.length === 0);

  // An overdue hold is still a hold, and approving a future request for something
  // that is out today is not a clash.
  book("h-late","e2","Rig","Dee","2026-08-01 09:00","2026-08-05 17:00");
  check("an overdue loan still holds its item", it("e2").status === "In Use" && it("e2").usedBy.join() === "Dee");
  const later = post({ action:"addCheckout", checkout:{ id:"h-q", itemId:"e2", item:"Rig", user:"Eli",
    out:"2026-08-20 09:00", ret:"2026-09-12 17:00", status:"Active",
    checkedOutByEmail:"eli@jh.edu", groupEmails:"", qty:1, fromTime:"", toTime:"" } });
  check("a long request for later still waits for an admin", later.pending === true);
  check("and the admin can approve it even though the rig is out today",
        post({ action:"decideCheckout", checkoutId:"h-q", approve:true }).ok === true);
  check("without taking it from whoever is late with it",
        it("e2").usedBy.indexOf("Dee") >= 0 && it("e2").usedBy.indexOf("Eli") < 0);
}

console.log("a new item is described, not commanded, into existence");
{
  const ssF = fresh();
  const cF = load(ssF);
  cF.setupNewLab();
  cF.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  cF.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" });
  const post = p => JSON.parse(cF.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  post({ action:"addItem", item:{ id:"n1", name:"Bench", cat:"Compute & Electronics", qty:1,
    unit:"units", loc:"H306", minQty:0, img:"", desc:"", status:"In Use", usedBy:["Nobody"],
    serial:"", displayId:"", shared:true, consumable:false } });
  const n1 = cF.readTable("Items").find(i => i.id === "n1");
  check("a member cannot add an item already checked out", n1.status === "Available");
  // Describing a thing you are putting on the shelf is not changing what an
  // existing thing is, so these two stay open at creation.
  check("but may say it is shared", n1.shared === true);
}

console.log("a printed base label belongs to one thing");
{
  const ss9 = fresh();
  const c9 = load(ss9);
  c9.setupNewLab();
  c9.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  c9.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });
  const post = p => JSON.parse(c9.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const add = (name, displayId) => post({ action:"addItem", item:{ id:name+displayId, name, cat:"Sensors & Vision",
    qty:1, unit:"units", loc:"H306", minQty:0, img:"", desc:"", status:"Available", usedBy:[], serial:"",
    displayId, shared:false, consumable:false } });

  check("first split unit takes the base it asked for", add("RealSense D435","SV-001-01").displayId === "SV-001-01");
  check("a second unit of the same model joins it",     add("RealSense D435","SV-001-01").displayId === "SV-001-02");
  // Two browsers, each reading a list a poll old, both compute SV-001 for
  // different models. They must not both print it.
  const other = add("Jetson Orin","SV-001-01");
  check("a different model asking for the same base is moved off it", other.displayId === "SV-002-01");
  check("and its own second unit follows it there", add("Jetson Orin","SV-002-01").displayId === "SV-002-02");
}

console.log("an admin is a member of their own lab");
{
  const ss8 = fresh();
  const c8 = load(ss8);
  c8.setupNewLab();
  c8.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));
  const post = p => JSON.parse(c8.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  c8.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" });

  // Filling in the allowlist and forgetting yourself used to lock you out of your
  // own lab — including out of the settings that would let you undo it.
  post({ action:"saveSettings", key:"members", value: JSON.stringify(["member@jh.edu"]) });
  check("an admin left off the allowlist is still let in", c8.isMember("zzhan409@jh.edu") === true);
  check("and can still write",
        post({ action:"addItem", item:{ name:"Scope", cat:"Compute & Electronics", qty:1, unit:"units" } }).ok === true);
  check("and can still put themselves back",
        post({ action:"saveSettings", key:"members", value:"[]" }).ok === true);
  c8.writeSetting("members", JSON.stringify(["member@jh.edu"]));
  c8.verifyToken = () => ({ email:"stranger@jh.edu", name:"S", oid:"s" });
  check("a stranger is still kept out", c8.isMember("stranger@jh.edu") === false);
  check("and gets the door closed on them",
        post({ action:"addItem", item:{ name:"X", cat:"C", qty:1, unit:"u" } }).error === "NotMember");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
