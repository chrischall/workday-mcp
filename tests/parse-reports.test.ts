import { describe, it, expect } from 'vitest';
import {
  parseReportPrompts,
  parseReportErrors,
  parseDashboardTabs,
  parseDashboardTab,
} from '../src/parse-reports.js';
import { parseTask } from '../src/parse.js';
import { promptPage, dashboardTab } from './reports-fixtures.js';

// Shapes mirror a production tenant captured live in 2026-11 (a custom
// position-management report, the Compensation Review Process View
// Organization report, and a "Year End Dashboard" landing-page group).
// Values are invented; structure is faithful.

describe('parseReportPrompts', () => {
  it('reads the OK id, flow key and every prompt with its current values', () => {
    const p = parseReportPrompts(promptPage);
    expect(p?.okId).toBe('189');
    expect(p?.flowKey).toBe('e1s1');
    expect(p?.prompts.map((x) => [x.label, x.widget, x.required, x.values.map((v) => v.text)])).toEqual([
      ['Acquisition', 'monikerListInput', false, []],
      ['Effective as of Date and Time', 'dateInput', false, []],
      ['Staffing Status', 'monikerListInput', false, ['Filled', 'Open']],
      ['Supervisory Organization', 'monikerListInput', true, ['Executive - CEO (Top Boss)']],
      ['Include Subordinate Organizations', 'checkBoxInput', false, ['true']],
    ]);
    const org = p?.prompts.find((x) => x.label === 'Supervisory Organization');
    expect(org).toMatchObject({ id: '174', contextId: 'c6' });
    expect(org?.values[0]).toEqual({ instanceId: '2500$1', text: 'Executive - CEO (Top Boss)' });
  });

  it('ignores the read-only instructions text', () => {
    expect(parseReportPrompts(promptPage)?.prompts.some((x) => x.label === 'Instructions')).toBe(false);
  });

  it('is undefined for a page with no inputs (a report that ran straight away)', () => {
    expect(parseReportPrompts({ widget: 'root', flowExecutionKey: 'x', body: { widget: 'vbox', id: '1', children: [] } }))
      .toBeUndefined();
  });

  it('never carries the session token', () => {
    expect(JSON.stringify(parseReportPrompts(promptPage))).not.toContain('SECRET-TOKEN');
  });
});

describe('parseReportErrors', () => {
  it('names the prompt each validation error belongs to', () => {
    const prompts = parseReportPrompts(promptPage)!.prompts;
    const errors = parseReportErrors(
      {
        widget: 'root',
        unassociatedErrorNodes: [
          { widget: 'error', nodeId: '174', message: 'The entered information does not meet the restrictions defined for this field.', type: 'ERROR' },
          { widget: 'error', message: 'Something general.', type: 'ERROR' },
          { widget: 'error', nodeId: '180', message: 'Just a heads-up.', type: 'WARNING' },
        ],
      },
      prompts
    );
    expect(errors).toEqual([
      'Supervisory Organization: The entered information does not meet the restrictions defined for this field.',
      'Something general.',
    ]);
  });

  it('also reads errors attached to the input widgets themselves', () => {
    const errors = parseReportErrors(
      {
        widget: 'root',
        body: {
          widget: 'monikerListInput',
          id: '68',
          label: 'Compensation Review Process',
          errorNodes: [{ widget: 'error', message: 'Field is required.', type: 'ERROR' }],
        },
      },
      []
    );
    expect(errors).toEqual(['Compensation Review Process: Field is required.']);
  });

  it('is empty for a clean result page', () => {
    expect(parseReportErrors({ widget: 'root', body: { widget: 'grid' } }, [])).toEqual([]);
  });
});

describe('parseDashboardTabs', () => {
  it('lists a landing-page group\'s tabs as task ids', () => {
    const tabs = parseDashboardTabs({
      widget: 'root',
      title: { widget: 'titleStaticText', text: 'Year End Dashboard' },
      body: {
        widget: 'landingPageGroup',
        children: [
          { widget: 'landingPageTab', label: 'Compensation', taskIid: '12709$31', instanceId: '12709$31' },
          { widget: 'landingPageTab', label: 'Talent', taskIid: '12709$32' },
        ],
      },
    });
    expect(tabs).toEqual([
      { label: 'Compensation', taskId: '12709$31' },
      { label: 'Talent', taskId: '12709$32' },
    ]);
  });

  it('is empty for a single landing page (no tabs)', () => {
    expect(parseDashboardTabs({ widget: 'root', body: { widget: 'landingPage', children: [] } })).toEqual([]);
  });
});

describe('parseDashboardTab', () => {
  it('reads each worklet as the report behind it (workletIid), not the shared launcher', () => {
    expect(parseDashboardTab(dashboardTab).worklets).toEqual([
      { label: 'Increase Summary by Performance Rating', reportId: '1422$6224' },
      { label: 'Budget Utilization', reportId: '1422$3981' },
    ]);
  });

  it('reads GET menu links with their section, and skips POST command buttons', () => {
    expect(parseDashboardTab(dashboardTab).links).toEqual([
      { section: 'Links to Reports', label: 'Compensation Review Process View Organization', reportId: '2997$10377' },
      { section: 'Links to Reports', label: 'Budget Report by Country', reportId: '1422$6216' },
    ]);
  });
});

describe('parseGrid column groups', () => {
  it('disambiguates a column label repeated under a group by prefixing the group', () => {
    const task = parseTask({
      widget: 'root',
      body: {
        widget: 'grid',
        rowCount: 1,
        deepRowCount: 1,
        columns: [
          { widget: 'column', columnId: '1.1', label: 'Status' },
          {
            widget: 'columnGroup',
            columnId: '1.2',
            label: 'Effective Job Requisition',
            columns: [{ widget: 'column', columnId: '2.1', label: 'Status' }],
          },
        ],
        rows: [
          {
            widget: 'row',
            cellsMap: {
              '1.1': { widget: 'text', value: 'Filled' },
              '2.1': { widget: 'text', value: 'Open' },
            },
          },
        ],
      },
    });
    expect(task.grids[0]!.columns).toEqual(['Status', 'Effective Job Requisition: Status']);
    expect(task.grids[0]!.rows[0]!.cells).toEqual({ Status: 'Filled', 'Effective Job Requisition: Status': 'Open' });
  });
});
