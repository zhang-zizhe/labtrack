/**
 * LabTrack calendar proxy — a Cloudflare Worker.
 *
 * Calendar clients cannot subscribe to an Apps Script web app directly. /exec
 * answers with a 302 to script.googleusercontent.com, an empty body typed
 * application/binary, carrying a key that works exactly once — fetch the same URL
 * twice and the second is a redirect again. Google Calendar and Outlook both
 * refuse it: "couldn't add this calendar". Serving the identical bytes with no
 * redirect, both accept them, which is how the transport was identified as the
 * fault rather than the file.
 *
 * All this does is follow that redirect on the client's behalf and hand back a
 * plain text/calendar body.
 *
 * It lives on workers.dev rather than under the site's own domain on purpose: the
 * site is expected to move to the lab's domain, and a subscription that breaks on
 * moving day is worse than one that never depended on the domain.
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → paste → Deploy.
 * Then set ICS_PUBLIC_BASE in google-apps-script.js to
 *   https://<worker>.<subdomain>.workers.dev/calendar.ics
 */

// The /exec URL of the deployed web app. Safe to have in the open: it verifies a
// Microsoft token on every other path, and this one needs the subscription token.
const APPS_SCRIPT =
  "https://script.google.com/macros/s/AKfycbzBrg3dcycZZ7u2uX6PYWq455ngl6CojS3w-Qcno6i3rKh1uvg2e9fTKxXWs9p5rF8LRQ/exec";

// The shape icsMintToken_() produces: two UUIDs, dashes removed.
const TOKEN = /^[0-9a-f]{32,128}$/;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Only a token-shaped ics parameter is forwarded, and nothing else is — not the
    // path, not other query parameters. Without this the worker would be an open
    // proxy to every parameter the backend understands, from an address with no
    // authentication in front of it.
    const token = new URL(request.url).searchParams.get("ics") || "";
    if (!TOKEN.test(token)) return new Response("Not found", { status: 404 });

    let upstream;
    try {
      upstream = await fetch(`${APPS_SCRIPT}?ics=${token}`, {
        redirect: "follow",
        // Five minutes. Calendar clients refresh in hours, so nobody notices the
        // delay — but the address is public and unauthenticated, and without this a
        // single client in a loop could spend the lab's Apps Script quota and take
        // the app itself down with it.
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return new Response("Upstream unreachable", { status: 502 });
    }

    // A rejected token still comes back 200, carrying a calendar whose one event
    // says the link is dead. That is the intended answer and must pass through.
    if (!upstream.ok) return new Response("Upstream error", { status: 502 });

    const body = await upstream.text();
    if (!body.startsWith("BEGIN:VCALENDAR")) {
      // Apps Script serves an HTML error page on a thrown script or a quota
      // refusal. Passing that through as text/calendar would have every subscriber
      // silently stop updating with no sign of why.
      return new Response("Upstream did not return a calendar", { status: 502 });
    }

    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-disposition": 'inline; filename="labtrack.ics"',
      },
    });
  },
};
