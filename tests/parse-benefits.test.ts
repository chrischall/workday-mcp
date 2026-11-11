import { describe, it, expect } from 'vitest';
import {
  parseRelatedTaskCatalog,
  parseEnrollmentEvent,
  parseEnrollmentLanding,
  parsePlanOptions,
  parsePlanRates,
  money,
} from '../src/parse-benefits.js';
import { relatedTasks, enrollInbox, landing, managePage, optionRow, planDetails } from './benefits-fixtures.js';

describe('parseRelatedTaskCatalog', () => {
  it('flattens nested task groups, keeping each task\'s folder and whether it is a view', () => {
    const tasks = parseRelatedTaskCatalog(relatedTasks);
    expect(tasks).toContainEqual({
      folder: 'Benefits',
      label: 'View My Current Benefit Elections',
      uri: '/acme/inst/247$1/rel-task/2998$3281',
      view: true,
    });
    expect(tasks).toContainEqual({
      folder: 'Benefits',
      label: 'Change Benefits',
      uri: '/acme/inst/247$1/rel-task/2997$1293',
      view: false,
    });
    expect(tasks.filter((t) => t.folder === 'Benefits')).toHaveLength(3);
  });

  it('falls back to the enclosing group label when a task has no folder', () => {
    const tasks = parseRelatedTaskCatalog({
      widget: 'relatedTasks',
      taskGroups: [{ widget: 'relatedTaskGroup', label: 'Benefits', tasks: [{ widget: 'relatedTask', uri: '/u', view: true, label: 'X' }] }],
    });
    expect(tasks).toEqual([{ folder: 'Benefits', label: 'X', uri: '/u', view: true }]);
  });

  it('returns nothing for a page that is not a related-task catalog', () => {
    expect(parseRelatedTaskCatalog({ widget: 'root' })).toEqual([]);
    expect(parseRelatedTaskCatalog(null)).toEqual([]);
  });
});

describe('parseEnrollmentEvent', () => {
  it('reads the event name, its window, the instructions and the GET entry into the elections', () => {
    expect(parseEnrollmentEvent(enrollInbox)).toEqual({
      event: 'USA Annual Enrollment',
      opens: '10/26/2026',
      closes: '11/08/2026',
      instructions: 'Choose new plans or re-enroll in the plans you currently have.',
      startUri: '/acme/inst/2363$1/rel-task/2997$15223',
    });
  });

  it('never offers a POST button as the entry', () => {
    const post = structuredClone(enrollInbox);
    (post.body.children[2] as Record<string, unknown>).httpMethod = 'POST';
    expect(parseEnrollmentEvent(post).startUri).toBeUndefined();
  });

  it('keeps the raw text when the window does not parse', () => {
    const odd = structuredClone(enrollInbox);
    (odd.body.children[0] as { children: Array<{ value: string }> }).children[0].value = 'Benefits Change';
    expect(parseEnrollmentEvent(odd)).toMatchObject({ event: 'Benefits Change' });
    expect(parseEnrollmentEvent(odd).closes).toBeUndefined();
  });
});

describe('parseEnrollmentLanding', () => {
  it('lists every plan type with its current choice, grouped by panel, and the projected cost', () => {
    expect(parseEnrollmentLanding(landing)).toEqual({
      projectedCost: '$500.00',
      costPeriod: 'Per Pay Period (Semi-Monthly)',
      planTypes: [
        { group: 'Health Care and Accounts', planType: 'USA Medical', current: 'Acme HSA Plan', waived: false, uri: '/acme/inst/8085$1/rel-task/2997$15286' },
        { group: 'Health Care and Accounts', planType: 'USA Critical Illness', current: 'Waived', waived: true, uri: '/acme/inst/8085$2/rel-task/2997$15286' },
        { group: 'Insurance', planType: 'USA Basic Life', current: '2X Salary', waived: false, uri: '/acme/inst/8085$3/rel-task/2997$15286' },
      ],
    });
  });

  it('never surfaces the Save for Later / Review and Sign command buttons', () => {
    expect(JSON.stringify(parseEnrollmentLanding(landing))).not.toMatch(/button\/c1/);
  });
});

describe('parsePlanOptions', () => {
  const page = managePage([
    optionRow('588', 'Acme PPO', '571$1', false, '$200.00', '$600.00'),
    optionRow('634', 'Acme HSA Plan', '571$3', true, '$120.00', '$700.00'),
  ]);

  it('reads each offered plan with its cost, company contribution and whether it is your current pick', () => {
    expect(parsePlanOptions(page)).toEqual({
      planType: 'USA Medical',
      costPeriod: 'Per Pay Period (Semi-Monthly)',
      plans: [
        { plan: 'Acme PPO', selected: false, youPay: '$200.00', companyPays: '$600.00', detailsUri: '/acme/inst/571$1/rel-task/2998$43660' },
        { plan: 'Acme HSA Plan', selected: true, youPay: '$120.00', companyPays: '$700.00', detailsUri: '/acme/inst/571$3/rel-task/2998$43660' },
      ],
      notes: [
        'Select a plan or Waive to opt out of USA Medical.',
        'You can select either Plan A or the Health Care FSA, but not both.',
      ],
      instructions: 'Pick a plan. **EPO is in-network only.**',
    });
  });

  it('marks a type as waived when no plan is selected', () => {
    const waived = managePage([optionRow('1', 'Voya 10K', '571$9', false, '$7.00', '')]);
    const parsed = parsePlanOptions(waived);
    expect(parsed?.waived).toBe(true);
    expect(parsed?.plans[0]).not.toHaveProperty('companyPays');
  });

  it('reads a contribution column ("You Contribute") as youPay too', () => {
    const hsa = managePage([optionRow('1', 'HSA Bank', '3253$1', true, '$300.00', '$50.00')]);
    const grid = (hsa.body.children[0] as any).children[0].children[1];
    grid.columns[2].label = 'You Contribute (Per Pay Period (Semi-Monthly))';
    expect(parsePlanOptions(hsa)?.plans[0]).toMatchObject({ plan: 'HSA Bank', youPay: '$300.00' });
  });

  it('never leaks the flow key and returns undefined for a page without a plan grid', () => {
    expect(JSON.stringify(parsePlanOptions(page))).not.toContain('FLOW-SECRET');
    expect(parsePlanOptions({ widget: 'root', body: { widget: 'vbox', children: [] } })).toBeUndefined();
  });
});

describe('parsePlanRates', () => {
  it('reads the per-coverage-level price table and the provider website', () => {
    expect(parsePlanRates(planDetails)).toEqual({
      plan: 'Acme PPO',
      provider: 'Acme Health',
      providerUrl: 'https://www.acme-health.example/',
      rates: [
        { coverage: 'Associate', youPay: '$80.00' },
        { coverage: 'Associate + Spouse', youPay: '$250.00' },
        { coverage: 'Associate + Family', youPay: '$380.00' },
      ],
    });
  });

  it('only keeps an http(s) provider url', () => {
    const js = structuredClone(planDetails);
    (js.body.children[0] as any).children[0].children[0].instances[0].target = 'javascript%3Aalert(1)';
    expect(parsePlanRates(js)).not.toHaveProperty('providerUrl');
  });
});

describe('money', () => {
  it('parses Workday currency text, including parentheses for negatives', () => {
    expect(money('$1,234.56')).toBe(1234.56);
    expect(money('($12.00)')).toBe(-12);
    expect(money('$7,550.00 Annual')).toBe(7550);
    expect(money(undefined)).toBeUndefined();
    expect(money('2 X Salary')).toBeUndefined();
  });
});
