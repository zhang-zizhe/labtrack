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

const text = fs.readFileSync(FILE, "utf8");
const want = stampOf(text);
const have = (text.match(/^const CODE_STAMP = "([^"]*)";$/m) || [])[1];

if (process.argv[2] === "--check") {
  if (have === want) { console.log("  ok    CODE_STAMP matches the file (" + want + ")"); process.exit(0); }
  console.log("  FAIL  CODE_STAMP is " + (have || "empty") + ", should be " + want);
  console.log("        run: node stamp.js");
  process.exit(1);
}

fs.writeFileSync(FILE, text.replace(LINE, 'const CODE_STAMP = "' + want + '";'));
console.log(have === want ? "unchanged (" + want + ")" : (have || "empty") + " → " + want);
