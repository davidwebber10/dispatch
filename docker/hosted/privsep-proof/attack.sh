#!/bin/bash
# The attack list of the privilege-separation proof (docs/hosted-privilege-separation.md, section 13).
#
# It must run AS A WORKLOAD: a descendant of the daemon (a thread's process or a shell thread), not
# through `docker exec` (that makes a process the daemon never started, with the container's own
# environment). Every attempt below must FAIL for the box to be sound; the script prints one line
# per attempt and a final count. It changes nothing when the box is sound.
#
#   attack.sh <sha256 of the inbound token> <sha256 of the outbound token> <platform base url> [<sha256 of a secret drop's value> [<profile>]]
#
# The hashes let the script hunt for the token VALUES without being given them. When the file
# $HOME/proof/leaked-inbound-token exists, it holds the real inbound token, handed over on purpose
# to prove that even a leaked owner credential is refused from inside the box (the hunt skips that
# one folder). The fourth hash is of the value an agent put in a `secret` Inbox drop; the profile
# (`business` or `developer`) is the one the box runs under.
IN_SHA="${1:-}"; OUT_SHA="${2:-}"; PLATFORM="${3:-}"; SECRET_SHA="${4:-}"; PROFILE="${5:-developer}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LEAKED="$(cat "$HOME/proof/leaked-inbound-token" 2>/dev/null)"
pass=0; fail=0; note=0
ok()   { printf 'PASS  %-58s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %-58s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
info() { printf 'NOTE  %-58s %s\n' "$1" "${2:-}"; note=$((note+1)); }
# must_fail <name> <command...>: PASS when the command fails.
must_fail() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$n" "succeeded"; else ok "$n"; fi; }

D="$(pgrep -u 0 -f 'packages/core/dist/server.js' | head -1)"
API="${DISPATCH_API:-${DISPATCH_SERVER_URL:-http://127.0.0.1:3456}}"
API="${API%/}"
STATE=/var/lib/dispatch/state; GATE=/var/lib/dispatch; RUN=/run/dispatch/agent
echo "== who am I: $(id) | daemon pid: ${D:-?} | api: $API"

echo "== 1. identity of a workload"
[ "$(id -u)" != 0 ] && ok "runs as a user that is not root" "uid $(id -u)" || bad "runs as a user that is not root"
[ "$(sed -n 's/^NoNewPrivs:[[:space:]]*//p' /proc/self/status)" = 1 ] && ok "no_new_privs is set" || bad "no_new_privs is set"
for c in CapPrm CapEff CapAmb; do
  [ "$(sed -n "s/^$c:[[:space:]]*//p" /proc/self/status)" = 0000000000000000 ] && ok "$c is empty" || bad "$c is empty"
done
[ -z "$(find / -xdev -type f -perm /6000 2>/dev/null | head -1)" ] && ok "no set-uid or set-gid program in the image" || bad "no set-uid or set-gid program in the image" "$(find / -xdev -type f -perm /6000 2>/dev/null | head -3 | tr '\n' ' ')"
must_fail "become root with su" sh -c 'su -s /bin/sh -c "id -u" root </dev/null | grep -qx 0'
must_fail "become root with setpriv" setpriv --reuid=0 --clear-groups true
# A user namespace of its own is NOT harmless: in it a workload mounts an empty folder over
# /etc/claude-code, and a nested harness then runs with no managed policy at all. So a namespace that
# can be made is a failure. The runtime's default seccomp filter refuses it (the proof starts the box
# with that filter, as the platform does); the daemon's start-up self-check measures it on each start
# and reports no privsep-v1 when one can be made.
must_fail "make an unprivileged user namespace" unshare -Ur true
must_fail "hide the managed policy with a mount in an own namespace" unshare -Urm sh -c 'mount -t tmpfs none /etc/claude-code && [ ! -e /etc/claude-code/managed-settings.json ]'
if unshare -Ur true 2>/dev/null; then
  must_fail "read the state root from a user namespace" unshare -Ur cat /var/lib/dispatch/state/dispatch.db
  must_fail "read the daemon's environment from a user namespace" unshare -Ur cat "/proc/$D/environ"
  must_fail "signal the daemon from a user namespace" unshare -Ur kill -0 "$D"
fi

echo "== 2. the two tokens"
names='DISPATCH_BOX_TOKEN|OS_BOX_TOKEN|DISPATCH_SECRETS_FD|AWS_CONTAINER_CREDENTIALS_RELATIVE_URI|AWS_CONTAINER_CREDENTIALS_FULL_URI|ECS_CONTAINER_METADATA_URI'
if env | grep -qE "^($names)"; then bad "own environment holds no token or credential locator" "$(env | grep -oE "^($names)[A-Z_0-9]*" | tr '\n' ' ')"; else ok "own environment holds no token or credential locator"; fi
readable=0; hit=""
for f in /proc/[0-9]*/environ; do
  if [ -r "$f" ]; then readable=$((readable+1)); tr '\0' '\n' < "$f" 2>/dev/null | grep -qE "^($names)" && hit="$hit $f"; fi
done
[ -z "$hit" ] && ok "no readable /proc/*/environ names a token" "$readable readable" || bad "no readable /proc/*/environ names a token" "$hit"
must_fail "read the daemon's environment" cat "/proc/$D/environ"
must_fail "read the init process's environment" cat /proc/1/environ
must_fail "read the daemon's memory" head -c 1 "/proc/$D/mem"
must_fail "list the daemon's open files" ls "/proc/$D/fd"
must_fail "enter the daemon's working directory" ls "/proc/$D/cwd/"
must_fail "enter the daemon's root" ls "/proc/$D/root/"
must_fail "read the daemon's memory map" cat "/proc/$D/maps"
# Hunt for the VALUES: every token-shaped string in every place this user can read, hashed.
if [ -n "$IN_SHA" ] && [ -n "$OUT_SHA" ]; then
  found=""
  cands="$( { cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | tr '\0' '\n'; env; grep -rhoaIE --exclude-dir=proof '[A-Za-z0-9_+/=-]{32,200}' /run /var/lib /var/log /etc /tmp /dev/shm "$HOME" 2>/dev/null; } | grep -oaE '[A-Za-z0-9_+/=-]{32,200}' | sort -u )"
  n=0
  while IFS= read -r c; do
    [ -z "$c" ] && continue; n=$((n+1))
    h="$(printf '%s' "$c" | sha256sum | cut -d' ' -f1)"
    [ "$h" = "$IN_SHA" ] && found="$found inbound"
    [ "$h" = "$OUT_SHA" ] && found="$found outbound"
  done <<< "$cands"
  [ -z "$found" ] && ok "neither token value is in any readable file, environment or command line" "$n candidates hashed" || bad "neither token value is in any readable place" "$found"
fi

echo "== 3. the daemon's state"
must_fail "list the parent of the state root" ls "$GATE"
must_fail "list the state root" ls "$STATE"
must_fail "read the database" cat "$STATE/dispatch.db"
must_fail "write the database" sh -c ": >> $STATE/dispatch.db"
must_fail "create a file in the state root" sh -c ": > $STATE/x"
must_fail "read the accounts file" cat "$STATE/accounts.json"
must_fail "read the daemon's log folder" ls "$STATE/logs"
must_fail "replace the state root (rename the parent)" mv "$GATE" /tmp/gate-moved
must_fail "find the old data directory's database in the home" test -e "$HOME/.dispatch/dispatch.db"
must_fail "find an owner token file in the home" test -e "$HOME/.dispatch/access-token"
[ "$(cat /proc/sys/fs/protected_symlinks 2>/dev/null)" = 1 ] && ok "links in shared temp folders are not followed for other users" || info "fs.protected_symlinks is not 1" "the daemon's temp files rely on its own folders only"

echo "== 4. files the daemon writes for workloads (must stay read-only)"
must_fail "create a file in the agent run dir" sh -c ": > $RUN/x"
for d in mcp hooks keys prompts shim; do
  [ -d "$RUN/$d" ] || continue
  must_fail "create a file in $d/" sh -c ": > $RUN/$d/x"
  f="$(find "$RUN/$d" -type f 2>/dev/null | head -1)"
  [ -n "$f" ] && must_fail "overwrite a file in $d/" sh -c "echo x >> '$f'"
  [ -n "$f" ] && must_fail "change the mode of a file in $d/" chmod 666 "$f"
  [ -n "$f" ] && must_fail "delete a file in $d/" rm -f "$f"
done
must_fail "replace the mcp folder" mv "$RUN/mcp" "$RUN/mcp2"
must_fail "write the harness managed policy" sh -c ": >> /etc/claude-code/managed-settings.json"
must_fail "create a managed policy drop-in" sh -c ": > /etc/claude-code/x.json"
must_fail "change the daemon's code" sh -c ": >> /app/packages/core/dist/server.js"
must_fail "change the entrypoint" sh -c ": >> /usr/local/bin/entrypoint.sh"
must_fail "put a program earlier on the system path" sh -c ": > /usr/local/bin/git"

echo "== 4b. the managed policy files and the harness programs (the image's, root-owned)"
for f in /etc/claude-code/managed-settings.json /etc/codex/requirements.toml; do
  [ -e "$f" ] || { info "$f is not in this image" "the developer image has no Codex policy"; continue; }
  own="$(stat -c '%U:%G %a' "$f" 2>/dev/null)"
  case "$own" in root:root\ 644|root:root\ 444) ok "$f belongs to root, others may only read" "$own" ;; *) bad "$f belongs to root, others may only read" "$own" ;; esac
  must_fail "overwrite $f" sh -c "echo '{}' > $f"
  must_fail "delete $f" rm -f "$f"
  must_fail "rename $f away" mv "$f" "/tmp/moved-policy.$$"
  must_fail "change the mode of $f" chmod 666 "$f"
  must_fail "replace $f with a link" ln -sf /tmp/own-policy "$f"
  d="$(dirname "$f")"
  must_fail "create a file beside $f" sh -c ": > $d/extra.$$"
  must_fail "rename the folder of $f away" mv "$d" "/tmp/moved-dir.$$"
