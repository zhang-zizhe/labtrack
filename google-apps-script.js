/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * Google Sheet must have these tabs (column order matters for write operations):
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails
 *   Orders     — id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail
 *   Settings   — key | value
 *   DeleteLog  — date | type | name | details | deletedBy
 *   SlackQueue — time | emoji | title | details | fields  (auto-created; used by digest mode)
 *
 * TRIGGERS to set up (Extensions → Apps Script → Triggers):
 *   sendDailyDigest   → Time-driven → Day timer → 5pm–6pm (set script timezone to America/New_York)
 *   checkOverduesAndAlert → Time-driven → Day timer → 8am–9am (morning check)
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Microsoft Entra ID (Azure AD) — sign-in is restricted to the Johns Hopkins
// tenant. The tenant ID below is JHU's; look it up again with:
//   https://login.microsoftonline.com/jh.edu/v2.0/.well-known/openid-configuration
const ENTRA_TENANT_ID = "9fa4f438-b1e6-473b-803f-86f8aedf0dec";
const ENTRA_CLIENT_ID = "5ac3d97f-238a-4e23-9bad-793830bd9b21";  // App registration → Application (client) ID

// Optional extra restriction on the sign-in name's domain. Empty array = any
// account in the JHU tenant is allowed, which is what "must be a JHU person"
// normally means. Note JHU sign-in names (UPNs) are <JHED>@jh.edu even though
// mail is often @jhu.edu — so list "jh.edu" here, not "jhu.edu".
const ALLOWED_UPN_DOMAINS = [];

const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL_HERE";

// ─── SLACK HELPER ────────────────────────────────────────────────────────────
// slack_mode in Settings tab: "all" | "important" | "digest" | "off"
// "important" = only deletions, urgent/high orders, overdue returns
// "digest" = queues to SlackQueue tab, sent by daily trigger (sendDailyDigest)
function getSlackMode() {
  try {
    var mode = readSettings()["slack_mode"];
    if (mode !== undefined) return String(mode).trim() || "all";
  } catch(e) {}
  return "all";
}

function sendSlack(emoji, title, details, fields, priority) {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE" || SLACK_WEBHOOK_URL === "") return;
  var mode = getSlackMode();
  if (mode === "off") return;
  // priority: "high" for deletions, urgent orders, overdue; "normal" for everything else
  var isHigh = (priority === "high");
  if (mode === "important" && !isHigh) return;
  if (mode === "digest") {
    // Queue it instead of sending immediately (high-priority still sends now)
    appendRow("SlackQueue", {
      time: new Date().toISOString(), emoji: emoji, title: title,
      details: details || "", fields: JSON.stringify(fields || []),
    });
    if (!isHigh) return; // high-priority also sends immediately
  }
  try {
    var blocks = [
      { type: "section", text: { type: "mrkdwn", text: emoji + " *" + title + "*" } }
    ];
    if (details) blocks.push({ type: "section", text: { type: "mrkdwn", text: details } });
    if (fields && fields.length > 0) {
      blocks.push({ type: "section", fields: fields.map(function(f) { return { type: "mrkdwn", text: f }; }) });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · " + new Date().toLocaleString() }] });
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ text: emoji + " " + title, blocks: blocks }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.log("Slack error (non-fatal): " + e.message);
  }
}

// ─── DIGEST HELPERS ──────────────────────────────────────────────────────────
function getPendingOrders_() {
  return readTable("Orders").filter(function(o){ return o.status==="Pending"||o.status==="Approved"||o.status==="Ordered"; });
}

function getOverdueCheckouts_() {
  var today = new Date().toISOString().slice(0,10);
  return readTable("Checkouts").filter(function(c){ return c.status==="Active" && c.ret && String(c.ret).slice(0,10) < today; });
}

function getLowStockItems_() {
  return readTable("Items").filter(function(i){ return i.qty!==undefined && i.minQty!==undefined && Number(i.minQty) > 0 && Number(i.qty) <= Number(i.minQty); });
}

// Sort orders so Urgent/High come first
function sortOrdersByUrgency_(list) {
  return list.slice().sort(function(a, b) {
    var aH = (a.urgency === "Urgent" || a.urgency === "High") ? 0 : 1;
    var bH = (b.urgency === "Urgent" || b.urgency === "High") ? 0 : 1;
    return aH - bH;
  });
}

// Format a single order line with urgency badge inline
function formatOrderLine_(o) {
  var badge = (o.urgency === "Urgent") ? "🚨 " : (o.urgency === "High") ? "⚠️ " : "";
  var parts = [badge + "*" + o.item + "*  " + o.qty + " " + (o.unit || "")];
  if (o.store) parts.push(o.store);
  if (o.price) parts.push(o.price);
  if (o.link)  parts.push("<" + o.link + "|link>");
  return "• " + parts.join(" | ");
}

