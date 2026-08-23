/* The docs navigation, in one place.
 *
 * Three pages sharing a sidebar means three copies of it, and three copies of one
 * thing drift — twice already in this project, and both times the drift is what
 * broke. So the sidebar is described once here and rendered into each page.
 *
 * Each page ships a plain list of links inside <nav class="site"> as well. This
 * replaces it; without JavaScript that list is what you get, which is every page,
 * unstyled but working.
 */
(function () {
  var TREE = [
    {
      head: "LabTrack docs",
      items: [{ href: "index.html", label: "Overview" }],
    },
    {
      head: "Member guide",
      items: [
        { href: "user.html", label: "Everything a member does" },
        { href: "user.html#in",       label: "Getting in",              sub: true },
        { href: "user.html#find",     label: "Finding a thing",         sub: true },
        { href: "user.html#borrow",   label: "Borrowing something",     sub: true },
        { href: "user.html#rules",    label: "Why a booking waits",     sub: true },
        { href: "user.html#back",     label: "Giving it back",          sub: true },
        { href: "user.html#supplies", label: "Supplies you use up",     sub: true },
        { href: "user.html#buy",      label: "Asking to buy something", sub: true },
        { href: "user.html#cal",      label: "The calendar",            sub: true },
      ],
    },
    {
      head: "Admin guide",
      admin: true,
      items: [
        { href: "admin.html", label: "Running the lab's copy" },
        { href: "admin.html#sheet",    label: "The Settings tab",    sub: true },
        { href: "admin.html#roster",   label: "Who gets in",         sub: true },
        { href: "admin.html#approve",  label: "Approving bookings",  sub: true },
        { href: "admin.html#orders",   label: "Purchase requests",   sub: true },
        { href: "admin.html#slack",    label: "Notifications",       sub: true },
        { href: "admin.html#calendar", label: "Calendar addresses",  sub: true },
        { href: "admin.html#backup",   label: "Backups",             sub: true },
        { href: "admin.html#account",  label: "Keeping the account",  sub: true },
      ],
    },
  ];

  // The app writes this when an admin signs in, and clears it otherwise. Same
  // origin, so it is simply readable here.
  //
  // It decides what the sidebar OFFERS, not what anybody may open: both pages are
  // public and sit in a public repository, and neither carries a credential. Sending
  // a member to a page about rosters and backups is sending them to the wrong page —
  // that is the whole of what this is for.
  var isAdmin = false;
  try { isAdmin = localStorage.getItem("labtrack_role") === "admin"; } catch (e) {}

  var here = (location.pathname.split("/").pop() || "index.html");
  var hash = location.hash;

  var nav = document.querySelector("nav.site");
  if (!nav) return;

  var html = "";
  TREE.forEach(function (group) {
    if (group.admin && !isAdmin) return;
    html += '<div class="group"><div class="ghead">' + group.head + "</div><ul>";
    group.items.forEach(function (it) {
      var file = it.href.split("#")[0];
      var frag = it.href.indexOf("#") >= 0 ? "#" + it.href.split("#")[1] : "";
      // The page you are on is marked; a section only when you are actually at it.
      var current = file === here && (frag ? frag === hash : !hash);
      html += '<li class="' + (it.sub ? "sub" : "") + '">' +
              '<a href="' + it.href + '"' + (current ? ' class="here"' : "") + ">" +
              it.label + "</a></li>";
    });
    html += "</ul></div>";
  });
  nav.innerHTML = html;

  // The right-hand rail is this page's own headings, built from the page rather
  // than listed by hand, so it cannot fall behind the writing.
  var rail = document.querySelector(".rail");
  if (rail) {
    var hs = document.querySelectorAll("main h2[id]");
    if (!hs.length) { rail.style.display = "none"; return; }
    var r = '<h2>On this page</h2><ol>';
    hs.forEach(function (h) { r += '<li><a href="#' + h.id + '">' + h.textContent + "</a></li>"; });
    rail.innerHTML = r + "</ol>";
  }
})();
