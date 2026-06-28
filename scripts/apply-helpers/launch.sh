#!/bin/bash
# launch.sh <slug> [url]  -> launch harness, poll to terminal-ish phase, print state
SLUG="$1"; URL="$2"
cd "$(dirname "$0")/../.." || { echo "cannot cd to repo root" >&2; exit 1; }
rm -f signals/apply/$SLUG/state.json signals/apply/$SLUG/control.json 2>/dev/null
if [ -n "$URL" ]; then node scripts/camoufox-apply.js run "$SLUG" --url "$URL" > /tmp/cfx-$SLUG.log 2>&1 &
else node scripts/camoufox-apply.js run "$SLUG" > /tmp/cfx-$SLUG.log 2>&1 & fi
sleep 1
for i in $(seq 1 50); do
  PHASE=$(node -e "try{console.log(require('./signals/apply/$SLUG/state.json').phase||'?')}catch(e){console.log('?')}" 2>/dev/null)
  case "$PHASE" in filled|error|needs-manual|blocked-location|submit-blocked-spam) break;; esac
  sleep 3
done
node -e "const s=require('./signals/apply/$SLUG/state.json'); const loc=(s.filled||[]).find(f=>/location/i.test(f.label)); console.log('PHASE:',s.phase,'| resume:',s.resumeUploaded,'| LOCATION:', loc?loc.value:'(none/na)'); (s.filled||[]).filter(f=>/authoriz|sponsor/i.test(f.label)).forEach(v=>console.log('  visa:',v.value,'<-',v.label.slice(0,50))); console.log('UNFILLED:',JSON.stringify(s.unfilled||[])); console.log('QUESTIONS:'); (s.questions||[]).forEach((q,i)=>console.log('  Q'+(i+1)+' ['+q.type+']'+(q.options?' opts='+JSON.stringify(q.options).slice(0,80):'')+': '+q.label.slice(0,120)))" 2>/dev/null