done
must_fail "create the managed folder of the third harness" mkdir -p /etc/opencode
for b in /usr/local/bin/claude /usr/local/bin/codex /usr/local/bin/opencode /usr/local/bin/mcp-remote /usr/local/bin/node \
         /opt/agents/.local/bin/claude /opt/agent-clis/node_modules/.bin/codex /opt/agent-clis/node_modules/.bin/opencode; do
  [ -e "$b" ] || continue
  must_fail "append to the program $b" sh -c ": >> $b"
  must_fail "delete the program $b" rm -f "$b"
  must_fail "put another program in the place of $b" sh -c "printf '#!/bin/sh\n' > $b.new.$$ && mv -f $b.new.$$ $b"
done
for v in /opt/agents/.local/share/claude/versions/*; do
  [ -e "$v" ] || continue
  must_fail "append to the Claude Code binary" sh -c ": >> '$v'"
  must_fail "replace the Claude Code binary" cp -f /bin/true "$v"
done
must_fail "add a version beside the Claude Code binary" sh -c ": > /opt/agents/.local/share/claude/versions/9.9.9"
# The PATH a harness process got from the daemon: no folder in it may be the agent's to write, or a
# program planted there would be the `claude` or the `git` of every later thread.
HPID="$(pgrep -u "$(id -u)" -f 'fake-claude.mjs|/claude ' | head -1)"
HPATH="$(tr '\0' '\n' < "/proc/${HPID:-self}/environ" 2>/dev/null | sed -n 's/^PATH=//p' | head -1)"
if [ -n "$HPID" ] && [ -n "$HPATH" ]; then
  writable=""
  IFS=':' read -r -a parts <<< "$HPATH"
  for d in "${parts[@]}"; do
    [ -z "$d" ] && { writable="$writable (empty entry)"; continue; }
    if [ -w "$d" ] || { [ ! -e "$d" ] && mkdir -p "$d" 2>/dev/null && rmdir "$d" 2>/dev/null; }; then writable="$writable $d"; fi
    case "$d" in "$HOME"|"$HOME"/*|/tmp|/tmp/*) writable="$writable $d" ;; esac
  done
  [ -z "$writable" ] && ok "no folder on a harness's PATH can be written by the agent" "${#parts[@]} entries, pid $HPID" || bad "no folder on a harness's PATH can be written by the agent" "$writable"
else
  info "no harness process to read a PATH from" "the PATH row did not run"
fi

echo "== 5. signals and debugging"
must_fail "signal the daemon (0)" kill -0 "$D"
must_fail "stop the daemon (STOP)" kill -STOP "$D"
must_fail "terminate the daemon (TERM)" kill -TERM "$D"
must_fail "signal the init process" kill -TERM 1
if command -v python3 >/dev/null 2>&1; then
py() { python3 - "$@" 2>/dev/null; }
must_fail "attach a debugger to the daemon (ptrace)" py "$D" <<'PY'
import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
r = libc.ptrace(16, int(sys.argv[1]), 0, 0)  # PTRACE_ATTACH
if r == 0: libc.ptrace(17, int(sys.argv[1]), 0, 0)
sys.exit(0 if r == 0 else 1)
PY
must_fail "read the daemon's memory (process_vm_readv)" py "$D" <<'PY'
import ctypes, sys, platform
libc = ctypes.CDLL(None, use_errno=True)
class iovec(ctypes.Structure): _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
buf = ctypes.create_string_buffer(64)
local = iovec(ctypes.cast(buf, ctypes.c_void_p), 64); remote = iovec(0x400000, 64)
nr = 270 if platform.machine() in ("aarch64", "arm64") else 310
r = libc.syscall(nr, int(sys.argv[1]), ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
# EPERM (1) is the refusal; EFAULT (14) would mean the kernel let us try.
sys.exit(1 if (r < 0 and ctypes.get_errno() == 1) else 0)
PY
else
  info "no interpreter in this image can call ptrace" "the kernel rule is the same one that hides /proc/<pid>/mem (tested above)"
fi

echo "== 6. the daemon's API from inside the box"
SID="$(cat "$HOME/proof/sid" 2>/dev/null)"; TID="$(cat "$HOME/proof/tid" 2>/dev/null)"
# One HTTP request with node (the image has no curl): prints the status code. 000: no answer.
REQ_JS='const [m,u,b,...h]=process.argv.slice(1);const headers={};for(const x of h){const i=x.indexOf(":");headers[x.slice(0,i).trim()]=x.slice(i+1).trim()}if(b)headers["content-type"]="application/json";const url=new URL(u);const r=require("http").request({host:url.hostname.replace(/^\[|\]$/g,""),port:url.port||80,path:url.pathname+url.search,method:m,headers,timeout:8000},res=>{res.resume();res.on("end",()=>process.stdout.write(String(res.statusCode)))});r.on("upgrade",(res,sock)=>{process.stdout.write(String(res.statusCode));sock.destroy()});r.on("timeout",()=>{r.destroy()});r.on("error",()=>process.stdout.write("000"));if(b)r.write(b);r.end()'
BODY_JS='const [u,...h]=process.argv.slice(1);const headers={};for(const x of h){const i=x.indexOf(":");headers[x.slice(0,i).trim()]=x.slice(i+1).trim()}fetch(u,{headers,signal:AbortSignal.timeout(8000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})'
code() { # code <method> <path> <body> <header>...   (against $TARGET)
  local m="$1" p="$2" b="$3"; shift 3
  node -e "$REQ_JS" "$m" "$TARGET$p" "$b" "$@" 2>/dev/null
}
refused() { case "$1" in 401|403|404|405) return 0 ;; *) return 1 ;; esac; }
OWNER_ROWS=(
  "GET|/api/sessions||list projects"
  "POST|/api/sessions/$SID/terminals|{\"type\":\"shell\"}|create a shell thread"
  "POST|/api/sessions/$SID/terminals|{\"type\":\"claude-code\",\"config\":{\"approvals\":\"auto\"}}|create a thread with approvals off"
  "POST|/api/terminals/$TID/approvals|{\"mode\":\"auto\"}|change a thread's approval mode"
  "POST|/api/terminals/$TID/autonomy|{\"level\":\"autonomous\"}|change a thread's autonomy"
  "POST|/api/terminals/$TID/permission|{\"decision\":\"allow\",\"requestId\":\"req-1\"}|allow a held action"
  "POST|/api/terminals/$TID/input|{\"data\":\"id\\r\"}|type into a terminal"
  "POST|/api/terminals/$TID/message|{\"content\":\"do it\",\"source\":\"user\"}|send a message as the owner"
  "POST|/api/terminals/$TID/transport|{\"transport\":\"pty\"}|switch a thread to a terminal"
  "PATCH|/api/terminals/$TID|{\"config\":{\"approvals\":\"auto\"}}|replace a thread's config"
  "GET|/api/integrations/export||export integrations"
  "GET|/api/os/connections||read the company connections state"
  "POST|/api/os/connections/refresh||refresh the company connections"
  "GET|/api/secrets/status||read the secrets status"
  "POST|/api/plugins/install|{\"url\":\"https://example.com/x\"}|install a plugin"
  "GET|/api/sessions/$SID/files/read?path=/proc/self/environ||read a file through the daemon"
  "GET|/api/access/no-credential-stats||read the access counters"
)
owner_calls() { # owner_calls <label> <header>...
  local label="$1"; shift
  local r m p b what c
  for r in "${OWNER_ROWS[@]}"; do
    IFS='|' read -r m p b what <<< "$r"
    c="$(code "$m" "$p" "$b" "$@")"
    if refused "$c"; then ok "$label: $what" "HTTP $c"; else bad "$label: $what" "HTTP $c"; fi
  done
}
upgrade() { node -e "$REQ_JS" GET "$TARGET/api/terminals/$TID/ws" "" "Connection: Upgrade" "Upgrade: websocket" "Sec-WebSocket-Version: 13" "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$@" 2>/dev/null; }
OWN_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
PORT="$(printf '%s' "$API" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"; PORT="${PORT:-3456}"
BASE="$(printf '%s' "$API" | sed -E 's#^https?://[^/]+##')"
for host in 127.0.0.1 "[::1]" "$OWN_IP"; do
  [ -z "$host" ] && continue
  TARGET="http://$host:$PORT$BASE"
  owner_calls "no credential @ $host"
  owner_calls "wrong box token @ $host" "x-dispatch-box-token: not-the-token"
  if [ -n "$LEAKED" ]; then
    owner_calls "LEAKED inbound token @ $host" "x-dispatch-box-token: $LEAKED"
    owner_calls "LEAKED token as bearer @ $host" "Authorization: Bearer $LEAKED"
    c="$(upgrade "x-dispatch-box-token: $LEAKED")"
    case "$c" in 401|403) ok "LEAKED inbound token @ $host: open a terminal socket" "HTTP $c" ;; *) bad "LEAKED inbound token @ $host: open a terminal socket" "HTTP $c" ;; esac
  fi
done
TARGET="$API"
# Every key this user can obtain: its own, those of other workload processes, key files.
keys="$( { echo "${DISPATCH_AUTH:-}"; cat /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' | sed -n 's/^DISPATCH_AUTH=//p'; cat "$RUN"/keys/* 2>/dev/null; grep -rhoE 'd[tcsp]k_[A-Za-z0-9_-]{43}' "$RUN" "$HOME/.dispatch" 2>/dev/null; } | grep -oE 'd[tcsp]k_[A-Za-z0-9_-]{43}' | sort -u)"
nk=0
KEY_ROWS=("${OWNER_ROWS[@]:1:11}" "POST|/api/plugins/install|{\"url\":\"https://example.com/x\"}|install a plugin" "POST|/api/access/login|{\"token\":\"x\"}|sign in as the owner" "GET|/api/access/no-credential-stats||read the access counters")
for k in $keys; do
  kind="$(node -e "$BODY_JS" "$TARGET/api/whoami" "Authorization: Bearer $k" | grep -oE '"kind":"[a-z]+"' | head -1 | cut -d'"' -f4)"
  [ -z "$kind" ] && continue
  nk=$((nk+1))
  for r in "${KEY_ROWS[@]}"; do
    IFS='|' read -r m p b what <<< "$r"
    c="$(code "$m" "$p" "$b" "Authorization: Bearer $k")"
    if refused "$c"; then ok "$kind key #$nk: $what" "HTTP $c"; else bad "$kind key #$nk: $what" "HTTP $c"; fi
  done
  c="$(upgrade "Authorization: Bearer $k")"
  case "$c" in 400|401|403|404) ok "$kind key #$nk: open a terminal socket" "HTTP $c" ;; *) bad "$kind key #$nk: open a terminal socket" "HTTP $c" ;; esac
done
[ "$nk" -gt 0 ] && info "live keys this user could collect and use" "$nk" || info "no live key could be collected" "the key rows did not run"

echo "== 7. the platform, directly (skipping the daemon)"
if [ -n "$PLATFORM" ]; then
  CALL='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crm_update_customer","arguments":{}}}'
  gw() { node -e "$REQ_JS" POST "$PLATFORM/api/dispatch/mcp" "$CALL" "x-dispatch-owner: person@example.com" "$@" 2>/dev/null; }
  c="$(gw)"; [ "$c" = 401 ] && ok "tool gateway with no token" "HTTP $c" || bad "tool gateway with no token" "HTTP $c"
  for k in $keys; do c="$(gw "x-dispatch-box-token: $k")"; [ "$c" = 401 ] && ok "tool gateway with a collected key as the token" "HTTP $c" || bad "tool gateway with a collected key as the token" "HTTP $c"; break; done
  if [ -n "$LEAKED" ]; then c="$(gw "x-dispatch-box-token: $LEAKED")"; [ "$c" = 401 ] && ok "tool gateway with the LEAKED inbound token (it is not the outbound one)" "HTTP $c" || bad "tool gateway with the LEAKED inbound token" "HTTP $c"; fi
  c="$(node -e "$REQ_JS" GET "$PLATFORM/api/dispatch/connections" "" "x-dispatch-owner: person@example.com" 2>/dev/null)"; [ "$c" = 401 ] && ok "connections broker with no token" "HTTP $c" || bad "connections broker with no token" "HTTP $c"
fi

echo "== 8. persistence with MORE rights"
must_fail "plant a role definition the daemon would run" sh -c "mkdir -p $STATE/roles && : > $STATE/roles/x.md"
must_fail "plant a plugin the daemon would load" sh -c "mkdir -p $STATE/plugins/x"
must_fail "edit a thread's hook settings" sh -c "f=\$(ls $RUN/hooks/*.json 2>/dev/null | head -1); [ -n \"\$f\" ] && echo x >> \"\$f\""
must_fail "edit a thread's MCP config" sh -c "f=\$(ls $RUN/mcp/*.json 2>/dev/null | head -1); [ -n \"\$f\" ] && echo x >> \"\$f\""
must_fail "edit the managed policy of the other harness" sh -c ": >> /etc/codex/requirements.toml"
# A link in the project that points into the state root must not make the daemon read it for us.
mkdir -p "$HOME/projects/proj1" 2>/dev/null; ln -sfn "$STATE/dispatch.db" "$HOME/projects/proj1/innocent.txt" 2>/dev/null
for k in $keys; do
  c="$(code GET "/api/sessions/$SID/files/read?path=innocent.txt" "" "Authorization: Bearer $k")"
  if refused "$c"; then ok "make the daemon read its database through a link in the project" "HTTP $c"; else bad "make the daemon read its database through a link in the project" "HTTP $c"; fi
  break
done
rm -f "$HOME/projects/proj1/innocent.txt" 2>/dev/null

# Sections 10 to 14: the routes and features added after the first proof (attack-routes.mjs).
if [ -f "$HERE/attack-routes.mjs" ]; then
  routes_out="$(A_PORT="$PORT" A_BASE="$BASE" A_HOSTS="127.0.0.1 [::1] $OWN_IP" A_KEYS="$keys" A_LEAKED="$LEAKED" A_PROFILE="$PROFILE" A_SID="$SID" \
    A_IN_SHA="$IN_SHA" A_OUT_SHA="$OUT_SHA" A_SECRET_SHA="$SECRET_SHA" node "$HERE/attack-routes.mjs" 2>&1)"
  printf '%s\n' "$routes_out"
  pass=$((pass + $(printf '%s\n' "$routes_out" | grep -c '^PASS')))
  fail=$((fail + $(printf '%s\n' "$routes_out" | grep -c '^FAIL')))
  note=$((note + $(printf '%s\n' "$routes_out" | grep -c '^NOTE')))
  printf '%s\n' "$routes_out" | grep -q '^== routes result' || bad "the route attacks ran to the end" "$(printf '%s\n' "$routes_out" | tail -1 | cut -c1-160)"
else
  bad "the route attacks ran" "attack-routes.mjs is not beside attack.sh"
fi

echo "== 9. stated, not protected (see section 12 of the design)"
if echo '{}' > "$HOME/.claude-proof-setting" 2>/dev/null; then info "a workload can write harness files in the home" "accepted: same user, same rights, never the daemon's"; rm -f "$HOME/.claude-proof-setting"; fi
# A second harness started from a shell: the managed policy decides whether it may skip approvals.
# The policy file is the image's (the harness-policy work); what is proven here is that it says so
# and that a workload cannot change it. The harness's own refusal needs a sign-in, which the proof
# does not have, so it is not observed.
MP=/etc/claude-code/managed-settings.json
if grep -q '"disableBypassPermissionsMode"' "$MP" 2>/dev/null; then
  ok "the managed policy turns the approval bypass off, and it is read-only" "$(stat -c '%U %a' "$MP")"
else
  info "this image's managed policy does not turn the approval bypass off" "a nested harness gains no daemon or platform right; see the harness policy"
fi
# A nested harness with each bypass flag (nested-harness.sh): the REAL binaries of the image, started
# by a workload. In the main proof box the Claude Code program is a stand-in, so those rows are notes
# there; run-proof.sh runs the same file in a box that has the real program.
if [ -f "$HERE/nested-harness.sh" ]; then
  nested_out="$(bash "$HERE/nested-harness.sh" 2>&1)"
  printf '%s\n' "$nested_out"
  pass=$((pass + $(printf '%s\n' "$nested_out" | grep -c '^PASS')))
  fail=$((fail + $(printf '%s\n' "$nested_out" | grep -c '^FAIL')))
  note=$((note + $(printf '%s\n' "$nested_out" | grep -c '^NOTE')))
fi
info "another AI account's credential" "not isolated by design (one person, one agent user)"

echo "== result: $pass passed, $fail FAILED, $note notes"
[ "$fail" -eq 0 ]
