import type { DaemonInstallOptions } from './daemon.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildLogonTaskXml(opts: DaemonInstallOptions & { userId: string }): string {
  // Wrapper command: set env then launch node with the server entry; redirect logs.
  const envSetup = Object.entries(opts.env)
    .map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}';`).join(' ');
  const cmd =
    `${envSetup} & '${opts.nodePath}' '${opts.entry}' ` +
    `*> '${opts.logDir}\\dispatch.out.log'`;
  const args = `-NoLogo -NonInteractive -Command "${cmd}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(opts.userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author">
    <UserId>${esc(opts.userId)}</UserId>
    <LogonType>InteractiveToken</LogonType>
    <RunLevel>HighestAvailable</RunLevel>
  </Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>powershell.exe</Command><Arguments>${esc(args)}</Arguments></Exec>
  </Actions>
</Task>`;
}
