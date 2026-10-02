#!/bin/bash
# launch.sh <slug> [url]  -> launch harness, poll to terminal-ish phase, print state
SLUG="$1"; URL="$2"
case "$SLUG" in ''|*[!A-Za-z0-9._-]*) echo "usage: launch.sh <slug> [url]   (slug: letters, digits, . _ -)" >&2; exit 2;; esac
cd "$(dirname "$0")/../.." || { echo "cannot cd to repo root" >&2; exit 1; }
# Apply state lives in the ACTIVE WORKSPACE (JOBE_USER_ROOT / JOBE_USER /
# users/.active), which is the install root only in single user mode.
WS="$(node -e 'console.log(require("./lib/config").getUserRoot())')" || { echo "cannot resolve the workspace" >&2; exit 1; }
DIR="$WS/signals/apply/$SLUG"
mkdir -p "$DIR"
rm -f "$DIR/state.json" "$DIR/control.json" 2>/dev/null
if [ -n "$URL" ]; then node scripts/camoufox-apply.js run "$SLUG" --url "$URL" > "$DIR/launch.log" 2>&1 &
else node scripts/camoufox-apply.js run "$SLUG" > "$DIR/launch.log" 2>&1 & fi
sleep 1
# The state path is passed as an ARGUMENT, never interpolated into the script text.
for i in $(seq 1 50); do
  PHASE=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).phase||"?")}catch(e){console.log("?")}' "$DIR/state.json" 2>/dev/null)
  case "$PHASE" in filled|error|needs-manual|blocked-location|submit-blocked-spam) break;; esac
  sleep 3
done
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const loc=(s.filled||[]).find(f=>/location/i.test(f.label)); console.log("PHASE:",s.phase,"| resume:",s.resumeUploaded,"| LOCATION:", loc?loc.value:"(none/na)"); (s.filled||[]).filter(f=>/authoriz|sponsor/i.test(f.label)).forEach(v=>console.log("  visa:",v.value,"<-",v.label.slice(0,50))); console.log("UNFILLED:",JSON.stringify(s.unfilled||[])); console.log("QUESTIONS:"); (s.questions||[]).forEach((q,i)=>console.log("  Q"+(i+1)+" ["+q.type+"]"+(q.options?" opts="+JSON.stringify(q.options).slice(0,80):"")+": "+q.label.slice(0,120)))' "$DIR/state.json" 2>/dev/null
