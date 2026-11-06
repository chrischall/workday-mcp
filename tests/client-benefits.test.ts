import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';
import { relatedTasks, enrollInbox, landing, managePage, optionRow, planDetails } from './benefits-fixtures.js';

// Shapes mirror a production tenant captured live in 2026-11 (annual
// enrollment season). Values are invented; structure is faithful.

type Route = unknown | ((init: FetchInit) => unknown);

class RoutingTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  constructor(private routes: Record<string, Route>) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const route = this.routes[init.path];
    const hit = typeof route === 'function' ? (route as (i: FetchInit) => unknown)(init) : route;
    return {
      status: hit === undefined ? 404 : 200,
      body: hit === undefined ? 'not found' : typeof hit === 'string' ? hit : JSON.stringify(hit),
      url: `https://wd5.myworkday.com${init.path}`,
    };
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

const currentUser = {
  widget: 'currentUser',
  iid: '247$1',
  label: 'Pat Doe',
  relatedTasksLink: { widget: 'link', rel: 'related-tasks', uri: '/acme/inst/247$1/rel-tasks' },
};

const APPS = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
const apps = {
  widget: 'configuredApps',
  children: [{ widget: 'configuredAppsItem', label: 'Org Chart', taskIid: '2998$2673' }],
};
const orgChart = {
  widget: 'root',
  title: 'Org Chart',
  currentUser,
  body: { widget: 'hierarchyNavigator', workerIid: '247$1', ancestors: [] },
};

const mon = (...items: Array<[string, string]>) => ({
  widget: 'monikerList',
  selfUriTemplate: '/acme/inst/15$1/[IID]',
  instances: items.map(([text, instanceId]) => ({ widget: 'moniker', text, instanceId })),
});
const txt = (value: string) => ({ widget: 'text', value });
const grid = (label: string, columns: string[], rows: Array<Record<string, unknown>>) => ({
  widget: 'grid',
  label,
  rowCount: rows.length,
  deepRowCount: rows.length,
  columns: columns.map((c, i) => ({ widget: 'column', columnId: `c${i}`, label: c })),
  rows: rows.map((cells) => ({
    widget: 'row',
    cellsMap: Object.fromEntries(
      columns
        .map((c, i) => [`c${i}`, cells[c] ? { label: c, ...(cells[c] as object) } : undefined])
        .filter(([, v]) => v)
    ),
  })),
});
const page = (title: string, ...children: unknown[]) => ({
  widget: 'root',
  title: { widget: 'titleStaticText', text: title },
  currentUser,
  sessionSecureToken: 'ENVELOPE-SECRET',
  body: { widget: 'vbox', children },
});

const ELECTION_COLS = [
  'Benefit Plan',
  'Coverage Begin Date',
  'Deduction Begin Date',
  'Coverage',
  'Calculated Coverage',
  'Dependents',
  'Beneficiaries',
  'Employee Cost (Per Pay Period (Semi-Monthly))',
  'Employer Contribution (Per Pay Period (Semi-Monthly))',
];
const electionRow = (plan: string, you: string, employer?: string, extra: Record<string, unknown> = {}) => ({
  'Benefit Plan': mon([plan, `542$${plan.length}`]),
  Coverage: txt('Associate + Child(ren)'),
  'Coverage Begin Date': { widget: 'date', value: '01/01/2026' },
  'Employee Cost (Per Pay Period (Semi-Monthly))': txt(you),
  ...(employer ? { 'Employer Contribution (Per Pay Period (Semi-Monthly))': txt(employer) } : {}),
  ...extra,
});

const currentGrid = page(
  'Pat Doe',
  grid('Current Benefit Elections and Costs', ELECTION_COLS, [
    electionRow('USA Medical - Acme HSA Plan', '$100.00', '$600.00', {
      Dependents: mon(['Kid One', '295$1'], ['Kid Two', '295$2']),
    }),
    electionRow('USA Vision - Acme Vision', '$7.00'),
    electionRow('USA Basic Life - 2X', '', '$9.00', {
      Coverage: txt('2 X Salary'),
      'Calculated Coverage': txt('$400,000.00'),
      Beneficiaries: mon(['Doe Family Trust', '6455$1']),
    }),
    {
      'Employee Cost (Per Pay Period (Semi-Monthly))': txt('$107.00'),
      'Employer Contribution (Per Pay Period (Semi-Monthly))': txt('$609.00'),
    },
  ])
);

const electionsCards = page('Current Benefit Elections', {
  widget: 'hbox',
  children: [
    {
      widget: 'commandButton',
      label: 'View as Grid',
      uri: '/acme/inst/247$1/rel-task/2998$50668',
      httpMethod: 'GET',
      actionId: 'view',
      values: [{ label: 'Pat Doe', uri: '/acme/inst/247$1/rel-task/2998$50668', httpMethod: 'GET' }],
    },
  ],
});

