/**
 * Behaviour snapshot for the Apps Script backend.
 *
 * Stubs the Apps Script globals with an in-memory spreadsheet, then runs every
 * data-mutating doPost action plus doGet and the daily digest, and dumps the
 * resulting sheet contents, Slack payloads and responses as JSON.
 *
 * The point is differential testing — the output is only meaningful compared
 * against another run:
 *
 *   node test-storage-layer.js > before.json
 *   # …change the storage layer…
 *   node test-storage-layer.js > after.json
 *   diff before.json after.json      # must be empty for a pure refactor
 *
 * This is how the eventual SharePoint adapter gets verified: reimplement
 * readTable/appendRow/updateRow/deleteRow/readSettings/writeSetting against
 * Graph, point the stub at a fake Graph instead of a fake Spreadsheet, and
 * require this diff to stay empty.
 *
 * Usage: node test-storage-layer.js [path-to-backend.js]
 */
const fs = require("fs");
const vm = require("vm");

const FIXED_NOW = new Date("2026-08-16T14:30:00Z");

function makeSheet(name, rows) {
  const data = rows.map(r => r.slice());
  const sheet = {
    __name: name,
    __data: data,
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => (data[0] ? data[0].length : 0),
    getDataRange() {
      return {
        getValues: () => data.map(r => r.slice()),
      };
    },
    getRange(row, col, numRows, numCols) {
      const nr = numRows === undefined ? 1 : numRows;
      const nc = numCols === undefined ? 1 : numCols;
      const api = {
        setValues(vals) {
          for (let i = 0; i < nr; i++) {
            while (data.length < row + i) data.push([]);
            for (let j = 0; j < nc; j++) data[row - 1 + i][col - 1 + j] = vals[i][j];
          }
          return api;
        },
        setValue(v) {
          while (data.length < row) data.push([]);
          data[row - 1][col - 1] = v;
          return api;
        },
        getValues: () => {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const r = [];
            for (let j = 0; j < nc; j++) r.push((data[row - 1 + i] || [])[col - 1 + j]);
            out.push(r);
          }
          return out;
        },
        // formatting / presentation — recorded but irrelevant to stored data
        setNumberFormat: () => api,
        setFormula: () => api,
        setFontWeight: () => api,
        setFontSize: () => api,
        setHorizontalAlignment: () => api,
        merge: () => api,
      };
      return api;
    },
    appendRow(row) { data.push(row.slice()); },
    deleteRow(n) { data.splice(n - 1, 1); },
    deleteRows(start, count) { data.splice(start - 1, count); },
    setColumnWidth: () => {},
    setFrozenRows: () => {},
  };
  return sheet;
}

function makeSpreadsheet(initial) {
  const sheets = {};
  Object.keys(initial).forEach(n => { sheets[n] = makeSheet(n, initial[n]); });
  return {
    __sheets: sheets,
    getId: () => "fake-ss-id",
    getSheetByName: n => sheets[n] || null,
    insertSheet(n) { sheets[n] = makeSheet(n, []); return sheets[n]; },
    deleteSheet(s) { delete sheets[s.__name]; },
    setActiveSheet: () => {},
  };
}

