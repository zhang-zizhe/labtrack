#!/usr/bin/env bash
# Publish the frontend to labtrack.zizhe.io.
#
# GitHub Pages serves this site from the `gh-pages` branch, which holds only the
# four files below — NOT from `main`. Pushing to main changes nothing that anyone
# can see, and there is no error to notice: the site simply goes on serving what it
# served before. That went unnoticed for three days once. Hence this script.
#
#   ./deploy.sh            deploy the working tree's index.html
#   ./deploy.sh --check    run the checks and stop, changing nothing
set -euo pipefail
cd "$(dirname "$0")"

SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CHECK_ONLY="${1:-}"
fail() { printf '\033[31m  FAIL  %s\033[0m\n' "$*"; BAD=1; }
pass() { printf '\033[32m  ok    \033[0m%s\n' "$*"; }
BAD=0

echo "── checks ──"

# The dev hatch removes authentication from a web app deployed as "Anyone", and the
# key sits in the page source where anybody can read it. It is for localhost.
grep -q '^  dev_key: "",' index.html \
  && pass "dev_key is empty" || fail "LAB_CONFIG.dev_key is set — the deployed app would have no authentication"
grep -q '^const DEV_NO_AUTH_KEY = "";' google-apps-script.js \
  && pass "DEV_NO_AUTH_KEY is empty" || fail "DEV_NO_AUTH_KEY is set in the backend"

# Sample data must never reach a signed-in session; it is gated on the local token.
grep -q '(bare && user.token === "local") ? demoData()' index.html \
  && pass "demo data is still gated on the local session" || fail "demoData() gating has moved or gone"

# The app is one inline Babel block: a syntax error is a blank page with no stack
# trace, and the only way to know is to compile it.
BABEL="$(ls node_modules/@babel/standalone/babel.min.js 2>/dev/null || true)"
if [ -n "$BABEL" ]; then
  node -e '
    const fs=require("fs"), B=require("./node_modules/@babel/standalone/babel.min.js");
    const src=fs.readFileSync("index.html","utf8");
    const b=[...src.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)];
    if(!b.length) { console.error("no babel block found"); process.exit(1); }
    b.forEach(x=>B.transform(x[1],{presets:["react"]}));
  ' && pass "JSX compiles" || fail "JSX does not compile — this would be a blank page"
else
  printf '\033[33m  skip  \033[0mJSX not compiled (npm i @babel/standalone to enable this check)\n'
fi

# A path with a home directory in it runs everywhere that home directory exists and
# nowhere else. It passed here, it passed in a fresh clone on this machine — because
# the clone went on reading the original working tree — and it failed on CI, which
# was the first honest test it had.
if grep -rn "/Users/\|/home/[a-z]" --include="*.js" --include="*.mjs" --include="*.sh" . \
     --exclude-dir=node_modules 2>/dev/null | grep -v "^\./deploy.sh:"; then
  fail "a machine-specific absolute path is checked in (see above)"
else
  pass "no machine-specific paths"
fi

[ "$BAD" = "0" ] || { echo; echo "Refusing to deploy."; exit 1; }
[ "$CHECK_ONLY" = "--check" ] && { echo; echo "Checks only — nothing deployed."; exit 0; }

echo
echo "── deploying $SOURCE_BRANCH → gh-pages ──"
git diff --quiet && git diff --cached --quiet || { echo "Working tree is dirty. Commit first."; exit 1; }

git fetch -q origin gh-pages
git checkout -q gh-pages
git pull -q --ff-only origin gh-pages
git checkout "$SOURCE_BRANCH" -- index.html
# The guides, if this branch has them. Tolerated as absent so the script still works
# on a branch from before they existed.
git checkout "$SOURCE_BRANCH" -- docs 2>/dev/null || true

if git diff --cached --quiet; then
  echo "  gh-pages already matches $SOURCE_BRANCH — nothing to do."
else
  git --no-pager diff --cached --stat
  git commit -q -m "Redeploy from $SOURCE_BRANCH ($(git rev-parse --short "$SOURCE_BRANCH"))"
  git push -q origin gh-pages
  echo "  pushed. GitHub Pages usually takes a minute or two."
fi
git checkout -q "$SOURCE_BRANCH"

echo
echo "── verify ──"
echo "  curl -s https://labtrack.zizhe.io/ | grep -c SubscribeModal"
