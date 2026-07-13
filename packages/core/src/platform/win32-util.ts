/** Parses PIDs (column 2) from `tasklist /FO CSV /NH` output. */
export function parseTasklistPids(csv: string): number[] {
  const pids: number[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split('","');
    if (cols.length < 2) continue;
    const pid = Number(cols[1].replace(/"/g, '').trim());
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}