// ─── DAILY DIGEST (Trigger: sendDailyDigest → Day timer → 5pm–6pm, timezone: America/New_York) ─
function sendDailyDigest() {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE") return;

  var now = new Date();
  var dateStr = now.toLocaleDateString("en-US", {weekday:"long", month:"short", day:"numeric", year:"numeric"});

  var pending   = getPendingOrders_();
  var overdues  = getOverdueCheckouts_();
  var lowStock  = getLowStockItems_();

  // Queue (today's activity log)
  var queuedRows = readTable("SlackQueue");

  var blocks = [
    { type: "header", text: { type: "plain_text", text: "📊 LabTrack Daily Summary — " + dateStr, emoji: true } },
    { type: "divider" }
  ];

  // ── Orders: grouped by stage so PI sees exactly what action is needed ──
  var needsApproval    = pending.filter(function(o){ return o.status === "Pending"; });
  var needsOrdering    = pending.filter(function(o){ return o.status === "Approved"; });
  var awaitingDelivery = pending.filter(function(o){ return o.status === "Ordered"; });

  if (pending.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "🛒 *Orders:* No active orders" } });
  } else {
    // 1 — Needs Approval (Pending): PI must act
    if (needsApproval.length > 0) {
      var approvalList = sortOrdersByUrgency_(needsApproval);
      var approvalText = approvalList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (needsApproval.length > 8) approvalText += "\n_…and " + (needsApproval.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "🔔 *Needs Approval (" + needsApproval.length + ")*\n" + approvalText } });
    }

    // 2 — Approved / Needs Ordering: approved but not yet purchased
    if (needsOrdering.length > 0) {
      var orderingList = sortOrdersByUrgency_(needsOrdering);
      var orderingText = orderingList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (needsOrdering.length > 8) orderingText += "\n_…and " + (needsOrdering.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "🛍️ *Approved — Place Order (" + needsOrdering.length + ")*\n" + orderingText } });
    }

    // 3 — Ordered / Awaiting Delivery: already purchased, just waiting
    if (awaitingDelivery.length > 0) {
      var deliveryList = sortOrdersByUrgency_(awaitingDelivery);
      var deliveryText = deliveryList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (awaitingDelivery.length > 8) deliveryText += "\n_…and " + (awaitingDelivery.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "📬 *Ordered — Awaiting Delivery (" + awaitingDelivery.length + ")*\n" + deliveryText } });
    }
  }

  // ── Overdue checkouts ──
  if (overdues.length > 0) {
    var odText = overdues.map(function(o){
      return "• *" + o.item + "* — " + o.user + " (due " + String(o.ret).slice(0,10) + ")";
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "🔴 *Overdue Checkouts (" + overdues.length + ")*\n" + odText } });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "✅ *Checkouts:* No overdue items" } });
  }

  // ── Low stock ──
  if (lowStock.length > 0) {
    var lsText = lowStock.slice(0,6).map(function(i){
      return "• *" + i.name + "* — " + i.qty + "/" + i.minQty + " " + i.unit + " (reorder needed)";
    }).join("\n");
    if (lowStock.length > 6) lsText += "\n_…and " + (lowStock.length-6) + " more_";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "📦 *Low Stock (" + lowStock.length + ")*\n" + lsText } });
  }

  // ── Today's activity: count by type only (no listing individual events) ──
  if (queuedRows.length > 0) {
    var counts = {};
    queuedRows.forEach(function(r) {
      var emoji = String(r.emoji).trim();
      counts[emoji] = (counts[emoji] || 0) + 1;
    });
    var countLine = Object.keys(counts).map(function(e){ return e + " ×" + counts[e]; }).join("  ·  ");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Today's activity: " + countLine + "  (" + queuedRows.length + " total)" }] });
  }

  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · Auto-digest · " + now.toLocaleString("en-US",{timeZone:"America/New_York"}) + " ET" }] });

  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ text: "📊 LabTrack Daily Summary — " + dateStr, blocks: blocks }),
      muteHttpExceptions: true,
    });
  } catch(e) { console.log("Digest send failed: " + e.message); }

  // Clear queue
  if (queuedRows.length > 0) clearTable("SlackQueue");
}

// Admin can trigger manually (via UI button → doPost "sendDigest")
function sendManualDigest() { sendDailyDigest(); }

// ─── SETUP TRIGGERS (run once from the Apps Script editor) ───────────────────
// Run this function manually from the editor to create both time-based triggers.
// Requires: Project Settings → Time zone = America/New_York
// After running, verify in Triggers tab (clock icon on left sidebar).
function createTriggers() {
  // Remove any existing triggers for these functions to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === "sendDailyDigest" || fn === "checkOverduesAndAlert" || fn === "backupSpreadsheet") {
      ScriptApp.deleteTrigger(t);
    }
  });
  // Daily digest at 5pm (script timezone must be America/New_York)
  ScriptApp.newTrigger("sendDailyDigest")
    .timeBased()
    .atHour(17)
    .everyDays(1)
    .create();
  // Overdue alert at 8am
  ScriptApp.newTrigger("checkOverduesAndAlert")
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();
  // Weekly backup every Sunday at 3am
  ScriptApp.newTrigger("backupSpreadsheet")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .create();
  Logger.log("✅ Triggers created (digest, overdue alert, weekly backup). Verify in Triggers tab. Time zone must be America/New_York.");
}

