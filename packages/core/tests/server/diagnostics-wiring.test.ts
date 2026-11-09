import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Wave 2 integration: the "why" panel (W2-G) reads the saved notices and questions of W2-C through
// app.locals. Without these two lines the panel silently shows no deliveries and no saved question.
describe('the daemon gives the diagnostics route its W2-C sources', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/server.ts'), 'utf8');
  it('sets app.locals.deliveryOutbox to the outbox', () => {
    expect(src).toMatch(/app\.locals\.deliveryOutbox\s*=\s*outbox\b/);
  });
  it('sets app.locals.pendingQuestions to the question table bound to the database', () => {
    expect(src).toMatch(/app\.locals\.pendingQuestions\s*=\s*\{\s*get:\s*\(id(: string)?\)\s*=>\s*pendingQuestionsDb\.get\(db,\s*id\)\s*\}/);
  });
});
