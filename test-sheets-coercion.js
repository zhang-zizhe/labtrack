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

function coerce(v) {
  if (typeof v !== "string") return v;
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
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ __text: t, setMimeType() { return this; } }) },
    Utilities: { base64DecodeWebSafe: s => Buffer.from(String(s), "base64"), formatDate: () => "x" },
    Session: { getScriptTimeZone: () => "America/New_York" },
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
