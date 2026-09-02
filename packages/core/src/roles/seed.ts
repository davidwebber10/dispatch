// Seed assembly — the first message of an incarnation (Task 2 of the run lifecycle,
// docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §2). Pure: nowIso is
// injected by the caller (the daemon, at spawn time), never read here via Date.now.
import type { RoleAuthority, RoleDefinition } from './definition.js';

const FRESHNESS_INSTRUCTION =
  'This is a fresh incarnation: verify the world before acting — fetch, check branch/data state; trust nothing remembered.';

const AUTHORITY_RULES: Record<RoleAuthority, string> = {
  observe:
    'Authority: observe. Report only, no writes of any kind — no commits, no pushes, no PRs, no data mutation.',
  stage:
    'Authority: stage. You may write on branches: commit, and push non-protected branches explicitly ' +
    '(`git push <remote> <branch>`, branch not main/master/prod), and open PRs (`gh pr create`). ' +
    'NEVER merge, deploy, push main/master/prod, release, publish, re-run production jobs, or mutate data.',
  'stage-deploy':
    'Authority: stage-deploy. Everything stage allows, plus explicit staging deploy forms only ' +
    '(for example `gh workflow run … environment=staging`). ' +
    'Everything production stays forbidden: NEVER merge, deploy to production, push main/master/prod, ' +
    'release, publish, re-run production jobs, or mutate data.',
};

const OUTPUT_CONTRACT = `## Output contract
End the run by calling report_status. End your FINAL message with exactly ONE fenced \`\`\`json block of this shape. Set "outcome" to exactly one of "ok", "attention", or "failed":

\`\`\`json
{"outcome":"ok","summary":"one paragraph of what happened","links":["https://github.com/..."],"proposedBriefChanges":"optional — omit when none"}
\`\`\`

"proposedBriefChanges" is optional. The daemon parses this block into the role's run log — it is the only record that survives this session.`;

export function buildSeedMessage(input: {
  def: RoleDefinition;
  memory: string;
  logTail: string[];
  nowIso: string;
}): string {
  const { def, memory, logTail, nowIso } = input;

  const sections: string[] = [];

  sections.push(`# Role: ${def.name}\nCurrent time: ${nowIso}\n${FRESHNESS_INSTRUCTION}`);
  sections.push(AUTHORITY_RULES[def.authority]);
  sections.push(def.brief);

  if (memory.trim()) {
    sections.push(`## Role memory\n${memory}`);
  }

  if (logTail.length > 0) {
    sections.push(`## Recent run reports\n${logTail.join('\n')}`);
  }

  sections.push(OUTPUT_CONTRACT);

  return sections.join('\n\n');
}
