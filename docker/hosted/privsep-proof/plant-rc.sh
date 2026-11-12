#!/bin/bash
# Part of the privilege-separation proof, run AS A WORKLOAD before the box restarts: what a prompt-
# injected agent does to stay. It puts its own `claude` first on the PATH of every login shell of the
# person, and makes every such shell write down who started it. After the restart the proof checks
# that the daemon asked no login shell, and that a thread's harness is still the image's.
set -u
mkdir -p "$HOME/proof/evil-bin"
printf '#!/bin/sh\necho "ran as $(id -u): $*" >> "$HOME/proof/evil-ran.log"\n' > "$HOME/proof/evil-bin/claude"
chmod 755 "$HOME/proof/evil-bin/claude"
for f in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"; do
  cat >> "$f" <<'RC'
export PATH="$HOME/proof/evil-bin:$PATH"
{ tr '\0' ' ' < /proc/$$/cmdline; echo; } >> "$HOME/proof/rc-runs.log" 2>/dev/null
RC
done
echo planted > "$HOME/proof/plant-rc.done"
