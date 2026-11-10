import { warmModelCapabilities } from '../settings/model-capabilities.js';
import { warmClaudeVersion, prunePromptFiles } from '../providers/claude-prompt-file.js';
import { sweepThreadMcpConfigs, sweepThreadKeyFiles } from '../sessions/mcp-config-sweep.js';
import { reconcileAtBoot } from '../sessions/boot-reconcile.js';
import { flushOutboxAtBoot } from '../delivery/wiring.js';
import { finishRestartedUpdate } from '../update/progress.js';
import { getRunningVersion } from '../update/version.js';
import type { DaemonServices } from './build.js';

/**
 * What the daemon does once after it starts to listen, to recover from the last shutdown.
 * The first part runs at once. The part after the kickstart runs when the kickstart settled;
 * the promise resolves after it. W3-B puts its `BootRecovery.run()` behind this function.
 */
export async function runBootRecovery(s: DaemonServices, opts: { network: boolean; settleMs?: number }): Promise<void> {
  const { db, dataDir, sessionService, statusService, agentService, ptyManager, outbox, endless } = s;
  if (opts.network) {
    // The spawn path is sync and reads caches only, so load the OpenRouter and models.dev catalogs
    // once now. A chat-only model resumed right after boot then gets its tools turned off instead
    // of failing its first turn.
    void warmModelCapabilities();
    // Same for the installed Claude Code version: it decides whether a spawn hands Claude its
    // appended system prompt in a private file or as command-line text (claude-prompt-file.ts).
    void warmClaudeVersion().then(() => prunePromptFiles());
    // Prime the brokered-tool cache so the FIRST spawn after boot already has tools
    // (getServerSpecs is sync, so it can only ever serve a cached answer).
    void s.osConnections.refresh().then((r) => {
      if (s.osConnections.enabled) console.log(`OS tools: ${r.servers.length} server(s), reachable=${r.reachable}`);
    });
    // First CLI auth-check pass, now the thread spawn env is final. Non-blocking; the Tools page
    // and the awareness note read its cache.
    void s.toolsAuth.refresh();
  }
  // Parked threads: read them back before the usage-limit timer starts.
  s.usageLimits.restore();
  // An update that restarted this daemon is done: the update window shows "Updated to …".
  finishRestartedUpdate(dataDir, getRunningVersion());
  s.threadAutoNamer.resumePending();

  // Auto-resume overseer threads (coordinator + typed agents) that the previous shutdown
  // interrupted mid-turn. It waits a short settle delay before reading status.
  try {
    const { kicked, skipped, completed } = await (opts.settleMs === undefined ? sessionService.kickstartInterruptedAgents() : sessionService.kickstartInterruptedAgents(opts.settleMs));
    if (kicked.length) console.log(`Kickstart: resumed ${kicked.length} interrupted thread(s); skipped ${skipped.length}`);
    // A Chat thread whose turn completed while no one listened owes Chat its report.
    endless.reportCompletedAtBoot(completed);
  } catch (err) {
    // A daemon that stopped while the kickstart waited has closed its database: that is not a failure.
    if (db.open) console.error('kickstart failed', err);
  }
  if (!db.open) return;
  try {
    const alive = (id: string) => ptyManager.isAlive(id) || !!sessionService.structuredManagerForTerminal(id)?.isAlive(id);
    // W2-C: a scheduled wake that the restart killed is flagged, and a thread that waits on a saved
    // question keeps waiting: the process check below must not turn it into an error, nor close its run.
    const reconciled = reconcileAtBoot({ db, isAlive: alive, markIdle: (id, activity) => statusService.markIdle(id, activity), outbox });
    if (reconciled.lostWakes.length) console.log(`Flagged ${reconciled.lostWakes.length} scheduled wake(s) that the restart lost`);
    if (reconciled.restoredQuestions.length) console.log(`Kept ${reconciled.restoredQuestions.length} pending question(s) through the restart`);
    const waitsOnQuestion = new Set(reconciled.restoredQuestions);
    const aliveOrWaiting = (id: string) => alive(id) || waitsOnQuestion.has(id);
    statusService.reconcileProcesses(aliveOrWaiting);
    // Runs that the restart left open: closed here, so their schedules can fire again (W1-D).
    // After the kickstart and the process check, so a thread that runs again keeps its run.
    const orphaned = agentService.reconcileRunsAtBoot(aliveOrWaiting);
    if (orphaned.length) console.log(`Closed ${orphaned.length} run(s) that the restart left open`);
    // Old per-thread MCP files: removed once the threads that will run again have rewritten theirs.
    const swept = sweepThreadMcpConfigs(dataDir, alive);
    if (swept) console.log(`Removed ${swept} stale thread MCP config file(s)`);
    // Key files and key-related config of threads that are gone (named files only).
    const sweptKeys = sweepThreadKeyFiles(dataDir, alive);
    if (sweptKeys) console.log(`Removed ${sweptKeys} stale thread key file(s)`);
    // The messages that waited through the restart (W2-C). After the kickstart, so a thread that runs again takes its own.
    const flushed = flushOutboxAtBoot(outbox);
    if (flushed.delivered) console.log(`Delivered ${flushed.delivered} message(s) that waited in the outbox`);
  } finally {
    setTimeout(() => endless.endBoot(), 1000).unref();
  }
}
