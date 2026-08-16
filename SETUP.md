# LabTrack Setup Guide

## Quick Start

1. Go to **https://penn-figueroa-lab.github.io/lab-inventory/**
2. Sign in with your **Johns Hopkins** account (`<JHED>@jh.edu`)
3. Start managing inventory

---

## Google Sheet Schema

The backend uses a Google Sheet with these tabs:

**Items** — `id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable`

**Deliveries** — `id | item | qty | unit | from | receivedBy | date | tracking | status`

**Checkouts** — `id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails`

**Orders** — `id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail`

> ⚠️ Column order matters for new rows written by the script. If upgrading an existing sheet:
> - **Orders**: add `requestedByEmail` as the last column (column 14)
> - **Checkouts**: add `checkedOutByEmail` and `groupEmails` as the last two columns
> - Existing rows without these columns remain fully functional (permissions fall back gracefully)

**Settings** — `key | value`

| key | value |
|-----|-------|
| `categories` | `["Robots & Motors","Sensors & Vision","Compute & Electronics","Wiring & Networking","Tools & Hardware","Consumables & Supplies","Safety & Facility","Other"]` |
| `admins` | `["jdoe12@jh.edu"]` — use the **sign-in name** (`<JHED>@jh.edu`), not the `@jhu.edu` mail alias. Compared case-insensitively. |
| `members` | `["jdoe12@jh.edu","asmith3@jh.edu"]` — if present and non-empty, only these accounts can sign in; all other JHU accounts are rejected. Omit the key (or leave it as `[]`) to allow anyone in the JHU tenant. |
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
| `UpdateOrder` | everyone | item, store |
| `OrderStatus` | admins only | item → new status |
| `DeleteOrder` | admins only | order name |

**SlackQueue** (auto-created, used by digest mode) — `time | emoji | title | details | fields`

---

## Microsoft Entra ID Setup (sign-in)

Sign-in is restricted to the Johns Hopkins Entra tenant
(`9fa4f438-b1e6-473b-803f-86f8aedf0dec`, resolvable any time from
`https://login.microsoftonline.com/jh.edu/v2.0/.well-known/openid-configuration`).

### The app registration (already created)

| Setting | Value |
|---|---|
| Application (client) ID | `5ac3d97f-238a-4e23-9bad-793830bd9b21` |
| Object ID | `7635392b-d637-4a4f-aff9-709655b57edd` |
| Display name | LabTrack - Figueroa Lab Inventory |
| Supported account types | Single tenant (`AzureADMyOrg`) |
| Platform | **Single-page application (SPA)** — *not* Web |
| Redirect URIs | `https://penn-figueroa-lab.github.io/lab-inventory/`, `http://localhost:8000/` |
| API permissions | `openid`, `profile`, `email`, `offline_access` (delegated, Microsoft Graph) |
| Implicit grant | Off — MSAL uses authorization code flow with PKCE |

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

- Open <https://login.microsoftonline.com/9fa4f438-b1e6-473b-803f-86f8aedf0dec/adminconsent?client_id=5ac3d97f-238a-4e23-9bad-793830bd9b21> and accept, or
- Entra admin center → Enterprise applications → *LabTrack - Figueroa Lab Inventory* → Permissions → **Grant admin consent**

Without this, sign-in stops at *"Approval required — this app requires your admin's approval"*.

---

## Apps Script Deployment

1. In the Google Sheet: **Extensions → Apps Script**
2. Paste contents of `google-apps-script.js`
3. Confirm `ENTRA_CLIENT_ID` matches `index.html`, and replace
   `"YOUR_SLACK_WEBHOOK_URL_HERE"` with your Slack webhook URL
4. **Set script timezone**: Project Settings → Time zone → **America/New_York**
5. **Deploy → New deployment** → Web app → Execute as: Me → Who has access: Anyone
6. Copy the Web app URL

> After code updates, always create a **new version** via Deploy → Manage deployments.

### Slack Notification Modes

Set `slack_mode` in the Settings tab:

| Mode | Behavior |
|------|----------|
| `all` | Every action sends a Slack notification |
| `important` | Only urgent/high order requests + overdue checkouts |
| `digest` | Queues events; sends compact daily summary at 5pm ET |
| `off` | No notifications |

