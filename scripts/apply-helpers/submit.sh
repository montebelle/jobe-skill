#!/bin/bash
# submit.sh <slug> "<company>" "<role>"  -> submit once; record if success; else skip (no retry)
SLUG="$1"; CO="$2"; ROLE="$3"

# Resolve repo root from this script's location (scripts/apply-helpers/ -> repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

TODAY="$(date +%F)"
FOLLOWUP="$(date -v+7d +%F 2>/dev/null || date -d '+7 days' +%F)"

node -e 'require("fs").writeFileSync("signals/apply/'$SLUG'/control.json", JSON.stringify({action:"submit"}))'
for i in $(seq 1 25); do
  PHASE=$(node -e "try{console.log(require('./signals/apply/$SLUG/state.json').phase||'?')}catch(e){console.log('?')}" 2>/dev/null)
  case "$PHASE" in submitted|confirmed|submit-failed|submit-blocked-spam|error) break;; esac
  sleep 3
done
PHASE=$(node -e "console.log(require('./signals/apply/$SLUG/state.json').phase)")
EXC=$(node -e "console.log((require('./signals/apply/$SLUG/state.json').postSubmitExcerpt||'').replace(/\s+/g,' ').slice(0,110))")
echo "PHASE=$PHASE | $EXC"
if [ "$PHASE" = "submitted" ] || [ "$PHASE" = "confirmed" ]; then
  node -e 'require("fs").writeFileSync("signals/apply/'$SLUG'/control.json", JSON.stringify({action:"done"}))'; sleep 2; pkill -f "camoufox-apply.js run $SLUG" 2>/dev/null
  node -e "const tw=require('./lib/tracker-writer'); try{tw.moveReportFolder('$SLUG','applied')}catch(e){}; try{tw.updateTrackerStatus&&tw.updateTrackerStatus({slug:'$SLUG',newStatus:'Applied',note:'auto-apply; submitted '+'$TODAY'})}catch(e){}; try{tw.updateQueueEntry&&tw.updateQueueEntry('$SLUG',{applied:true,appliedDate:'$TODAY'})}catch(e){}"
  node -e "require('fs').appendFileSync('data/followups.md','\n- $FOLLOWUP: Follow up with $CO ($ROLE) — applied $TODAY')"
  echo "=== APPLIED: $CO — $ROLE ==="
else
  pkill -f "camoufox-apply.js run $SLUG" 2>/dev/null; echo "=== NOT submitted ($PHASE) — skipped, NO retry ==="
fi
