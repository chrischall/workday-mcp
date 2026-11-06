import { describe, it, expect } from 'vitest';
import {
  parsePlanTypeForm,
  parseContributionForm,
  parseLandingActions,
  parseSaveModal,
  parseSignForm,
  changeSummaryXml,
  isSubmittedPage,
  isSavedPage,
} from '../src/parse-benefits.js';
import {
  landing,
  optionRow,
  planTypeForm,
  contributePage,
  saveModal,
  savedConfirmation,
  signPage,
  submittedPage,
} from './benefits-fixtures.js';

describe('parsePlanTypeForm', () => {
  it('reads the flow handles and each row\'s Select / Waive field ids', () => {
    const page = planTypeForm([
      optionRow('588', 'Acme PPO', '571$1', false, '$200.00', '$600.00'),
      optionRow('634', 'Acme HSA Plan', '571$3', true, '$110.00', '$650.00'),
    ]);
    expect(parsePlanTypeForm(page)).toEqual({
      flowKey: 'e1s1',
      pageId: '655',
      cancelUri: '/acme/seamless/cancel/task:2997$15286,instance:8085$1,created:1',
      rows: [
        { plan: 'Acme PPO', selected: false, electId: '588/wd:Elect', waiveId: '588/wd:Waive' },
        { plan: 'Acme HSA Plan', selected: true, electId: '634/wd:Elect', waiveId: '634/wd:Waive' },
      ],
    });
  });

  it('carries the event date when the page has one', () => {
    const page = planTypeForm([optionRow('1', 'HSA Bank', '3$1', true, '$1', '$1')], { effective: '2027-01-01-08:00' });
    expect(parsePlanTypeForm(page)?.effective).toBe('2027-01-01-08:00');
  });

  it('is undefined without a flow key or body id', () => {
    const page = planTypeForm([optionRow('1', 'A', '1$1', true, '$1', '$1')]) as Record<string, unknown>;
    delete page.flowExecutionKey;
    expect(parsePlanTypeForm(page)).toBeUndefined();
  });
});

describe('parseContributionForm', () => {
  it('reads the annual amount field and the page handles', () => {
    expect(parseContributionForm(contributePage('7550', { effective: '2027-01-01-08:00' }))).toEqual({
      flowKey: 'e1s2',
      pageId: '659',
      annualId: '648/wd:Annual_Contribution',
      annual: 7550,
      effective: '2027-01-01-08:00',
    });
  });

  it('is undefined on a page with no annual amount (a slim conclusion)', () => {
    expect(parseContributionForm({ widget: 'root', flowExecutionKey: 'k', body: { widget: 'vbox', id: '1', children: [{ widget: 'slimConclusion' }] } })).toBeUndefined();
  });
});

describe('parseLandingActions', () => {
  it('finds the Save for Later and Review and Sign POST buttons the read parser hides', () => {
    expect(parseLandingActions(landing)).toEqual({ save: '/acme/button/c1/38/1', review: '/acme/button/c1/32/1' });
  });
});

describe('parseSaveModal', () => {
  it('reads the modal\'s confirm checkbox and handles', () => {
    expect(parseSaveModal(saveModal)).toEqual({ flowKey: 'e2s1', pageId: '87', confirmId: '85/wd:Confirm' });
  });
});

describe('parseSignForm', () => {
  it('reads the signature checkbox and the Submit button of the bar', () => {
    expect(parseSignForm(signPage)).toEqual({
      flowKey: 'e3s1',
      pageId: '1632',
      signatureId: '1630/wd:Employee_Enrollment_Event_Electronic_Signature',
      bar: { id: '1618', submit: '934$20' },
    });
  });
});

describe('outcome pages', () => {
  it('recognises the submitted and saved confirmations, and nothing else', () => {
    expect(isSubmittedPage(submittedPage)).toBe(true);
    expect(isSubmittedPage(savedConfirmation)).toBe(false);
    expect(isSavedPage(savedConfirmation)).toBe(true);
    expect(isSavedPage(signPage)).toBe(false);
  });
});

describe('changeSummaryXml', () => {
  it('builds Workday\'s change summary for one field, escaping the ref', () => {
    expect(changeSummaryXml('582/wd:Waive', '0')).toBe(
      '<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0" xmlns:wd="urn:com.workday/bsvc" ' +
        'xmlns:nyw="urn:com.netyourwork/aod"><wd:Waive Ref="582/wd:Waive" Replaced=""><V>0</V></wd:Waive></wml:Change_Summary>'
    );
    expect(() => changeSummaryXml('5"/wd:X', '1')).toThrow();
  });
});
