#!/bin/bash
# The privilege-separation proof (docs/hosted-privilege-separation.md, section 13).
#
# Runs one hosted box from a LOCALLY built image, with a stand-in for the platform and a stand-in
# for the `claude` CLI, and prints two tables: what works, and what an attacker inside the box
# cannot do. No registry, no cloud call. Needs docker, node and curl on the host.
#
#   docker/hosted/privsep-proof/run-proof.sh [--image NAME] [--old-image NAME] [--box-port N] [--stub-port N]
#
#   --image       the image under test (default dispatch-box-privsep:latest)
#   --old-image   an image from BEFORE privilege separation, for the migration proof (skipped when absent)
#
# Exit code 0 only when every functional check passed and no attack succeeded.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=dispatch-box-privsep:latest; OLD_IMAGE=""; BOX_PORT=3972; STUB_PORT=3922; DIST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift ;;
    --old-image) OLD_IMAGE="$2"; shift ;;
    --box-port) BOX_PORT="$2"; shift ;;
    --stub-port) STUB_PORT="$2"; shift ;;
    --dist) DIST="$2"; shift ;;   # development only: mount a local build over the image's
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
NAME="privsep-proof-$BOX_PORT"; VH="$NAME-home"; VS="$NAME-state"
WORK="$(mktemp -d)"; BASE=/dispatch-native
IN="$(openssl rand -hex 24)"; OUT="$(openssl rand -hex 24)"
sha() { printf '%s' "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1; }
fpass=0; ffail=0
fok()  { printf 'PASS  %-62s %s\n' "$1" "${2:-}"; fpass=$((fpass+1)); }
fbad() { printf 'FAIL  %-62s %s\n' "$1" "${2:-}"; ffail=$((ffail+1)); }
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then fok "$n"; else fbad "$n"; fi; }
api() { local m="$1" p="$2" d="${3:-}"; curl -s -m 20 -X "$m" -H "x-dispatch-box-token: $IN" ${d:+-H 'content-type: application/json' -d "$d"} "http://127.0.0.1:$BOX_PORT$BASE$p"; }
apic() { local m="$1" p="$2" d="${3:-}"; curl -s -o /dev/null -w '%{http_code}' -m 20 -X "$m" -H "x-dispatch-box-token: $IN" ${d:+-H 'content-type: application/json' -d "$d"} "http://127.0.0.1:$BOX_PORT$BASE$p"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
inbox() { docker exec "$NAME" "$@"; }   # as root, for SET-UP and for READING results only

cleanup() {
  docker rm -f "$NAME" "$NAME-old" >/dev/null 2>&1
  docker volume rm -f "$VH" "$VS" "$VH-legacy" "$VS-legacy" >/dev/null 2>&1
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup_start() { docker rm -f "$NAME" "$NAME-old" >/dev/null 2>&1; docker volume rm -f "$VH" "$VS" "$VH-legacy" "$VS-legacy" >/dev/null 2>&1; }
cleanup_start

STUB_OUTBOUND_TOKEN="$OUT" node "$HERE/os-stub.mjs" "$STUB_PORT" "$WORK/stub.log" >"$WORK/stub.out" 2>&1 &
STUB_PID=$!
sleep 1

start_box() { # start_box <name> <image> <home volume> <state volume or ""> [extra docker args...]
  local name="$1" image="$2" home="$3" state="$4"; shift 4
  docker rm -f "$name" >/dev/null 2>&1
  # Started as root (the task definition's `user: "0"`), with a read-only root file system for the
  # image under test: what the platform is asked to set.
  local ro=""; [ "$image" = "$IMAGE" ] && ro="--read-only"
  docker run -d --name "$name" --platform linux/arm64 --init --user 0 $ro -p "127.0.0.1:$BOX_PORT:3456" \
    -v "$home:/home/dispatch" ${state:+-v "$state:/var/lib/dispatch/state"} \
    -v "$HERE/fake-claude:/opt/agents/.local/bin/claude:ro" ${DIST:+-v "$DIST:/app/packages/core/dist:ro"} \
    -e DISPATCH_BOX_TOKEN="$IN" -e OS_BOX_TOKEN="$OUT" -e OS_BASE_URL="http://host.docker.internal:$STUB_PORT" \
    -e DISPATCH_OWNER_EMAIL=person@example.com -e DISPATCH_BOX_ID=proofbox -e DISPATCH_BASE_PATH="$BASE" -e DISPATCH_PROFILE=developer \
    -e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/not-real -e ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/not-real \
    "$@" "$image" >/dev/null || return 1
  for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && return 0; sleep 1; done
  return 1
}
wait_file() { for _ in $(seq 1 "${2:-90}"); do inbox test -e "$1" 2>/dev/null && return 0; sleep 2; done; return 1; }
type_in() { api POST "/api/terminals/$1/input" "$(node -e 'console.log(JSON.stringify({data: process.argv[1] + "\r"}))' "$2")" >/dev/null; }
set_profile() { curl -s "http://127.0.0.1:$STUB_PORT/__ctl?profile=$1" >/dev/null; api POST /api/os/connections/refresh >/dev/null; sleep 1; }

echo "################ image under test: $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null | cut -c1-19))"
echo
echo "################ A. what works"
if start_box "$NAME" "$IMAGE" "$VH" "$VS"; then fok "the box starts and answers the platform's health call"; else fbad "the box starts"; docker logs "$NAME" 2>&1 | tail -20; exit 1; fi
CTX="$(api GET /api/host-context)"
echo "$CTX" | grep -q '"privsep-v1"' && fok "the start-up self-check passed: privsep-v1 is reported" || fbad "privsep-v1 is reported" "$(docker logs "$NAME" 2>&1 | grep privsep.proof | tail -1 | cut -c1-200)"
docker logs "$NAME" 2>&1 | grep -q 'privilege separation is ON' && fok "the entrypoint chose the two-user layout (state volume present)" || fbad "the entrypoint chose the two-user layout"
[ "$(inbox ps -o user= -p "$(inbox pgrep -f dist/server.js | head -1)" | tr -d ' ')" = root ] && fok "the daemon runs as root (bounded capability set)" "CapBnd $(inbox sh -c 'sed -n "s/^CapBnd:[[:space:]]*//p" /proc/$(pgrep -f dist/server.js | head -1)/status')" || fbad "the daemon runs as root"
grep -q '"p":"/api/dispatch/connections".*"tokenOk":true' "$WORK/stub.log" && fok "the daemon reached the platform with the outbound token" || fbad "the daemon reached the platform with the outbound token"

SID="$(api POST /api/sessions '{"name":"proj1"}' | jget id)"
[ -n "$SID" ] && fok "create a project" "$(inbox stat -c '%U:%G %a' /home/dispatch/projects/proj1 2>/dev/null) (owned by the agent)" || fbad "create a project"
TID="$(api POST "/api/sessions/$SID/terminals" '{"type":"claude-code","label":"chat","config":{"transport":"structured"}}' | jget id)"
sleep 2
api POST "/api/terminals/$TID/message" '{"content":"first turn"}' >/dev/null; sleep 3
api GET "/api/terminals/$TID/journal" | grep -q 'echo:first turn' && fok "a chat thread with the stand-in harness answers a turn" || fbad "a chat thread answers a turn"
HP="$(api GET "/api/terminals/$TID" | jget pid)"
[ "$(inbox ps -o user= -p "$HP" 2>/dev/null | tr -d ' ')" = dispatch ] && fok "the harness process runs as the agent user" "pid $HP: $(inbox sh -c "sed -n 's/^NoNewPrivs:[[:space:]]*/nnp=/p;s/^CapEff:[[:space:]]*/capeff=/p' /proc/$HP/status" | tr '\n' ' ')" || fbad "the harness process runs as the agent user"

SHID="$(api POST "/api/sessions/$SID/terminals" '{"type":"shell","label":"dev"}' | jget id)"
sleep 2
type_in "$SHID" 'echo "PTY-$(id -un)-$(stat -c %U "$(tty)")-$(test -t 0 && echo tty)" > ~/proof-pty.txt'
wait_file /home/dispatch/proof-pty.txt 15
[ "$(inbox cat /home/dispatch/proof-pty.txt 2>/dev/null)" = "PTY-dispatch-dispatch-tty" ] && fok "a developer terminal works; its device belongs to the agent" "scrollback $(api GET "/api/terminals/$SHID/scrollback" | jget totalBytes) bytes" || fbad "a developer terminal works" "$(inbox cat /home/dispatch/proof-pty.txt 2>&1)"

# Files, both directions.
type_in "$SHID" 'cd ~/projects/proj1 && echo agent-wrote > from-agent.txt && (umask 077; echo private > private.txt) && echo ok > ~/proof-f1.done'
wait_file /home/dispatch/proof-f1.done 15
api GET "/api/sessions/$SID/files/read?path=from-agent.txt" | grep -q 'agent-wrote' && fok "a file the agent wrote is visible to the daemon's file API" || fbad "a file the agent wrote is visible to the daemon's file API"
api GET "/api/sessions/$SID/files/read?path=private.txt" | grep -q 'private' && fok "also a file the agent made 0600" || fbad "also a file the agent made 0600"
[ "$(apic PUT "/api/sessions/$SID/files/write?path=from-owner.txt" '{"content":"owner-wrote\n"}')" = 200 ] && fok "the owner writes a file through the daemon" "$(inbox stat -c '%U:%G' /home/dispatch/projects/proj1/from-owner.txt 2>/dev/null) (owned by the agent)" || fbad "the owner writes a file through the daemon"
type_in "$SHID" 'cd ~/projects/proj1 && cat from-owner.txt && echo more >> from-owner.txt && echo ok > ~/proof-f2.done'
wait_file /home/dispatch/proof-f2.done 15 && fok "the agent reads and changes the file the owner wrote" || fbad "the agent reads and changes the file the owner wrote"

# Sign-in state: the harness's own credential file, and the daemon's view of it.
type_in "$SHID" 'mkdir -p ~/.claude && (umask 077; echo "{\"proof\":true}" > ~/.claude/.credentials.json) && echo ok > ~/proof-f3.done'
wait_file /home/dispatch/proof-f3.done 15
api GET /api/claude-auth | grep -qi 'person@example.com\|loggedIn\|"signedIn":true\|"authenticated":true' && fok "the daemon sees the harness sign-in (asked as the agent)" || fbad "the daemon sees the harness sign-in" "$(api GET /api/claude-auth | head -c 160)"

# The process table: nothing but init and the daemon is root.
STRAY="$(inbox ps -eo user=,pid=,args= | awk '$1!="dispatch"' | grep -v -E 'docker-init|dist/server.js|ps -eo' | head -5)"
[ -z "$STRAY" ] && fok "every process except init and the daemon runs as the agent user" "$(inbox ps -eo user= | sort | uniq -c | tr -s ' ' | tr '\n' ';')" || fbad "every process except init and the daemon runs as the agent user" "$STRAY"

echo
echo "################ B. attacks, run as a workload (a developer shell the daemon started)"
inbox mkdir -p /home/dispatch/proof
docker cp "$HERE/attack.sh" "$NAME:/home/dispatch/proof/attack.sh" >/dev/null
inbox sh -c "echo $SID > /home/dispatch/proof/sid; echo $TID > /home/dispatch/proof/tid; printf '%s' '$IN' > /home/dispatch/proof/leaked-inbound-token; chown -R 1000:1000 /home/dispatch/proof; chmod 755 /home/dispatch/proof/attack.sh"
type_in "$SHID" "bash ~/proof/attack.sh $(sha "$IN") $(sha "$OUT") http://host.docker.internal:$STUB_PORT > ~/proof/attack-dev.out 2>&1; echo done > ~/proof/attack-dev.done"
wait_file /home/dispatch/proof/attack-dev.done 150
inbox cat /home/dispatch/proof/attack-dev.out > "$WORK/attack-dev.out" 2>/dev/null
grep -E '^(==|FAIL|NOTE)' "$WORK/attack-dev.out" | sed "s/$IN/<inbound>/g"
A1="$(grep -c '^FAIL' "$WORK/attack-dev.out")"; P1="$(grep -c '^PASS' "$WORK/attack-dev.out")"

echo
echo "################ C. the same attacks under the business profile, run by the harness process itself"
set_profile business
[ "$(apic POST "/api/sessions/$SID/terminals" '{"type":"shell"}')" = 403 ] && fok "business profile: the owner cannot open a shell" || fbad "business profile: the owner cannot open a shell" "HTTP $(apic POST "/api/sessions/$SID/terminals" '{"type":"shell"}')"
inbox sh -c "printf '#!/bin/bash\n[ -e \$HOME/proof/attack-biz.started ] && exit 0; : > \$HOME/proof/attack-biz.started\nbash \$HOME/proof/attack.sh $(sha "$IN") $(sha "$OUT") http://host.docker.internal:$STUB_PORT > \$HOME/proof/attack-biz.out 2>&1; echo done > \$HOME/proof/attack-biz.done\n' > /home/dispatch/proof/on-harness-start.sh; chmod 755 /home/dispatch/proof/on-harness-start.sh; chown 1000:1000 /home/dispatch/proof/on-harness-start.sh"
BT="$(api POST "/api/sessions/$SID/terminals" '{"type":"claude-code","label":"business chat"}')"
BTID="$(echo "$BT" | jget id)"; sleep 2
api POST "/api/terminals/$BTID/message" '{"content":"business turn"}' >/dev/null
wait_file /home/dispatch/proof/attack-biz.done 150
inbox cat /home/dispatch/proof/attack-biz.out > "$WORK/attack-biz.out" 2>/dev/null
grep -E '^(==|FAIL|NOTE)' "$WORK/attack-biz.out" | sed "s/$IN/<inbound>/g"
A2="$(grep -c '^FAIL' "$WORK/attack-biz.out")"; P2="$(grep -c '^PASS' "$WORK/attack-biz.out")"
inbox rm -f /home/dispatch/proof/on-harness-start.sh
# What the platform saw: every accepted call carried the outbound token; the direct ones did not.
DIRECT_OK="$(grep -c '"tokenOk":true.*"tool":"crm_update_customer"' "$WORK/stub.log")"
[ "$DIRECT_OK" = 0 ] && fok "the platform accepted no tool call that skipped the daemon" "$(grep -c '"tokenOk":false' "$WORK/stub.log") refused" || fbad "the platform accepted no tool call that skipped the daemon" "$DIRECT_OK accepted"
set_profile developer

echo
echo "################ D. restart: threads, history and sign-in state survive"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && break; sleep 1; done
api GET /api/host-context | grep -q '"privsep-v1"' && fok "after a restart the box proves the separation again" || fbad "after a restart the box proves the separation again"
api GET "/api/sessions/$SID/terminals" | grep -q "$TID" && fok "the thread is still listed" || fbad "the thread is still listed"
api GET "/api/terminals/$TID/journal" | grep -q 'echo:first turn' && fok "its history is still there" || fbad "its history is still there"
api POST "/api/terminals/$TID/message" '{"content":"second turn"}' >/dev/null; sleep 5
J="$(api GET "/api/terminals/$TID/journal")"
echo "$J" | grep -q 'echo:second turn' && fok "the thread resumes and answers a new turn" || fbad "the thread resumes and answers a new turn" "$(echo "$J" | tail -c 200)"
[ "$(inbox stat -c '%U %a' /home/dispatch/.claude/.credentials.json 2>/dev/null)" = "dispatch 600" ] && fok "the harness credential file survived, private to the agent" || fbad "the harness credential file survived" "$(inbox stat -c '%U %a' /home/dispatch/.claude/.credentials.json 2>&1)"
inbox test ! -e /home/dispatch/.dispatch/dispatch.db && inbox test -s /var/lib/dispatch/state/dispatch.db && fok "the database is in the state root, not in the home" || fbad "the database is in the state root, not in the home"

if [ -n "$OLD_IMAGE" ] && docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
  echo
  echo "################ E. an existing box: a home made by the old image ($OLD_IMAGE)"
  docker rm -f "$NAME" >/dev/null 2>&1
  if DIST="" start_box "$NAME-old" "$OLD_IMAGE" "$VH-legacy" ""; then
    OSID="$(api POST /api/sessions '{"name":"oldproj"}' | jget id)"
    OTID="$(api POST "/api/sessions/$OSID/terminals" '{"type":"claude-code","label":"old chat","config":{"transport":"structured"}}' | jget id)"; sleep 2
    api POST "/api/terminals/$OTID/message" '{"content":"old turn"}' >/dev/null; sleep 3
    docker exec "$NAME-old" test -s /home/dispatch/.dispatch/dispatch.db && fok "old image: state in the home, one user" "$(docker exec "$NAME-old" stat -c '%U %a' /home/dispatch/.dispatch/dispatch.db)" || fbad "old image wrote its state in the home"
    docker exec -u 1000 "$NAME-old" sh -c 'mkdir -p ~/.dispatch/claude-accounts/acct1 && echo cred > ~/.dispatch/claude-accounts/acct1/.credentials.json'
    docker stop "$NAME-old" >/dev/null; docker rm -f "$NAME-old" >/dev/null
    # First start of the new image WITHOUT the platform's permission: nothing may be deleted.
    start_box "$NAME" "$IMAGE" "$VH-legacy" "$VS-legacy" >/dev/null
    inbox test -s /home/dispatch/.dispatch/dispatch.db && fok "without the platform's flag the old state is left untouched" || fbad "without the platform's flag the old state is left untouched"
    docker rm -f "$NAME" >/dev/null; docker volume rm -f "$VS-legacy" >/dev/null
    start_box "$NAME" "$IMAGE" "$VH-legacy" "$VS-legacy" -e DISPATCH_MIGRATE_LEGACY_HOME=1 && fok "new image starts on the old home" || fbad "new image starts on the old home"
    docker logs "$NAME" 2>&1 | grep 'privsep.prepare' | tail -1 | grep -q '"imported":[1-9]' && fok "the old state was imported into the state root" "$(docker logs "$NAME" 2>&1 | grep 'privsep.prepare' | tail -1 | grep -oE '"imported":[0-9]+,"removed":[0-9]+')" || fbad "the old state was imported into the state root"
    api GET /api/host-context | grep -q '"privsep-v1"' && fok "the migrated box proves the separation" || fbad "the migrated box proves the separation"
    api GET /api/sessions | grep -q '"oldproj"' && fok "the old project is listed" || fbad "the old project is listed"
    api GET "/api/terminals/$OTID/journal" | grep -q 'echo:old turn' && fok "the old thread's history is there" || fbad "the old thread's history is there"
    api POST "/api/terminals/$OTID/message" '{"content":"new turn"}' >/dev/null; sleep 5
    api GET "/api/terminals/$OTID/journal" | grep -q 'echo:new turn' && fok "the old thread answers a new turn" || fbad "the old thread answers a new turn"
    inbox test ! -e /home/dispatch/.dispatch/dispatch.db && fok "no database is left in the home" "$(inbox ls /home/dispatch/.dispatch | tr '\n' ' ')" || fbad "no database is left in the home"
    inbox test ! -e /home/dispatch/.dispatch/access-token && fok "the old owner token file is gone and was not imported" || fbad "the old owner token file is gone"
    inbox test -s /home/dispatch/.dispatch/claude-accounts/acct1/.credentials.json && fok "an added account's sign-in stayed in the home" || fbad "an added account's sign-in stayed in the home"
    docker restart "$NAME" >/dev/null; for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && break; sleep 1; done
    docker logs "$NAME" 2>&1 | grep 'privsep.prepare' | tail -1 | grep -q 'already-migrated' && fok "a second start imports nothing (idempotent)" || fbad "a second start imports nothing"
  else
    fbad "the old image starts" "$(docker logs "$NAME-old" 2>&1 | tail -3)"
  fi
fi

echo
echo "################ summary"
echo "functional checks: $fpass passed, $ffail failed"
echo "attacks as a developer shell:   $P1 stopped, $A1 NOT stopped"
echo "attacks as a business harness:  $P2 stopped, $A2 NOT stopped"
cp "$WORK/attack-dev.out" "${PROOF_OUT:-/dev/null}.dev" 2>/dev/null; cp "$WORK/attack-biz.out" "${PROOF_OUT:-/dev/null}.biz" 2>/dev/null
[ "$ffail" = 0 ] && [ "$A1" = 0 ] && [ "$A2" = 0 ] && [ "${P1:-0}" -gt 0 ] && [ "${P2:-0}" -gt 0 ]
