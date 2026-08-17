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

---

## Google Sheet Schema

The backend uses a Google Sheet with these tabs:

**Items** — `id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable`

**Deliveries** — `id | item | qty | unit | from | receivedBy | date | tracking | status`

**Checkouts** — `id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails | qty`

**Orders** — `id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail`

> ⚠️ Column order matters for new rows written by the script. If upgrading an existing sheet:
> - **Orders**: add `requestedByEmail` as the last column (column 14)
> - **Checkouts**: add `checkedOutByEmail`, `groupEmails` and `qty` as the last three columns
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

Adding a redirect URI later (a new domain, say) is additive:

```bash
az rest --method PATCH \
  --url https://graph.microsoft.com/v1.0/applications/131c5c77-3d58-40b5-979f-3773a54776ca \
  --body '{"spa":{"redirectUris":["https://labtrack.zizhe.io/","http://localhost:8000/","<new URL>"]}}'
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
| Button/switch | "Preview as member" / "Preview as admin" on the login page | `LAB_CONFIG.dev_key` + `DEV_NO_AUTH_KEY` |
| Backend | none — data lives in `localStorage` | the real Sheet |
| Risk | none | **removes authentication from the deployment** |
| Use for | reviewing the interface, demos | testing sync, RBAC, Slack, the digest |

**Preview** needs no setup, and comes in both roles — the two differ in what the interface offers at all (deleting, categories, order status), so both are worth looking at. Nothing reaches the backend: every API call is
short-circuited client-side, and `verifyToken` rejects the token value `"local"`
as its first statement, so it cannot touch real data even in principle.

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

**Requester** (or admin): edit their own order request — but only while it is still `Pending`. Once an admin approves it, editing the quantity or price would quietly change what was approved, so it becomes admin-only. Enforced in Apps Script, not just hidden in the UI

**Checkout owner + group members** (or admin): return a checked-out item. Group members are listed at checkout time as comma-separated emails.

All deletions are logged in the DeleteLog tab with timestamp, details, and who deleted.

---

## Features

- **Inventory**: Add/edit items with serial numbers, label IDs (`PREFIX-NNN`, counted per category; split units add `-NN`), image upload (camera/file/URL), customizable categories (admin only); mark items as Shared (multi-user checkout) or Consumable (qty deduction without checkout). Consumables get no label ID — nothing is stickered — and a supply can be added with no quantity at all, which swaps its Use button for Notify: one click tells whoever restocks that it is running low
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

### Tests

```bash
node --check google-apps-script.js       # backend syntax
node test-storage-layer.js > after.json  # behaviour snapshot — see below
```

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

Everything else in the backend — token verification, RBAC, Slack, the digest,
audit logging — is storage-agnostic, and the frontend only ever calls
`API.fetchAll(token)` and `API.post(token, action, payload)`. **Changing where the
data lives means reimplementing that section and nothing else.**

Two functions deliberately sit outside the layer and are marked `SHEETS-ONLY`,
because they emit formatted spreadsheets as output rather than storing data:
`backupSpreadsheet()` and the `generatePurchaseSummary` action. Both are dropped
rather than ported.

`test-storage-layer.js` stubs the Apps Script globals with an in-memory
spreadsheet and runs every action, `doGet`, and the digest under both
`slack_mode=all` and `slack_mode=digest`. It is a differential test — the output
only means something compared against another run:

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