// ─── SPREADSHEET BACKUP ──────────────────────────────────────────────────────
// Copies the entire spreadsheet into a "LabTrack Backups" folder in Google Drive.
// Keeps the most recent BACKUP_KEEP_COUNT copies and trashes the rest.
// Called automatically every Sunday at 3am (set up via createTriggers()),
// or manually via the "Backup Now" button in the admin UI.
// SHEETS-ONLY — does not survive a storage migration. This copies the whole
// spreadsheet file to Drive; a SharePoint List has version history and a recycle
// bin instead, so on migration this function is deleted rather than ported.
function backupSpreadsheet() {
  var BACKUP_KEEP_COUNT = 12; // keep ~3 months of weekly backups
  var FOLDER_NAME = "LabTrack Backups";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssFile = DriveApp.getFileById(ss.getId());

  // Place backup folder next to the spreadsheet (or in root if no parent)
  var parents = ssFile.getParents();
  var parentFolder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  // Find or create the backup folder
  var backupFolder;
  var folders = parentFolder.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) {
    backupFolder = folders.next();
  } else {
    backupFolder = parentFolder.createFolder(FOLDER_NAME);
  }

  // Name the backup with a timestamp (no colons — not allowed in Drive file names)
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var dateStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  var timeStr = pad(now.getHours()) + "h" + pad(now.getMinutes());
  var backupName = "LabTrack Backup " + dateStr + " " + timeStr;

  ssFile.makeCopy(backupName, backupFolder);

  // Prune: keep only the most recent BACKUP_KEEP_COUNT files
  var files = [];
  var iter = backupFolder.getFiles();
  while (iter.hasNext()) {
    var f = iter.next();
    files.push({ file: f, date: f.getDateCreated() });
  }
  files.sort(function(a, b) { return b.date - a.date; }); // newest first
  for (var i = BACKUP_KEEP_COUNT; i < files.length; i++) {
    files[i].file.setTrashed(true);
  }

  // Record last backup time in Settings
  var displayTime = dateStr + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  writeSetting("last_backup", displayTime);

  sendSlack("💾", "Weekly Backup Complete", null, [
    "*File*\n" + backupName,
    "*Location*\n" + FOLDER_NAME,
    "*Kept*\n" + Math.min(files.length, BACKUP_KEEP_COUNT) + " backups"
  ]);
  Logger.log("✅ Backup created: " + backupName + " → " + FOLDER_NAME);
  return backupName;
}

// ─── OVERDUE ALERT (Trigger: checkOverduesAndAlert → Day timer → 8am–9am) ────
function checkOverduesAndAlert() {
  var overdues = getOverdueCheckouts_();
  if (overdues.length === 0) return;
  var text = overdues.map(function(o){
    return "• *" + o.item + "* — " + o.user + " (due " + String(o.ret).slice(0,10) + ")";
  }).join("\n");
  sendSlack("🔴", "Overdue Checkouts (" + overdues.length + ")", text, [], "high");
}

// ─── TOKEN VERIFICATION (Microsoft Entra ID) ─────────────────────────────────
// Unlike Google, Microsoft has no tokeninfo endpoint that validates a token for
// you — we have to verify the RS256 signature ourselves against the tenant's
// published JWKS, then check the claims.
//
// Returns { email, name, oid } on success, or null on any failure.
function verifyToken(token) {
  if (!token || token === "local") return null;
  try {
    var parts = String(token).split(".");
    if (parts.length !== 3) return null;

    var header = JSON.parse(base64UrlToString_(parts[0]));
    if (header.alg !== "RS256" || !header.kid) return null;

    // Look up the signing key by kid. If the cached JWKS doesn't have it, the
    // tenant probably rotated keys — refetch once, bypassing the cache.
    var jwk = getEntraSigningKey_(header.kid, false);
    if (!jwk) jwk = getEntraSigningKey_(header.kid, true);
    if (!jwk) return null;

    if (!verifyRs256_(parts[0] + "." + parts[1],
                      Utilities.base64DecodeWebSafe(parts[2]), jwk.n, jwk.e)) {
      return null;
    }

    var claims = JSON.parse(base64UrlToString_(parts[1]));
    var now = Math.floor(Date.now() / 1000);
    var SKEW = 300;  // 5 min clock skew tolerance

    if (!claims.exp || now > Number(claims.exp) + SKEW) return null;
    if (claims.nbf && now < Number(claims.nbf) - SKEW) return null;
    // aud: the token was minted for THIS app, not some other app that happens
    // to be in the same tenant. This is what stops token replay from another site.
    if (claims.aud !== ENTRA_CLIENT_ID) return null;
    // tid + iss: the signer is the JHU tenant.
    if (claims.tid !== ENTRA_TENANT_ID) return null;
    if (claims.iss !== "https://login.microsoftonline.com/" + ENTRA_TENANT_ID + "/v2.0") return null;

    var upn = String(claims.preferred_username || claims.upn || claims.email || "")
                .trim().toLowerCase();
    if (!upn || upn.indexOf("@") < 0) return null;

    if (ALLOWED_UPN_DOMAINS.length > 0 &&
        ALLOWED_UPN_DOMAINS.indexOf(upn.split("@")[1]) < 0) {
      return null;
    }

    return { email: upn, name: claims.name || upn, oid: claims.oid || "" };
  } catch (e) {
    return null;
  }
}

// Fetch the tenant's signing keys, cached for 6h so the common path makes no
// network call at all (the old Google tokeninfo check cost a round trip per request).
function getEntraSigningKey_(kid, forceRefresh) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "entra_jwks_" + ENTRA_TENANT_ID;
  var raw = forceRefresh ? null : cache.get(cacheKey);
  if (!raw) {
    var resp = UrlFetchApp.fetch(
      "https://login.microsoftonline.com/" + ENTRA_TENANT_ID + "/discovery/v2.0/keys",
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return null;
    raw = resp.getContentText();
    cache.put(cacheKey, raw, 21600);
  }
  var keys = (JSON.parse(raw) || {}).keys || [];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].kid === kid && keys[i].n && keys[i].e) return keys[i];
  }
  return null;
}

