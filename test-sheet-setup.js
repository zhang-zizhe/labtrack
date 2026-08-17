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
    JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error, Date, parseInt, parseFloat, isNaN,
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
  const ss6 = fresh();
  ss6.__sheets.Items = makeSheet("Items", [
    ["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"],
    ["s1","Oscilloscope","Compute & Electronics",1,"units","H306",0,"","","Available","[]","","CE-001",true,false],
    ["p1","Franka Arm","Robots & Motors",1,"units","H306",0,"","","Available","[]","","RM-001",false,false],
  ]);
  const c6 = load(ss6);
  const asAdmin  = () => { c6.verifyToken = () => ({ email:"zzhan409@jh.edu", name:"Z", oid:"a" }); };
  const asMember = () => { c6.verifyToken = () => ({ email:"member@jh.edu", name:"Member", oid:"m" }); };
  const post = p => JSON.parse(c6.doPost({ postData:{ contents: JSON.stringify(Object.assign({token:"t"}, p)) } }).__text);
  const book = (id,user,out,ret,from,to,item,itemId) => post({ action:"addCheckout", checkout:{
    id, itemId: itemId||"s1", item: item||"Oscilloscope", user, out, ret, status:"Active",
    checkedOutByEmail:"x@jh.edu", groupEmails:"", qty:1, fromTime:from||"", toTime:to||"" } });

  asAdmin();
  c6.writeSetting("admins", JSON.stringify(["zzhan409@jh.edu"]));

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

  // Over a week: recorded, but the item stays free until someone agrees.
  const long = book("k8","Hal","2026-10-01 09:00","2026-10-20 09:00","","","Franka Arm","p1");
  check("a long hold comes back pending", long.pending === true);
  check("its row is Pending Approval",
        c6.readTable("Checkouts").find(x=>x.id==="k8").status === "Pending Approval");
  check("and the item is not marked In Use by asking",
        c6.readTable("Items").find(i=>i.id==="p1").status !== "In Use" ||
        c6.readTable("Items").find(i=>i.id==="p1").usedBy.indexOf("Hal") < 0);

  asMember();
  check("a member cannot approve it",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Forbidden");

  // Gil (k7) still has the arm. Nothing was reserved by asking, so approving now
  // would hand one item to two people.
  asAdmin();
  check("approving what someone else took is refused",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Clash");
  check("and it stays pending",
        c6.readTable("Checkouts").find(x=>x.id==="k8").status === "Pending Approval");

  post({ action:"returnItem", checkoutId:"k7" });
  check("an admin can once it is back", post({ action:"decideCheckout", checkoutId:"k8", approve:true }).ok === true);
  check("which makes it Active",
        c6.readTable("Checkouts").find(x=>x.id==="k8").status === "Active");
  check("and hands the item over",
        c6.readTable("Items").find(i=>i.id==="p1").usedBy.indexOf("Hal") >= 0);
  check("deciding twice is refused",
        post({ action:"decideCheckout", checkoutId:"k8", approve:true }).error === "Not pending");

  // Same story for a shared item: the slot can be taken while the request waits.
  const long2 = book("k9","Ivy","2026-11-01 09:00","2026-11-20 09:00","09:00","12:00");
  check("a long shared hold is pending too", long2.pending === true);
  check("its slot can still be booked by someone else",
        book("k10","Jon","2026-11-05 09:00","2026-11-06 09:00","09:00","12:00").error === "Clash");
  check("a non-overlapping window is still free",
        book("k11","Kim","2026-11-05 09:00","2026-11-06 09:00","13:00","17:00").ok === true);
  check("approving a still-free shared slot works",
        post({ action:"decideCheckout", checkoutId:"k9", approve:true }).ok === true);

  // Rejecting leaves the item alone.
  const long3 = book("k12","Lee","2026-12-01 09:00","2026-12-20 09:00","","","Franka Arm","p1");
  check("another long hold is pending", long3.pending === true);
  check("rejecting marks it Rejected",
        post({ action:"decideCheckout", checkoutId:"k12", approve:false }).ok === true &&
        c6.readTable("Checkouts").find(x=>x.id==="k12").status === "Rejected");
  check("a rejected request never touched the item",
        c6.readTable("Items").find(i=>i.id==="p1").usedBy.indexOf("Lee") < 0);
  check("a rejected slot frees up for someone else",
        book("k13","Moe","2026-12-02 09:00","2026-12-03 09:00","","","Franka Arm","p1").ok === true);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
