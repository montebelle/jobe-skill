#!/bin/bash
# submit.sh <slug> "<company>" "<role>"  -> submit once; record if success; else skip (no retry)
SLUG="$1"; CO="$2"; ROLE="$3"
case "$SLUG" in ''|*[!A-Za-z0-9._-]*) echo "usage: submit.sh <slug> \"<company>\" \"<role>\"   (slug: letters, digits, . _ -)" >&2; exit 2;; esac

# Resolve repo root from this script's location (scripts/apply-helpers/ -> repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1
# Apply state, the queue, the tracker and followups live in the ACTIVE WORKSPACE
# (JOBE_USER_ROOT / JOBE_USER / users/.active), which is the install root only
# in single user mode.
WS="$(node -e 'console.log(require("./lib/config").getUserRoot())')" || { echo "cannot resolve the workspace" >&2; exit 1; }
DIR="$WS/signals/apply/$SLUG"
[ -d "$DIR" ] || { echo "no apply run for $SLUG in $WS (launch it first)" >&2; exit 1; }

TODAY="$(date +%F)"
FOLLOWUP="$(date -v+7d +%F 2>/dev/null || date -d '+7 days' +%F)"

# Company and role strings come from scraped postings. Every value reaches node
# as an ARGUMENT (process.argv), never interpolated into the script text.
ctl() { node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({action:process.argv[2]}))' "$DIR/control.json" "$1"; }
field() { node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(String(s[process.argv[2]]||"").replace(/\s+/g," ").slice(0,110))}catch(e){console.log("")}' "$DIR/state.json" "$1" 2>/dev/null; }

ctl submit
for i in $(seq 1 25); do
  PHASE="$(field phase)"
  case "$PHASE" in submitted|confirmed|submit-failed|submit-blocked-spam|error) break;; esac
  sleep 3
done
PHASE="$(field phase)"
EXC="$(field postSubmitExcerpt)"
echo "PHASE=$PHASE | $EXC"
if [ "$PHASE" = "submitted" ] || [ "$PHASE" = "confirmed" ]; then
  ctl done; sleep 2; pkill -f "camoufox-apply.js run $SLUG" 2>/dev/null
  node -e 'const tw=require("./lib/tracker-writer"); const [slug,today]=process.argv.slice(1); try{tw.moveReportFolder(slug,"applied")}catch(e){}; try{tw.updateTrackerStatus({slug,newStatus:"Applied",notesAppend:"auto-apply; submitted "+today})}catch(e){}; try{tw.updateQueueEntry(slug,{applied:true,appliedDate:today})}catch(e){}' "$SLUG" "$TODAY"
  node -e 'const [file,followup,co,role,today]=process.argv.slice(1); require("fs").appendFileSync(file,"\n- "+followup+": Follow up with "+co+" ("+role+") — applied "+today)' "$WS/data/followups.md" "$FOLLOWUP" "$CO" "$ROLE" "$TODAY"
  echo "=== APPLIED: $CO — $ROLE ==="
else
  pkill -f "camoufox-apply.js run $SLUG" 2>/dev/null; echo "=== NOT submitted ($PHASE) — skipped, NO retry ==="
fi
