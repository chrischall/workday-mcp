import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';

// Synthetic fixture mirroring the real Workday `*.htmld` widget-tree shape
// captured from a live tenant (values invented — no real data). Structure is
// faithful: a `root` envelope wrapping `body.cardContentSections[]`, leaf
// `text` widgets as {label,value}, `moniker` as {text,instanceId}, and a
// `sessionSecureToken` in the envelope that must NEVER reach tool output.
const sampleTask = {
  widget: 'root',
  title: 'Benefits and Pay',
  taskId: '2998$43525',
  tenant: 'acme',
  sessionSecureToken: 'SECRET-DO-NOT-LEAK',
  currentUser: {
    widget: 'currentUser',
    iid: 'user-1',
    label: 'Pat Example',
    selfLink: { widget: 'link', uri: '/d/user.htmld' },
    relatedTasksLink: { widget: 'link', uri: '/d/related.htmld' },
  },
  accountTasks: [
    { label: 'Change Preferences', uri: '/prefs.htmld' },
    { label: 'View Signon History', uri: '/signon.htmld' },
  ],
  header: {
    widget: 'header',
    excelLink: { uri: '/export.xlsx', httpMethod: 'GET' },
    pdfLink: { uri: '/export.pdf', httpMethod: 'GET' },
  },
  body: {
    widget: 'card',
    contentType: 'cardWidget',
    enabled: true,
    cardContentSections: [
      {
        widget: 'cardContentSection',
        contentSectionName: 'Base Pay',
        contentSectionItems: [
          // wrapper object with no `widget` of its own — the real tree nests
          // the leaf text widget one level down. The parser must recurse.
          {
            someWrapper: {
              widget: 'text',
              label: 'Total Base Pay',
              value: '$100,000.00',
              iid: 't1',
            },
          },
          { widget: 'text', label: 'Frequency', value: 'Annual', iid: 't2' },
          // empty text widget → skipped (no label, no value)
          { widget: 'text', label: '', value: '', iid: 't3' },
        ],
      },
      {
        widget: 'cardContentSection',
        contentSectionName: 'Manager',
        contentSectionItems: [
          {
            widget: 'monikerList',
            label: 'Manager',
            propertyName: 'manager',
            selfUriTemplate: '/worker/{id}.htmld',
            relatedTasksUriTemplate: '/worker/{id}/related.htmld',
            instances: [
              { widget: 'moniker', text: 'Jane Boss', instanceId: 'worker-9' },
            ],
          },
        ],
      },
    ],
  },
};

describe('parseTask', () => {
  const parsed = parseTask(sampleTask);

  it('extracts the envelope metadata', () => {
    expect(parsed.title).toBe('Benefits and Pay');
    expect(parsed.taskId).toBe('2998$43525');
    expect(parsed.tenant).toBe('acme');
    expect(parsed.user).toEqual({
      label: 'Pat Example',
      id: 'user-1',
      relatedTasksUri: '/d/related.htmld',
    });
  });

  it('collects text widgets as label/value fields, skipping empties and recursing wrappers', () => {
    const basePay = parsed.sections.find((s) => s.name === 'Base Pay');
    expect(basePay?.fields).toEqual([
      { label: 'Total Base Pay', value: '$100,000.00' },
      { label: 'Frequency', value: 'Annual' },
    ]);
    expect(basePay?.references).toEqual([]);
  });

  it('collects monikers as navigable references labeled by their monikerList', () => {
    const mgr = parsed.sections.find((s) => s.name === 'Manager');
    expect(mgr?.fields).toEqual([]);
    expect(mgr?.references).toEqual([
      {
        label: 'Manager',
        value: 'Jane Boss',
        instanceId: 'worker-9',
        uri: '/worker/worker-9.htmld',
      },
    ]);
  });

  it('surfaces account tasks and export links', () => {
    expect(parsed.relatedTasks).toEqual([
      { label: 'Change Preferences', uri: '/prefs.htmld' },
      { label: 'View Signon History', uri: '/signon.htmld' },
    ]);
    expect(parsed.export).toEqual({ excel: '/export.xlsx', pdf: '/export.pdf' });
  });

  it('NEVER leaks the session secure token (or any envelope secret)', () => {
    expect(JSON.stringify(parsed)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('is defensive against malformed input', () => {
    expect(parseTask(null).sections).toEqual([]);
    expect(parseTask({}).sections).toEqual([]);
    expect(parseTask({ body: { cardContentSections: 'nope' } }).sections).toEqual([]);
  });
});

// Workday LIST cards: each contentSectionItems[i] is a ROW whose keys are
// columns (label / value / secondaryValue / task), each column a widget whose
// `.value` carries the real datum — so the human label is the row's `label`
// column value, NOT the column widget's own `label` ("Label"/"Value"). Captured
// from a live benefits list card.
const listCardTask = {
  widget: 'root',
  title: 'Benefit Costs',
  body: {
    widget: 'card',
    cardContentSections: [
      {
        widget: 'cardContentSection',
        contentSectionName: 'listCardItems',
        contentSectionItems: [
          // propertyName values are NAMESPACED in real Workday data
          // (`wd:Label`, `nyw:Value`) — the parser must key on the clean
          // object key (`label`, `value`), NOT propertyName.
          {
            label: { widget: 'text', label: 'Label', value: 'Medical', propertyName: 'wd:Label' },
            value: { widget: 'text', label: 'Value', value: '$120.00', propertyName: 'nyw:Value' },
            secondaryValue: {
              widget: 'text',
              label: 'Secondary Value',
              value: 'Monthly',
              propertyName: 'wd:Secondary_Value',
            },
            task: {
              widget: 'monikerList',
              label: 'Task',
              propertyName: 'nyw:Task--IS',
              selfUriTemplate: '/plan/{id}.htmld',
              instances: [{ widget: 'moniker', text: 'Aetna PPO', instanceId: 'plan-3' }],
            },
            // decorative monikerList column — must NOT become a reference
            uxIcon: {
              widget: 'monikerList',
              label: 'UX Icon',
              propertyName: 'wd:UX_Icon--IS',
              selfUriTemplate: '/icon/{id}',
              instances: [{ widget: 'moniker', text: 'dollar', instanceId: 'icon-1' }],
            },
          },
          {
            label: { widget: 'text', label: 'Label', value: 'Dental', propertyName: 'wd:Label' },
            value: { widget: 'text', label: 'Value', value: '$15.00', propertyName: 'nyw:Value' },
          },
        ],
      },
    ],
  },
};

describe('parseTask — list cards', () => {
  const parsed = parseTask(listCardTask);
  const sec = parsed.sections[0];

  it('reads each row as {row-label : value}, using the column widgets correctly', () => {
    expect(sec.fields).toEqual([
      { label: 'Medical', value: '$120.00 (Monthly)' },
      { label: 'Dental', value: '$15.00' },
    ]);
  });

  it('still collects the row-level drill-in references', () => {
    expect(sec.references).toEqual([
      { label: 'Task', value: 'Aetna PPO', instanceId: 'plan-3', uri: '/plan/plan-3.htmld' },
    ]);
  });
});
