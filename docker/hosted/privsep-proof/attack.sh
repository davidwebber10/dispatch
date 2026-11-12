#!/bin/bash
# The attack list of the privilege-separation proof (docs/hosted-privilege-separation.md, section 13).
#
# It must run AS A WORKLOAD: a descendant of the daemon (a thread's process or a shell thread), not
# through `docker exec` (that makes a process the daemon never started, with the container's own
# environment). Every attempt below must FAIL for the box to be sound; the script prints one line
# per attempt and a final count. It changes nothing when the box is sound.
#
#   attack.sh <sha256 of the inbound token> <sha256 of the outbound token> <platform base url>
#
# The hashes let the script hunt for the token VALUES without being given them. When the file
# $HOME/proof/leaked-inbound-token exists, it holds the real inbound token, handed over on purpose
# to prove that even a leaked owner credential is refused from inside the box (the hunt skips that
# one folder).
IN_SHA="${1:-}"; OUT_SHA="${2:-}"; PLATFORM="${3:-}"
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
# A user namespace of its own gives a workload no right over the daemon or its files. Whether one
# can be made at all depends on the platform's seccomp filter, so that is a note, not a verdict.
if unshare -Ur true 2>/dev/null; then
  info "an unprivileged user namespace can be created here" "checked below: it opens nothing"
  must_fail "read the state root from a user namespace" unshare -Ur cat /var/lib/dispatch/state/dispatch.db
  must_fail "read the daemon's environment from a user namespace" unshare -Ur cat "/proc/$D/environ"
  must_fail "signal the daemon from a user namespace" unshare -Ur kill -0 "$D"
  must_fail "write the managed policy from a user namespace" unshare -Ur sh -c ': >> /etc/claude-code/managed-settings.json'
else
  ok "an unprivileged user namespace cannot be created"
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

echo "== 5. signals and debugging"
must_fail "signal the daemon (0)" kill -0 "$D"
must_fail "stop the daemon (STOP)" kill -STOP "$D"
must_fail "terminate the daemon (TERM)" kill -TERM "$D"
must_fail "signal the init process" kill -TERM 1
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
maps_ok = False
local = iovec(ctypes.cast(buf, ctypes.c_void_p), 64); remote = iovec(0x400000, 64)
nr = 270 if platform.machine() in ("aarch64", "arm64") else 310
r = libc.syscall(nr, int(sys.argv[1]), ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
# EPERM (1) is the refusal; EFAULT (14) would mean the kernel let us try.
sys.exit(1 if (r < 0 and ctypes.get_errno() == 1) else 0)
PY

echo "== 6. the daemon's API from inside the box"
SID="$(cat "$HOME/proof/sid" 2>/dev/null)"; TID="$(cat "$HOME/proof/tid" 2>/dev/null)"
code() { # code <method> <path> <body> <curl auth args...>
  local m="$1" p="$2" b="$3"; shift 3
  curl -s -o /dev/null -w '%{http_code}' -m 8 -X "$m" ${b:+-H 'content-type: application/json' -d "$b"} "$@" "$TARGET$p" 2>/dev/null
}
owner_calls() { # owner_calls <label> <curl auth args...>
  local label="$1"; shift
  local rows=(
    "GET|/api/sessions||list projects"
    "POST|/api/sessions/$SID/terminals|{\"type\":\"shell\"}|create a shell thread"
    "POST|/api/sessions/$SID/terminals|{\"type\":\"claude-code\",\"config\":{\"approvals\":\"auto\"}}|create a thread with approvals off"
    "POST|/api/terminals/$TID/approvals|{\"mode\":\"auto\"}|change a thread's approval mode"
    "POST|/api/terminals/$TID/autonomy|{\"level\":\"autonomous\"}|change a thread's autonomy"
    "POST|/api/terminals/$TID/permission|{\"decision\":\"allow\",\"requestId\":\"req-1\"}|approve a held action"
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
  local r m p b what c
  for r in "${rows[@]}"; do
    IFS='|' read -r m p b what <<< "$r"
    c="$(code "$m" "$p" "$b" "$@")"
    case "$c" in 401|403|404|405) ok "$label: $what" "HTTP $c" ;; *) bad "$label: $what" "HTTP $c" ;; esac
  done
}
OWN_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
PORT="$(printf '%s' "$API" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"; PORT="${PORT:-3456}"
BASE="$(printf '%s' "$API" | sed -E 's#^https?://[^/]+##')"
for host in 127.0.0.1 "[::1]" "$OWN_IP"; do
  [ -z "$host" ] && continue
  TARGET="http://$host:$PORT$BASE"
  owner_calls "no credential @ $host"
  owner_calls "wrong box token @ $host" -H "x-dispatch-box-token: not-the-token"
  [ -n "$LEAKED" ] && owner_calls "LEAKED inbound token @ $host" -H "x-dispatch-box-token: $LEAKED"
  [ -n "$LEAKED" ] && owner_calls "LEAKED token as bearer @ $host" -H "Authorization: Bearer $LEAKED"
