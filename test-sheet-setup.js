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
  Checkouts:  ["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails","qty","fromTime","toTime"],
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
check("admins seeded lowercase", JSON.parse(st.admins)[0] === "zzhan409@jh.edu");
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
  c3.updateItemStatus("u2", "TEST ROBOT", "In Use", "Zizhe", "add");
  const after = c3.readTable("Items");
  const u1 = after.find(r => r.id === "u1"), u2 = after.find(r => r.id === "u2");
  check("picked unit went In Use",       u2.status === "In Use");
  check("its sibling stayed Available",  u1.status === "Available");
  check("usedBy set on the picked unit", JSON.stringify(u2.usedBy) === '["Zizhe"]');
  check("sibling usedBy untouched",      JSON.stringify(u1.usedBy) === "[]");

  // Returning it must also only touch that unit.
  c3.updateItemStatus("u2", "TEST ROBOT", "Available", "Zizhe", "remove");
  const back = c3.readTable("Items");
  check("return clears only that unit", back.find(r=>r.id==="u2").status === "Available"
                                     && JSON.stringify(back.find(r=>r.id==="u2").usedBy) === "[]");

  // Legacy rows carry no itemId, so the name is all there is to fall back on.
  c3.updateItemStatus("", "TEST ROBOT", "In Use", "Zizhe", "add");
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

  // A plain item is kept exclusive by the availability filter, not by this check.
  check("non-shared item is not clash-checked",
        book("k7","Gil","2026-09-01 09:00","2026-09-02 12:00","","","Franka Arm","p1").ok === true);

  // ── over a week: recorded, but the item stays free until someone agrees ──
  const long = book("k8","Hal","2026-09-05 09:00","2026-09-24 09:00","","","Franka Arm","p1");
  check("a long hold comes back pending", long.pending === true);
  check("and says it was the length", long.reason === "long");
  check("its row is Pending Approval", row("k8").status === "Pending Approval");
  check("and the item is not marked In Use by asking", used("p1").indexOf("Hal") < 0);

  asMember();
  check("a member cannot approve it",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Forbidden");

  // Gil (k7) still has the arm. Nothing was reserved by asking, so approving now
  // would hand one item to two people.
  asAdmin();
  check("approving what someone else took is refused",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Clash");
  check("and it stays pending", row("k8").status === "Pending Approval");

  post({ action:"returnItem", checkoutId:"k7" });
  check("an admin can once it is back", post({ action:"decideCheckout", checkoutId:"k8", approve:true }).ok === true);
  check("which makes it Active", row("k8").status === "Active");
  check("and hands the item over", used("p1").indexOf("Hal") >= 0);
  check("deciding twice is refused",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Not pending");

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
  const long3 = book("k12","Lee","2026-09-10 09:00","2026-09-29 09:00","","","Franka Arm","p1");
  check("another long hold is pending", long3.pending === true);
  check("rejecting marks it Rejected",
        post({ action:"decideCheckout", checkoutId:"k12", approve:false }).ok === true &&
        row("k12").status === "Rejected");
  check("a rejected request never touched the item", used("p1").indexOf("Lee") < 0);
  check("a rejected slot frees up for someone else",
        !book("k13","Moe","2026-09-11 09:00","2026-09-12 09:00","","","Franka Arm","p1").pending);

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
  check("and the item is handed over", used("s3").indexOf("Ned") >= 0);
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
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
