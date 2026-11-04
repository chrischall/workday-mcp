import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('auto-review follow-ups of #181', () => {
  it('src/tools/review.ts keeps every import above its first statement', () => {
    const lines = read('src/tools/review.ts').split('\n');
    const firstStatement = lines.findIndex((l) => /^(const|let|function|export|class) /.test(l));
    const lastImport = lines.reduce((at, l, i) => (/^import /.test(l) ? i : at), -1);
    expect(lastImport).toBeLessThan(firstStatement);
  });

  it("README documents workday_get_inbox's additive brief view", () => {
    const row = read('README.md').split('\n').find((l) => l.startsWith('| `workday_get_inbox`'));
    expect(row).toMatch(/view: "brief"/);
    expect(row).toMatch(/additive/);
  });

  it("SKILL.md documents brief in workday_get_inbox's tool entry", () => {
    const skill = read('skills/workday-mcp/SKILL.md');
    const entry = skill.slice(skill.indexOf('- **`workday_get_inbox`**'), skill.indexOf('- **`workday_get_my_requests`**'));
    expect(entry).toMatch(/view: "brief"/);
    expect(entry).toMatch(/additive/);
  });
});
