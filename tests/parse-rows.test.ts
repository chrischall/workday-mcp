import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';

// A manager-shaped list card: a direct-reports / approvals table whose rows
// carry MORE than the label+value pair the v1 parser reduced them to. The
// worker's name lives in a `onInstance` MONIKER column (not a text column),
// which the v1 row reader dropped entirely.
const teamCard = {
  widget: 'root',
  title: 'My Team',
  body: {
    widget: 'card',
    cardContentSections: [
      {
        widget: 'cardContentSection',
        contentSectionName: 'listCardItems',
        contentSectionItems: [
          {
            label: { widget: 'text', label: 'Label', value: 'Time Off Request' },
            value: { widget: 'text', label: 'Value', value: '3 days' },
            secondaryValue: { widget: 'text', label: 'Secondary Value', value: 'Awaiting me' },
            dueDate: { widget: 'text', label: 'Due Date', value: '2026-08-21' },
            onInstance: {
              widget: 'monikerList',
              label: 'On Instance',
              selfUriTemplate: '/worker/{id}.htmld',
              instances: [{ widget: 'moniker', text: 'Sam Report', instanceId: 'worker-42' }],
            },
            uxIcon: {
              widget: 'monikerList',
              label: 'UX Icon',
              instances: [{ widget: 'moniker', text: 'clock', instanceId: 'icon-9' }],
            },
          },
        ],
      },
    ],
  },
};

describe('parseTask — full rows', () => {
  const sec = parseTask(teamCard).sections[0];

  it('keeps EVERY column as a cell, not just label/value', () => {
    expect(sec.rows).toHaveLength(1);
    expect(sec.rows[0].cells).toEqual({
      label: 'Time Off Request',
      value: '3 days',
      secondaryValue: 'Awaiting me',
      dueDate: '2026-08-21',
      onInstance: 'Sam Report',
    });
  });

  it('drops decorative columns from cells (uxIcon / image)', () => {
    expect(sec.rows[0].cells.uxIcon).toBeUndefined();
  });

  it('attaches the row-level drill-in references to the ROW, not just the section', () => {
    expect(sec.rows[0].references).toEqual([
      {
        label: 'On Instance',
        value: 'Sam Report',
        instanceId: 'worker-42',
        uri: '/worker/worker-42.htmld',
      },
    ]);
  });

  it('still emits the v1 flattened field for back-compat', () => {
    expect(sec.fields).toEqual([{ label: 'Time Off Request', value: '3 days (Awaiting me)' }]);
  });
});

describe('parseTask — rows whose primary datum is a moniker', () => {
  // A pure org/roster card: no text `label` column at all — the worker IS the
  // moniker. v1 returned nothing for these rows.
  const rosterCard = {
    body: {
      cardContentSections: [
        {
          contentSectionName: 'Direct Reports',
          contentSectionItems: [
            {
              worker: {
                widget: 'monikerList',
                label: 'Worker',
                selfUriTemplate: '/worker/{id}.htmld',
                instances: [{ widget: 'moniker', text: 'Alex Report', instanceId: 'w-1' }],
              },
              jobTitle: { widget: 'text', label: 'Job Title', value: 'Engineer' },
            },
          ],
        },
      ],
    },
  };

  it('reads the moniker column as a cell so the row is not lost', () => {
    const sec = parseTask(rosterCard).sections[0];
    expect(sec.rows[0].cells).toEqual({ worker: 'Alex Report', jobTitle: 'Engineer' });
    expect(sec.rows[0].references[0].instanceId).toBe('w-1');
  });
});

describe('parseTask — crawl frontier', () => {
  it('collects data-endpoint uris found anywhere in the envelope, ranked with child cards first', () => {
    const hub = {
      title: 'Benefits and Pay',
      sessionSecureToken: 'SECRET-DO-NOT-LEAK',
      body: {
        cardContentSections: [
          {
            contentSectionName: 'Cards',
            contentSectionItems: [
              { widget: 'link', label: 'Payslips', uri: '/acme/task/2998$1.htmld' },
            ],
          },
        ],
        children: [
          { widget: 'card', label: 'Cost Card', uri: '/acme/card/all/c1/39330!tok.htmld' },
        ],
      },
    };
    const parsed = parseTask(hub);
    expect(parsed.childCards[0].uri).toBe('/acme/card/all/c1/39330!tok.htmld');
    expect(parsed.childCards.map((c) => c.uri)).toContain('/acme/task/2998$1.htmld');
    expect(JSON.stringify(parsed)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('dedupes uris and ignores non-data links', () => {
    const parsed = parseTask({
      body: {
        children: [
          { widget: 'card', uri: '/acme/card/all/c1/tok.htmld' },
          { widget: 'card', uri: '/acme/card/all/c1/tok.htmld' },
          { widget: 'link', uri: 'https://example.com/help' },
          { widget: 'link', uri: '/acme/d/inst/home.htmld' },
        ],
      },
    });
    expect(parsed.childCards.map((c) => c.uri)).toEqual(['/acme/card/all/c1/tok.htmld']);
  });
});
