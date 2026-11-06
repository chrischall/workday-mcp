import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';
import {
  card,
  enrollInbox,
  optionRow,
  planTypeForm,
  contributePage,
  slimConclusion,
  changeSummary,
  saveModal,
  savedConfirmation,
  signPage,
  submittedPage,
} from './benefits-fixtures.js';

// Making elections, end to end over a transport that answers each POST the
// way Workday did when the user made their own 2027 elections (2026-11).

type Handler = (init: FetchInit, form: URLSearchParams) => unknown;

class FlowTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  posts: Array<{ path: string; form: Record<string, string> }> = [];
  constructor(private routes: Record<string, unknown | Handler>) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    if (init.method === 'POST') this.posts.push({ path: init.path, form: Object.fromEntries(form) });
    const route = this.routes[`${init.method} ${init.path}`] ?? this.routes[init.path];
    const hit = typeof route === 'function' ? (route as Handler)(init, form) : route;
    return {
      status: hit === undefined ? 404 : 200,
      body: hit === undefined ? 'not found' : JSON.stringify(hit),
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

const mon = (...items: Array<[string, string]>) => ({
  widget: 'monikerList',
  instances: items.map(([text, instanceId]) => ({ widget: 'moniker', text, instanceId })),
});
const txt = (value: string) => ({ widget: 'text', value });
const grid = (label: string, columns: string[], rows: Array<Record<string, unknown>>) => ({
  widget: 'grid',
  label,
  rowCount: rows.length,
  columns: columns.map((c, i) => ({ widget: 'column', columnId: `c${i}`, label: c })),
  rows: rows.map((cells) => ({
    widget: 'row',
    cellsMap: Object.fromEntries(
      columns.map((c, i) => [`c${i}`, cells[c] ? { label: c, ...(cells[c] as object) } : undefined]).filter(([, v]) => v)
    ),
  })),
});
const COLS = ['Benefit Plan', 'Coverage', 'Employee Cost (Per Pay Period (Semi-Monthly))'];
const eventView = (elected: Array<[string, string, string]>, waived: string[]) => ({
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'View Event' },
  body: {
    widget: 'vbox',
    children: [
      grid(
        'Elected Coverages',
        COLS,
        elected.map(([plan, coverage, cost]) => ({
          'Benefit Plan': mon([plan, '542$1']),
          Coverage: txt(coverage),
          'Employee Cost (Per Pay Period (Semi-Monthly))': txt(cost),
        }))
      ),
      grid('Waived Coverages', ['Plan Type'], waived.map((w) => ({ 'Plan Type': mon([w, '540$1']) }))),
    ],
  },
});

const BEFORE = eventView(
  [
    ['USA Medical - Acme HSA Plan', 'Associate + Child(ren)', '$110.00'],
    ['USA Health Savings Account - HSA Bank', '$7,550.00 Annual', '$314.58'],
    ['USA Dependent Care FSA - Acme FSA Co', '$2,400.00 Annual', '$100.00'],
  ],
  ['USA Critical Illness']
);
const AFTER = eventView(
  [
    ['USA Medical - Acme PPO', 'Associate + Child(ren)', '$200.00'],
    ['USA Health Savings Account - HSA Bank', '$7,800.00 Annual', '$325.00'],
  ],
  ['USA Critical Illness', 'USA Dependent Care FSA']
);

const landingWith = (projected: string, cards: unknown[]) => ({
  widget: 'root',
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'stylizedHeader',
        rightJustifiedFields: [
          {
            widget: 'stylizedHeaderRightJustifiedField',
            label: 'Projected Total Cost (Per Pay Period (Semi-Monthly))',
            headings: [{ widget: 'text', value: projected }],
          },
        ],
      },
      {
        widget: 'panel',
        label: 'Health Care and Accounts',
        children: [{ widget: 'cardContainerWidget', cardContainerNode: { widget: 'cardContainer', cards } }],
      },
      {
        widget: 'commandButtonList',
        children: [
          { widget: 'commandButton', label: 'Save for Later', uri: '/acme/button/c1/38/1', httpMethod: 'POST' },
          { widget: 'commandButton', label: 'Review and Sign', uri: '/acme/button/c1/32/1', httpMethod: 'POST' },
        ],
      },
    ],
  },
});
const LANDING = landingWith('$524.58', [
  card('USA Medical', 'Acme HSA Plan', 'Manage', '/acme/inst/8085$1/rel-task/2997$15286'),
  card('USA Health Savings Account', 'HSA Bank', 'Manage', '/acme/inst/8085$4/rel-task/2997$15286'),
  card('USA Dependent Care FSA', 'Acme FSA Co', 'Manage', '/acme/inst/8085$5/rel-task/2997$15286'),
  card('USA Critical Illness', 'Waived', 'Enroll', '/acme/inst/8085$2/rel-task/2997$15286'),
]);

