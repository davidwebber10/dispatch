// Preload for the isolated daemon (plan section 1A.3, transcript paging). It measures the event-loop
// delay and the memory of the daemon process from the inside, with no change to product code.
// Run:  W2B_PROBE_OUT=<file> node --import ./packages/core/scripts/perf/loop-delay-probe.mjs packages/core/dist/server.js
// Send SIGUSR2 to the process: it writes the numbers since the last signal to W2B_PROBE_OUT, then starts again.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';

const out = process.env.W2B_PROBE_OUT;
if (out) {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  let peakRss = 0;
  setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25).unref();
  const ms = (ns) => Math.round(ns / 1e4) / 100;
  process.on('SIGUSR2', () => {
    const rss = process.memoryUsage().rss;
    fs.writeFileSync(out, JSON.stringify({
      samples: histogram.count,
      loopDelayMs: { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), mean: ms(histogram.mean) },
      rssMb: Math.round(rss / 1048576), peakRssMb: Math.round(Math.max(peakRss, rss) / 1048576),
    }) + '\n');
    histogram.reset();
    peakRss = 0;
  });
}