function base64UrlToString_(s) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString();
}

// ─── RS256 SIGNATURE VERIFICATION ────────────────────────────────────────────
// Apps Script's Utilities can sign with RSA but cannot verify, so this is a
// direct implementation of RSASSA-PKCS1-v1_5 verification on top of BigInt.

function bytesToBigInt_(bytes) {
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex.length ? BigInt("0x" + hex) : BigInt(0);
}

function modPow_(base, exp, mod) {
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2);
  var result = ONE;
  var b = base % mod;
  var e = exp;
  while (e > ZERO) {
    if (e % TWO === ONE) result = (result * b) % mod;
    e = e / TWO;
    b = (b * b) % mod;
  }
  return result;
}

// DER-encoded DigestInfo prefix for SHA-256
var SHA256_DIGEST_INFO_ = [
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
  0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20
];

function verifyRs256_(signingInput, sigBytes, nB64u, eB64u) {
  var nBytes = Utilities.base64DecodeWebSafe(nB64u);
  var n = bytesToBigInt_(nBytes);
  var e = bytesToBigInt_(Utilities.base64DecodeWebSafe(eB64u));
  var s = bytesToBigInt_(sigBytes);
  if (n === BigInt(0) || s >= n) return false;

  var k = nBytes.length;
  if (sigBytes.length !== k) return false;

  // EM = sig^e mod n, left-padded to exactly k bytes
  var hex = modPow_(s, e, n).toString(16);
  while (hex.length < k * 2) hex = "0" + hex;
  if (hex.length !== k * 2) return false;
  var em = [];
  for (var i = 0; i < k; i++) em.push(parseInt(hex.substr(i * 2, 2), 16));

  // Expected: 0x00 || 0x01 || 0xFF...FF || 0x00 || DigestInfo || SHA-256(input)
  var hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signingInput);
  var tail = SHA256_DIGEST_INFO_.concat(hash.map(function (b) { return b & 0xff; }));
  var psLen = k - tail.length - 3;
  if (psLen < 8) return false;

  var expected = [0x00, 0x01];
  for (var j = 0; j < psLen; j++) expected.push(0xff);
  expected.push(0x00);
  expected = expected.concat(tail);
  if (expected.length !== em.length) return false;

  var diff = 0;
  for (var q = 0; q < em.length; q++) diff |= (em[q] ^ expected[q]);
  return diff === 0;
}

// ─── ADMIN CHECK ─────────────────────────────────────────────────────────────
function isAdmin(email) {
  var raw = readSettings()["admins"];
  if (raw === undefined) return false;
  try {
    var admins = JSON.parse(raw);
    return Array.isArray(admins) && normalizeEmails_(admins).indexOf(email) >= 0;
  } catch(e) { return false; }
}

// Entra UPNs are case-insensitive and users type them inconsistently, so the
// sheet's admin/member lists are compared case-insensitively.
function normalizeEmails_(list) {
  return list.map(function (x) { return String(x).trim().toLowerCase(); });
}

// ─── MEMBER CHECK ────────────────────────────────────────────────────────────
// If "members" key exists in Settings with a non-empty array, only those sign-in
// names can access the system. If the key is absent or empty, any account in the
// JHU tenant is allowed (backward compatible).
function isMember(email) {
  var raw = readSettings()["members"];
  if (raw === undefined) return true; // key not set → allow anyone in the JHU tenant
  try {
    var members = JSON.parse(raw);
    if (!Array.isArray(members) || members.length === 0) return true;
    return normalizeEmails_(members).indexOf(email) >= 0;
  } catch(e) { return true; }
}

// ─── DELETE LOG ──────────────────────────────────────────────────────────────
function logDeletion(type, name, details, deletedBy) {
  appendRow("DeleteLog", {
    date: new Date().toISOString().slice(0, 19).replace("T", " "),
    type: type, name: name, details: details, deletedBy: deletedBy,
  });
  sendSlack("🗑️", type + " Deleted: " + name, null, ["*Deleted by*\n" + deletedBy, "*Details*\n" + details], "normal");
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
// Logs every significant write action for accountability / troll detection.
// Columns: date | user | email | action | details
function logAudit(userName, userEmail, action, details) {
  appendRow("AuditLog", {
    date: new Date().toISOString().slice(0, 19).replace("T", " "),
    user: userName || "", email: userEmail || "", action: action, details: details || "",
  });
}

// ─── STORAGE LAYER ────────────────────────────────────────────────────────────
// The only code that knows the data lives in a Google Sheet. Everything else —
// auth, RBAC, Slack, digest, audit logging, and every action handler in
// doGet/doPost — is storage-agnostic and goes through the functions here.
//
// To move the data elsewhere (SharePoint Lists via Graph, a real database, …),
// reimplement this section and nothing else.
//
// Two things deliberately sit OUTSIDE this layer because they are not storage at
// all — they emit formatted spreadsheets as output artifacts, and have no
// equivalent after a migration. Both are marked SHEETS-ONLY:
//   · backupSpreadsheet()                    → superseded by the target store's own versioning
//   · doPost action "generatePurchaseSummary" → would become a generated file/export
//
// `match` throughout is either an id — compared leniently via idsMatch, because
// Sheets happily turns "007" into the number 7 — or a predicate over the row object.

// Canonical column order. Sheets are positional, so this is authoritative for
// writes. A typed store would use it only as the field list.
const TABLE_HEADERS = {
  Items:      ["id","name","cat","qty","unit","loc","minQty","img","desc","status","usedBy","serial","displayId","shared","consumable"],
  Deliveries: ["id","item","qty","unit","from","receivedBy","date","tracking","status"],
  Checkouts:  ["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails"],
  Orders:     ["id","store","item","link","qty","unit","price","cat","requestedBy","reason","urgency","date","status","requestedByEmail"],
  Settings:   ["key","value"],
  DeleteLog:  ["date","type","name","details","deletedBy"],
  AuditLog:   ["date","user","email","action","details"],
  SlackQueue: ["time","emoji","title","details","fields"],
};

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    var h = headers || TABLE_HEADERS[name];
    if (h && h.length > 0) {
      sheet.getRange(1, 1, 1, h.length).setValues([h]);
    }
  }
  return sheet;
}