const MEDICAL = planTypeForm([
  optionRow('588', 'Acme PPO', '571$1', false, '$200.00', '$600.00'),
  optionRow('634', 'Acme HSA Plan', '571$3', true, '$110.00', '$650.00'),
]);
const HSA = planTypeForm([optionRow('701', 'HSA Bank', '3253$1', true, '$314.58', '$50.00')], { effective: '2027-01-01-08:00' });
const DCFSA = planTypeForm([optionRow('582', 'Acme FSA Co', '572$1', true, '$100.00', '')]);
const CI = planTypeForm([optionRow('801', 'Voya 10K', '571$9', false, '$7.15', '')]);

const bootConfig = { appRoot: JSON.stringify({ sessionSecureToken: 'INBOX-TOKEN' }) };
const INBOX = '/acme/internalapi/internalapi/inbox/v2/acme/inboxItems?category=Actions&offset=0&limit=100';
const enrollmentItem = {
  relatedItem: {
    title: 'Open Enrollment Change: Pat Doe on 01/01/2027',
    createdDate: '2026-10-26T10:00:00.000Z',
    effectiveDate: '2027-01-01',
    itemType: { descriptor: 'Change Benefits for Open Enrollment' },
  },
  taskToExecute: { label: 'Open', uri: '/acme/d/inst/2363$1/rel-task/2997$1195.htmld' },
  relatedTasks: [{ label: 'View Details', uri: '/acme/d/inst/795$9/rel-task/2997$3463' }],
};

function flow(opts: { failOn?: (form: URLSearchParams) => boolean; noContributePage?: boolean } = {}) {
  let lastCard = '';
  let state: 'open' | 'saved' | 'submitted' = 'open';
  const changed = new Set<string>();
  const cardRoute = (name: string, page: unknown) => () => {
    lastCard = name;
    return page;
  };
  const transport = new FlowTransport({
    '/acme/boot-config': bootConfig,
    [INBOX]: () => ({ total: 1, data: state === 'submitted' ? [] : [enrollmentItem] }),
    '/acme/inst/2363$1/rel-task/2997$1195.htmld': enrollInbox,
    '/acme/inst/795$9/rel-task/2997$3463.htmld': () => (changed.size ? AFTER : BEFORE),
    '/acme/inst/2363$1/rel-task/2997$15223.htmld': LANDING,
    '/acme/inst/8085$1/rel-task/2997$15286.htmld': cardRoute('medical', MEDICAL),
    '/acme/inst/8085$4/rel-task/2997$15286.htmld': cardRoute('hsa', HSA),
    '/acme/inst/8085$5/rel-task/2997$15286.htmld': cardRoute('dcfsa', DCFSA),
    '/acme/inst/8085$2/rel-task/2997$15286.htmld': cardRoute('ci', CI),
    'POST /acme/flowController.htmld': (_: FetchInit, form: URLSearchParams) => {
      if (opts.failOn?.(form)) return { widget: 'root', body: { widget: 'vbox', children: [{ widget: 'errorWidget', message: 'Contribution exceeds the maximum.' }] }, errors: [{ message: 'Contribution exceeds the maximum.' }] };
      const validate = form.get('_eventId_validate');
      if (validate) return changeSummary(validate, form.get(validate));
      if (form.get('_eventId_add') === '1618') return changeSummary('1618', '934$20');
      const submit = form.get('_eventId_submit');
      if (submit === '655') {
        changed.add(lastCard);
        return lastCard === 'hsa' && !opts.noContributePage ? contributePage('7550', { effective: '2027-01-01-08:00' }) : slimConclusion;
      }
      if (submit === '659') return slimConclusion;
      if (submit === '87') {
        state = 'saved';
        return savedConfirmation;
      }
      if (submit === '1632') {
        state = 'submitted';
        return submittedPage;
      }
      return undefined;
    },
    'POST /acme/button/c1/38/1.htmld': saveModal,
    'POST /acme/button/c1/32/1.htmld': signPage,
    'POST /acme/seamless/cancel/task:2997$15286,instance:8085$1,created:1.htmld': { result: 'Ok' },
  });
  return { client: new WorkdayClient({ transport, tenant: 'acme' }), transport };
}