### Setting Up Triggers (for digest mode)

Go to **Apps Script → Triggers → Add Trigger**:

| Function | Event Type | Time |
|----------|-----------|------|
| `sendDailyDigest` | Time-driven → Day timer | **5pm – 6pm** |
| `checkOverduesAndAlert` | Time-driven → Day timer | 8am – 9am |

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

**Admins can**: delete items/orders, manage categories, change settings, send digest manually, change order status (Approve/Reject/etc.), edit any order request, return any checked-out item

**All users can**: add/edit items, check out items, log deliveries, submit order requests

**Requester only** (or admin): edit their own order request

**Checkout owner + group members** (or admin): return a checked-out item. Group members are listed at checkout time as comma-separated emails.

All deletions are logged in the DeleteLog tab with timestamp, details, and who deleted.

---

## Features

- **Inventory**: Add/edit items with serial numbers, label IDs (`PREFIX-NNNNN`), image upload (camera/file/URL), customizable categories (admin only); mark items as Shared (multi-user checkout) or Consumable (qty deduction without checkout)
- **Order Requests**: Submit orders (store, item, link, qty, price, etc.); only the requester or an admin can edit; admins can change status (Pending/Approved/Ordered/Received/Rejected); "Mark Received" opens a staging form to set location/label/serial before adding to inventory; generate copy-pasteable email text with per-item totals and grand total
- **Usage Tracking**: Check out/return items with overdue alerts and bulk return; only the checkout creator, listed group members, or admins can return an item; consumables use a "Use" button instead of checkout
- **Group Checkout**: When checking out, optionally list teammates' emails as group members — they can then return the item too
- **Calendar**: Visual calendar of deliveries, checkouts, and return dates
- **Live Sync**: Auto-polls every 30s so all users see changes without refreshing
- **Pagination & Sort**: 24 items/page with sort by name, date, quantity; Order Requests tab has search/filter/pagination (15/page) with shift-click range select
- **Slack**: Rich Block Kit notifications; daily 5pm ET digest with compact PI-friendly summary; `important` mode for urgent orders + overdues only
- **Dark/Light Mode**: Toggle with the ☀/🌙 button in the header; preference saved per browser
- **Access Control**: Server-side RBAC — admins control categories/deletion/settings; order editing restricted to requester; returns restricted to checkout owner + group members; all enforced in Apps Script, not just UI
- **Delete Audit Log**: Full record of all deletions

---

## Frontend Configuration

In `index.html`, update the Entra config in `<head>` and `APP_CONFIG` in the app script:
```js
window.ENTRA_CONFIG = {
  tenant_id: "9fa4f438-b1e6-473b-803f-86f8aedf0dec",  // Johns Hopkins
  client_id: "5ac3d97f-238a-4e23-9bad-793830bd9b21",
  scopes: ["openid", "profile", "email"],
};

const APP_CONFIG = {
  apps_script_url: "YOUR_APPS_SCRIPT_WEB_APP_URL",
};
```

MSAL is loaded as an ES module from jsDelivr (`@azure/msal-browser@5.18.0`) because
Microsoft retired their own CDN and no longer ships a UMD build.

## GitHub Pages Deployment

```bash
git add index.html google-apps-script.js SETUP.md
git commit -m "Deploy LabTrack"
git push origin main
```

Repo Settings → Pages → Deploy from branch: `main` / `/ (root)`

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
  - Category changes → admin only
  - Order edits → requester (`requestedByEmail`) or admin only
  - Item returns → checkout creator (`checkedOutByEmail`), group members, or admin only
  - Deletions → admin only
- Legacy rows without `requestedByEmail`/`checkedOutByEmail` are not restricted (backward compatible)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Sign-in failed — you must use a Johns Hopkins account" | Signed in with a personal/other-tenant Microsoft account |
| "Approval required — this app requires your admin's approval" | Admin consent hasn't been granted yet; see the one-time admin consent step above |
| Sign-in popup blocked | Allow popups for the site, or switch `loginPopup` → `loginRedirect` in `index.html` |
| `AADSTS700016` (app not found) | `client_id` is still the placeholder, or the app registration is in another tenant |
| `AADSTS50011` (redirect mismatch) | Add the exact GitHub Pages URL as a **SPA** redirect URI in the app registration |
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