function sheetToJson(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let val = row[i];
      if (h === "usedBy") {
        if (typeof val === "string") {
          try { val = JSON.parse(val); } catch(e) { val = []; }
        }
        // Always ensure usedBy is a clean array of non-empty strings
        if (!Array.isArray(val)) val = [];
        else val = val.filter(function(x){ return x != null && x !== ""; });
      }
      if (["qty", "minQty", "itemId"].includes(h) && val !== "") {
        val = Number(val);
      }
      if (h === "id") { val = String(val); }
      // Ensure text fields are strings — Sheets auto-detects numbers in text cells
      // (e.g. a serial number "12345678" returns as the JS number 12345678)
      var textFields = ["name","loc","cat","desc","serial","unit","status","displayId","tags","item","store","requestedBy","reason","link","from","receivedBy","tracking"];
      if (textFields.indexOf(h) >= 0 && typeof val !== "string") {
        val = val == null ? "" : String(val);
      }
      // Normalize datetime fields — Sheets auto-converts "YYYY-MM-DD HH:MM" strings to Date objects
      if (["out","ret"].includes(h)) {
        if (val instanceof Date) {
          val = val.getFullYear()+"-"+String(val.getMonth()+1).padStart(2,"0")+"-"+String(val.getDate()).padStart(2,"0")
               +" "+String(val.getHours()).padStart(2,"0")+":"+String(val.getMinutes()).padStart(2,"0");
        } else if (val != null && typeof val !== "string") { val = String(val); }
      }
      if (h === "date") {
        if (val instanceof Date) {
          val = val.getFullYear()+"-"+String(val.getMonth()+1).padStart(2,"0")+"-"+String(val.getDate()).padStart(2,"0");
        } else if (val != null && typeof val !== "string") { val = String(val); }
      }
      obj[h] = val;
    });
    return obj;
  });
}

// Read every row of a table as plain objects.
function readTable(name) {
  return sheetToJson(getSheet(name));
}

// Locate one row, keeping the sheet handle and row number alongside the parsed
// object. Private: only the writers below use the positional part.
function locateRow_(name, match) {
  var sheet = getSheet(name);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  var headers = data[0];
  var idCol = headers.indexOf("id");
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = data[i][c];
    var hit = (typeof match === "function")
      ? match(obj)
      : (idCol >= 0 && idsMatch(data[i][idCol], match));
    if (hit) return { sheet: sheet, headers: headers, rowNum: i + 1, raw: data[i], obj: obj };
  }
  return null;
}

// Find one row, or null. The result is a snapshot — mutating it does nothing.
function findRow(name, match) {
  var hit = locateRow_(name, match);
  return hit ? hit.obj : null;
}

// Sheets cells hold scalars only, so arrays are serialized on the way in.
function serializeCell_(header, val) {
  if (header === "usedBy" && Array.isArray(val)) return JSON.stringify(val);
  return (val === undefined || val === null) ? "" : val;
}

function appendRow(name, obj) {
  var sheet = getOrCreateSheet(name);
  var headers = TABLE_HEADERS[name] || sheet.getDataRange().getValues()[0];
  sheet.appendRow(headers.map(function(h) { return serializeCell_(h, obj[h]); }));
  // Keep ids textual — Sheets would otherwise render "0012" as 12 and break lookups.
  var idCol = headers.indexOf("id");
  if (idCol >= 0) sheet.getRange(sheet.getLastRow(), idCol + 1).setNumberFormat("@");
}

// Patch the named fields of one row, leaving every other column untouched (rows
// written by an older schema keep their extra columns). Returns the row as it was
// BEFORE the update, or null if no row matched.
function updateRow(name, match, patch) {
  var hit = locateRow_(name, match);
  if (!hit) return null;
  var row = hit.raw.slice();
  Object.keys(patch).forEach(function(f) {
    var col = hit.headers.indexOf(f);
    if (col >= 0 && patch[f] !== undefined) row[col] = serializeCell_(f, patch[f]);
  });
  hit.sheet.getRange(hit.rowNum, 1, 1, row.length).setValues([row]);
  return hit.obj;
}

// Returns the deleted row, or null — every caller logs what it removed.
function deleteRow(name, match) {
  var hit = locateRow_(name, match);
  if (!hit) return null;
  hit.sheet.deleteRow(hit.rowNum);
  return hit.obj;
}

// Drop every row but the header.
function clearTable(name) {
  var sheet = getSheet(name);
  if (!sheet) return;
  var n = sheet.getLastRow();
  if (n > 1) sheet.deleteRows(2, n - 1);
}