function run(scriptPath, slackMode, asAdmin) {
  const slack = [];

  const ss = makeSpreadsheet({
    Items:      [["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"]],
    Deliveries: [["id","item","qty","unit","from","receivedBy","date","tracking","status"]],
    Checkouts:  [["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails"]],
    Orders:     [["id","store","item","link","qty","unit","price","cat","requestedBy","reason","urgency","date","status","requestedByEmail"]],
    Settings:   [["key","value"],
                 ["admins", JSON.stringify(["zzhan409@jh.edu"])],
                 ["slack_mode", slackMode || "all"]],
  });

  // Freeze time so timestamps don't diff between the two runs.
  class FrozenDate extends Date {
    constructor(...args) { if (args.length === 0) super(FIXED_NOW.getTime()); else super(...args); }
    static now() { return FIXED_NOW.getTime(); }
  }

  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        slack.push(JSON.parse(opts.payload));
        return { getContentText: () => "{}", getResponseCode: () => 200 };
      },
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: t => ({ __text: t, setMimeType() { return this; } }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    Utilities: {
      base64DecodeWebSafe: s => Buffer.from(String(s), "base64"),
      formatDate: () => "August 16, 2026",
    },
    Session: { getScriptTimeZone: () => "America/New_York" },
    DriveApp: {},
    Logger: { log: () => {} },
    console: { log: () => {}, error: () => {} },
    Date: FrozenDate,
    JSON, Math, String, Number, Boolean, Array, Object, RegExp, Error, parseInt, parseFloat, isNaN,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // SLACK_WEBHOOK_URL is a top-level const, so it lives in the script's lexical
  // scope and can't be reassigned from here — substitute it in the source instead,
  // otherwise sendSlack() early-returns and the whole notification path goes untested.
  const src = fs.readFileSync(scriptPath, "utf8")
    .replace('const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL_HERE";',
             'const SLACK_WEBHOOK_URL = "https://hooks.slack.test/fake";');
  if (src.indexOf("hooks.slack.test") < 0) throw new Error("webhook substitution failed — check the constant");
  vm.runInContext(src, ctx, { filename: scriptPath });

  // Bypass the real Entra verification — it needs JWKS over the network and is
  // orthogonal to storage. isAdmin still runs for real against the seeded
  // Settings, so the admin-only branches are genuinely exercised.
  ctx.verifyToken = asAdmin === false
    ? () => ({ email: "member@jh.edu",   name: "Regular Member", oid: "oid-2" })
    : () => ({ email: "zzhan409@jh.edu", name: "Zizhe Zhang",    oid: "oid-1" });

  const post = payload => {
    const res = ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: "t" }, payload)) } });
    return JSON.parse(res.__text);
  };

  const results = [];
  const step = (label, payload) => results.push([label, post(payload)]);

  // ── every data-mutating action, in dependency order ──
  step("addItem/regular", { action: "addItem", item: {
    id: "i1", name: "UR5e Arm", cat: "Robots & Motors", qty: 1, unit: "unit",
    loc: "Hackerman 306", minQty: 0, img: "", desc: "", status: "Available",
    usedBy: [], serial: "SN-9001", displayId: "RM-000000", shared: false, consumable: false } });

  step("addItem/second", { action: "addItem", item: {
    id: "i2", name: "RealSense D435", cat: "Sensors & Vision", qty: 3, unit: "unit",
    loc: "Hackerman 306", minQty: 1, img: "", desc: "", status: "Available",
    usedBy: [], serial: "", displayId: "SV-000000", shared: true, consumable: false } });

  step("addItem/subId", { action: "addItem", item: {
    id: "i3", name: "RealSense D435 #2", cat: "Sensors & Vision", qty: 1, unit: "unit",
    loc: "Hackerman 306", minQty: 0, img: "", desc: "", status: "Available",
    usedBy: [], serial: "", displayId: "SV-000002-001", shared: false, consumable: false } });

  step("updateItem", { action: "updateItem", item: {
    id: "i1", name: "UR5e Arm", qty: 2, loc: "Hackerman 310", serial: "SN-9001", displayId: "RM-000001" } });

  step("updateItem/missing", { action: "updateItem", item: { id: "nope", name: "x" } });

  step("addDelivery", { action: "addDelivery", delivery: {
    id: "d1", item: "Jetson Orin", qty: 2, unit: "unit", from: "Arrow",
    receivedBy: "Zizhe Zhang", date: "2026-08-16", tracking: "1Z999", status: "Received" } });

  step("addCheckout", { action: "addCheckout", checkout: {
    id: "c1", itemId: "i1", item: "UR5e Arm", user: "Zizhe Zhang",
    out: "2026-08-16 10:00", ret: "2026-08-20 10:00", status: "Active",
    checkedOutByEmail: "zzhan409@jh.edu", groupEmails: "peer@jh.edu" } });

  step("addCheckout/shared", { action: "addCheckout", checkout: {
    id: "c2", itemId: "i2", item: "RealSense D435", user: "Zizhe Zhang",
    out: "2026-08-16 11:00", ret: "2026-08-18 11:00", status: "Active",
    checkedOutByEmail: "zzhan409@jh.edu", groupEmails: "" } });

  step("returnItem", { action: "returnItem", checkoutId: "c1" });
  step("returnItem/missing", { action: "returnItem", checkoutId: "nope" });

  step("addOrder", { action: "addOrder", order: {
    id: "o1", store: "Amazon", item: "M3 screws", link: "https://a.co/d/xyz", qty: 2,
    unit: "box", price: "$14.99", cat: "Tools & Hardware", requestedBy: "Zizhe Zhang",
    reason: "restock", urgency: "High", date: "2026-08-16", status: "Pending",
    requestedByEmail: "zzhan409@jh.edu" } });

  step("updateOrder", { action: "updateOrder", order: { id: "o1", qty: 5, price: "$29.98", store: "McMaster" } });
  step("updateOrder/missing", { action: "updateOrder", order: { id: "nope" } });
  step("updateOrderStatus", { action: "updateOrderStatus", orderId: "o1", status: "Approved" });
  step("updateOrderStatus/missing", { action: "updateOrderStatus", orderId: "nope", status: "Approved" });

  step("saveSettings/new", { action: "saveSettings", key: "categories", value: JSON.stringify(["A","B"]) });
  step("saveSettings/existing", { action: "saveSettings", key: "slack_mode", value: "digest" });

  step("logEditUnlock", { action: "logEditUnlock" });

  step("deleteOrder", { action: "deleteOrder", orderId: "o1" });
  step("deleteOrder/missing", { action: "deleteOrder", orderId: "nope" });
  step("deleteItem", { action: "deleteItem", itemId: "i3" });
  step("deleteItem/missing", { action: "deleteItem", itemId: "nope" });

  step("unknownAction", { action: "wat" });

  // Digest reads the SlackQueue table and clears it — exercised only in digest mode.
  if (slackMode === "digest") ctx.sendDailyDigest();

  // doGet snapshot
  const got = JSON.parse(ctx.doGet({ parameter: { token: "t" } }).__text);

  const sheets = {};
  Object.keys(ss.__sheets).sort().forEach(n => { sheets[n] = ss.__sheets[n].__data; });

  return { results, sheets, slack, doGet: got };
}

const target = process.argv[2] || __dirname + "/google-apps-script.js";
console.log(JSON.stringify({
  all:      run(target, "all"),
  digest:   run(target, "digest"),
  // Same script as a non-admin: every admin-only action must come back Forbidden
  // and leave no trace in the sheets.
  nonAdmin: run(target, "all", false),
}, null, 2));