const dependents = page(
  'Dependents',
  grid('Dependents', ['Dependent', 'Relationship', 'Age'], [
    { Dependent: mon(['Kid One', '295$1']), Relationship: mon(['Child', '620$2']), Age: txt('9 years') },
  ])
);

const BASE: Record<string, Route> = {
  [APPS]: apps,
  '/acme/task/2998$2673.htmld': orgChart,
  '/acme/inst/247$1/rel-tasks.htmld': relatedTasks,
  '/acme/inst/247$1/rel-task/2998$3281.htmld': electionsCards,
  '/acme/inst/247$1/rel-task/2998$50668.htmld': currentGrid,
  '/acme/inst/247$1/rel-task/2998$6508.htmld': dependents,
};

function makeClient(extra: Record<string, Route> = {}) {
  const transport = new RoutingTransport({ ...BASE, ...extra });
  return { client: new WorkdayClient({ transport, tenant: 'acme' }), transport };
}

describe('getBenefits', () => {
  it('reads your current elections from your own Benefits catalog, by label', async () => {
    const { client } = makeClient();
    const res = await client.getBenefits();
    expect(res).toEqual({
      matched: 'View My Current Benefit Elections',
      costPeriod: 'Per Pay Period (Semi-Monthly)',
      elections: [
        {
          plan: 'USA Medical - Acme HSA Plan',
          coverage: 'Associate + Child(ren)',
          coverageBegins: '01/01/2026',
          dependents: ['Kid One', 'Kid Two'],
          youPay: '$100.00',
          companyPays: '$600.00',
        },
        { plan: 'USA Vision - Acme Vision', coverage: 'Associate + Child(ren)', coverageBegins: '01/01/2026', youPay: '$7.00' },
        {
          plan: 'USA Basic Life - 2X',
          coverage: '2 X Salary',
          calculatedCoverage: '$400,000.00',
          coverageBegins: '01/01/2026',
          beneficiaries: ['Doe Family Trust'],
          companyPays: '$9.00',
        },
      ],
      totals: { youPay: '$107.00', companyPays: '$609.00' },
    });
  });

  it('reads the other Benefits views as rows', async () => {
    const { client } = makeClient();
    expect(await client.getBenefits('dependents')).toEqual({
      matched: 'View Dependents',
      rows: [{ Dependent: 'Kid One', Relationship: 'Child', Age: '9 years' }],
    });
  });

  it('names the Benefits tasks it did find when a view is missing', async () => {
    const { client } = makeClient();
    await expect(client.getBenefits('beneficiaries')).rejects.toThrow(
      /beneficiaries.*View My Current Benefit Elections.*View Dependents/s
    );
  });

  it('never fetches a non-view (action) task such as Change Benefits', async () => {
    const { client, transport } = makeClient();
    await client.getBenefits();
    expect(transport.calls.map((c) => c.path)).not.toContain('/acme/inst/247$1/rel-task/2997$1293.htmld');
    expect(transport.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Open enrollment
// ---------------------------------------------------------------------------

const bootConfig = {
  appRoot: JSON.stringify({ sessionSecureToken: 'INBOX-TOKEN' }),
};
const INBOX = '/acme/internalapi/internalapi/inbox/v2/acme/inboxItems?category=Actions&offset=0&limit=100';
const inboxItem = (title: string, task: string, uri: string, details: string, created: string, effective?: string) => ({
  relatedItem: {
    title,
    createdDate: created,
    ...(effective ? { effectiveDate: effective } : {}),
    itemType: { descriptor: 'Change Benefits for Open Enrollment' },
  },
  taskToExecute: { label: task, uri },
  relatedTasks: [{ label: 'View Details', uri: details }],
});
const inbox = {
  total: 3,
  data: [
    inboxItem(
      'Open Enrollment Change: Pat Doe on 01/01/2027',
      'Open',
      '/acme/d/inst/2363$1/rel-task/2997$1195.htmld',
      '/acme/d/inst/795$9/rel-task/2997$3463',
      '2026-10-26T10:00:00.000Z',
      '2027-01-01'
    ),
    inboxItem(
      'Add Dependent Documentation: Open Enrollment Change: Pat Doe on 01/01/2025',
      'To Do',
      '/acme/d/inst/781$1/rel-task/2997$362.htmld',
      '/acme/d/inst/795$2/rel-task/2997$3463',
      '2024-11-08T10:00:00.000Z',
      '2025-01-01'
    ),
    {
      relatedItem: { title: 'Self Evaluation: 2026', createdDate: '2026-11-02T00:00:00Z', itemType: { descriptor: 'Performance Review' } },
      taskToExecute: { label: 'Complete Self Evaluation', uri: '/acme/d/inst/1$1/rel-task/2997$272.htmld' },
      relatedTasks: [],
    },
  ],
};

const eventView = page(
  'View Event',
  grid('Elected Coverages', ELECTION_COLS, [
    electionRow('USA Medical - Acme HSA Plan', '$110.00', '$650.00', {
      Dependents: mon(['Kid One', '295$1'], ['Kid Two', '295$2']),
    }),
    electionRow('USA Vision - Acme Vision', '$7.00'),
    electionRow('USA Basic Life - 2X', '', '$9.00', { Coverage: txt('2 X Salary') }),
    {
      'Employee Cost (Per Pay Period (Semi-Monthly))': txt('$117.00'),
      'Employer Contribution (Per Pay Period (Semi-Monthly))': txt('$659.00'),
    },
  ]),
  grid('Waived Coverages', ['Plan Type'], [{ 'Plan Type': mon(['USA Critical Illness', '540$7']) }, { 'Plan Type': mon(['Legal Plan', '4263$3']) }]),
  grid('Beneficiary Designations', ['Benefit Plan', 'Beneficiary'], [
    { 'Benefit Plan': mon(['USA Basic Life - 2X', '545$1']), Beneficiary: mon(['Doe Family Trust', '6455$1']) },
  ]),
  grid('Process History', ['Process', 'Step', 'Status'], [
    { Process: mon(['Change Benefits for Open Enrollment', '2363$1']), Step: mon(['Change Benefits for Open Enrollment', '749$1']), Status: txt('Awaiting Action') },
  ])
);

const ENROLL = {
  [`/acme/boot-config`]: bootConfig,
  [INBOX]: inbox,
  '/acme/inst/2363$1/rel-task/2997$1195.htmld': enrollInbox,
  '/acme/inst/795$9/rel-task/2997$3463.htmld': eventView,
  '/acme/inst/2363$1/rel-task/2997$15223.htmld': landing,
  '/acme/inst/8085$1/rel-task/2997$15286.htmld': managePage([
    optionRow('588', 'Acme PPO', '571$1', false, '$200.00', '$600.00'),
    optionRow('634', 'Acme HSA Plan', '571$3', true, '$110.00', '$650.00'),
  ]),
  '/acme/inst/8085$2/rel-task/2997$15286.htmld': managePage([optionRow('1', 'Voya 10K', '571$9', false, '$7.00', '')]),
  '/acme/inst/8085$3/rel-task/2997$15286.htmld': managePage([optionRow('1', '2X Salary', '545$1', true, '$0.00', '$9.00')]),
  '/acme/inst/571$1/rel-task/2998$43660.htmld': planDetails,
  '/acme/inst/571$3/rel-task/2998$43660.htmld': planDetails,
};

describe('getBenefitEnrollment', () => {
  it('reads the open event: its window, what is elected, what changed in cost, and every plan on offer', async () => {
    const { client } = makeClient(ENROLL);
    const res = await client.getBenefitEnrollment();
    expect(res.event).toEqual({
      title: 'Open Enrollment Change: Pat Doe on 01/01/2027',
      name: 'USA Annual Enrollment',
      opens: '10/26/2026',
      closes: '11/08/2026',
      effective: '2027-01-01',
      instructions: 'Choose new plans or re-enroll in the plans you currently have.',
      status: 'Awaiting Action',
    });
    expect(res.elected.map((e) => [e.plan, e.youPay])).toEqual([
      ['USA Medical - Acme HSA Plan', '$110.00'],
      ['USA Vision - Acme Vision', '$7.00'],
      ['USA Basic Life - 2X', undefined],
    ]);
    expect(res.costChanges).toEqual([
      { plan: 'USA Medical - Acme HSA Plan', now: '$100.00', next: '$110.00', change: '+$10.00' },
    ]);
    expect(res.totals).toEqual({
      period: 'Per Pay Period (Semi-Monthly)',
      youPay: { now: '$107.00', next: '$117.00', change: '+$10.00' },
      companyPays: { now: '$609.00', next: '$659.00', change: '+$50.00' },
    });
    expect(res.waived).toEqual(['USA Critical Illness', 'Legal Plan']);
    expect(res.beneficiaries).toEqual([{ 'Benefit Plan': 'USA Basic Life - 2X', Beneficiary: 'Doe Family Trust' }]);
    expect(res.planTypes?.map((t) => t.planType)).toEqual(['USA Medical', 'USA Critical Illness', 'USA Basic Life']);
    expect(res.planTypes?.[0]).toMatchObject({
      group: 'Health Care and Accounts',
      current: 'Acme HSA Plan',
      plans: [
        { plan: 'Acme PPO', selected: false, youPay: '$200.00', companyPays: '$600.00' },
        { plan: 'Acme HSA Plan', selected: true, youPay: '$110.00', companyPays: '$650.00' },
      ],
    });
    expect(res.planTypes?.[1]).toMatchObject({ waived: true, plans: [{ plan: 'Voya 10K', youPay: '$7.00' }] });
    expect(res.toDos).toEqual([
      { title: 'Add Dependent Documentation: Open Enrollment Change: Pat Doe on 01/01/2025', created: '2024-11-08T10:00:00.000Z' },
    ]);
    expect(res.errors).toBeUndefined();
  });

  it('is GET-only and never touches a POST button or leaks a secret', async () => {
    const { client, transport } = makeClient(ENROLL);
    const res = await client.getBenefitEnrollment();
    expect(transport.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(transport.calls.map((c) => c.path).some((p) => p.includes('/button/'))).toBe(false);
    const out = JSON.stringify(res);
    expect(out).not.toMatch(/ENVELOPE-SECRET|FLOW-SECRET|INBOX-TOKEN|SECRET/);
    // Internal uris are plumbing, not output.
    expect(out).not.toContain('2997$15286');
  });

  it('narrows to one plan type and adds its rate table when asked', async () => {
    const { client, transport } = makeClient(ENROLL);
    const res = await client.getBenefitEnrollment({ planType: 'medical', rates: true });
    expect(res.planTypes?.map((t) => t.planType)).toEqual(['USA Medical']);
    expect(res.planTypes?.[0].plans?.[0]).toMatchObject({
      plan: 'Acme PPO',
      provider: 'Acme Health',
      providerUrl: 'https://www.acme-health.example/',
      rates: [
        { coverage: 'Associate', youPay: '$80.00' },
        { coverage: 'Associate + Spouse', youPay: '$250.00' },
        { coverage: 'Associate + Family', youPay: '$380.00' },
      ],
    });
    const paths = transport.calls.map((c) => c.path);
    expect(paths).not.toContain('/acme/inst/8085$2/rel-task/2997$15286.htmld');
  });

  it('refuses rates without a plan type, since that would fetch every plan of every type', async () => {
    const { client } = makeClient(ENROLL);
    await expect(client.getBenefitEnrollment({ rates: true })).rejects.toThrow(/planType/);
  });

  it('names the plan types when planType matches none', async () => {
    const { client } = makeClient(ENROLL);
    await expect(client.getBenefitEnrollment({ planType: 'pet insurance' })).rejects.toThrow(
      /USA Medical.*USA Critical Illness.*USA Basic Life/
    );
  });

  it('keeps going when one plan-type page fails, recording the failure', async () => {
    const { client } = makeClient({ ...ENROLL, '/acme/inst/8085$2/rel-task/2997$15286.htmld': undefined });
    const res = await client.getBenefitEnrollment();
    expect(res.planTypes?.[1]).toEqual(expect.objectContaining({ planType: 'USA Critical Illness' }));
    expect(res.planTypes?.[1]).not.toHaveProperty('plans');
    expect(res.errors?.[0]).toMatch(/USA Critical Illness/);
    expect(res.planTypes?.[0].plans).toHaveLength(2);
  });

  it('says so, and still lists to-dos, when no benefit event is open', async () => {
    const { client } = makeClient({
      ...ENROLL,
      [INBOX]: { total: 1, data: [inbox.data[1]] },
    });
    const res = await client.getBenefitEnrollment();
    expect(res.event).toBeUndefined();
    expect(res.note).toMatch(/no open benefit/i);
    expect(res.toDos).toHaveLength(1);
  });

  it('picks an event by name when several are open', async () => {
    const second = inboxItem(
      'Birth/Adoption: Pat Doe on 03/01/2026',
      'Open',
      '/acme/d/inst/2363$7/rel-task/2997$1195.htmld',
      '/acme/d/inst/795$7/rel-task/2997$3463',
      '2026-03-02T10:00:00.000Z'
    );
    const { client } = makeClient({ ...ENROLL, [INBOX]: { total: 2, data: [inbox.data[0], second] } });
    await expect(client.getBenefitEnrollment({ event: 'nope' })).rejects.toThrow(/Birth\/Adoption/);
    const res = await client.getBenefitEnrollment({ event: 'open enrollment' });
    expect(res.event?.title).toBe('Open Enrollment Change: Pat Doe on 01/01/2027');
    expect(res.otherEvents).toEqual(['Birth/Adoption: Pat Doe on 03/01/2026']);
  });
});