done
TARGET="$API"
# Every key this user can obtain: its own, those of other workload processes, key files.
keys="$( { echo "${DISPATCH_AUTH:-}"; cat /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' | sed -n 's/^DISPATCH_AUTH=//p'; cat "$RUN"/keys/* 2>/dev/null; grep -rhoE 'd[tcsp]k_[A-Za-z0-9_-]{43}' "$RUN" "$HOME/.dispatch" 2>/dev/null; } | grep -oE 'd[tcsp]k_[A-Za-z0-9_-]{43}' | sort -u)"
nk=0
for k in $keys; do
  nk=$((nk+1))
  kind="$(curl -s -m 5 -H "Authorization: Bearer $k" "$TARGET/api/whoami" | grep -oE '"kind":"[a-z]+"' | head -1 | cut -d'"' -f4)"
  [ -z "$kind" ] && continue
  rows=(
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
    "POST|/api/plugins/install|{\"url\":\"https://example.com/x\"}|install a plugin"
    "POST|/api/access/login|{\"token\":\"x\"}|sign in as the owner"
    "GET|/api/access/no-credential-stats||read the access counters"
  )
  for r in "${rows[@]}"; do
    IFS='|' read -r m p b what <<< "$r"
    c="$(code "$m" "$p" "$b" -H "Authorization: Bearer $k")"
    case "$c" in 401|403|404|405) ok "$kind key #$nk: $what" "HTTP $c" ;; *) bad "$kind key #$nk: $what" "HTTP $c" ;; esac
  done
  # A terminal or a structured socket with a key: refused at the upgrade.
  c="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $k" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$TARGET/api/terminals/$TID/ws")"
  case "$c" in 401|403|404|400) ok "$kind key #$nk: open a terminal socket" "HTTP $c" ;; *) bad "$kind key #$nk: open a terminal socket" "HTTP $c" ;; esac
done
[ "$nk" -gt 0 ] && info "keys this user could collect" "$nk" || info "no key could be collected" "the key rows did not run"
if [ -n "$LEAKED" ]; then
  c="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "x-dispatch-box-token: $LEAKED" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$TARGET/api/terminals/$TID/ws")"
  case "$c" in 401|403) ok "LEAKED inbound token: open a terminal socket from inside" "HTTP $c" ;; *) bad "LEAKED inbound token: open a terminal socket from inside" "HTTP $c" ;; esac
fi

echo "== 7. the platform, directly (skipping the daemon)"
if [ -n "$PLATFORM" ]; then
  gw() { curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST -H 'content-type: application/json' "$@" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"crm_update_customer","arguments":{}}}' "$PLATFORM/api/dispatch/mcp"; }
  c="$(gw -H 'x-dispatch-owner: person@example.com')"; [ "$c" = 401 ] && ok "tool gateway with no token" "HTTP $c" || bad "tool gateway with no token" "HTTP $c"
  for k in $keys; do c="$(gw -H "x-dispatch-box-token: $k" -H 'x-dispatch-owner: person@example.com')"; [ "$c" = 401 ] && ok "tool gateway with a collected key as the token" "HTTP $c" || bad "tool gateway with a collected key as the token" "HTTP $c"; break; done
  if [ -n "$LEAKED" ]; then c="$(gw -H "x-dispatch-box-token: $LEAKED" -H 'x-dispatch-owner: person@example.com')"; [ "$c" = 401 ] && ok "tool gateway with the LEAKED inbound token (it is not the outbound one)" "HTTP $c" || bad "tool gateway with the LEAKED inbound token" "HTTP $c"; fi
  c="$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H 'x-dispatch-owner: person@example.com' "$PLATFORM/api/dispatch/connections")"; [ "$c" = 401 ] && ok "connections broker with no token" "HTTP $c" || bad "connections broker with no token" "HTTP $c"
fi

echo "== 8. persistence with MORE rights"
must_fail "plant a role definition the daemon would run" sh -c "mkdir -p $STATE/roles && : > $STATE/roles/x.md"
must_fail "plant a plugin the daemon would load" sh -c "mkdir -p $STATE/plugins/x"
must_fail "edit another thread's hook settings" sh -c "f=\$(ls $RUN/hooks/*.json 2>/dev/null | head -1); [ -n \"\$f\" ] && echo x >> \"\$f\""
must_fail "edit another thread's MCP config" sh -c "f=\$(ls $RUN/mcp/*.json 2>/dev/null | head -1); [ -n \"\$f\" ] && echo x >> \"\$f\""
# A link in the home that points into the state root must not make the daemon read it for us.
mkdir -p "$HOME/projects/proj1" 2>/dev/null; ln -sfn "$STATE/dispatch.db" "$HOME/projects/proj1/innocent.txt" 2>/dev/null
for k in $keys; do
  c="$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H "Authorization: Bearer $k" "$TARGET/api/sessions/$SID/files/read?path=innocent.txt")"
  case "$c" in 401|403|404) ok "make the daemon read its database through a link in the project" "HTTP $c" ;; *) bad "make the daemon read its database through a link in the project" "HTTP $c" ;; esac
  break
done
rm -f "$HOME/projects/proj1/innocent.txt" 2>/dev/null

echo "== 9. stated, not protected (see section 12 of the design)"
if echo '{}' > "$HOME/.claude-proof-setting" 2>/dev/null; then info "a workload can write harness files in the home" "accepted: same user, same rights, never the daemon's"; rm -f "$HOME/.claude-proof-setting"; fi
REAL="$(ls /opt/agents/.local/share/claude/versions/* 2>/dev/null | head -1)"
if [ -n "$REAL" ] && [ -x "$REAL" ]; then
  out="$(timeout 20 "$REAL" --dangerously-skip-permissions -p 'say hi' 2>&1 | head -c 400)"
  if printf '%s' "$out" | grep -qiE 'bypass|not allowed|disabled|managed'; then ok "nested harness with the bypass flag is refused by the managed policy" ; else info "nested harness with the bypass flag is NOT refused by policy here" "it gains no daemon or platform right; closing it is the harness-policy work"; fi
fi
info "another AI account's credential" "not isolated by design (one person, one agent user)"

echo "== result: $pass passed, $fail FAILED, $note notes"
[ "$fail" -eq 0 ]
