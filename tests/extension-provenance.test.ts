import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every place that tells a user to install the ContextMint Bridge extension must
// also say where it comes from (it is the fetchproxy extension, renamed) and how
// to verify it (public source; each release zip ships a .sha256 beside it). The
// extension mediates access to Workday pay/benefits/PII, so an install step
// without provenance is a trust-boundary gap (auto-review follow-up #129).
const INSTALL_SURFACES = [
  'README.md',
  'skills/workday-mcp/SKILL.md',
  'skills/workday-fpx/SKILL.md',
  'src/index.ts',
];

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('ContextMint Bridge install provenance', () => {
  it.each(INSTALL_SURFACES)('%s names the extension as fetchproxy, renamed', (rel) => {
    expect(read(rel)).toMatch(/fetchproxy (browser )?extension/i);
    expect(read(rel)).toContain('https://github.com/nullnet-app/contextmint-bridge');
  });

  it.each(INSTALL_SURFACES)('%s says how to verify the download', (rel) => {
    expect(read(rel)).toContain('.sha256');
  });

  it('README points at fetchproxy’s own README, which links the new name', () => {
    expect(read('README.md')).toContain('https://github.com/chrischall/fetchproxy#extension');
  });
});