// Settings is key/value rather than a record table, so it gets its own pair.
function readSettings() {
  var out = {};
  var sheet = getSheet("Settings");
  if (!sheet) return out;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) out[String(data[i][0])] = data[i][1];
  return out;
}

function writeSetting(key, value) {
  var sheet = getOrCreateSheet("Settings");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(key)) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function idsMatch(sheetVal, targetId) {
  var a = String(sheetVal).trim();
  var b = String(targetId).trim();
  if (a === b) return true;
  try { if (Number(a) === Number(b) && !isNaN(Number(a))) return true; } catch(e) {}
  if (a.replace(/\.0+$/, "") === b.replace(/\.0+$/, "")) return true;
  return false;
}

// ─── GET ─────────────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    const user = verifyToken(token);
    if (!user) {
      return jsonResponse({ error: "Unauthorized", detail: "Token verification failed" });
    }
    if (!isMember(user.email)) {
      return jsonResponse({ error: "NotMember", detail: "Your account is not authorized to access this lab's system. Contact a lab admin." });
    }

    return jsonResponse({
      items: readTable("Items"),
      deliveries: readTable("Deliveries"),
      checkouts: readTable("Checkouts"),
      orders: readTable("Orders"),
      settings: readSettings(),
      userRole: isAdmin(user.email) ? "admin" : "member",
    });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
  const body = JSON.parse(e.postData.contents);
  const user = verifyToken(body.token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized", detail: "Token verification failed for POST" });
  }
  if (!isMember(user.email)) {
    return jsonResponse({ error: "NotMember", detail: "Your account is not authorized to access this lab's system." });
  }

  const action = body.action;
  const userEmail = user.email || "";
  const userName = user.name || userEmail;
  const admin = isAdmin(userEmail);

  // ── Add Item ──────────────────────────────────────────────────────────────
  if (action === "addItem") {
    var addLock = LockService.getScriptLock();
    addLock.waitLock(10000);
    try {
      const it = body.item;
      // Always generate displayId server-side (inside the lock) to prevent collisions.
      const allItems = readTable("Items");
      const isSubId = /^.+-\d{3}$/.test(String(it.displayId||""));
      if (!isSubId) {
        // Regular item: global sequential 6-digit counter across all prefixes.
        const prefixMatch = String(it.displayId||"GEN-000000").match(/^([^-]+)-/);
        const prefix = prefixMatch ? prefixMatch[1] : "GEN";
        const maxNum = Math.max(0, ...allItems.map(function(i) {
          var m = String(i.displayId||"").match(/(\d{6})(?:-\d+)?$/);
          return m ? parseInt(m[1]) : 0;
        }));
        it.displayId = prefix + "-" + String(maxNum + 1).padStart(6, "0");
      } else {
        // Sub-ID item (e.g. CE-000042-001): assign next available 3-digit suffix
        // for this base ID server-side so concurrent "Add Unit" calls can't collide.
        const baseId = String(it.displayId||"").replace(/-\d{3}$/, "");
        const maxSuffix = Math.max(0, ...allItems
          .filter(function(i) { return String(i.displayId||"").replace(/-\d{3}$/, "") === baseId; })
          .map(function(i) {
            var m = String(i.displayId||"").match(/-(\d{3})$/);
            return m ? parseInt(m[1]) : 0;
          })
        );
        it.displayId = baseId + "-" + String(maxSuffix + 1).padStart(3, "0");
      }
      appendRow("Items", it);
      sendSlack("📦", "New Item Added: " + it.name, null, ["*Category*\n" + (it.cat||"—"), "*Qty*\n" + (it.qty||0) + " " + (it.unit||""), "*Location*\n" + (it.loc||"—"), "*Added by*\n" + userName]);
      logAudit(userName, userEmail, "AddItem", it.name + " | qty:" + (it.qty||0) + " " + (it.unit||"") + " | cat:" + (it.cat||"") + " | id:" + (it.displayId||""));
      return jsonResponse({ ok: true, displayId: it.displayId });
    } finally {
      addLock.releaseLock();
    }
  }

  // ── Update Item ───────────────────────────────────────────────────────────
  if (action === "updateItem") {
    const it = body.item;
    const fields = ["name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "serial", "displayId", "shared", "consumable"];
    const patch = {};
    fields.forEach(f => { if (it[f] !== undefined) patch[f] = it[f]; });

    if (!updateRow("Items", it.id, patch)) {
      return jsonResponse({ error: "Item not found", detail: "No item with id " + it.id });
    }
    logAudit(userName, userEmail, "UpdateItem", (it.name||"") + " | id:" + (it.displayId||it.id||""));
    return jsonResponse({ ok: true });
  }

  // ── Delete Item (admin only) ──────────────────────────────────────────────
  if (action === "deleteItem") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can delete items" });
    }
    const itemId = body.itemId;
    const row = findRow("Items", itemId);
    if (!row) {
      return jsonResponse({ error: "Item not found", detail: "No item with id " + itemId });
    }
    // Log before destroying, so a failure here can't lose the audit trail.
    var itemName = row.name || "Unknown";
    var details = "cat:" + (row.cat||"") + " qty:" + (row.qty||"") + " loc:" + (row.loc||"") + " serial:" + (row.serial||"");
    logDeletion("Item", itemName, details, userName);
    logAudit(userName, userEmail, "DeleteItem", itemName + " | " + details);
    deleteRow("Items", itemId);
    return jsonResponse({ ok: true });
  }

  // ── Add Delivery ──────────────────────────────────────────────────────────
  if (action === "addDelivery") {
    const d = body.delivery;
    appendRow("Deliveries", d);
    sendSlack("🚚", "Delivery Received: " + d.item, null, ["*Qty*\n" + d.qty + " " + d.unit, "*Supplier*\n" + (d.from||"—"), "*Received by*\n" + (d.receivedBy||userName), "*Tracking*\n" + (d.tracking||"—")]);
    logAudit(userName, userEmail, "AddDelivery", d.item + " × " + d.qty + " " + (d.unit||"") + " from " + (d.from||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Add Checkout ──────────────────────────────────────────────────────────
  if (action === "addCheckout") {
    const c = body.checkout;
    appendRow("Checkouts", c);
    updateItemStatus(c.item, "In Use", c.user, "add");
    sendSlack("🔑", "Item Checked Out: " + c.item, null, ["*Person*\n" + c.user, "*Date*\n" + (c.out||"—"), "*Return by*\n" + (c.ret||"—")]);
    logAudit(userName, userEmail, "Checkout", c.item + " → " + c.user + " | return by:" + (c.ret||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Return Item ───────────────────────────────────────────────────────────
  if (action === "returnItem") {
    const coId = body.checkoutId;
    const co = findRow("Checkouts", coId);
    if (co) {
      // Legacy rows written before these columns existed have no owner recorded,
      // and stay returnable by anyone.
      const coEmail = String(co.checkedOutByEmail || "").trim().toLowerCase();
      const groupList = String(co.groupEmails || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
      if (!admin && coEmail && userEmail !== coEmail && !groupList.includes(userEmail)) {
        return jsonResponse({ error: "Forbidden", detail: "Only the person who checked out this item, group members, or an admin can return it." });
      }
      const now = new Date();
      const nowStr = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0")
                    +" "+String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
      updateRow("Checkouts", coId, { ret: nowStr, status: "Returned" });
      updateItemStatus(co.item, "Available", co.user, "remove");
      sendSlack("✅", "Item Returned: " + co.item, null, ["*Returned by*\n" + userName]);
      logAudit(userName, userEmail, "Return", co.item + " | originally checked out by:" + co.user);
    }
    return jsonResponse({ ok: true });
  }

  // ── Add Order ─────────────────────────────────────────────────────────────
  if (action === "addOrder") {
    const o = body.order;
    appendRow("Orders", o);
    var linkText = o.link ? " | <" + o.link + "|Purchase Link>" : "";
    sendSlack("🛒", "New Order Request: " + o.item,
      "*Store:* " + (o.store||"—") + linkText,
      ["*Qty*\n" + o.qty + " " + o.unit, "*Urgency*\n" + (o.urgency||"Normal"), "*Price*\n" + (o.price||"—"), "*Requested by*\n" + userName],
      (o.urgency==="Urgent"||o.urgency==="High")?"high":"normal");
    logAudit(userName, userEmail, "AddOrder", o.item + " | " + (o.store||"—") + " | qty:" + o.qty + " | urgency:" + (o.urgency||"Normal"));
    return jsonResponse({ ok: true });
  }

  // ── Update Order ──────────────────────────────────────────────────────────
  if (action === "updateOrder") {
    const o = body.order;
    const existing = findRow("Orders", o.id);
    if (!existing) return jsonResponse({ error: "Order not found" });

    // Legacy rows without requestedByEmail are not restricted.
    const reqEmail = String(existing.requestedByEmail || "").trim().toLowerCase();
    if (!admin && reqEmail && userEmail !== reqEmail) {
      return jsonResponse({ error: "Forbidden", detail: "Only the person who submitted this order or an admin can edit it." });
    }
    const fields = ["store","item","link","qty","unit","price","cat","requestedBy","reason","urgency","date","status"];
    const patch = {};
    fields.forEach(f => { if (o[f] !== undefined) patch[f] = o[f]; });
    updateRow("Orders", o.id, patch);
    logAudit(userName, userEmail, "UpdateOrder", (o.item||"") + " | store:" + (o.store||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Send Digest (admin only) ───────────────────────────────────────────────
  if (action === "sendDigest") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can send digest" });
    }
    try { sendDailyDigest(); } catch(e) { return jsonResponse({ error: "Digest failed", detail: e.message }); }
    return jsonResponse({ ok: true });
  }

  // ── Update Order Status ───────────────────────────────────────────────────
  if (action === "updateOrderStatus") {
    const orderId = body.orderId;
    const newStatus = body.status;
    const prev = updateRow("Orders", orderId, { status: newStatus });
    if (!prev) {
      return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
    }
    var orderItem = prev.item || "";
    sendSlack("📋", "Order Status Updated: " + orderItem, null, ["*New Status*\n" + newStatus, "*Updated by*\n" + userName]);
    logAudit(userName, userEmail, "OrderStatus", orderItem + " → " + newStatus);
    return jsonResponse({ ok: true });
  }

  // ── Delete Order (admin only) ─────────────────────────────────────────────
  if (action === "deleteOrder") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can delete orders" });
    }
    const orderId = body.orderId;
    const order = findRow("Orders", orderId);
    if (!order) {
      return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
    }
    var orderName = order.item || "Unknown";
    logDeletion("Order", orderName, "id:" + orderId, userName);
    logAudit(userName, userEmail, "DeleteOrder", orderName);
    deleteRow("Orders", orderId);
    return jsonResponse({ ok: true });
  }

  // ── Save Settings (admin only) ────────────────────────────────────────────
  if (action === "saveSettings") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can change settings" });
    }
    writeSetting(body.key, body.value);
    return jsonResponse({ ok: true });
  }

  // ── Log Edit Unlock (non-admin members only; admin skipped client-side) ────
  if (action === "logEditUnlock") {
    logAudit(userName, userEmail, "EditUnlock", "inventory editing unlocked");
    return jsonResponse({ ok: true });
  }

  // ── Generate Purchase Summary sheet ──────────────────────────────────────
  // SHEETS-ONLY — builds a formatted spreadsheet as an output artifact rather
  // than storing data, so it deliberately bypasses the storage layer. On a
  // migration this becomes a generated file/export, not a ported function.
  if (action === "generatePurchaseSummary") {
    var orders = body.orders || [];
    if (orders.length === 0) return jsonResponse({ error: "No orders provided" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = "Purchase Summary";

    // Remove existing sheet if present, then create fresh
    var existing = ss.getSheetByName(sheetName);
    if (existing) ss.deleteSheet(existing);
    var ps = ss.insertSheet(sheetName);

    // ── Header row (plain styling) ──
    var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy");
    ps.getRange(1, 1, 1, 6).merge()
      .setValue("Purchase Summary — " + dateStr)
      .setFontWeight("bold").setFontSize(13);

    // ── Column headers (plain bold, default background) ──
    var headers = ["Qty", "Item", "Unit Price", "Total", "Purchase Link", "Store"];
    var hRow = ps.getRange(2, 1, 1, 6);
    hRow.setValues([headers]).setFontWeight("bold");

    // ── Data rows: qty and price as numbers; total and grand total as formulas ──
    var firstDataRow = 3;
    var dataRows = orders.map(function(o) {
      var qty = parseFloat(o.qty) || 0;
      var price = parseFloat(String(o.price || "").replace(/[^0-9.]/g, "")) || null;
      return [
        qty || o.qty || "",
        o.item || "",
        price !== null ? price : "",  // numeric — formatted as currency below
        "",                           // Total: filled with formula per row below
        o.link || "",
        o.store || ""
      ];
    });

    var lastDataRow = firstDataRow + dataRows.length - 1;

    if (dataRows.length > 0) {
      ps.getRange(firstDataRow, 1, dataRows.length, 6).setValues(dataRows);

      // Per-row total formulas: =A3*C3, =A4*C4, …
      for (var r = 0; r < dataRows.length; r++) {
        var rowNum = firstDataRow + r;
        ps.getRange(rowNum, 4).setFormula("=A" + rowNum + "*C" + rowNum);

        // Clickable hyperlink in Link column
        var link = dataRows[r][4];
        if (link && link.startsWith("http")) {
          ps.getRange(rowNum, 5).setFormula('=HYPERLINK("' + link.replace(/"/g, '""') + '","' + link.replace(/"/g, '""') + '")');
        }
      }

      // Format Unit Price (col C) and Total (col D) as currency
      ps.getRange(firstDataRow, 3, dataRows.length, 2)
        .setNumberFormat('"$"#,##0.00');
    }

    // ── Grand total row with SUM formula ──
    var totalRow = lastDataRow + 2;
    ps.getRange(totalRow, 1, 1, 3).merge().setValue("Grand Total").setFontWeight("bold").setHorizontalAlignment("right");
    ps.getRange(totalRow, 4)
      .setFormula("=SUM(D" + firstDataRow + ":D" + lastDataRow + ")")
      .setNumberFormat('"$"#,##0.00')
      .setFontWeight("bold");

    // ── Column widths and freeze ──
    ps.setColumnWidth(1, 50);   // Qty
    ps.setColumnWidth(2, 220);  // Item
    ps.setColumnWidth(3, 100);  // Unit Price
    ps.setColumnWidth(4, 90);   // Total
    ps.setColumnWidth(5, 320);  // Link
    ps.setColumnWidth(6, 120);  // Store
    ps.setFrozenRows(2);

    ss.setActiveSheet(ps);
    logAudit(userName, userEmail, "PurchaseSummary", orders.length + " items");
    return jsonResponse({ ok: true });
  }

  // ── Backup Now (admin only) ───────────────────────────────────────────────
  if (action === "backupNow") {
    if (!admin) return jsonResponse({ error: "Forbidden", detail: "Admin only" });
    var backupName = backupSpreadsheet();
    return jsonResponse({ ok: true, backupName: backupName });
  }

  return jsonResponse({ error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── Update item status & usedBy in Items sheet ──────────────────────────────
function updateItemStatus(itemName, newStatus, userName, mode) {
  const byName = function(r) { return r.name === itemName; };
  const item = findRow("Items", byName);
  if (!item) return;

  const patch = {};
  // A shared item stays "Available" while checked out — several people hold it at once.
  const isShared = item.shared === true || String(item.shared).toLowerCase() === "true";
  if (!(newStatus === "In Use" && isShared)) patch.status = newStatus;

  let usedBy = [];
  try { usedBy = JSON.parse(item.usedBy) || []; } catch(e) {}
  if (!Array.isArray(usedBy)) usedBy = [];
  if (mode === "add" && !usedBy.includes(userName)) usedBy.push(userName);
  else if (mode === "remove") usedBy = usedBy.filter(u => u !== userName);
  patch.usedBy = usedBy;   // serialized on write by the storage layer

  updateRow("Items", byName, patch);
}
