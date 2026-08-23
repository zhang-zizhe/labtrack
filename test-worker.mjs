/**
 * The calendar proxy, exercised without deploying it.
 *
 *   node test-worker.mjs
 *
 * It is 40 lines of code sitting on a public, unauthenticated address, running
 * unattended. The interesting assertions are the refusals: that it forwards only a
 * token-shaped parameter and drops every other one, so it cannot be used as an open
 * proxy to the backend's other query parameters; and that it never answers 200 with
 * something that is not a calendar, because Apps Script serves an HTML error page on
 * a thrown script or a quota refusal, and passing that through as text/calendar
 * would have every subscriber quietly stop updating with no sign of why.
 */
import worker from "./worker/calendar-proxy.mjs";
const CAL = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
let lastUrl = "";
const stub = (body, ok = true, status = 200) => {
  globalThis.fetch = async (u) => { lastUrl = u; return { ok, status, text: async () => body }; };
};
const req = (url, method = "GET") => new Request(url, { method });
const B = "https://labtrack-cal.example.workers.dev/calendar.ics";
const TOK = "a".repeat(64);
let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log("  ✓ " + l)) : (fail++, console.log("  ✗ " + l)); };

stub(CAL);
let r = await worker.fetch(req(`${B}?ics=${TOK}`));
check("a token-shaped address serves the calendar", r.status === 200 && (await r.text()) === CAL);
check("typed text/calendar", r.headers.get("content-type").startsWith("text/calendar"));
check("cached briefly", /max-age=300/.test(r.headers.get("cache-control")));
check("only the token reaches upstream", lastUrl.endsWith("/exec?ics=" + TOK));

r = await worker.fetch(req(`${B}?ics=${TOK}&extra=1&token=x`));
check("other query parameters are dropped", lastUrl === `https://script.google.com/macros/s/AKfycbzBrg3dcycZZ7u2uX6PYWq455ngl6CojS3w-Qcno6i3rKh1uvg2e9fTKxXWs9p5rF8LRQ/exec?ics=${TOK}`);

for (const bad of ["constructor", "__proto__", "", "../x", "a".repeat(200), "ZZZZ", "a".repeat(31)]) {
  const rr = await worker.fetch(req(`${B}?ics=${encodeURIComponent(bad)}`));
  check(`?ics=${bad.slice(0, 14) || "(empty)"} is refused`, rr.status === 404);
}

r = await worker.fetch(req(`${B}?ics=${TOK}`, "POST"));
check("POST is refused", r.status === 405);
r = await worker.fetch(req(`${B}?ics=${TOK}`, "HEAD"));
check("HEAD gets the headers and no body", r.status === 200 && (await r.text()) === "");

stub("<html>Sorry, unable to open the file</html>");
r = await worker.fetch(req(`${B}?ics=${TOK}`));
check("an Apps Script error page is not passed off as a calendar", r.status === 502);

stub(CAL, false, 500);
r = await worker.fetch(req(`${B}?ics=${TOK}`));
check("an upstream failure is not 200", r.status === 502);

globalThis.fetch = async () => { throw new Error("network"); };
r = await worker.fetch(req(`${B}?ics=${TOK}`));
check("an unreachable upstream is not 200", r.status === 502);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
