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
        { href: "user.html#in",       label: "Getting in",                 sub: true },
        { href: "user.html#around",   label: "Finding your way around",    sub: true },
        { href: "user.html#find",     label: "Finding a thing",            sub: true },
        { href: "user.html#borrow",   label: "Borrowing something",        sub: true },
        { href: "user.html#rules",    label: "Why a booking waits",        sub: true },
        { href: "user.html#back",     label: "Giving it back",             sub: true },
        { href: "user.html#supplies", label: "Supplies you use up",        sub: true },
        { href: "user.html#add",      label: "Adding and correcting",      sub: true },
        { href: "user.html#buy",      label: "Asking to buy something",    sub: true },
        { href: "user.html#cal",      label: "The calendar",               sub: true },
        { href: "user.html#wrong",    label: "When something looks wrong", sub: true },
      ],
    },
    {
      head: "Admin guide",
      admin: true,
      items: [
        { href: "admin.html", label: "Running the lab's copy" },
        { href: "admin.html#adds",       label: "What admin adds",            sub: true },
        { href: "admin.html#sheet",      label: "The Settings tab",           sub: true },
        { href: "admin.html#roster",     label: "Who gets in",                sub: true },
        { href: "admin.html#approve",    label: "Approving bookings",         sub: true },
        { href: "admin.html#items",      label: "Items only you change",      sub: true },
        { href: "admin.html#labels",     label: "Labels and prefixes",        sub: true },
        { href: "admin.html#orders",     label: "Purchase requests",          sub: true },
        { href: "admin.html#deliveries", label: "Deliveries",                 sub: true },
        { href: "admin.html#slack",      label: "Notifications",              sub: true },
        { href: "admin.html#calendar",   label: "Calendar addresses",         sub: true },
        { href: "admin.html#trail",      label: "The audit trail",            sub: true },
        { href: "admin.html#backup",     label: "Backups",                    sub: true },
        { href: "admin.html#account",    label: "Keeping the account",        sub: true },
        { href: "admin.html#diag",       label: "When something looks wrong", sub: true },
      ],
    },
  ];

  // The app writes this when an admin signs in, and clears it otherwise. Same
  // origin, so it is simply readable here.
  //
  // It decides what the sidebar OFFERS, not what anybody may open: both pages are
  // public, sit in a public repository and carry no credential. Sending a member to
  // a page about rosters and backups is sending them to the wrong page — that is the
  // whole of what this is for.
  var isAdmin = false;
  try { isAdmin = localStorage.getItem("labtrack_role") === "admin"; } catch (e) {}

  var here = (location.pathname.split("/").pop() || "index.html");
  var nav = document.querySelector("nav.site");
  if (!nav) return;

  // ── the sidebar, built once ───────────────────────────────────────────────
  // Built once and then marked by toggling a class, rather than re-rendered on every
  // change. A sidebar that replaces its own markup as you scroll loses hover, loses
  // focus, and can interrupt a click already halfway through.
  var html = "";
  TREE.forEach(function (group) {
    if (group.admin && !isAdmin) return;
    html += '<div class="group"><div class="ghead">' + group.head + "</div><ul>";
    group.items.forEach(function (it) {
      html += '<li class="' + (it.sub ? "sub" : "") + '"><a href="' + it.href + '">' + it.label + "</a></li>";
    });
    html += "</ul></div>";
  });
  nav.innerHTML = html;

  // ── this page's own headings, on the right ────────────────────────────────
  // Read off the page rather than listed by hand, so it cannot fall behind the
  // writing.
  var rail = document.querySelector(".rail");
  var heads = [].slice.call(document.querySelectorAll("main h2[id]"));
  if (rail) {
    if (!heads.length) { rail.style.display = "none"; }
    else {
      var r = "<h2>On this page</h2><ol>";
      heads.forEach(function (h) { r += '<li><a href="#' + h.id + '">' + h.textContent + "</a></li>"; });
      rail.innerHTML = r + "</ol>";
    }
  }

  // ── which link means "where you are" ──────────────────────────────────────
  var navLinks = [].slice.call(nav.querySelectorAll("a"));
  var railLinks = rail ? [].slice.call(rail.querySelectorAll("a")) : [];
  var marked;

  function mark(frag) {
    frag = frag || "";
    if (frag === marked) return;
    marked = frag;
    // The page's own top-level entry while you are above the first heading, the
    // section's entry once you are inside one. One mark, never two.
    var want = here + frag;
    navLinks.forEach(function (a) {
      a.className = a.getAttribute("href") === want ? "here" : "";
    });
    railLinks.forEach(function (a) {
      a.className = a.getAttribute("href") === frag ? "here" : "";
    });
  }

  // Scrolling is how people actually move through a page, and the mark used to
  // follow only clicks — so it sat wherever you last clicked while you read
  // something else entirely. The current section is the last heading to have
  // crossed the line just under the sticky header.
  var LINE = 92;
  function spy() {
    var frag = "";
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= LINE) frag = "#" + heads[i].id;
      else break;
    }
    // At the very bottom the final heading may never reach the line — a short last
    // section under a long one would leave the mark stuck above it for good.
    var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (heads.length && atEnd) frag = "#" + heads[heads.length - 1].id;
    mark(frag);
  }

  var queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; spy(); });
  }

  if (heads.length) {
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // A click wins at once rather than waiting for the scroll to land, then the spy
    // takes over again once it has.
    window.addEventListener("hashchange", function () { mark(location.hash); setTimeout(spy, 450); });
    spy();
  } else {
    mark(location.hash);
    window.addEventListener("hashchange", function () { mark(location.hash); });
  }
})();
