import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';

// Shapes captured live from a production tenant (2026-10). Values invented.

// A worker's "View Goals for Associate" page: a tabContainer whose tabs hold
// `card` widgets — one per goal — each naming its status in
// `headerIndicatorLabel` and its detail in a `/card/all/...` `contentUri`.
// There is no grid and no text widget, so v1 parsed the page as empty.
const goalsPage = {
  widget: 'root',
  tenant: 'acme',
  title: { widget: 'titleStaticText', text: 'View Goals for Associate' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'fieldSet',
        children: [
          { widget: 'commandButton', label: 'Create Goal for Associate', uri: '/acme/task/2998$1' },
        ],
      },
      {
        widget: 'tabContainer',
        tabs: [
          {
            widget: 'tabContent',
            label: 'Individual Goals',
            content: {
              widget: 'panel',
              label: 'Individual Goals',
              children: [
                {
                  widget: 'cardContainer',
                  children: [
                    {
                      widget: 'card',
                      name: 'Goal Card',
                      title: 'Integrate AI into development process',
                      headerIndicatorLabel: 'Completed',
                      headerIndicatorCode: 'green',
                      contentType: 'list card',
                      contentUri: '/acme/card/all/28406$124/39330!CTX1',
                      miniCard: { widget: 'mini' },
                      footerButtons: [
                        { widget: 'cardFooterButton', label: 'Edit Goal', taskUri: '/acme/inst/3591$1/rel-task/2998$3' },
                        { widget: 'cardFooterButton', label: 'View Goal', taskUri: '/acme/inst/3591$1/rel-task/2998$4' },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          {
            widget: 'tabContent',
            label: 'Archived Goals',
            content: {
              widget: 'panel',
              children: [
                {
                  widget: 'card',
                  title: 'Ship the 2025 platform',
                  headerIndicatorLabel: 'Archived',
                  contentUri: '/acme/card/all/28406$124/39330!CTX2',
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

describe('parseTask — card tiles (goal cards)', () => {
  const page = parseTask(goalsPage);

  it('lists each card with its title, status, tab and detail uri', () => {
    expect(page.tiles).toEqual([
      {
        title: 'Integrate AI into development process',
        status: 'Completed',
        group: 'Individual Goals',
        uri: '/acme/card/all/28406$124/39330!CTX1.htmld',
        actions: [
          { label: 'Edit Goal', uri: '/acme/inst/3591$1/rel-task/2998$3.htmld' },
          { label: 'View Goal', uri: '/acme/inst/3591$1/rel-task/2998$4.htmld' },
        ],
      },
      {
        title: 'Ship the 2025 platform',
        status: 'Archived',
        group: 'Archived Goals',
        uri: '/acme/card/all/28406$124/39330!CTX2.htmld',
      },
    ]);
  });

  it('puts the card details on the crawl frontier so expand reads them', () => {
    expect(page.childCards.slice(0, 2).map((c) => c.uri)).toEqual([
      '/acme/card/all/28406$124/39330!CTX1.htmld',
      '/acme/card/all/28406$124/39330!CTX2.htmld',
    ]);
  });

  it('no longer reports a goals page as empty', () => {
    expect(page.kind).toBe('card');
  });
});

describe('parseTask — dashboard worklets and tabs', () => {
  // Every worklet on a dashboard carries the SAME generic launcher taskIid
  // (`3001$26`); the report it shows is `/task/<workletIid>` — verified live.
  const dashboard = {
    widget: 'root',
    tenant: 'acme',
    title: { widget: 'titleStaticText', text: 'Compensation' },
    body: {
      widget: 'landingPage',
      children: [
        { widget: 'landingPageWorklet', label: 'Increase Summary by Performance Rating', taskIid: '3001$26', workletIid: '1422$6224' },
        { widget: 'landingPageWorklet', label: 'Budget Utilization', taskIid: '3001$26', workletIid: '1422$3981' },
      ],
    },
  };
  const tabbed = {
    widget: 'root',
    tenant: 'acme',
    title: { widget: 'titleStaticText', text: 'Year End Dashboard' },
    body: {
      widget: 'landingPageGroup',
      children: [
        { widget: 'landingPageTab', label: 'Compensation', taskIid: '12709$31' },
        { widget: 'landingPageTab', label: '2026 Promotion Considerations', taskIid: '12709$77' },
      ],
    },
  };

  it('points each worklet at its own report, not the shared launcher', () => {
    expect(parseTask(dashboard).navigation).toEqual([
      { label: 'Increase Summary by Performance Rating', instanceId: '3001$26', uri: '/acme/task/1422$6224.htmld' },
      { label: 'Budget Utilization', instanceId: '3001$26', uri: '/acme/task/1422$3981.htmld' },
    ]);
  });

  it('lists dashboard tabs as navigation', () => {
    const page = parseTask(tabbed);
    expect(page.kind).toBe('hub');
    expect(page.navigation).toEqual([
      { label: 'Compensation', instanceId: '12709$31', uri: '/acme/task/12709$31.htmld' },
      { label: '2026 Promotion Considerations', instanceId: '12709$77', uri: '/acme/task/12709$77.htmld' },
    ]);
  });

  it('crawls worklet reports and tabs', () => {
    expect(parseTask(dashboard).childCards.map((c) => c.uri)).toEqual([
      '/acme/task/1422$6224.htmld',
      '/acme/task/1422$3981.htmld',
    ]);
    expect(parseTask(tabbed).childCards.map((c) => c.uri)).toEqual([
      '/acme/task/12709$31.htmld',
      '/acme/task/12709$77.htmld',
    ]);
  });

  it('leaves a worklet without a tenant on the envelope as before', () => {
    const { tenant: _t, ...noTenant } = dashboard;
    expect(parseTask(noTenant).navigation[0]).toEqual({
      label: 'Increase Summary by Performance Rating',
      instanceId: '3001$26',
    });
  });
});
