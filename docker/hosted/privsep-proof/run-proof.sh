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
# No `pipefail`: most checks are `<a command that prints> | grep -q <text>`. grep stops at the first
# match, the printing command may then end on a closed pipe, and with pipefail that made a check fail
# although the text was there (seen with `docker logs`).
set -u
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
IN="$(openssl rand -hex 24)"; OUT="$(openssl rand -hex 24)"; SECRET="$(openssl rand -hex 20)"
sha() { printf '%s' "$1" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1; }
fpass=0; ffail=0
fok()  { printf 'PASS  %-62s %s\n' "$1" "${2:-}"; fpass=$((fpass+1)); }
fbad() { printf 'FAIL  %-62s %s\n' "$1" "${2:-}"; ffail=$((ffail+1)); }
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then fok "$n"; else fbad "$n"; fi; }
PORT="$BOX_PORT"   # the box the owner's calls go to (the compatibility starts use other ports)
api() { local m="$1" p="$2" d="${3:-}"; curl -s -m 20 -X "$m" -H "x-dispatch-box-token: $IN" ${d:+-H 'content-type: application/json' -d "$d"} "http://127.0.0.1:$PORT$BASE$p"; }
apic() { local m="$1" p="$2" d="${3:-}"; curl -s -o /dev/null -w '%{http_code}' -m 20 -X "$m" -H "x-dispatch-box-token: $IN" ${d:+-H 'content-type: application/json' -d "$d"} "http://127.0.0.1:$PORT$BASE$p"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
BOX=""   # the container the helpers below talk to (default: the box under test)
inbox() { docker exec "${BOX:-$NAME}" "$@"; }   # as root, for SET-UP and for READING results only
pfile() { inbox cat "/home/dispatch/proof/$1" 2>/dev/null; }

cleanup() {
  docker rm -f "$NAME" "$NAME-old" "$NAME-compat" >/dev/null 2>&1
  docker volume rm -f "$VH" "$VS" "$VH-legacy" "$VS-legacy" "$VH-compat" "$VS-compat" >/dev/null 2>&1
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup_start() { docker rm -f "$NAME" "$NAME-old" "$NAME-compat" >/dev/null 2>&1; docker volume rm -f "$VH" "$VS" "$VH-legacy" "$VS-legacy" "$VH-compat" "$VS-compat" >/dev/null 2>&1; }
cleanup_start

STUB_OUTBOUND_TOKEN="$OUT" node "$HERE/os-stub.mjs" "$STUB_PORT" "$WORK/stub.log" >"$WORK/stub.out" 2>&1 &
STUB_PID=$!
sleep 1

PLATFORM_CAP_DROP="--cap-drop AUDIT_WRITE --cap-drop FSETID --cap-drop MKNOD --cap-drop NET_BIND_SERVICE --cap-drop NET_RAW --cap-drop SETFCAP --cap-drop SYS_CHROOT"
start_box() { # start_box <name> <image> <home volume> <state volume or ""> [extra docker args...]
  local name="$1" image="$2" home="$3" state="$4"; shift 4
  docker rm -f "$name" >/dev/null 2>&1
  # Started as root (the task definition's `user: "0"`), with a read-only root file system for the
  # image under test: what the platform is asked to set.
  # And with the capabilities the platform's task definition leaves: it drops these seven of the
  # runtime's default set, which leaves CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID SETPCAP.
  local ro=""; [ "$image" = "$IMAGE" ] && ro="--read-only $PLATFORM_CAP_DROP"
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
copy_in() { docker cp "$1" "${BOX:-$NAME}:/home/dispatch/proof/$2" >/dev/null && inbox sh -c "chown 1000:1000 '/home/dispatch/proof/$2'; chmod 755 '/home/dispatch/proof/$2'"; }
# hook <tag> <thread-only: 1|0> <commands>: what the stand-in harness starts, once, as a workload. The
# commands see the harness's own arguments ("$@") and environment. `thread-only`: only a thread's
# harness (it has an MCP config and a key), not a probe the daemon runs.
hook() {
  { echo '#!/bin/bash'
    [ "$2" = 1 ] && echo 'case " $* " in *" --mcp-config "*) ;; *) exit 0 ;; esac; [ -n "${DISPATCH_AUTH:-}${DISPATCH_AUTH_FILE:-}" ] || exit 0'
    echo "[ -e \"\$HOME/proof/hook-$1.started\" ] && exit 0; : > \"\$HOME/proof/hook-$1.started\""
    echo "$3"
  } > "$WORK/hook.sh"
  copy_in "$WORK/hook.sh" on-harness-start.sh
}
# Every copy of a posted file that the daemon keeps holds the proof's CSV or the agent's own marker:
# never a file the agent could not read itself. Prints the names of the copies that do not.
bad_copies() { inbox sh -c 'cd /var/lib/dispatch/state/plugin-files/previews 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] || continue; grep -q -e AGENT-OWN-FILE -e "region,units" "$f" || echo "$f"; done' | tr '\n' ' '; }
copies() { inbox sh -c 'ls /var/lib/dispatch/state/plugin-files/previews 2>/dev/null | wc -l' | tr -d ' '; }

echo "################ image under test: $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null | cut -c1-19))"
echo
echo "################ A. what works"
if start_box "$NAME" "$IMAGE" "$VH" "$VS"; then fok "the box starts and answers the platform's health call"; else fbad "the box starts"; docker logs "$NAME" 2>&1 | tail -20; exit 1; fi
CTX="$(api GET /api/host-context)"
echo "$CTX" | grep -q '"privsep-v1"' && fok "the start-up self-check passed: privsep-v1 is reported" || fbad "privsep-v1 is reported" "$(docker logs "$NAME" 2>&1 | grep privsep.proof | tail -1 | cut -c1-200)"
CAPS="$(echo "$CTX" | jget capabilities)"
MISSING=""; for c in base-path profile os-tools-proxy headless-v1 idle-info gate-v2 privsep-v1 inbox-v1 live-tools-v1; do echo "$CAPS" | grep -q "\"$c\"" || MISSING="$MISSING $c"; done
[ -z "$MISSING" ] && fok "the capability list is complete" "$CAPS" || fbad "the capability list is complete" "missing:$MISSING in $CAPS"
docker logs "$NAME" 2>&1 | grep -q 'privilege separation is ON' && fok "the entrypoint chose the two-user layout (state volume present)" || fbad "the entrypoint chose the two-user layout"
docker logs "$NAME" 2>&1 | grep -q 'box tokens: split' && fok "two different tokens: each has one job (split mode)" || fbad "two different tokens: split mode" "$(docker logs "$NAME" 2>&1 | grep 'box tokens' | tail -1)"
[ "$(inbox ps -o user= -p "$(inbox pgrep -f dist/server.js | head -1)" | tr -d ' ')" = root ] && fok "the daemon runs as root (bounded capability set)" "CapBnd $(inbox sh -c 'sed -n "s/^CapBnd:[[:space:]]*//p" /proc/$(pgrep -f dist/server.js | head -1)/status')" || fbad "the daemon runs as root"
grep -q '"p":"/api/dispatch/connections".*"tokenOk":true' "$WORK/stub.log" && fok "the daemon reached the platform with the outbound token" || fbad "the daemon reached the platform with the outbound token"
# The two calls the platform's provisioner makes before it calls a box ready.
[ "$(apic GET /api/sessions)" = 200 ] && PROV="$(api GET /api/providers)" && echo "$PROV" | grep -q '"name":"claude-code"' && echo "$PROV" | grep -q '"name":"codex"' && fok "the platform's readiness calls pass (/api/sessions, /api/providers: claude-code, codex)" || fbad "the platform's readiness calls pass" "sessions $(apic GET /api/sessions); providers $(api GET /api/providers | head -c 160)"
# What the hardened image removed stays removed, and its default user is not root.
TOOLS="$(inbox sh -c 'for t in gcc cc g++ make python3 python curl wget unzip pnpm corepack yarn; do command -v $t; done' | tr '\n' ' ')"
[ -z "$TOOLS" ] && fok "no compiler, python, curl, unzip or package manager wrapper in the image" || fbad "no compiler, python, curl or unzip in the image" "$TOOLS"
[ "$(docker image inspect "$IMAGE" --format '{{.Config.User}}')" = dispatch ] && fok "the image's default user is the agent user, not root" || fbad "the image's default user is the agent user" "$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
[ "$(docker inspect "$NAME" --format '{{.HostConfig.ReadonlyRootfs}}')" = true ] && fok "the box runs with a read-only root file system" || fbad "the box runs with a read-only root file system"
[ "$(inbox stat -c '%U:%G %a' /etc/claude-code/managed-settings.json /etc/codex/requirements.toml 2>/dev/null | sort -u)" = "root:root 644" ] && fok "both managed policy files belong to root, mode 644" || fbad "both managed policy files belong to root, mode 644" "$(inbox stat -c '%n %U:%G %a' /etc/claude-code/managed-settings.json /etc/codex/requirements.toml 2>&1 | tr '\n' ' ')"
inbox grep -q '"disableBypassPermissionsMode"' /etc/claude-code/managed-settings.json && fok "the Claude Code policy turns the approval bypass off" || fbad "the Claude Code policy turns the approval bypass off"
docker logs "$NAME" 2>&1 | grep -q "PATH: the image's" && fok "the daemon keeps the image's PATH (no login shell of the agent is asked)" || fbad "the daemon keeps the image's PATH"

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

# The file routes and the folder that was the data folder before the state moved out of the home: it
# keeps the harness account folders, so the daemon still serves nothing from it, to the owner either.
type_in "$SHID" 'mkdir -p ~/.dispatch/claude-accounts/a1 && echo "{\"account\":true}" > ~/.dispatch/claude-accounts/a1/.credentials.json && echo ok > ~/proof-f4.done'
wait_file /home/dispatch/proof-f4.done 15
R4="$(api GET "/api/sessions/$SID/files/read?path=/home/dispatch/.dispatch/claude-accounts/a1/.credentials.json")"
[ "$(apic GET "/api/sessions/$SID/files/read?path=/home/dispatch/.dispatch/claude-accounts/a1/.credentials.json")" = 403 ] && ! echo "$R4" | grep -q '"account"' && [ "$(apic GET "/api/sessions/$SID/files/read?path=/home/dispatch/proof-pty.txt")" = 200 ] && fok "the file routes serve the home, but not an account folder of a harness in ~/.dispatch" "$(echo "$R4" | jget reason)" || fbad "the file routes do not serve an account folder of a harness in ~/.dispatch" "HTTP $(apic GET "/api/sessions/$SID/files/read?path=/home/dispatch/.dispatch/claude-accounts/a1/.credentials.json") $(echo "$R4" | head -c 120)"

# ── The Inbox tool, end to end (the bundled plugin `previews`), and live tool changes ──────────────────────
# A thread's harness starts the proof's MCP client (agent-work.mjs) with its own arguments and key. It
# hands the person a CSV file and a secret through the Inbox tool, then waits for the tools of a system
# the person connects while the thread runs.
inbox mkdir -p /home/dispatch/proof
inbox chown 1000:1000 /home/dispatch/proof
copy_in "$HERE/agent-work.mjs" agent-work.mjs
copy_in "$HERE/attack.sh" attack.sh
copy_in "$HERE/attack-routes.mjs" attack-routes.mjs
copy_in "$HERE/plant-rc.sh" plant-rc.sh
copy_in "$HERE/nested-harness.sh" nested-harness.sh
inbox sh -c "printf '%s' '$SECRET' > /home/dispatch/proof/secret-value; chown 1000:1000 /home/dispatch/proof/secret-value"
hook work-dev 1 'node "$HOME/proof/agent-work.mjs" inbox dev -- "$@"; node "$HOME/proof/agent-work.mjs" live dev -- "$@"'
ITID="$(api POST "/api/sessions/$SID/terminals" '{"type":"claude-code","label":"inbox chat","config":{"transport":"structured"}}' | jget id)"
sleep 2
api POST "/api/terminals/$ITID/message" '{"content":"put the report in my inbox"}' >/dev/null
wait_file /home/dispatch/proof/inbox-dev.done 45
inbox rm -f /home/dispatch/proof/secret-value
R="$(pfile inbox-dev.json)"
DROP="$(echo "$R" | jget dropId)"; FID="$(echo "$R" | jget fileId)"; SDROP="$(echo "$R" | jget secretDropId)"
[ "$(echo "$R" | jget steps.serverInConfig)" = true ] && fok "the thread's MCP config holds the Inbox server (plugin-previews)" "run as uid $(echo "$R" | jget uid), key from a $(echo "$R" | jget keyFrom)" || fbad "the thread's MCP config holds the Inbox server" "$(echo "$R" | jget steps.servers) $(echo "$R" | jget steps.error | head -c 200)"
echo "$R" | jget steps.tools | grep -q '"name":"preview"' && fok "the Inbox server starts as the agent and lists its tool" "$(echo "$R" | jget steps.tools)" || fbad "the Inbox server starts as the agent and lists its tool" "$(echo "$R" | jget steps.initialize | head -c 200)"
[ -n "$DROP" ] && [ "$(echo "$R" | jget steps.sendCsv.isError)" = false ] && fok "the agent sends a CSV file through the Inbox tool" "drop ${DROP:0:8}…" || fbad "the agent sends a CSV file through the Inbox tool" "$(echo "$R" | jget steps.sendCsv.text | head -c 200)"
LIST="$(api GET /api/inbox)"
echo "$LIST" | grep -q "\"id\":\"$DROP\"" && echo "$LIST" | grep -q 'report-dev.csv' && fok "the owner route lists the drop with its file" "unread $(api GET /api/inbox/unread | jget total)" || fbad "the owner route lists the drop with its file" "$(echo "$LIST" | head -c 200)"
[ "$(api GET "/api/inbox/drops/$DROP/files/$FID")" = "$(printf 'region,units\nnorth,12\nsouth,30')" ] && fok "the owner route serves the file, byte for byte" "$(curl -s -o /dev/null -D - -m 20 -H "x-dispatch-box-token: $IN" "http://127.0.0.1:$PORT$BASE/api/inbox/drops/$DROP/files/$FID" | grep -i -E '^content-(type|disposition)' | tr -d '\r' | tr '\n' ' ' | cut -c1-110)" || fbad "the owner route serves the file, byte for byte" "$(api GET "/api/inbox/drops/$DROP/files/$FID" | head -c 120)"
SNAP="$(inbox sh -c 'stat -c "%U %a" /var/lib/dispatch/state/plugin-files/previews/*.csv 2>/dev/null | sort -u')"
[ "$SNAP" = "root 600" ] && fok "the copy of the file is in the daemon's state, private to root" "$(inbox sh -c 'stat -c "%U %a" /var/lib/dispatch/state/plugin-files/previews' ) folder" || fbad "the copy of the file is in the daemon's state, private to root" "$SNAP"
[ "$(echo "$R" | jget steps.ownerRoutesAsThread)" = '{"list":403,"counts":403,"one drop":403,"mark read":403}' ] && fok "the thread's own key gets 403 on the owner's Inbox routes" || fbad "the thread's own key gets 403 on the owner's Inbox routes" "$(echo "$R" | jget steps.ownerRoutesAsThread)"
[ "$(echo "$R" | jget steps.fileRoutesAsThread)" = '{"inbox":403,"plugin":403}' ] && fok "the thread's own key cannot read the file bytes back" || fbad "the thread's own key cannot read the file bytes back" "$(echo "$R" | jget steps.fileRoutesAsThread)"
SD="$(api GET "/api/inbox/drops/$SDROP")"
[ -n "$SDROP" ] && echo "$SD" | grep -q '"secret":{"present":true' && ! echo "$SD$LIST" | grep -q "$SECRET" && fok "a secret drop is listed without its value" || fbad "a secret drop is listed without its value" "$(echo "$SD" | sed "s/$SECRET/<the value>/g" | head -c 200)"
[ "$(api GET "/api/inbox/drops/$SDROP/secret" | jget value)" = "$SECRET" ] && fok "developer profile: the owner reads the secret on an explicit request" || fbad "developer profile: the owner reads the secret on an explicit request"
inbox sh -c "printf '%s' '$DROP' > /home/dispatch/proof/drop-id; printf '%s' '$FID' > /home/dispatch/proof/file-id; printf '%s' '$SDROP' > /home/dispatch/proof/secret-drop-id; chown 1000:1000 /home/dispatch/proof/*-id"

# Live tools: the system `erp` is not connected, so its server has the one tool `connect`. The person
# connects it on the platform while the thread runs; the platform signals the box.
if wait_file /home/dispatch/proof/live-dev.ready 45; then
  curl -s "http://127.0.0.1:$STUB_PORT/__ctl?connect=erp" >/dev/null
  api POST /api/os/connections/refresh >/dev/null
fi
wait_file /home/dispatch/proof/live-dev.done 60
L="$(pfile live-dev.json)"
[ "$(echo "$L" | jget steps.hasServer)" = true ] && [ "$(echo "$L" | jget steps.toolsBefore)" = '["connect"]' ] && fok "a system that is not connected has a server with the one tool: connect" "servers $(echo "$L" | jget steps.servers)" || fbad "a not-connected system has a server with the one tool: connect" "$(echo "$L" | jget steps.servers) $(echo "$L" | jget steps.toolsBefore) $(echo "$L" | jget steps.error | head -c 200)"
[ "$(echo "$L" | jget steps.listChangedDeclared)" = true ] && fok "its server declares tools.listChanged" "transport $(echo "$L" | jget steps.transport)" || fbad "its server declares tools.listChanged"
[ "$(echo "$L" | jget steps.streamOpened)" = true ] && [ "$(echo "$L" | jget steps.viaStream)" = true ] && fok "list_changed reaches the harness on the event stream after the person connects" || fbad "list_changed reaches the harness on the event stream" "opened $(echo "$L" | jget steps.streamOpened) got $(echo "$L" | jget steps.viaStream)"
[ "$(echo "$L" | jget steps.viaBridge)" = true ] && fok "list_changed reaches the harness through the stdio bridge too" || fbad "list_changed reaches the harness through the stdio bridge" "$(echo "$L" | jget steps.bridgeInit)"
[ "$(echo "$L" | jget steps.toolsAfter)" = '["get_order","list_orders"]' ] && [ "$(echo "$L" | jget steps.bridgeToolsAfter)" = '["get_order","list_orders"]' ] && fok "the same thread then lists the system's real tools" "$(echo "$L" | jget steps.toolsAfter)" || fbad "the same thread then lists the system's real tools" "$(echo "$L" | jget steps.toolsAfter) / $(echo "$L" | jget steps.bridgeToolsAfter)"
inbox rm -f /home/dispatch/proof/on-harness-start.sh

# The process table: nothing but init and the daemon is root.
STRAY="$(inbox ps -eo user=,pid=,args= | awk '$1!="dispatch"' | grep -v -E 'docker-init|dist/server.js|ps -eo' | head -5)"
[ -z "$STRAY" ] && fok "every process except init and the daemon runs as the agent user" "$(inbox ps -eo user= | sort | uniq -c | tr -s ' ' | tr '\n' ';')" || fbad "every process except init and the daemon runs as the agent user" "$STRAY"

echo
echo "################ B. attacks, run as a workload (a developer shell the daemon started)"
inbox sh -c "echo $SID > /home/dispatch/proof/sid; echo $TID > /home/dispatch/proof/tid; printf '%s' '$IN' > /home/dispatch/proof/leaked-inbound-token; chown 1000:1000 /home/dispatch/proof/sid /home/dispatch/proof/tid /home/dispatch/proof/leaked-inbound-token"
type_in "$SHID" "bash ~/proof/attack.sh $(sha "$IN") $(sha "$OUT") http://host.docker.internal:$STUB_PORT $(sha "$SECRET") developer > ~/proof/attack-dev.out 2>&1; echo done > ~/proof/attack-dev.done"
wait_file /home/dispatch/proof/attack-dev.done 240
inbox cat /home/dispatch/proof/attack-dev.out > "$WORK/attack-dev.out" 2>/dev/null
grep -E '^(==|FAIL|NOTE)' "$WORK/attack-dev.out" | sed "s/$IN/<inbound>/g"
A1="$(grep -c '^FAIL' "$WORK/attack-dev.out")"; P1="$(grep -c '^PASS' "$WORK/attack-dev.out")"
BC="$(bad_copies)"
[ -z "$BC" ] && fok "no copy the daemon kept holds a file the agent could not read" "$(copies) copies; race posts accepted/tried: $(pfile race-developer.count | tr -d '\n')" || fbad "no copy the daemon kept holds a file the agent could not read" "$BC"
api GET "/api/inbox/drops/$DROP" | grep -q "\"id\":\"$DROP\"" && fok "the other thread's drop is still there after the attacks" || fbad "the other thread's drop is still there after the attacks"

# The owner's own actions must not be redirected by a link a workload planted (the daemon is root:
# it makes every change below the home AS the agent, so a link leads only where the agent could go).
type_in "$SHID" 'ln -s /run/dispatch/agent/planted-dir ~/projects/evil; mkdir -p ~/projects/proj1 && ln -sfn /run/dispatch/agent ~/projects/proj1/redirect; echo ok > ~/proof-links.done'
wait_file /home/dispatch/proof-links.done 15
api POST /api/sessions '{"name":"evil"}' >/dev/null
api POST "/api/sessions/$SID/files/mkdir?path=redirect/planted-by-owner" >/dev/null
api PUT "/api/sessions/$SID/files/write?path=redirect/planted.json" '{"content":"{}"}' >/dev/null
PLANTED="$(inbox sh -c 'ls -d /run/dispatch/agent/planted-dir /run/dispatch/agent/planted-by-owner /run/dispatch/agent/planted.json 2>/dev/null' | tr '\n' ' ')"
[ -z "$PLANTED" ] && fok "a planted link cannot redirect the owner's project, folder or file creation" || fbad "a planted link cannot redirect the owner's actions" "$PLANTED"
type_in "$SHID" 'rm -f ~/projects/evil ~/projects/proj1/redirect'

echo
echo "################ C. the same attacks under the business profile, run by the harness process itself"
set_profile business
[ "$(apic POST "/api/sessions/$SID/terminals" '{"type":"shell"}')" = 403 ] && fok "business profile: the owner cannot open a shell" || fbad "business profile: the owner cannot open a shell" "HTTP $(apic POST "/api/sessions/$SID/terminals" '{"type":"shell"}')"
# The harness of a business chat thread first does an agent's work (the Inbox tool), then turns hostile.
hook biz 1 "node \"\$HOME/proof/agent-work.mjs\" inbox biz -- \"\$@\"; bash \"\$HOME/proof/attack.sh\" $(sha "$IN") $(sha "$OUT") http://host.docker.internal:$STUB_PORT $(sha "$SECRET") business > \"\$HOME/proof/attack-biz.out\" 2>&1; echo done > \"\$HOME/proof/attack-biz.done\""
BT="$(api POST "/api/sessions/$SID/terminals" '{"type":"claude-code","label":"business chat"}')"
BTID="$(echo "$BT" | jget id)"; sleep 2
api POST "/api/terminals/$BTID/message" '{"content":"business turn"}' >/dev/null
wait_file /home/dispatch/proof/inbox-biz.done 45
RB="$(pfile inbox-biz.json)"; BDROP="$(echo "$RB" | jget dropId)"; BFID="$(echo "$RB" | jget fileId)"
[ -n "$BDROP" ] && [ "$(echo "$RB" | jget steps.sendCsv.isError)" = false ] && fok "business profile: the agent sends a CSV file through the Inbox tool" "tool title: $(echo "$RB" | jget steps.tools | grep -o '"title":"[^"]*"' | head -1)" || fbad "business profile: the agent sends a CSV file through the Inbox tool" "$(echo "$RB" | jget steps.servers) $(echo "$RB" | jget steps.sendCsv.text | head -c 160) $(echo "$RB" | jget steps.error | head -c 160)"
api GET /api/inbox | grep -q "\"id\":\"$BDROP\"" && [ "$(api GET "/api/inbox/drops/$BDROP/files/$BFID")" = "$(printf 'region,units\nnorth,12\nsouth,30')" ] && fok "business profile: the owner route lists the drop and serves the file" || fbad "business profile: the owner route lists the drop and serves the file"
[ "$(echo "$RB" | jget steps.ownerRoutesAsThread)" = '{"list":403,"counts":403,"one drop":403,"mark read":403}' ] && [ "$(echo "$RB" | jget steps.fileRoutesAsThread)" = '{"inbox":403,"plugin":403}' ] && fok "business profile: the thread's own key gets 403 on the owner's routes and on the file" || fbad "business profile: the thread's own key gets 403 on the owner's routes" "$(echo "$RB" | jget steps.ownerRoutesAsThread) $(echo "$RB" | jget steps.fileRoutesAsThread)"
[ "$(apic GET "/api/inbox/drops/$SDROP/secret")" = 403 ] && fok "business profile: a secret drop's value is refused, to the owner too" || fbad "business profile: a secret drop's value is refused" "HTTP $(apic GET "/api/inbox/drops/$SDROP/secret")"
wait_file /home/dispatch/proof/attack-biz.done 240
inbox cat /home/dispatch/proof/attack-biz.out > "$WORK/attack-biz.out" 2>/dev/null
grep -E '^(==|FAIL|NOTE)' "$WORK/attack-biz.out" | sed "s/$IN/<inbound>/g"
A2="$(grep -c '^FAIL' "$WORK/attack-biz.out")"; P2="$(grep -c '^PASS' "$WORK/attack-biz.out")"
inbox rm -f /home/dispatch/proof/on-harness-start.sh
BC="$(bad_copies)"
[ -z "$BC" ] && fok "business profile: no copy the daemon kept holds a file the agent could not read" "$(copies) copies; race posts accepted/tried: $(pfile race-business.count | tr -d '\n')" || fbad "business profile: no copy holds a file the agent could not read" "$BC"
# What the platform saw: every accepted call carried the outbound token; the direct ones did not.
DIRECT_OK="$(grep -c '"tokenOk":true.*"tool":"crm_update_customer"' "$WORK/stub.log")"
[ "$DIRECT_OK" = 0 ] && fok "the platform accepted no tool call that skipped the daemon" "$(grep -c '"tokenOk":false' "$WORK/stub.log") refused" || fbad "the platform accepted no tool call that skipped the daemon" "$DIRECT_OK accepted"
set_profile developer

echo
echo "################ D. restart: threads, history and sign-in state survive"
# Before the restart a workload plants what a prompt-injected agent would: its own `claude` first on the
# PATH of every login shell of the person (plant-rc.sh).
type_in "$SHID" 'bash ~/proof/plant-rc.sh'
wait_file /home/dispatch/proof/plant-rc.done 15
docker restart "$NAME" >/dev/null
for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && break; sleep 1; done
api GET /api/host-context | grep -q '"privsep-v1"' && fok "after a restart the box proves the separation again" || fbad "after a restart the box proves the separation again"
api GET "/api/sessions/$SID/terminals" | grep -q "$TID" && fok "the thread is still listed" || fbad "the thread is still listed"
api GET "/api/terminals/$TID/journal" | grep -q 'echo:first turn' && fok "its history is still there" || fbad "its history is still there"
api POST "/api/terminals/$TID/message" '{"content":"second turn"}' >/dev/null; sleep 5
J="$(api GET "/api/terminals/$TID/journal")"
echo "$J" | grep -q 'echo:second turn' && fok "the thread resumes and answers a new turn" || fbad "the thread resumes and answers a new turn" "$(echo "$J" | tail -c 200)"
HP2="$(api GET "/api/terminals/$TID" | jget pid)"
# (Read as the agent user: root in the box has no right to read another user's environment either.)
HPATH="$(docker exec -u 1000 "$NAME" sh -c "tr '\0' '\n' < /proc/$HP2/environ 2>/dev/null | sed -n 's/^PATH=//p'")"
inbox test -e /home/dispatch/proof/plant-rc.done && ! inbox test -e /home/dispatch/proof/evil-ran.log && [ -n "$HPATH" ] && ! echo "$HPATH" | grep -q -e evil-bin -e /home/dispatch && fok "a program the agent put on the login PATH is not the harness of a later thread" "harness PATH: $(echo "$HPATH" | cut -c1-70)…" || fbad "a program the agent put on the login PATH is not the harness of a later thread" "PATH=$HPATH $(inbox cat /home/dispatch/proof/evil-ran.log 2>/dev/null | head -2 | tr '\n' ' ')"
! inbox grep -q DISPATCH_PATH_START /home/dispatch/proof/rc-runs.log 2>/dev/null && fok "the daemon's start ran no start file of the agent's home" || fbad "the daemon's start ran no start file of the agent's home" "$(inbox grep DISPATCH_PATH_START /home/dispatch/proof/rc-runs.log | head -1 | cut -c1-120)"
api GET "/api/inbox/drops/$DROP" | grep -q "\"id\":\"$DROP\"" && [ "$(api GET "/api/inbox/drops/$DROP/files/$FID")" = "$(printf 'region,units\nnorth,12\nsouth,30')" ] && fok "the Inbox drop and its file survived the restart" || fbad "the Inbox drop and its file survived the restart"
[ "$(inbox stat -c '%U %a' /home/dispatch/.claude/.credentials.json 2>/dev/null)" = "dispatch 600" ] && fok "the harness credential file survived, private to the agent" || fbad "the harness credential file survived" "$(inbox stat -c '%U %a' /home/dispatch/.claude/.credentials.json 2>&1)"
inbox test ! -e /home/dispatch/.dispatch/dispatch.db && inbox test -s /var/lib/dispatch/state/dispatch.db && fok "the database is in the state root, not in the home" || fbad "the database is in the state root, not in the home"

echo
echo "################ D2. the same image on the task definition the platform writes TODAY, and with one token value"
# The platform issues two token values and the new task definition only after a box is rebuilt on new
# platform code. Until then the image gets: no user (the image's own), one volume (the home), and ONE
# value in both token variables. It must start, as one user, and must not claim the separation.
docker rm -f "$NAME" >/dev/null 2>&1
PORT=$((BOX_PORT + 1))
compat() { # compat <label> <extra docker args...>: start, wait for the health call
  docker rm -f "$NAME-compat" >/dev/null 2>&1
  docker run -d --name "$NAME-compat" --platform linux/arm64 --init --read-only -p "127.0.0.1:$PORT:3456" \
    -v "$HERE/fake-claude:/opt/agents/.local/bin/claude:ro" \
    -e DISPATCH_BOX_TOKEN="$IN" -e OS_BOX_TOKEN="$IN" -e OS_BASE_URL="http://host.docker.internal:$STUB_PORT" \
    -e DISPATCH_OWNER_EMAIL=person@example.com -e DISPATCH_BOX_ID=proofbox -e DISPATCH_BASE_PATH="$BASE" -e DISPATCH_PROFILE=developer \
    "$@" "$IMAGE" >/dev/null || return 1
  for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && return 0; sleep 1; done
  return 1
}
if compat -v "$VH-compat:/home/dispatch"; then
  fok "old task definition, one token value: the box starts and answers" "$(docker logs "$NAME-compat" 2>&1 | grep -o 'box tokens: [A-Z]*' | tail -1)"
  CC="$(api GET /api/host-context | jget capabilities)"
  docker logs "$NAME-compat" 2>&1 | grep -q 'privilege separation is OFF' && ! echo "$CC" | grep -q privsep-v1 && echo "$CC" | grep -q gate-v2 && echo "$CC" | grep -q inbox-v1 && fok "it runs as one user and does not report privsep-v1" "$CC" || fbad "it runs as one user and does not report privsep-v1" "$CC"
  [ "$(docker exec "$NAME-compat" sh -c 'ps -o user= -p $(pgrep -f dist/server.js | head -1)' | tr -d ' ')" = dispatch ] && fok "its daemon runs as the agent user (no process is root)" || fbad "its daemon runs as the agent user"
  CSID="$(api POST /api/sessions '{"name":"compat"}' | jget id)"
  CTID="$(api POST "/api/sessions/$CSID/terminals" '{"type":"claude-code","label":"chat","config":{"transport":"structured"}}' | jget id)"; sleep 2
  api POST "/api/terminals/$CTID/message" '{"content":"compat turn"}' >/dev/null; sleep 4
  api GET "/api/terminals/$CTID/journal" | grep -q 'echo:compat turn' && [ "$(apic GET /api/inbox)" = 200 ] && fok "in that layout a chat thread answers a turn and the Inbox route answers" || fbad "in that layout a chat thread answers a turn" "inbox HTTP $(apic GET /api/inbox)"
  # One user: the daemon's FIRST environment block still names the tokens, and a workload of the same
  # user can read it (docs/hosted.md, "The two tokens"): a NOTE, because this layout is not the
  # protected one and the box does not claim it is. What must hold in EVERY layout: no process the
  # daemon started has a token in its own environment.
  ENVS="$(docker exec -u 1000 "$NAME-compat" sh -c 'd=$(pgrep -f dist/server.js | head -1); n=0; kids=0
    for f in /proc/[0-9]*/environ; do p=${f#/proc/}; p=${p%/environ}; [ "$p" = "$$" ] && continue
      tr "\0" "\n" < "$f" 2>/dev/null | grep -qE "^(DISPATCH_BOX_TOKEN|OS_BOX_TOKEN)=" || continue
      n=$((n+1)); [ "$(awk "{print \$4}" /proc/$p/stat 2>/dev/null)" = "$d" ] && kids=$((kids+1))
    done; echo "$n $kids $(ls -d /proc/[0-9]* | wc -l)"')"
  [ "$(echo "$ENVS" | cut -d' ' -f2)" = 0 ] && fok "in that layout too, no process the daemon started has a token in its environment" "$(echo "$ENVS" | cut -d' ' -f3) processes" || fbad "no process the daemon started has a token in its environment" "$ENVS"
  printf 'NOTE  %-62s %s\n' "one-user layout: a workload can read the first environment of the daemon" "blocks that name a token: $(echo "$ENVS" | cut -d' ' -f1) (init, the daemon; not protected, so privsep-v1 is not reported)"
else
  fbad "old task definition, one token value: the box starts" "$(docker logs "$NAME-compat" 2>&1 | tail -3 | tr '\n' ' ')"
fi
# shellcheck disable=SC2086
if compat --user 0 $PLATFORM_CAP_DROP -v "$VH-compat:/home/dispatch" -v "$VS-compat:/var/lib/dispatch/state"; then
  CC="$(api GET /api/host-context | jget capabilities)"
  docker logs "$NAME-compat" 2>&1 | grep -q 'privilege separation is ON' && docker logs "$NAME-compat" 2>&1 | grep -q 'box tokens: SHARED' && echo "$CC" | grep -q privsep-v1 && fok "new task definition, one token value: separated start, tokens through the pipe" "$(docker logs "$NAME-compat" 2>&1 | grep -o 'box tokens: [A-Z]*' | tail -1)" || fbad "new task definition, one token value: separated start" "$CC $(docker logs "$NAME-compat" 2>&1 | grep 'box tokens' | tail -1)"
  # As the agent user (a process that `docker exec` makes has the container's own environment, so the
  # check leaves its own shell out): no environment block that user can read names a token.
  SEEN="$(docker exec -u 1000 "$NAME-compat" sh -c 'n=0; for f in /proc/[0-9]*/environ; do p=${f#/proc/}; p=${p%/environ}; [ "$p" = "$$" ] && continue; tr "\0" "\n" < "$f" 2>/dev/null | grep -qE "^(DISPATCH_BOX_TOKEN|OS_BOX_TOKEN)=" && n=$((n+1)); done; echo $n')"
  [ "$SEEN" = 0 ] && fok "in that start no environment the agent user can read names a token" "init and the daemon are root" || fbad "in that start no environment the agent user can read names a token" "$SEEN readable blocks name one"
else
  fbad "new task definition, one token value: the box starts" "$(docker logs "$NAME-compat" 2>&1 | tail -3 | tr '\n' ' ')"
fi
docker rm -f "$NAME-compat" >/dev/null 2>&1
PORT="$BOX_PORT"

echo
echo "################ D3. a second harness with the bypass flags, started by a workload (the image's REAL programs)"
# The boxes above run a stand-in in the place of the Claude Code program. This one has no stand-in:
# the task definition of the platform, a developer's shell, and in it the harness programs of the image.
PORT=$((BOX_PORT + 1)); BOX="$NAME-compat"
docker rm -f "$BOX" >/dev/null 2>&1; docker volume rm -f "$VH-compat" "$VS-compat" >/dev/null 2>&1
# shellcheck disable=SC2086
docker run -d --name "$BOX" --platform linux/arm64 --init --user 0 --read-only $PLATFORM_CAP_DROP -p "127.0.0.1:$PORT:3456" \
  -v "$VH-compat:/home/dispatch" -v "$VS-compat:/var/lib/dispatch/state" \
  -e DISPATCH_BOX_TOKEN="$IN" -e OS_BOX_TOKEN="$OUT" -e OS_BASE_URL="http://host.docker.internal:$STUB_PORT" \
  -e DISPATCH_OWNER_EMAIL=person@example.com -e DISPATCH_BOX_ID=proofbox -e DISPATCH_BASE_PATH="$BASE" -e DISPATCH_PROFILE=developer \
  "$IMAGE" >/dev/null
for _ in $(seq 1 60); do [ "$(apic GET /api/host-context)" = 200 ] && break; sleep 1; done
A3=0; P3=0
if api GET /api/host-context | grep -q '"privsep-v1"'; then
  fok "the box with the real harness programs starts and proves the separation" "$(api GET /api/providers | grep -o '"name":"[a-z-]*","installed":true[^}]*"version":"[^"]*"' | tr '\n' ' ' | cut -c1-110)"
  NSID="$(api POST /api/sessions '{"name":"nested"}' | jget id)"
  NSH="$(api POST "/api/sessions/$NSID/terminals" '{"type":"shell","label":"dev"}' | jget id)"
  sleep 2
  inbox mkdir -p /home/dispatch/proof; inbox chown 1000:1000 /home/dispatch/proof
  copy_in "$HERE/nested-harness.sh" nested-harness.sh
  type_in "$NSH" 'bash ~/proof/nested-harness.sh > ~/proof/nested.out 2>&1; echo done > ~/proof/nested.done'
  wait_file /home/dispatch/proof/nested.done 200
  inbox cat /home/dispatch/proof/nested.out > "$WORK/nested.out" 2>/dev/null
  grep -E '^(==|PASS|FAIL|NOTE)' "$WORK/nested.out"
  A3="$(grep -c '^FAIL' "$WORK/nested.out")"; P3="$(grep -c '^PASS' "$WORK/nested.out")"
  grep -q '^== nested result' "$WORK/nested.out" && fok "the nested harness rows ran to the end" || fbad "the nested harness rows ran to the end" "$(tail -1 "$WORK/nested.out" | cut -c1-160)"
else
  fbad "the box with the real harness programs starts and proves the separation" "$(docker logs "$BOX" 2>&1 | tail -3 | tr '\n' ' ')"
fi
docker rm -f "$BOX" >/dev/null 2>&1
PORT="$BOX_PORT"; BOX=""

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
echo "a nested harness, real programs: ${P3:-0} stopped, ${A3:-0} NOT stopped (a row with no verdict is a NOTE above)"
cp "$WORK/attack-dev.out" "${PROOF_OUT:-/dev/null}.dev" 2>/dev/null; cp "$WORK/attack-biz.out" "${PROOF_OUT:-/dev/null}.biz" 2>/dev/null; cp "$WORK/nested.out" "${PROOF_OUT:-/dev/null}.nested" 2>/dev/null
[ "$ffail" = 0 ] && [ "$A1" = 0 ] && [ "$A2" = 0 ] && [ "${A3:-0}" = 0 ] && [ "${P1:-0}" -gt 0 ] && [ "${P2:-0}" -gt 0 ]
