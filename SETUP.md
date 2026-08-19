# LabTrack Setup Guide — Alliance AI Lab

## Quick Start

1. Go to **https://labtrack.zizhe.io/**
2. Sign in with your **Johns Hopkins** account (`<JHED>@jh.edu`)
3. Start managing inventory

> **Sign-in does not work yet.** A JHU Entra administrator must grant admin
> consent once before anyone can sign in — see [Microsoft Entra ID Setup](#microsoft-entra-id-setup-sign-in).
> Until then, use **Preview without signing in** on the login page to explore the
> interface, or the [dev escape hatch](#running-without-sign-in) to test against a
> real Sheet.

## Current status

| | |
|---|---|
| App | ✅ deployed at `labtrack.zizhe.io` (temporary home; the intended one is a subdomain of the lab domain, which needs a JHU CS IT DNS request) |
| Entra app registration | ✅ created — `06d4df0f-39e8-4c3a-aa24-8e76a45d1aa3` |
| Admin consent | ❌ **not granted** — the one thing blocking real sign-in |
| Backend | ❌ no Sheet yet; `apps_script_url` is empty, so the app runs out of localStorage |
| Slack | ❌ webhook not created |
| Data store | Google Sheet for now, **SharePoint List is the destination** — see [Moving the data](#moving-the-data-to-sharepoint) |
| Backend host | Apps Script for now; whether it moves to Azure depends on the scheduled jobs — see [Moving the backend](#moving-the-backend-off-google) |

---

## Google Sheet Schema

The backend uses a Google Sheet with these tabs:

**Items** — `id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable`

**Deliveries** — `id | item | qty | unit | from | receivedBy | date | tracking | status`

**Checkouts** — `id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails | qty | fromTime | toTime | notes`

**Orders** — `id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail`

> ⚠️ Column order matters for new rows written by the script. If upgrading an existing sheet:
> - **Orders**: add `requestedByEmail` as the last column (column 14)
> - **Checkouts**: add `checkedOutByEmail`, `groupEmails`, `qty`, `fromTime`, `toTime` and `notes` as the last six columns
> - `setupNewLab()` appends whatever is missing for you, in place, without touching existing rows
> - Existing rows without these columns remain fully functional (permissions fall back gracefully)

**Settings** — `key | value`

| key | value |
|-----|-------|
| `categories` | `["Robots & Motors","Sensors & Vision","Compute & Electronics","Wiring & Networking","Tools & Hardware","Consumables & Supplies","Safety & Facility","Other"]` |
| `admins` | `["jdoe12@jh.edu"]` — use the **sign-in name** (`<JHED>@jh.edu`), not the `@jhu.edu` mail alias. Compared case-insensitively. Must be valid JSON: `isAdmin` treats a value it cannot parse as "nobody is an admin", and only the Settings tab itself can then put you back. Saving it through the app is checked for exactly that, and refuses a list that leaves you out. |
| `members` | `["jdoe12@jh.edu","asmith3@jh.edu"]` — if present and non-empty, only these accounts can sign in; all other JHU accounts are rejected. Omit the key (or leave it as `[]`) to allow anyone in the JHU tenant. **Anyone in `admins` is a member whether or not they are listed here** — otherwise filling this in and forgetting yourself would lock you out of your own lab, settings included. |
| `cat_prefixes` | `{"Robots & Motors":"RM","Sensors & Vision":"SV"}` — the label prefix per category, set from **Manage Categories** in the app. Written here as well as cached per-browser, because it decides what gets printed on a sticker: when it lived only in `localStorage`, the admin's machine and everyone else's produced two label series for one category, and clearing site data started a third |
| `slack_mode` | `all` or `important` or `digest` or `off` |

**DeleteLog** (auto-created) — `date | type | name | details | deletedBy`

**AuditLog** (auto-created) — `date | user | email | action | details`

| Action | Logged for | Details |
|--------|-----------|---------|
| `EditUnlock` | non-admins only | "inventory editing unlocked" |
| `AddItem` | everyone | name, qty, category, label ID |
| `UpdateItem` | everyone | name, label ID |
| `DeleteItem` | admins only | name + cat/qty/loc/serial |
| `AddDelivery` | everyone | item × qty, supplier |
| `Checkout` | everyone | item → person, return date |
| `Return` | everyone | item, original checkout owner |
| `AddOrder` | everyone | item, store, qty, urgency |
| `UpdateOrder` | requester (while Pending) or admin | item, store |
| `OrderStatus` | admins only | item → new status |
| `DeleteOrder` | admins only | order name |
| `CheckoutPending` | everyone | item → person, until, why it waits, how many competing |
| `CheckoutApproved` | admins only | item → person |
| `CheckoutRejected` | admins only | item → person |
| `CheckoutEdited` | requester or admin | item → person, the new dates |
| `CheckoutWithdrawn` | requester or admin | item, what was withdrawn |
| `NotifyLowStock` | everyone | item, note |
| `PurchaseSummary` | admins only | how many orders |
| `SaveSetting` | admins only | key = value (first 200 chars) |

**SlackQueue** (auto-created, used by digest mode) — `time | emoji | title | details | fields`

---

## Microsoft Entra ID Setup (sign-in)

Sign-in is restricted to the Johns Hopkins Entra tenant
(`9fa4f438-b1e6-473b-803f-86f8aedf0dec`, resolvable any time from
`https://login.microsoftonline.com/jh.edu/v2.0/.well-known/openid-configuration`).

### The app registration (already created)

| Setting | Value |
|---|---|
| Application (client) ID | `06d4df0f-39e8-4c3a-aa24-8e76a45d1aa3` |
| Object ID | `131c5c77-3d58-40b5-979f-3773a54776ca` |
| Service principal ID | `6b25d3e1-700e-42b8-ac1d-79bf68e258c5` |
| Display name | LabTrack — Alliance AI Lab |
| Supported account types | Single tenant (`AzureADMyOrg`) |
| Platform | **Single-page application (SPA)** — *not* Web |
| Redirect URIs | `https://labtrack.zizhe.io/`, `http://localhost:8000/`, `http://localhost:8000/index.html` |
| API permissions | `openid`, `profile`, `email`, `offline_access` (delegated, Microsoft Graph) |
| Implicit grant | Off — MSAL uses authorization code flow with PKCE |

This is **separate from the Figueroa lab's registration** (`5ac3d97f-…`), on purpose.
Sharing one would mean either lab's token passed the other backend's `aud` check,
and Alliance users would see "Figueroa Lab Inventory" on the Microsoft sign-in screen.

Adding a redirect URI later (a new domain, say) means **rewriting the whole list**.
PATCH replaces `spa.redirectUris` outright — it does not merge — so every URI you
still want has to appear, including the two localhost ones the local-dev section
below tells you to open:

```bash
az rest --method PATCH \
  --url https://graph.microsoft.com/v1.0/applications/131c5c77-3d58-40b5-979f-3773a54776ca \
  --body '{"spa":{"redirectUris":[
    "https://labtrack.zizhe.io/",
    "http://localhost:8000/",
    "http://localhost:8000/index.html",
    "<new URL>"]}}'
```

Leaving one out does not fail; sign-in from that address just starts returning
`AADSTS50011: redirect URI … does not match`. Read the current list back first if
you are unsure:

```bash
az rest --method GET \
  --url https://graph.microsoft.com/v1.0/applications/131c5c77-3d58-40b5-979f-3773a54776ca \
  --query spa.redirectUris
```

The SPA platform type matters: it enables CORS on the token endpoint and issues
SPA refresh tokens, which is what keeps sessions alive without third-party cookies.
`offline_access` is added by MSAL automatically to obtain that refresh token.

The client ID is already filled into **both** files, and they must stay in sync —
the backend checks that the token was minted for this exact app:

- `index.html` → `window.ENTRA_CONFIG.client_id` (near the top)
- `google-apps-script.js` → `ENTRA_CLIENT_ID`

To restrict further than "anyone at JHU", set `ALLOWED_UPN_DOMAINS = ["jh.edu"]`
in `google-apps-script.js`, or use the `members` allowlist in the Settings tab.

> **`jh.edu` vs `jhu.edu`**: JHU sign-in names (UPNs) are `<JHED>@jh.edu`, but mail
> is often `@jhu.edu`. The app keys off the sign-in name, so `admins`/`members`
> lists and group-checkout emails must use `@jh.edu`.

The JHU tenant allows users to register apps (`allowedToCreateApps: true`), so no
admin was needed to create this. It does **not** allow users to consent to apps, so
a Global Administrator or Cloud Application Administrator must grant consent once
before anyone can sign in — see below. The Entra admin center portal returns 401
for ordinary accounts; use Microsoft Graph via `az rest` instead, which the portal
restriction does not cover.

### One-time admin consent (required before first sign-in)

Ask a JHU Entra administrator to do **either**:

- Open <https://login.microsoftonline.com/9fa4f438-b1e6-473b-803f-86f8aedf0dec/adminconsent?client_id=06d4df0f-39e8-4c3a-aa24-8e76a45d1aa3> and accept, or
- Entra admin center → Enterprise applications → *LabTrack — Alliance AI Lab* → Permissions → **Grant admin consent**

Without this, sign-in stops at *"Approval required — this app requires your admin's approval"*.

What to tell them: no client secret, no application permissions, and no Graph data
is read beyond the signed-in user's own name and sign-in address. Single tenant, so
only JHU accounts can use it at all.

Check whether it has landed:

```bash
az rest --method GET \
  --url https://graph.microsoft.com/v1.0/servicePrincipals/6b25d3e1-700e-42b8-ac1d-79bf68e258c5/oauth2PermissionGrants
# "value": []  → not granted yet
```

> **If you also want the SharePoint scope, add it to the registration *before*
> asking.** One request to IT covers both; asking later means a second round trip.
> See [Moving the data](#moving-the-data-to-sharepoint) for which scope to pick.

---

## Running without sign-in

Two ways to use the app while admin consent is pending. They are different tools:

| | Preview | Dev key |
|---|---|---|
| Button/switch | Member One / Member Two / Admin on the login page | `LAB_CONFIG.dev_key` + `DEV_NO_AUTH_KEY` |
| Backend | none — data lives in `localStorage` | the real Sheet |
| Risk | none | **removes authentication from the deployment** |
| Use for | reviewing the interface, demos | testing sync, RBAC, Slack, the digest |

**Preview** needs no setup and offers three doors, defined in `PREVIEW_USERS`.
They are three *people*, not two roles. The roles differ in what the interface
offers at all (deleting, categories, order status). The two members differ in what
is **theirs** — and half of what the app decides is exactly that, so one member
login could only ever show one side of it:

| | Member One | Member Two | Admin |
|---|---|---|---|
| Overdue banner | "You have 1 overdue item" | none — it isn't theirs | "1 item overdue in the lab" |
| Low-stock banner & chip | hidden | hidden | shown |
| Pending requests on the calendar | only their own | only their own | everyone's |
| Pending requests in the Usage list | everyone's, by name | everyone's, by name | everyone's |
| Edit / Withdraw on a request | only their own | only their own | anyone's |

Nothing reaches the backend: every API call is short-circuited client-side, and
`verifyToken` rejects the token value `"local"` as its first statement, so it
cannot touch real data even in principle.

**Preview starts with a sample lab, not an empty grid.** `demoData()` in
`index.html` seeds seven items, three checkouts, two competing requests, an
overdue hold, a delivery and an order, cast across the three preview identities
so that who-owns-what is visible — enough that every state worth looking at
(shared item with a daily window, split units, a low-stock consumable, an
untracked supply, an approval queue, the overdue banner) is on screen without
anyone hand-building an inventory first. Dates are relative to today, so it never
goes stale.

It seeds only when the local store is empty **and** the token is `"local"`, so it
can never appear in front of a real backend. Editing it is normal — changes persist
to `localStorage` like any preview change. To get the sample lab back, clear
`labtrack_data_preview` (or the whole origin) and sign in again.

Preview writes to **`labtrack_data_preview`**; a real session's offline cache is
**`labtrack_data`**. They used to share one key, and both the no-backend branch and
the backend-error fallback read that cache — so someone who clicked "Member One" to
look around and then signed in for real was shown the sample lab as if it were the
lab's, and any write went out against those rows. Separate keys make that
impossible in both directions.

**Dev key** — set the same random string in both files:

```js
// index.html
window.LAB_CONFIG = { …, dev_key: "some-random-string" };

// google-apps-script.js
const DEV_NO_AUTH_KEY  = "some-random-string";
const DEV_NO_AUTH_EMAIL = "zzhan409@jh.edu";   // identity the backend assumes
```

> ⚠️ The key is in the page source, and the web app is deployed as "Anyone".
> Anyone who opens the URL can read the key and then read and write the Sheet.
> **Use it on `http://localhost:8000/` against a scratch Sheet only**, and deploy
> the normal auth-gated build to the public URL. A permanent red banner shows
> while it is on. Set both back to `""` before real inventory goes in.

---

## Apps Script Deployment

1. Create a **new, empty Google Sheet** — Alliance gets its own, separate from
   Figueroa's. Everything below assumes a blank one.
2. **Extensions → Apps Script**, paste the contents of `google-apps-script.js`
3. **Run → `setupNewLab`.** This creates all eight tabs with the correct headers
   and seeds Settings (categories, admins, members, slack_mode). It is idempotent,
   so it is safe to re-run later. Without it you would be building tabs by hand and
   column order matters.
4. Confirm `ENTRA_CLIENT_ID` matches `client_id` in `index.html`, and replace
   `"YOUR_SLACK_WEBHOOK_URL_HERE"` with your Slack webhook URL
5. **Set script timezone**: Project Settings → Time zone → **America/New_York**
6. **Deploy → New deployment** → Web app → Execute as: Me → Who has access: Anyone
7. Copy the Web app URL into `LAB_CONFIG.apps_script_url` in `index.html`

> After code updates, always create a **new version** via Deploy → Manage deployments.

> **`Execute as: Me` binds the deployment to one Google account permanently.**
> JHU has no Google Workspace, so that account is necessarily a personal one.
> This is acceptable while the Sheet is an interim store — but it is also the
> reason the data is headed for SharePoint. If the Sheet ends up being kept, move
> it to a lab-held Google account rather than a graduating student's.

### Slack Notification Modes

Set `slack_mode` in the Settings tab:

| Mode | Behavior |
|------|----------|
| `all` | Every action sends a Slack notification |
| `important` | Only urgent/high order requests + overdue checkouts |
| `digest` | Queues events; sends compact daily summary at 5pm ET |
| `off` | No notifications |

### Setting Up Triggers

Easiest: run **`createTriggers()`** once from the Apps Script editor. It removes any
existing triggers for these three functions first, so it is safe to re-run, and
creates all three at the right times.

By hand instead — **Apps Script → Triggers → Add Trigger**:

| Function | Event Type | Time | Needed for |
|----------|-----------|------|------------|
| `sendDailyDigest` | Time-driven → Day timer | **5pm – 6pm** | digest mode |
| `checkOverduesAndAlert` | Time-driven → Day timer | 8am – 9am | overdue nags, any mode |
| `backupSpreadsheet` | Time-driven → Week timer, Sunday | 3am – 4am | the weekly Drive copy |

> Make sure the script timezone is **America/New_York** so 5pm ET is correct.

### Daily Digest Format (sent at 5pm ET)

The digest is compact but informative — designed for your PI to quickly review:
- 🚨 **Urgent/High orders** — item, qty, store, price, purchase link
- 🛒 **All pending orders** — item, store, status
- 🔴 **Overdue checkouts** — item, person, due date
- 📦 **Low stock items** — item, current/min qty
- One-line activity count: e.g. `🚚 ×3 · 🔑 ×5 · ✅ ×2` (no per-event listing)

Deletions are **not** flagged as important — admins delete items during cleanup and it shouldn't flood the channel. Deletions are logged in the DeleteLog sheet and appear in digest mode only as a count.

### Admin: Manual Digest

Admins can send the digest at any time by clicking the **Digest** button in the top header bar. This is useful for testing or when your PI needs an immediate summary.

---

## Admin System

Add sign-in names to the `admins` list in the Settings tab to grant admin access.
Use the `@jh.edu` UPN, not the `@jhu.edu` mail alias:
```
["jdoe12@jh.edu","asmith3@jh.edu"]
```

**Admins can**: delete items/orders, manage categories, change settings, send digest manually, change order status (Approve/Reject/etc.), approve or reject a booking that is waiting, edit any order request, return any checked-out item, write the Purchase Summary sheet, run a backup

**All users can**: add/edit items, check out items, log deliveries, submit order requests, report a supply as running low

**Requester** (or admin): edit their own order request — but only while it is still `Pending`. Once an admin approves it, editing the quantity or price would quietly change what was approved, so it becomes admin-only. Enforced in Apps Script, not just hidden in the UI

**Requester** (or admin): edit or withdraw their own booking request — but only while it is still `Pending Approval`. `updateCheckout` accepts `out`, `ret`, `fromTime`, `toTime` and `groupEmails` and nothing else; taking the body wholesale would let a member patch `status: "Active"` and approve themselves

**Checkout owner + group members** (or admin): return a checked-out item, and only while it is still `Active`. Group members are listed at checkout time as comma-separated emails, matched case-insensitively on both sides.

All deletions are logged in the DeleteLog tab with timestamp, details, and who deleted.

### What the server decides, whatever the browser sends

The form is not the boundary. Anything a browser can POST, `curl` can POST, so a
few fields are overwritten server-side rather than trusted:

| Field | Rule |
|-------|------|
| `Orders.status` | A member's create is forced to `Pending`, and `status` is dropped from a member's edit. `updateOrderStatus` is admin-only and says why; `updateOrder` used to carry `status` in its whitelist, so a member could walk round the back and approve their own $2400 request — silently, with no Slack notice and an audit line reading only `UpdateOrder \| store:—`. The form hides the dropdown from members and labels it *Status (Admin only)*; that hid it from the click, not from the request |
| `Orders.requestedBy` / `requestedByEmail` | Stamped with the caller on create, so a request cannot be filed under someone else's name |
| `Checkouts.user` / `checkedOutByEmail` | Stamped with the caller on create unless the caller is an admin, who legitimately logs checkouts on other people's behalf. These fields decide who is nagged for an overdue return and who may edit or withdraw the row, so they have to be the person who actually asked |
| `Checkouts.status` | Set by `waitReason_()`, never by the browser. A member cannot post themselves an already-approved booking |
| `Settings.admins` | Refused if it is not a JSON array, or if it leaves the caller out — there would be nobody left in the app to put them back |

---

## Features

- **Inventory**: Add/edit items with serial numbers, label IDs (`PREFIX-NNN`, counted per category; split units add `-NN`), image upload (camera/file/URL), customizable categories (admin only); mark items as Shared (multi-user checkout) or Consumable (qty deduction without checkout). Consumables get no label ID — nothing is stickered — and a supply can be added with no quantity at all, which swaps its Use button for Notify: one click tells whoever restocks that it is running low
- **Order Requests**: Submit orders (store, item, link, qty, price, etc.); only the requester or an admin can edit; admins can change status (Pending/Approved/Ordered/Received/Rejected); "Mark Received" opens a staging form to set location/label/serial before adding to inventory; generate copy-pasteable email text with per-item totals and grand total
- **Usage Tracking**: Check out/return items with overdue alerts and bulk return; only the checkout creator, listed group members, or admins can return an item; consumables use a "Use" button instead of checkout
- **Overdue banner**: anything past its return date raises a red banner at the top of every tab on sign-in. A member sees only their own, and the wording says so ("You have 1 overdue item"); an admin sees the lab's ("1 item overdue in the lab"). Dismissing it lasts until the next reload; the header chip stays either way
- **Low stock is an admin signal**: the running list — banner and header chip — shows only to admins, because restocking is their job and a banner you cannot act on is noise. Members still get the Low Stock badge on the card, and the Notify button on untracked supplies, which is how they say something is running out
- **Group Checkout**: When checking out, optionally list teammates' emails as group members — they can then return the item too
- **Booking rules**: shared items are booked by the hour and long holds need an admin — see below
- **Calendar**: Month and week views. A booking draws as a **span across every day it covers**, not two marks at its ends, coloured by what it is — blue in use, amber awaiting approval, red overdue, grey returned. A daily window (`13:00–16:00`) renders as a block at those hours on **every** day of the hold; an all-day multi-day hold goes in the week view's all-day strip instead, the way a calendar normally splits them. Active holds are visible to everyone; **pending requests only to the person who asked and to admins**, since an undecided request is nobody else's business yet
- **Live Sync**: Auto-polls every 30s so all users see changes without refreshing
- **Sort & paging**: the inventory loads 24 at a time and grows with a *Show more* button — it does not paginate; sort by name, date or quantity. The Order Requests tab does paginate, 15 per page, with search, filter and shift-click range select
- **Slack**: Rich Block Kit notifications; daily 5pm ET digest with compact PI-friendly summary; `important` mode for urgent orders + overdues only
- **Dark/Light Mode**: Toggle with the ☀/🌙 button in the header; preference saved per browser
- **Access Control**: Server-side RBAC — admins control categories/deletion/settings; order editing restricted to requester; returns restricted to checkout owner + group members; all enforced in Apps Script, not just UI
- **Delete Audit Log**: Full record of all deletions

---

## Booking rules

Six rules govern checkouts. All six are enforced in `google-apps-script.js`,
which is the only place that can see everyone's bookings at once; the checkout form
re-implements them so it can refuse before a round trip instead of after one. The
two halves have to be kept in step — the constants carry the same names on both
sides (`MAX_DAYS_WITHOUT_APPROVAL`, `MAX_LEAD_DAYS`, `bookingsClash_`/`bookingsClash`,
`waitReason_`/`waitReason`, `leadTooFar_`/`leadTooFar`, `badRange_`/`badRange`,
`bookingMs_`/`bookingMs`).

**1. Shared items are booked by the hour.** Checking out an item marked *Shared*
asks whether the hold is all day or the same window every day (`fromTime`,
`toTime`, blank = all day). The question only appears when something shared is
selected — a sole-use item is held for the whole span whatever the clock says, so
asking would imply a freedom that isn't there. A batch containing both writes the
window only onto the shared rows.

**2. An active booking owns its slot.** Two bookings of the same item clash when
their date ranges overlap **and** their daily windows do. A blank window is all
day and clashes with anything inside the range. Touching endpoints don't clash, so
handing something over at 12:00 is fine. Only `Active` blocks — see rule 4.

> This applies to **sole-use items too**, which it did not always. The old rule
> skipped them on the grounds that a sole-use item is kept exclusive by its
> availability rather than by the hour — but the In Use flag is written from the
> browser's copy of the item list, which is up to a poll old, so two people who
> pressed Check Out inside the same thirty seconds both got the arm; and the flag
> knows nothing about dates, so it could not tell a booking for next week from one
> for right now. A date range is the honest test for both kinds of item. A sole-use
> item simply has no daily window, which reads as all day and clashes with anything
> inside the range — which is what exclusive means.

**3. A booking waits for an admin for either of two reasons.** `waitReason_()`
is the single place that decides, and returns `"long"`, `"queue"` or `""`:

- `"long"` — the hold is over `MAX_DAYS_WITHOUT_APPROVAL` (7) days, shared or not.
- `"queue"` — it is short enough on its own, but it **overlaps a request that is
  already waiting**. Without this a three-day booking would take the slot a
  three-week request has been queuing for, and win purely by being short enough to
  skip the queue. Whoever asked first gets their claim looked at.

Either way the row is written with status `Pending Approval` and the item is **not**
marked In Use. Slack gets a high-priority ping naming the reason. Admins see a
*Waiting for approval* panel at the top of the Usage tab with Approve / Reject,
which posts `decideCheckout`; members see "Waiting on an admin".

> Only genuine overlap queues. A pending request for October does not make a
> booking in December wait, and on a shared item a 09:00–12:00 request does not
> make a 14:00–16:00 booking wait.

> **The queue is transitive, and that is worth knowing.** Once a short booking
> joins the queue it holds the slot open for the *next* one too, so a single
> long-range request can put every overlapping booking behind an admin until it is
> decided. In a lab this size that is a feature — it forces the decision. Rule 5
> is what keeps its blast radius finite.

**4. A pending request reserves nothing, so several people may ask for the same
slot.** This is the point of it being pending: `Pending Approval` rows are reported
as *competing*, never used to refuse — they change whether a booking needs approval
(rule 3) but never whether it is allowed. The requester sees who else is in the
queue before submitting; the admin sees the whole queue for one item grouped
together and picks. `Returned` and `Rejected` rows are inert, so rejecting empties
the queue and the next booking is ordinary again.

> Competing is detected for **sole-use items too**, and matters most there. A
> pending request marks nothing In Use, so the availability filter that normally
> keeps a sole-use item exclusive cannot see the queue at all. Two people both
> asking for the arm is the ordinary case, not an edge case.

**5. Nothing may start more than `MAX_LEAD_DAYS` (31) days from now.**
`leadTooFar_()` refuses with `"Too far ahead"`, on both `addCheckout` and
`updateCheckout`. Only the **start** is capped — a long hold is still allowed, it
just needs approval, so a request may legitimately end well past the limit.

This exists because of rule 3's queue. A request starting months out would sit
there holding its slot open against every overlapping booking until somebody
decided it, so one speculative request could freeze an item for a term. Capping
the lead time bounds that at a month.

Start dates in the **past** stay legal — logging a checkout after the fact is
normal, and nothing about it can block a future booking that isn't already there.

**6. The dates have to make sense.** `badRange_()` refuses a booking whose return
date is missing, unparseable, or on or before the checkout date, and a daily window
that is half-filled or ends before it starts. This is not fussiness: every rule
above is a comparison between two instants, and a comparison against something
unparseable is false, so a backwards range did not trip the rules — it slipped past
all five at once. It measured as a negative number of days, so it was never long
enough to need approval; it clashed with nothing, so it never blocked; it covered
no calendar day, so it drew nowhere at all — while sitting in the Usage list as an
active, already-overdue loan. Typing the wrong month into the second date box was
all it took. The form refuses it before the round trip and names the reason.

Both ends of a booking are read off the **local** clock. `new Date("2026-08-25")`
is UTC midnight while `new Date("2026-08-25T09:00")` is local, and the form lets
you leave the return *time* blank — so a hold from 18 Aug 09:00 to 25 Aug used to
measure as 6.46 days rather than 7, and one from 18 Aug 20:00 to 26 Aug measured as
exactly 7.0 and so slipped under "more than 7". `bookingMs_()` builds the instant
from the parts rather than leaving it to the parser.

The date picker carries `max={leadLimitDate()}`, so the native calendar greys out
anything later; the red notice is for typed or pasted dates, and the backend
refuses regardless.

### What happens when the admin picks one

Approving does **not** auto-reject the others — that would be destructive and
sometimes wrong, since two long requests for the same item may not overlap at all.
Instead the loser stays pending and becomes unapprovable: its Approve button greys
out and the row explains *"Conflicts with <name>'s approved booking"*. The admin
then rejects it, or edits it onto free dates. The backend refuses the approval
independently, so a stale browser can't slip one through.

The same re-check protects the gap between asking and approving. Because nothing
was reserved, the slot can be gone by the time an admin gets to it. `decideCheckout`
re-runs both tests on approve — the clash test for shared items, an
"is it still on the shelf" test for sole-use ones — and refuses with *"Taken while
this was waiting"* rather than handing one item to two people.

### Editing a request that is still waiting

`updateCheckout` lets the requester (or an admin) move a pending request without
cancelling and retyping it — usually because the app has just told them their slot
collides with someone else's. Editable: `out`, `ret`, `fromTime`, `toTime`,
`groupEmails`. Not editable: the item, the person, the quantity — changing those
makes it a different request.

- The patch is **whitelisted server-side**. Accepting `body.checkout` wholesale
  would let a member send `status: "Active"` and approve themselves.
- Only rows still in `Pending Approval` can be edited. Once decided, it's fixed.
- `cancelCheckout` lets the same people **withdraw** a request instead. Rejection is
  an admin's decision and worth keeping as a record, so it leaves a `Rejected` row;
  withdrawing is just undo, so the row is deleted (logged to `DeleteLog` and
  `AuditLog` first). Withdrawing frees the slot for whoever was queued behind it.
- Editing re-runs the rules through the same `waitReason_()`. Shorten it under the
  seven-day limit **and** off everyone else's slot, and the reason it needed an
  admin is gone, so it becomes a plain `Active` checkout on save and the item is
  handed over — the button changes to *Save & Check Out* to say so. Still
  overlapping someone who is waiting keeps it in the queue, and the notice says
  which of the two reasons applies.
- Moving it onto an `Active` booking is refused, exactly like making one there.

All five rules and both admin paths are covered by `node test-sheet-setup.js`
(119 assertions). That suite runs on a **frozen clock** — bookings are judged
against "now", so a real one would quietly rot every fixture date.

---

## Frontend Configuration

Everything lab-specific lives in one block at the top of `index.html`. Standing
LabTrack up for another lab means editing this and nothing else in the file:

```js
window.LAB_CONFIG = {
  app_title:       "LabTrack for Alliance AI Lab",  // tab, login page, header
  lab_name:        "Alliance AI Lab",
  institution:     "Johns Hopkins University",
  signin_hint:     "@jh.edu",
  apps_script_url: "",   // this lab's own deployment; empty = localStorage only
  dev_key:         "",   // see "Running without sign-in"
  logo:            "data:image/png;base64,…",           // inlined lab mark; also the favicon
};

window.ENTRA_CONFIG = {
  tenant_id: "9fa4f438-b1e6-473b-803f-86f8aedf0dec",  // Johns Hopkins
  client_id: "06d4df0f-39e8-4c3a-aa24-8e76a45d1aa3",  // Alliance AI Lab
  scopes: ["openid", "profile", "email"],
};
```

MSAL is loaded as an ES module from jsDelivr (`@azure/msal-browser@5.18.0`) because
Microsoft retired their own CDN and no longer ships a UMD build.

MSAL derives its redirect URI from `location.origin + location.pathname`, so the
app follows whatever host serves it — each origin just has to be registered as a
SPA redirect URI on the app registration.

## Deployment

GitHub Pages with a custom subdomain:

```bash
git push origin <branch>
```

1. Repo Settings → Pages → deploy from the branch, `/ (root)`
2. The `CNAME` file at the repo root sets the custom domain (`labtrack.zizhe.io`)
3. DNS: `CNAME  labtrack → zhang-zizhe.github.io`

> **Set the DNS record to "DNS only" (grey cloud) in Cloudflare at first.**
> A proxied record breaks GitHub's HTTP-01 certificate validation and Pages hangs
> at *"certificate not yet created"*. Once the certificate issues, the proxy can be
> switched back on with SSL mode = Full.

Moving to a different domain later means: update `CNAME`, add the DNS record, and
add the new origin to the app registration's SPA redirect URIs (see above) —
otherwise sign-in fails with `AADSTS50011`.

## Local development

```bash
python3 -m http.server 8000     # then open http://localhost:8000/index.html
```

`http://localhost:8000/` is already a registered redirect URI.

### Session logs

Design decisions that never made it into a commit message — why SharePoint over
Excel, why Power Automate is out, what the JHU tenant does and does not allow —
live in the chat logs at the repo root:

| | |
|---|---|
| `chat-log-2026-08-15-entra-auth-migration.txt` | replacing Google Sign-In with Entra; Graph permission GUIDs in §16 |
| `chat-log-2026-08-17-booking-rules-and-calendar.md` | booking rules, the approval queue, the calendar rewrite, the backend-migration analysis |

The `.md` one is generated from the Claude Code session transcript:

```bash
node transcript-to-md.js ~/.claude/projects/-Users-zizhe-labtrack/<session-id>.jsonl out.md
#   --thinking      keep the reasoning blocks
#   --full-output   stop clipping tool results
```

Tool output is clipped and screenshots dropped by default — the raw transcript is
22 MB and mostly base64. **Git history is the authoritative record of what
changed**; these are only the record of *why*.

### Tests

```bash
node --check google-apps-script.js       # backend syntax
node test-sheet-setup.js                 # 158 assertions: setup, labels, per-unit
                                         # targeting, order approval, booking rules
node test-sheets-coercion.js             # 25 assertions: the ones that only fail live
node test-storage-layer.js > after.json  # behaviour snapshot — see below
```

**`test-sheets-coercion.js` is the one worth understanding.** The in-memory sheet
the other two tests use stores whatever JavaScript value it is handed and gives the
same one back. A real Google Sheet does not: it *parses* what you write. `"09:00"`
becomes a time and reads back as a `Date` in 1899. `"2026-08-18 09:00"` becomes a
datetime and reads back as a `Date`. A serial number that happens to be all digits
comes back a `Number`. `"TRUE"` comes back a boolean. Text beginning with `=` stops
being text at all.

Two bugs lived in exactly that gap, and neither was visible to the other two files:
every daily time window silently became all-day after one round trip, and every
rule evaluated on a `findRow()` row — the "taken while this was waiting" re-check,
the whole edit path — quietly found no conflict. So this file wraps the same stub
in a layer that coerces the way Sheets coerces, and asserts the rules still hold.

If you add a column that stores anything other than plain text, add it to
`normalizeRow_()` and add a case here.

The app is one big inline Babel block, so a JSX syntax error renders a blank page
with no stack trace. Compiling it with `@babel/standalone` 7.24.7 before deploying
is worth the thirty seconds.

---

## Storage layer

All data access in `google-apps-script.js` goes through ten functions:

```
readTable   findRow   appendRow   updateRow   deleteRow   clearTable
readSettings   writeSetting   getSheet   getOrCreateSheet
```

plus two that convert between what the store holds and what the rules expect:

```
normalizeRow_    on the way out — undo the store's own type coercion
serializeCell_   on the way in  — arrays to JSON, and text that a spreadsheet
                                  would rather run marked as text
```

`normalizeRow_` is the reason `readTable` and `findRow` return the same shape. They
did not always: `findRow` handed back raw sheet values, which meant a `Date` where
every booking rule expected `"YYYY-MM-DD HH:MM"`, and a comparison against a `Date`
that stringifies to `"Sat Aug 18 2026 09:00:00 GMT-0400"` yields `null` — so the
rules did not fail loudly, they found no conflict. **Any new reader must go through
one of these two; anything that reads `getValues()` directly is a bug waiting.**

Everything else in the backend — token verification, RBAC, Slack, the digest,
audit logging — is storage-agnostic, and the frontend only ever calls
`API.fetchAll(token)` and `API.post(token, action, payload)`. **Changing where the
data lives means reimplementing that section and nothing else** — with one
exception below.

Three functions deliberately sit outside the layer and are marked `SHEETS-ONLY`,
because they emit formatted spreadsheets as output rather than storing data, or
build the store itself: `backupSpreadsheet()`, the `generatePurchaseSummary`
action, and `setupNewLab()`. The first two are dropped rather than ported.
`setupNewLab()` has to be rewritten for whatever the new store is — it creates the
tables and widens ones that predate a column, which is a job every store has and
none of them share an API for.

`test-storage-layer.js` stubs the Apps Script globals with an in-memory
spreadsheet and runs most actions, `doGet`, and the digest under both
`slack_mode=all` and `slack_mode=digest`. Not every action: `decideCheckout`,
`updateCheckout`, `cancelCheckout`, `notifyLowStock`, `generatePurchaseSummary`,
`backupNow` and the `sendDigest` wrapper are never posted, so the whole
booking-approval write path is covered by `test-sheet-setup.js` instead. It is a
differential test — the output only means something compared against another run:

```bash
node test-storage-layer.js > before.json
#   …swap the storage layer…
node test-storage-layer.js > after.json
diff before.json after.json          # must be empty for a pure refactor
```

## Moving the data to SharePoint

The lab's site is `https://livejohnshopkins.sharepoint.com/sites/AllianceLab`, which
is in **the same Entra tenant as sign-in** (`9fa4f438-…`) — so one app registration
and one consent request can cover both. (Note `cs.jhu.edu` resolves to a *different*
tenant, `63fbd982-…`; it is not involved.)

Use a SharePoint **List**, not an Excel file. Microsoft's own guidance is to avoid
concurrent writes to the same workbook and to serialize requests per workbook —
which a multi-user checkout flow violates by design.

### What still needs an administrator

Owning the SharePoint site is *not* the permission that matters here. Three separate
steps, and the `*.Selected` scopes grant nothing until all three are done:

1. **Consent** the app to `Sites.Selected` or `Lists.SelectedOperations.Selected`
   — JHU Global Administrator or Cloud Application Administrator
2. **Bind** the app to the specific site or list via
   `POST /sites/{siteId}/permissions` with role `write` — needs
   `Sites.FullControl.All`, i.e. a SharePoint or Global Administrator; a site owner
   cannot do it
3. Acquire a token that actually carries the scope

Site ID for step 2:

```
livejohnshopkins.sharepoint.com,3fcb7469-0cf8-442a-9937-2e9dd83d9623,f5a0656e-bb85-4bdb-a176-ca2ae36097d1
```

### Which scope

| Scope | GUID | Consent type | Scope of access |
|---|---|---|---|
| `Sites.Selected` | `f89c84ef-20d0-4b54-87e9-02e856d66d53` | User | one site collection |
| `Lists.SelectedOperations.Selected` | `033b51ee-d6fa-4add-b627-ee680c7212b5` | Admin | one list |

Delegated mode is preferable to application mode: the app can never exceed the
signed-in user's own SharePoint permissions, and there is no client secret to store.
Note JHU disables self-service consent entirely, so both need an administrator here
regardless of the "consent type" column.

### The thing to decide first

> **If lab members can see the List in SharePoint, they can edit it there directly.**
> That makes the app's RBAC — admin-only delete, requester-only order edit,
> owner-only return — a guard against mistakes rather than a security boundary,
> no matter what the code does. Making it a real boundary means locking the List so
> only the app can write, which forces application-mode access, a client secret, and
> a server to hold it.

#### Why SharePoint permissions don't fix this

The obvious move is to give members read-only access on the List and let the app do
the writing. **In delegated mode that cannot work**, and it isn't a matter of finding
the right setting. Microsoft's rule for delegated tokens is that the app's and the
user's permissions are *intersected* — "the application can never exceed the user's
permissions":

```
LabTrack's effective rights  =  what the app was granted  ∩  what the user already has
```

| Members' rights on the List | Result |
|---|---|
| Read | the app cannot write on their behalf — checkout, return and ordering all fail |
| Contribute | the app can write — but so can they, directly in the SharePoint UI |

There is no delegated configuration that separates "can write through the app" from
"can write directly".

Hiding the List (`Hidden` / "Hide from browser") is not an answer either: it removes
the List from the UI without changing any permission, and anyone with the URL still
reaches it. Obscurity, not a boundary.

#### What list permissions *do* buy

Some of it maps for free. List Settings → Advanced Settings → **Item-level
Permissions** has exactly two dropdowns:

- Read access — *Read all items* / *Read items that were created by the user*
- Create and Edit access — *Create and edit all items* / ***Create items and edit
  items that were created by the user*** / *None*

| LabTrack rule | Enforceable by SharePoint? |
|---|---|
| Only the requester may edit their own order | ✅ that second option, exactly |
| Only admins may delete | ⚠️ partly — members can still delete what they created |
| Checkout owner + group members may return | ❌ several people writing one record needs per-item permissions, which breaks inheritance and runs into the unique-permission-scope limits |
| **Only admins may change order status** | ❌ that is column-level permission, which SharePoint does not have |

Holders of Design or Full Control override item-level permissions, which conveniently
matches "admins are exempt".

The rule that does *not* map is the one that matters most — changing order status is
the purchase-approval control, and it is what commit `0c070b3` had to fix in the
Apps Script backend for exactly this reason.

#### Practical recommendation

For a lab of this size, the middle path is probably right: turn on item-level
permissions to get the requester-only rule for free, keep the rest of the rules in
the app as mistake-prevention, and rely on SharePoint version history and the recycle
bin to undo accidents. The threat being defended against is a slip, not an attacker.

Go application-mode only if the PI decides purchase approval has to be a hard
boundary — and price in the client secret and somewhere to run it.

Also worth knowing before planning around it: **Power Automate cannot cover the
scheduled digest and Slack posts on a standard M365 A3/A5 licence** — the HTTP
connector is premium.

### What the abstraction will not absorb

| | |
|---|---|
| **Concurrent ID generation** | `LockService` currently generates sub-IDs inside a lock. SharePoint has no equivalent — this needs optimistic concurrency (ETag + `If-Match` + retry). The one genuinely tricky part |
| Column order → typed fields | Sheets are positional; Lists are named and typed. The adapter maps between them — and the "wrong column order breaks everything" class of bug disappears |
| Pagination | `readTable` reads a whole tab; Graph list items page via `@odata.nextLink` |
| Item images | `<50 KB` base64 in a cell. SharePoint plain-text fields cap at 63,999 characters ≈ 50 KB — fits, but barely. Eventually belongs in a document library |
| Backup | `backupSpreadsheet()` becomes meaningless; SharePoint has version history and a recycle bin |

---

## Moving the backend off Google

Moving the *data* to SharePoint still leaves `google-apps-script.js` running on
script.google.com. This section is about whether that should move too.

### What's actually still on Google

At the time of writing, four things — and the first three are one thing seen from
three angles, because they all disappear together the moment the data moves:

1. **The API server.** Apps Script deployed as a Web App. `Execute as: Me` binds
   the deployment to one Google account permanently, and since JHU has no Google
   Workspace, that account is necessarily a personal one.
2. **The data store.** Google Sheets via `SpreadsheetApp`.
3. **The weekly backup.** `backupSpreadsheet()` copies the sheet to Drive.
4. **Google Fonts.** A stylesheet link in `<head>`. Unrelated to data; it just
   means every visitor's browser makes one request to Google. Removable at any time
   by self-hosting the three woff2 files.

Everything else is already Microsoft or neutral: authentication is Entra end to end
with no Google Sign-In remnant, hosting is GitHub Pages, the logo is inlined, and
React/Babel come from unpkg and jsdelivr.

### Azure Functions maps 1:1

| Apps Script | Azure Functions |
|---|---|
| Web App `doGet`/`doPost` | HTTP trigger |
| `verifyToken` + `verifyRs256_` + JWKS cache (~140 lines) | **Easy Auth** — delete the lot |
| `SpreadsheetApp` | Graph → SharePoint List |
| `LockService` | ETag + `If-Match` optimistic concurrency |
| `CacheService` (JWKS, 6 h) | not needed once Easy Auth validates |
| `ScriptApp` triggers ×3 | Timer trigger (CRON) |
| `UrlFetchApp` → Slack | `fetch` |
| `SLACK_WEBHOOK_URL` constant | App settings / Key Vault |
| `backupSpreadsheet()` | delete — version history |

The real prize is the ~140 lines of hand-rolled RS256 verification. Microsoft has no
tokeninfo endpoint, so Apps Script has to fetch the JWKS, verify the signature and
check every claim itself. Easy Auth does that at the platform layer.

### Two routes that don't work

- **Power Automate** — the "When an HTTP request is received" trigger is premium,
  not included in A3/A5.
- **Browser talks to Graph directly, no backend** — technically possible since MSAL
  already holds a token, but it **destroys server-side RBAC**. `isAdmin` is currently
  unforgeable because it runs in Apps Script; with a direct-to-Graph client, anyone
  who can write the list can edit the `admins` setting, approve their own purchase
  request, or approve their own long checkout. SharePoint permissions are
  list-level, so they cannot express "only the requester may edit their own order
  while it is Pending". The Slack webhook would also end up in page source.

### The thing that decides it

The reason to leave Apps Script is continuity, but the continuity risk is in the
**data**, not the compute:

- Data in a personal Google Drive → the student graduates and the lab's inventory
  goes with them. **Serious.**
- Compute on a personal Google account → the student graduates and someone pastes
  1,360 lines into a fresh Apps Script project. **Five minutes, no data lost.**

So moving the data to SharePoint solves most of the problem on its own.

The catch is the three scheduled jobs. Nobody is signed in at 5 pm, so a cron job
cannot use a delegated token. If Apps Script is to write to SharePoint on a
schedule it needs **application permissions** — a client secret stored in the
script, plus an admin granting an app role. That is a *larger* consent request than
the delegated-only one currently planned. Azure Functions gets app-only Graph access
through a **managed identity with no secret at all**, which is a genuine
architectural advantage rather than a preference.

| | |
|---|---|
| Drop the scheduled jobs | Delegated is enough — Apps Script + SharePoint is fine, and far less work |
| Keep the scheduled jobs | App-only is required either way → Azure Functions is the better home |

### Cost and the open question

Azure Functions Consumption includes a permanent monthly free grant (1 M executions,
400,000 GB-s) — not trial credit. At 30-second polling, 15 people, 8 h/day,
22 days/month ≈ 320 k executions, inside the grant. Tabs left open around the clock
could push past 1 M; overage is cents.

**The open question is whether an Azure subscription is obtainable.** Azure for
Students needs only a .edu address, but a subscription in a student's own name
reproduces the continuity problem in Microsoft colours. The clean answer is a
lab or departmental subscription, which is another IT request.

If the move does happen, **Azure Static Web Apps** is a better target than bare
Functions: free tier, bundles static hosting + managed Functions + Entra auth +
custom domains, and would replace GitHub Pages and solve `labtrack.<lab domain>`
at the same time.

### Recommendation

**Move the data first; leave the backend on Apps Script; decide about the scheduled
jobs afterwards.** The storage seam is already cut, so the data move is a road
already built. Azure introduces a new dependency that isn't yet known to be
obtainable, in order to address the smaller half of the risk — and everything is
already queued behind the same IT approvals, so there is no reason to open a second
front.

---

## Security

- **Sign-in restricted to the JHU Entra tenant**, enforced twice:
  1. The app registration is single-tenant and MSAL uses a tenant-specific authority, so Microsoft refuses to issue a token to a non-JHU account in the first place.
  2. Apps Script re-verifies every request: it fetches the tenant's JWKS, verifies the RS256 signature itself (`verifyRs256_`), and checks `aud` (token was minted for *this* app), `tid`, `iss`, `exp`, and `nbf`. Unlike Google, Microsoft has no tokeninfo endpoint, so none of this can be delegated.
- Checking `aud` is what blocks token replay: a token some other app obtained for a JHU user cannot be used against this backend.
- Optionally restricted further by `ALLOWED_UPN_DOMAINS` in Apps Script and the `members` list in the Settings tab
- JWKS is cached 6h in `CacheService`, so the common request path makes **no** outbound network call (the old Google tokeninfo check cost a round trip per request)
- Slack webhook stored only in Apps Script (server-side), never in client code
- No secrets in HTML — only the Entra client ID and tenant ID (both designed to be public) and the Apps Script URL
- **Server-side RBAC**: every sensitive action is verified in Apps Script regardless of client state:
  - Category changes, settings, the Purchase Summary sheet, backups → admin only
  - Order **status** → admin only, on both `updateOrderStatus` and `updateOrder`
  - Order edits → requester (`requestedByEmail`) while still `Pending`, or admin
  - Booking approve / reject → admin only; booking edit / withdraw → requester (`checkedOutByEmail`) or admin, and only while still `Pending Approval`
  - Item returns → checkout creator, group members, or admin, and only while still `Active`
  - Deletions → admin only
- **Identity fields are stamped, not accepted.** A member's checkout and order rows are filed under the caller's own name and address whatever the request body says, and a booking's `status` is decided by the rules rather than sent in. See *What the server decides, whatever the browser sends* above
- **Text that a spreadsheet would run is stored as text.** A value beginning with `=`, `+`, `-` or `@` is written with a leading apostrophe, so an item named `=IMPORTXML("https://…"&Settings!A1:B99,"//a")` is a name rather than a live exfiltration of the admin roster the next time somebody opens the sheet
- Legacy rows without `requestedByEmail`/`checkedOutByEmail` are not restricted (backward compatible)

### What is deliberately *not* restricted

Worth knowing, because none of it is an oversight:

- **Any member can add and edit any item** — name, quantity, location, category, `status`, and the `shared` and `consumable` flags. The lab inventory is a shared document; the edit lock in the header is a guard against fat fingers, not a permission. The costly direction is `status`: a member can set an item to `Available` while somebody has it. Since rule 2 now clash-checks by date rather than trusting that flag, this no longer lets anyone double-book — it just makes a badge wrong
- **`doGet` returns every table to every member**, including all pending requests and the `admins`/`members` roster. The calendar hides other people's pending requests, but that is presentation, not access control; anyone who opens the network tab sees them. Do not put anything in Settings you would not show the whole lab
- **Any member can trigger a Slack notification** by reporting a supply as running low. That is the point of the button

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Sign-in failed — you must use a Johns Hopkins account" | Signed in with a personal/other-tenant Microsoft account |
| "Approval required — this app requires your admin's approval" | Admin consent hasn't been granted yet; see the one-time admin consent step above |
| Sign-in popup blocked | Allow popups for the site, or switch `loginPopup` → `loginRedirect` in `index.html` |
| `AADSTS700016` (app not found) | `client_id` is still the placeholder, or the app registration is in another tenant |
| `AADSTS50011` (redirect mismatch) | Add the exact origin as a **SPA** redirect URI in the app registration — the platform type must be SPA, not Web |
| Changes appear then vanish; nothing persists | No backend — `apps_script_url` is empty, or you are in Preview mode. Both keep data in `localStorage` only |
| Red "DEV MODE" banner across the top | `dev_key` is set in `index.html`. Fine on localhost; clear it and `DEV_NO_AUTH_KEY` before deploying |
| Tabs missing / "column order" errors on a new Sheet | Run `setupNewLab` from the Apps Script editor instead of creating tabs by hand |
| Pages stuck on "certificate not yet created" | The Cloudflare DNS record is proxied. Set it to DNS only (grey cloud) until the certificate issues |
| Signed in fine but everything returns "Unauthorized" | `ENTRA_CLIENT_ID` in Apps Script doesn't match `client_id` in `index.html` (the `aud` check fails) |
| "not authorized to access this lab's system" | Account isn't in the `members` list — remember it must be `@jh.edu`, not `@jhu.edu` |
| Data not syncing | Check Apps Script URL; redeploy as new version |
| Delete not working | Check you're in the `admins` list in Settings tab |
| Digest not sending | Verify trigger is set; check script timezone = America/New_York |
| Orders not saving correctly | Ensure Orders sheet column order matches: `id \| store \| item \| link \| qty \| unit \| price \| cat \| requestedBy \| reason \| urgency \| date \| status \| requestedByEmail` |
| `displayId`/`shared`/`consumable` not saving | Ensure Items sheet has these 3 columns after `serial`: `displayId \| shared \| consumable` |
| Can't return item / "Forbidden" error | Ensure Checkouts sheet has `checkedOutByEmail` and `groupEmails` columns (add them if upgrading); old rows without these columns are returnable by anyone |
| Can't edit order / "Forbidden" error | Ensure Orders sheet has `requestedByEmail` column (add it if upgrading); only the requester or an admin can edit |
| Slow updates | Inherent to Apps Script (~1-3s); UI updates instantly |
| Images not showing | Images are compressed to <50KB base64; check cell size limit |
