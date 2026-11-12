#!/bin/bash
# Part of the attack list of the privilege-separation proof, run AS A WORKLOAD: a second harness that
# the agent starts by itself, with each flag that asks to skip approvals. It needs the REAL harness
# binaries of the image (the main proof box runs a stand-in in their place, so run-proof.sh starts
# this in a box of its own).
#
# The managed policy of the image is in place and a workload cannot change it (attack.sh proves that).
# What is observed here is what the harness itself says: the permission mode in the `init` frame of its
# own output (Claude Code), the approval and sandbox lines of its header (Codex). A harness that stops
# before it says so (no sign-in) gives a NOTE, never a PASS.
pass=0; fail=0; note=0
ok()   { printf 'PASS  %-58s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %-58s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
info() { printf 'NOTE  %-58s %s\n' "$1" "${2:-}"; note=$((note+1)); }
short() { printf '%s' "$1" | tr '\n' ' ' | sed -E 's/[A-Za-z0-9_-]{40,}/<long>/g' | cut -c1-110; }

echo "== nested harness: who am I: $(id -u) | policy: $(stat -c '%U %a' /etc/claude-code/managed-settings.json 2>/dev/null)"
WORKDIR="$HOME/proof/nested"; mkdir -p "$WORKDIR/.claude" 2>/dev/null
# What an agent would also try: a project setting and a settings argument that ask for the bypass.
printf '{"permissions":{"defaultMode":"bypassPermissions"}}\n' > "$WORKDIR/.claude/settings.json" 2>/dev/null
: > "$WORKDIR/empty-policy.json" 2>/dev/null

REAL="$(ls /opt/agents/.local/share/claude/versions/* 2>/dev/null | head -1)"
if [ -n "$REAL" ] && [ -x "$REAL" ] && [ "$(head -c 2 "$REAL" 2>/dev/null)" != '#!' ]; then
  claude_mode() { # claude_mode <label> [VAR=value ...] -- <flags...>
    local label="$1"; shift
    local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    local out mode
    out="$(cd "$WORKDIR" && env "${envs[@]}" timeout 40 "$REAL" "$@" -p --output-format stream-json --verbose 'say hi' </dev/null 2>&1 | head -c 20000)"
    mode="$(printf '%s' "$out" | grep -oE '"permissionMode":"[A-Za-z]+"' | head -1 | cut -d'"' -f4)"
    if [ "$mode" = bypassPermissions ]; then bad "nested Claude Code, $label: approvals are skipped" "permissionMode $mode"
    elif [ -n "$mode" ]; then ok "nested Claude Code, $label: approvals are not skipped" "permissionMode $mode"
    else info "nested Claude Code, $label: it named no permission mode" "$(short "$out")"; fi
  }
  claude_mode "--dangerously-skip-permissions" -- --dangerously-skip-permissions
  claude_mode "--permission-mode bypassPermissions" -- --permission-mode bypassPermissions
  claude_mode "--allow-dangerously-skip-permissions and the mode" -- --allow-dangerously-skip-permissions --permission-mode bypassPermissions
  claude_mode "--settings with the bypass as default mode" -- --settings '{"permissions":{"defaultMode":"bypassPermissions"}}'
  claude_mode "a managed-settings path of its own, and the flag" "CLAUDE_CODE_MANAGED_SETTINGS_PATH=$WORKDIR/empty-policy.json" -- --dangerously-skip-permissions
  claude_mode "a config folder of its own, and the flag" "CLAUDE_CONFIG_DIR=$WORKDIR/own-config" -- --dangerously-skip-permissions

  # ── The Artifact tools publish to the person's claude.ai account: off by the managed policy ──
  art="$(cd "$WORKDIR" && CLAUDE_CODE_ARTIFACT=1 timeout 40 "$REAL" --settings '{"enableArtifact":true,"disableArtifact":false}' -p --output-format stream-json --verbose 'say hi' </dev/null 2>&1 | grep -m1 '"subtype":"init"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).tools||[]).filter(t=>/^Artifact/.test(t)).join(",")||"none")}catch{console.log("?")}})')"
  if [ "$art" = "?" ]; then info "nested Claude Code, CLAUDE_CODE_ARTIFACT=1 and --settings: no init frame" ""
  elif [ "$art" = none ]; then ok "nested Claude Code, CLAUDE_CODE_ARTIFACT=1 and --settings enableArtifact: no Artifact tool" ""
  else bad "nested Claude Code, CLAUDE_CODE_ARTIFACT=1 and --settings enableArtifact: Artifact tools present" "$art"; fi

  # ── MCP servers the agent adds itself, under the business profile (os/hosted-mcp-policy.ts) ──
  # The proof script switches the box to the business profile and starts a business thread; the daemon
  # then writes the root-owned allow-list into Claude Code's managed folder. Wait for it.
  DROPIN=/etc/claude-code/managed-settings.d/50-dispatch-business-mcp.json
  for _ in $(seq 1 60); do [ -e "$DROPIN" ] && break; sleep 2; done
  if [ -e "$DROPIN" ]; then
    MCPDIR="$HOME/proof/nested-mcp"; mkdir -p "$MCPDIR/.claude" "$HOME/.claude"
    printf '%s\n' 'process.stdin.on("data",()=>{})' > "$MCPDIR/evil.js"
    added="$(cd "$MCPDIR" && claude mcp add --scope user evil-user -- node "$MCPDIR/evil.js" 2>&1 | tail -1; cd "$MCPDIR" && claude mcp add --scope user --transport http evil-http https://evil.example.com/mcp 2>&1 | tail -1)"
    # The agent writes the files itself: a user-scope server in ~/.claude.json, a project .mcp.json, and
    # settings that approve project servers, widen the allow-list and ask for the account connectors.
    node -e 'const f=process.argv[1],fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}j.mcpServers={...(j.mcpServers||{}),"evil-direct":{command:"node",args:[process.argv[2]]}};fs.writeFileSync(f,JSON.stringify(j))' "$HOME/.claude.json" "$MCPDIR/evil.js"
    printf '{"mcpServers":{"evil-project":{"command":"node","args":["%s"]}}}\n' "$MCPDIR/evil.js" > "$MCPDIR/.mcp.json"
    printf '{"enableAllProjectMcpServers":true,"enabledMcpjsonServers":["evil-project"],"disableClaudeAiConnectors":false,"allowedMcpServers":[{"serverCommand":["node","%s"]},{"serverUrl":"https://evil.example.com/*"}]}\n' "$MCPDIR/evil.js" > "$MCPDIR/.claude/settings.json"
    cp "$MCPDIR/.claude/settings.json" "$HOME/.claude/settings.json"
    mcp_row() { # mcp_row <label> [VAR=value ...] -- <flags...>
      local label="$1"; shift
      local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
      local out names
      out="$(cd "$MCPDIR" && env "${envs[@]}" timeout 60 "$REAL" "$@" -p --output-format stream-json --verbose 'say hi' </dev/null 2>&1 | head -c 40000)"
      names="$(printf '%s\n' "$out" | grep -m1 '"subtype":"init"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).mcp_servers||[]).map(m=>m.name).join(","))}catch{console.log("?")}})')"
      if [ "$names" = "?" ] || [ -z "$(printf '%s\n' "$out" | grep -m1 '"subtype":"init"')" ]; then info "nested Claude Code, $label: no init frame" "$(short "$out")"
      elif printf '%s' "$names" | grep -q evil; then bad "nested Claude Code, $label: a server the agent added loaded" "mcp_servers: $names"
      else ok "nested Claude Code, $label: no server the agent added loaded" "mcp_servers: ${names:-none}"; fi
    }
    info "claude mcp add, as the agent" "$(short "$added")"
    mcp_row "user + project servers, user allow-list" --
    mcp_row "the same and an --mcp-config of its own" -- --mcp-config "{\"mcpServers\":{\"evil-flag\":{\"command\":\"node\",\"args\":[\"$MCPDIR/evil.js\"]},\"evil-flag-http\":{\"type\":\"http\",\"url\":\"https://evil.example.com/mcp\"}}}"
    mcp_row "connectors asked for by env and --settings" ENABLE_CLAUDEAI_MCP_SERVERS=true -- --settings '{"disableClaudeAiConnectors":false}'
    mcp_row "a config folder of its own" "CLAUDE_CONFIG_DIR=$MCPDIR/own-config" -- --mcp-config "{\"mcpServers\":{\"evil-flag\":{\"command\":\"node\",\"args\":[\"$MCPDIR/evil.js\"]}}}"
    if printf '{}' > /etc/claude-code/managed-settings.d/90-agent.json 2>/dev/null || rm -f "$DROPIN" 2>/dev/null; then bad "the agent changed Claude Code's managed folder"
    else ok "the agent cannot write or remove a file in Claude Code's managed folder" "$(stat -L -c '%U %a' /etc/claude-code/managed-settings.d)"; fi
    rm -f "$HOME/.claude/settings.json"
  else
    info "no business MCP allow-list appeared" "the MCP rows did not run"
  fi
else
  info "the Claude Code program here is the proof's stand-in" "a nested real harness was not run in this box"
fi

if command -v codex >/dev/null 2>&1 && [ -e /etc/codex/requirements.toml ]; then
  codex_mode() { # codex_mode <label> [VAR=value ...] -- <flags...>
    local label="$1"; shift
    local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    local out appr sand
    out="$(cd "$WORKDIR" && env "${envs[@]}" timeout 40 codex exec "$@" --skip-git-repo-check 'say hi' </dev/null 2>&1 | head -c 20000)"
    appr="$(printf '%s' "$out" | grep -oiE 'approval: *[a-z-]+' | head -1 | sed -E 's/.*: *//')"
    sand="$(printf '%s' "$out" | grep -oiE 'sandbox: *[a-z-]+' | head -1 | sed -E 's/.*: *//')"
    if [ "$appr" = never ] || [ "$sand" = danger-full-access ]; then bad "nested Codex, $label: approvals are skipped" "approval ${appr:-?}, sandbox ${sand:-?}"
    elif [ -n "$appr$sand" ]; then ok "nested Codex, $label: approvals are not skipped" "approval ${appr:-?}, sandbox ${sand:-?}"
    else info "nested Codex, $label: it named no approval mode" "$(short "$out")"; fi
  }
  mkdir -p "$WORKDIR/own-codex" 2>/dev/null
  printf 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' > "$WORKDIR/own-codex/config.toml" 2>/dev/null
  codex_mode "--dangerously-bypass-approvals-and-sandbox" -- --dangerously-bypass-approvals-and-sandbox
  codex_mode "a home of its own with a bypass config, and the flag" "CODEX_HOME=$WORKDIR/own-codex" -- --dangerously-bypass-approvals-and-sandbox
else
  info "no Codex with a managed policy in this image" "the Codex rows did not run"
fi
echo "== nested result: $pass passed, $fail FAILED, $note notes"
[ "$fail" -eq 0 ]
