/**
 * The backend carries a hash of its own source so smokeTest() can tell you whether
 * the code in the Apps Script editor is the code in the repo.
 *
 *   node stamp.js          rewrite CODE_STAMP to match the file
 *   node stamp.js --check  fail if it does not (this is what npm test runs)
 *
 * The hash is taken over the file with the stamp line itself blanked out, so it does
 * not chase its own tail. Apps Script computes the same hash the same way over what
 * it fetches from GitHub, and compares.
 *
 * Checked rather than merely written because a stamp somebody forgot to update is
 * worse than none: it reports "up to date" about code that is not.
 */
const fs = require("fs");
const crypto = require("crypto");

const FILE = __dirname + "/google-apps-script.js";
const LINE = /^const CODE_STAMP = "[^"]*";$/m;
const BLANK = 'const CODE_STAMP = "";';

function stampOf(text) {
  if (!LINE.test(text)) throw new Error("google-apps-script.js has no CODE_STAMP line");
  return crypto.createHash("sha256").update(text.replace(LINE, BLANK), "utf8").digest("hex").slice(0, 16);
}

// ── the docs' own assets ────────────────────────────────────────────────────
// GitHub Pages serves the stylesheet with max-age=14400 and no revalidation, so for
// four hours after a change a returning reader gets the old CSS against the new
// markup — which on this site meant an unstyled sidebar and no cards. A version in
// the query string makes the URL change when the file does. Checked here rather than
// remembered, for the same reason CODE_STAMP is.
const DOCS = __dirname + "/docs";
const ASSETS = ["guide.css", "nav.js"];
const REF = /(guide\.css|nav\.js)(\?v=[0-9a-f]+)?/g;

function docsVersion() {
  const h = crypto.createHash("sha256");
  ASSETS.forEach(a => h.update(fs.readFileSync(DOCS + "/" + a)));
  return h.digest("hex").slice(0, 8);
}

function docsPages() {
  if (!fs.existsSync(DOCS)) return [];
  return fs.readdirSync(DOCS).filter(f => f.endsWith(".html")).map(f => DOCS + "/" + f);
}

function stampDocs(check) {
  const pages = docsPages();
  if (!pages.length) return true;
  const v = docsVersion();
  let allOk = true;
  pages.forEach(p => {
    const before = fs.readFileSync(p, "utf8");
    const after = before.replace(REF, (m, file) => file + "?v=" + v);
    if (before === after) return;
    if (check) { allOk = false; console.log("  FAIL  " + p.split("/").pop() + " references a stale asset version (want " + v + ")"); }
    else fs.writeFileSync(p, after);
  });
  if (!check) console.log("docs assets → v=" + v + " (" + pages.length + " pages)");
  else if (allOk) console.log("  ok    docs asset versions match (" + v + ")");
  return allOk;
}

const text = fs.readFileSync(FILE, "utf8");
const want = stampOf(text);
const have = (text.match(/^const CODE_STAMP = "([^"]*)";$/m) || [])[1];

if (process.argv[2] === "--check") {
  const docsOk = stampDocs(true);
  if (have === want && docsOk) { console.log("  ok    CODE_STAMP matches the file (" + want + ")"); process.exit(0); }
  if (have !== want) {
    console.log("  FAIL  CODE_STAMP is " + (have || "empty") + ", should be " + want);
  }
  console.log("        run: node stamp.js");
  process.exit(1);
}
stampDocs(false);

fs.writeFileSync(FILE, text.replace(LINE, 'const CODE_STAMP = "' + want + '";'));
console.log(have === want ? "unchanged (" + want + ")" : (have || "empty") + " → " + want);