const CHANGES = [
  { planType: 'medical', plan: 'PPO' },
  { planType: 'health savings', annualContribution: 7800 },
  { planType: 'dependent care', waive: true },
];

describe('planBenefitUpdate', () => {
  it('resolves each change from a fresh read, previews from → to, and sends nothing', async () => {
    const { client, transport } = flow();
    const plan = await client.planBenefitUpdate({ changes: CHANGES, action: 'submit' });
    expect(plan.preview).toEqual({
      event: 'Open Enrollment Change: Pat Doe on 01/01/2027',
      deadline: '11/08/2026',
      action: 'submit',
      projectedCostNow: '$524.58',
      changes: [
        { planType: 'USA Medical', from: 'Acme HSA Plan', to: 'Acme PPO' },
        { planType: 'USA Health Savings Account', from: 'HSA Bank, $7,550.00 a year', to: 'HSA Bank, $7,800.00 a year' },
        { planType: 'USA Dependent Care FSA', from: 'Acme FSA Co', to: 'Waived' },
      ],
    });
    expect(transport.posts).toEqual([]);
    expect(typeof plan.revision).toBe('string');
  });

  it('skips a change that is already in place, and refuses a save with nothing to change', async () => {
    const { client } = flow();
    const plan = await client.planBenefitUpdate({
      changes: [{ planType: 'medical', plan: 'Acme HSA Plan' }, { planType: 'critical', waive: true }],
      action: 'submit',
    });
    expect(plan.preview.changes).toEqual([]);
    expect(plan.preview.unchanged).toEqual(['USA Medical (already Acme HSA Plan)', 'USA Critical Illness (already waived)']);
    await expect(
      client.planBenefitUpdate({ changes: [{ planType: 'medical', plan: 'Acme HSA Plan' }], action: 'save' })
    ).rejects.toThrow(/nothing to save/i);
  });

  it('names the choices when a plan type or plan does not match', async () => {
    const { client } = flow();
    await expect(client.planBenefitUpdate({ changes: [{ planType: 'pet', waive: true }], action: 'save' })).rejects.toThrow(
      /USA Medical.*USA Health Savings Account/
    );
    await expect(client.planBenefitUpdate({ changes: [{ planType: 'medical', plan: 'Gold' }], action: 'save' })).rejects.toThrow(
      /Acme PPO.*Acme HSA Plan/
    );
  });

  it('refuses contradictory or malformed changes', async () => {
    const { client } = flow();
    for (const bad of [
      { planType: 'medical', plan: 'PPO', waive: true },
      { planType: 'health savings', waive: true, annualContribution: 100 },
      { planType: 'health savings', annualContribution: -5 },
      { planType: 'medical' },
    ]) {
      await expect(client.planBenefitUpdate({ changes: [bad], action: 'save' }), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(
      client.planBenefitUpdate({ changes: [{ planType: 'medical', plan: 'PPO' }, { planType: 'USA Medical', waive: true }], action: 'save' })
    ).rejects.toThrow(/more than once/);
  });
});

describe('applyBenefitUpdate', () => {
  it('sends the web app\'s exact sequence, signs, submits, and verifies by re-reading', async () => {
    const { client, transport } = flow();
    const plan = await client.planBenefitUpdate({ changes: CHANGES, action: 'submit' });
    transport.posts.length = 0;
    const res = await client.applyBenefitUpdate(plan);

    const steps = transport.posts.map(({ path, form }) => {
      const { sessionSecureToken, clientRequestID, ...rest } = form;
      expect(sessionSecureToken).toBe('TOKEN-1');
      expect(clientRequestID).toMatch(/^[0-9a-f]{32}$/);
      return [path.replace('/acme/', ''), rest];
    });
    const cs = (ref: string, v: string) => expect.stringContaining(`Ref="${ref}" Replaced=""><V>${v}</V>`);
    expect(steps).toEqual([
      // Medical: pick the PPO, release the HSA plan, Confirm and Continue, close.
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_validate: '588/wd:Elect', '588/wd:Elect': '1', 'change-summary': cs('588/wd:Waive', '0') }],
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_validate: '634/wd:Waive', '634/wd:Waive': '1', 'change-summary': cs('634/wd:Elect', '0') }],
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_submit: '655' }],
      ['seamless/cancel/task:2997$15286,instance:8085$1,created:1.htmld', {}],
      // HSA: plan already chosen → Confirm and Continue, set the amount, Save, close.
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_submit: '655', effective: '2027-01-01-08:00' }],
      ['flowController.htmld', { _flowExecutionKey: 'e1s2', _eventId_validate: '648/wd:Annual_Contribution', '648/wd:Annual_Contribution': '7800', effective: '2027-01-01-08:00' }],
      ['flowController.htmld', { _flowExecutionKey: 'e1s2', _eventId_submit: '659', effective: '2027-01-01-08:00' }],
      ['seamless/cancel/task:2997$15286,instance:8085$1,created:1.htmld', { effective: '2027-01-01-08:00' }],
      // Dependent care: waive, Confirm and Continue, close.
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_validate: '582/wd:Waive', '582/wd:Waive': '1', 'change-summary': cs('582/wd:Elect', '0') }],
      ['flowController.htmld', { _flowExecutionKey: 'e1s1', _eventId_submit: '655' }],
      ['seamless/cancel/task:2997$15286,instance:8085$1,created:1.htmld', {}],
      // Review and Sign → I Accept → Submit.
      ['button/c1/32/1.htmld', {}],
      ['flowController.htmld', { _flowExecutionKey: 'e3s1', _eventId_validate: '1630/wd:Employee_Enrollment_Event_Electronic_Signature', '1630/wd:Employee_Enrollment_Event_Electronic_Signature': '1' }],
      ['flowController.htmld', { _flowExecutionKey: 'e3s1', _eventId_add: '1618', '1618': '934$20', '934$20_DID': 'Submit', '934$20_IID': '934$20' }],
      ['flowController.htmld', { _flowExecutionKey: 'e3s1', _eventId_submit: '1632' }],
    ]);
    expect(res).toMatchObject({ action: 'submit', verified: true });
    expect(res.verification).toMatch(/no longer waiting/i);
    expect(JSON.stringify(res)).not.toMatch(/e1s1|TOKEN-1|flowExecutionKey/);
  });

  it('saves for later through the confirmation modal', async () => {
    const { client, transport } = flow();
    const plan = await client.planBenefitUpdate({ changes: [{ planType: 'dependent care', waive: true }], action: 'save' });
    transport.posts.length = 0;
    const res = await client.applyBenefitUpdate(plan);
    const tail = transport.posts.slice(-2).map(({ path, form }) => {
      const { sessionSecureToken, clientRequestID, ...rest } = form;
      return [path, rest];
    });
    expect(tail).toEqual([
      ['/acme/button/c1/38/1.htmld', {}],
      [
        '/acme/flowController.htmld',
        { _flowExecutionKey: 'e2s1', _eventId_submit: '87', 'change-summary': expect.stringContaining('Ref="85/wd:Confirm" Replaced=""><V>1</V>') },
      ],
    ]);
    expect(res).toMatchObject({ action: 'save', verified: true });
    expect(res.verification).toMatch(/USA Dependent Care FSA/);
  });

  it('stops before signing when Workday rejects a step, and says what had already changed', async () => {
    const { client, transport } = flow({ failOn: (f) => f.get('_eventId_validate') === '648/wd:Annual_Contribution' });
    const plan = await client.planBenefitUpdate({ changes: CHANGES, action: 'submit' });
    await expect(client.applyBenefitUpdate(plan)).rejects.toThrow(
      /USA Health Savings Account.*Contribution exceeds the maximum.*USA Medical/s
    );
    expect(transport.posts.some((p) => p.path.includes('/button/'))).toBe(false);
    expect(transport.posts.some((p) => p.form._eventId_submit === '1632')).toBe(false);
  });

  it('stops when an amount is asked for but Workday shows no contribution page', async () => {
    const { client, transport } = flow({ noContributePage: true });
    const plan = await client.planBenefitUpdate({ changes: [{ planType: 'health savings', annualContribution: 7800 }], action: 'submit' });
    await expect(client.applyBenefitUpdate(plan)).rejects.toThrow(/contribution/i);
    expect(transport.posts.some((p) => p.path.includes('/button/'))).toBe(false);
  });
});
