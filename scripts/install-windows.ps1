#Requires -Version 5
# Dispatch bootstrap: ensures WSL2 + Ubuntu, then runs the Linux installer inside it.
$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu'
function Test-Wsl { try { wsl.exe --status *> $null; return $LASTEXITCODE -eq 0 } catch { return $false } }
if (-not (Test-Wsl)) {
  Write-Host 'Installing WSL2 (this can require a reboot — re-run this script afterwards)...'
  wsl.exe --install -d $distro
  exit 0
}
$distros = (wsl.exe -l -q) -join "`n"
if ($distros -notmatch [regex]::Escape($distro)) {
  wsl.exe --install -d $distro
  Write-Host "Ubuntu is installing. Complete its first-run user setup, then re-run this script."
  exit 0
}
Write-Host 'WSL2 ready — installing Dispatch inside Ubuntu...'
wsl.exe -d $distro -- bash -lc 'git clone https://github.com/davidwebber10/dispatch.git ~/dispatch 2>/dev/null || git -C ~/dispatch pull; cd ~/dispatch && ./scripts/install.sh'
Write-Host 'Done. Open http://localhost:3456'
