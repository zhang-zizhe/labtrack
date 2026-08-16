:robot_face: *Introducing LabTrack — Our Lab Inventory & Purchasing System*

Hey everyone! The Alliance AI Lab is moving to a shared digital system for tracking equipment and submitting purchase requests. No more spreadsheets, emails back and forth, or not knowing where things are. Everything lives in one place, synced in real time for the whole lab.

:point_right: <LABTRACK_URL>
Sign in with Microsoft using your JHU account (`<JHED>@jh.edu`).

:warning: Use your *`@jh.edu` sign-in name*, not the `@jhu.edu` mail alias — they look similar but only the first one works.

*What it does*
:package: Inventory — Browse all lab equipment by category, search by name/location/serial, view photos and label IDs
:label: Check Out / Return — Track who's using what; check out multiple items at once; overdue alerts turn red
:shopping_trolley: Order Requests — Submit purchase requests with store, price, urgency, and purchase link; generate a formatted email table for purchasing
:truck: Deliveries — Orders auto-log a delivery and open a staging form before going to inventory
:calendar_spiral: Calendar — Visual monthly view of all lab activity

*Quick start*
• Check out an item → Click its card → Quick Check Out, or Usage tab → New Checkout
• Request a purchase → Order Requests tab → New Request
• Return items → Usage tab → check boxes → Return selected
• Changes sync to everyone within ~30 seconds

:pencil: *Action required*
• *Add your items to the inventory* — if you own or regularly use any lab equipment, add it so everyone can find it
• *Label physical items* — once added, print the generated label ID (e.g. RM-000001) on a sticker and attach it to the item
• *Use this for all purchase requests going forward* — no more emailing purchase lists separately
• *Check out items when you take them* and return them when done — this is how we know where things are

:warning: *Good to know*
• Only admins can delete items — contact a lab admin if needed
• For Amazon links, use Share → Copy link on the product page for a short URL (e.g. a.co/d/…) — the app will remind you if you paste a long one
• When submitting an order, enter the purchase unit (e.g. 1 box), not the inventory unit (e.g. 100 stickers) — you'll adjust when the order arrives
• Group checkout: list teammates' `@jh.edu` addresses when checking out and they can return the item too

Questions or issues? Ping me! :raised_hands:

---

<!--
NOT READY TO SEND YET. Before posting:

1. Replace <LABTRACK_URL> with the live URL.
   Currently https://labtrack.zizhe.io/ ; the intended home is a subdomain of
   the lab domain, which needs a DNS request to JHU CS IT.

2. Sign-in must actually work — a JHU Entra administrator has to grant admin
   consent first, or everyone who clicks the link hits "Approval required".
   See SETUP.md → Microsoft Entra ID Setup.

3. Create the Slack incoming webhook and put it in SLACK_WEBHOOK_URL in
   google-apps-script.js, otherwise none of the notifications this message
   promises will fire.
-->
