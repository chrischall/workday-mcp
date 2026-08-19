import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';

// Every fixture below mirrors a widget shape captured live from a production
// tenant (2026-08). VALUES are invented; STRUCTURE is faithful — including the
// three template dialects and the URL-encoded `target` edge, each of which the
// v1 parser mishandled.

describe('parseTask — grid (the table widget most manager data arrives in)', () => {
  const gridPage = {
    widget: 'root',
    title: 'Management Chain',
    sessionSecureToken: 'SECRET-DO-NOT-LEAK',
    body: {
      widget: 'vbox',
      children: [
        {
          widget: 'grid',
          label: 'Supervisory Management Chain',
          gridType: 'LIST',
          rowCount: 2,
          deepRowCount: 6,
          chunkingUrl: '/acme/chunkablegrid/c10/98.24',
          excelLink: { uri: '/acme/export/c10.xlsx' },
          columns: [
            { widget: 'column', columnId: '24.1', label: 'Organization' },
            { widget: 'column', columnId: '24.2', label: 'Manager' },
            { widget: 'column', columnId: '24.3', label: 'Phone Number' },
          ],
          rows: [
            {
              widget: 'row',
              rowIndex: 0,
              id: 'r0',
              cellsMap: {
                '24.1': { widget: 'text', value: 'Engineering' },
                '24.2': {
                  widget: 'monikerList',
                  selfUriTemplate: '/acme/inst/1$715/{id}',
                  instances: [{ widget: 'moniker', text: 'Jane Boss', instanceId: '247$1' }],
                },
                '24.3': { widget: 'text', value: '+1 555 0100' },
              },
            },
            {
              widget: 'row',
              rowIndex: 1,
              id: 'r1',
              cellsMap: {
                '24.1': { widget: 'text', value: 'Platform' },
                '24.2': {
                  widget: 'monikerList',
                  instances: [{ widget: 'moniker', text: 'Sam Lead', instanceId: '247$2' }],
                },
              },
            },
          ],
        },
      ],
    },
  };

  const parsed = parseTask(gridPage);

  it('reads the grid as a real table keyed by COLUMN LABEL', () => {
    expect(parsed.grids).toHaveLength(1);
    const g = parsed.grids[0];
    expect(g.label).toBe('Supervisory Management Chain');
    expect(g.columns).toEqual(['Organization', 'Manager', 'Phone Number']);
    expect(g.rows[0].cells).toEqual({
      Organization: 'Engineering',
      Manager: 'Jane Boss',
      'Phone Number': '+1 555 0100',
    });
  });

  it('tolerates a row that omits a column', () => {
    expect(parsed.grids[0].rows[1].cells).toEqual({
      Organization: 'Platform',
      Manager: 'Sam Lead',
    });
  });

  it('keeps each row drill-in reference, resolving a {id} template', () => {
    expect(parsed.grids[0].rows[0].references[0]).toMatchObject({
      value: 'Jane Boss',
      instanceId: '247$1',
      uri: '/acme/inst/1$715/247$1',
    });
  });

  it('surfaces paging + export so a truncated grid is not mistaken for the whole set', () => {
    const g = parsed.grids[0];
    expect(g.rowCount).toBe(2);
    expect(g.totalRowCount).toBe(6);
    expect(g.pagingUri).toBe('/acme/chunkablegrid/c10/98.24');
    expect(g.excel).toBe('/acme/export/c10.xlsx');
  });

  it('marks the page kind and leaks nothing', () => {
    expect(parsed.kind).toBe('grid');
    expect(JSON.stringify(parsed)).not.toContain('SECRET-DO-NOT-LEAK');
  });
});

describe('parseTask — worker profile (compositeView)', () => {
  const profilePage = {
    widget: 'root',
    title: 'View Associate',
    body: {
      widget: 'compositeView',
      compositeView: {
        widget: 'compositeList',
        children: [
          {
            widget: 'compositeViewSection',
            label: 'Job',
            taskNodes: [
              {
                widget: 'compositeViewTask',
                label: 'Job Details',
                uri: '/acme/inst/1508$1/rel-task/2998$6445',
              },
              {
                widget: 'compositeViewTask',
                label: 'Management Chain',
                uri: '/acme/inst/1508$1/rel-task/2998$6290',
              },
            ],
          },
          {
            widget: 'compositeViewSection',
            label: 'Compensation',
            taskNodes: [
              {
                widget: 'compositeViewTask',
                label: 'Compensation',
                uri: '/acme/inst/1508$1/rel-task/2998$6374',
              },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseTask(profilePage);

  it('exposes the profile as sections of named, fetchable drill-in tasks', () => {
    expect(parsed.kind).toBe('profile');
    expect(parsed.profile?.sections.map((s) => s.label)).toEqual(['Job', 'Compensation']);
    expect(parsed.profile?.sections[0].tasks).toEqual([
      { label: 'Job Details', uri: '/acme/inst/1508$1/rel-task/2998$6445.htmld' },
      { label: 'Management Chain', uri: '/acme/inst/1508$1/rel-task/2998$6290.htmld' },
    ]);
  });

  it('appends .htmld — the bare rel-task uri 404s', () => {
    expect(parsed.profile?.sections[1].tasks[0].uri).toMatch(/\.htmld$/);
  });
});

describe('parseTask — org chart (hierarchyNavigator)', () => {
  const orgPage = {
    widget: 'root',
    title: 'Org Chart',
    body: {
      widget: 'hierarchyNavigator',
      workerIid: '247$100',
      ancestors: [
        {
          widget: 'navigatorDetail',
          relationship: 'ancestor',
          hasChildren: true,
          childrenAndPeersCount: 4,
          navigatorInstance: {
            widget: 'navigatorList',
            selfUriTemplate: '/acme/inst/1$715/247$9',
            instances: [{ widget: 'moniker', text: 'Top Boss', instanceId: '247$9' }],
          },
          navigatorItems: [
            {
              widget: 'navigatorItem',
              detailOne: 'EVP, Technology',
              detailTwo: 'Remote - NY',
              detailThree: '4',
            },
          ],
        },
      ],
      navigatorDetail: {
        widget: 'navigatorDetail',
        relationship: 'direct',
        hasChildren: true,
        childrenAndPeersCount: 8,
        navigatorInstance: {
          widget: 'navigatorList',
          selfUriTemplate: '/acme/inst/1$715/247$42',
          instances: [{ widget: 'moniker', text: 'Sam Report', instanceId: '247$42' }],
        },
        navigatorItems: [
          {
            widget: 'navigatorItem',
            detailOne: 'Sr Engineer',
            detailTwo: 'Remote - TX',
            detailThree: '0',
          },
        ],
      },
    },
  };

  const parsed = parseTask(orgPage);

  it('reads the reporting chain and the nodes, with profile uris to drill into', () => {
    expect(parsed.kind).toBe('orgchart');
    expect(parsed.org?.workerId).toBe('247$100');
    expect(parsed.org?.ancestors[0]).toMatchObject({
      name: 'Top Boss',
      title: 'EVP, Technology',
      location: 'Remote - NY',
      reportCount: '4',
      relationship: 'ancestor',
      profileUri: '/acme/inst/1$715/247$9.htmld',
    });
    expect(parsed.org?.nodes[0]).toMatchObject({
      name: 'Sam Report',
      title: 'Sr Engineer',
      instanceId: '247$42',
      childrenAndPeersCount: 8,
    });
  });
});

describe('parseTask — app hub navigation (landingPage)', () => {
  const hubPage = {
    widget: 'root',
    title: 'My Team Management',
    body: {
      widget: 'landingPage',
      children: [
        {
          widget: 'landingPageWorklet',
          label: 'My Team',
          taskIid: '2997$2151',
          workletIid: '501$326',
        },
        {
          widget: 'landingPageMenuItem',
          link: {
            widget: 'monikerList',
            label: 'Menu Item Quicklink',
            instances: [
              {
                widget: 'moniker',
                instanceId: '3395$106',
                text: 'Request Compensation Change',
                action: 'URL',
                target: 'https%3A%2F%2Fwd5.myworkday.com%2Facme%2Fd%2Ftask%2F2997%244913.htmld',
              },
            ],
          },
        },
      ],
    },
  };

  const parsed = parseTask(hubPage);

  it('lists worklets and quicklinks as one navigation menu', () => {
    expect(parsed.kind).toBe('hub');
    expect(parsed.navigation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'My Team', instanceId: '2997$2151' }),
        expect.objectContaining({
          label: 'Request Compensation Change',
          // target decoded, /d/ stripped, made tenant-relative
          uri: '/acme/task/2997$4913.htmld',
        }),
      ])
    );
  });
});

describe('parseTask — template dialects and target decoding', () => {
  it('resolves {id}, [IID] and already-concrete templates alike', () => {
    const page = {
      body: {
        cardContentSections: [
          {
            contentSectionName: 'Refs',
            contentSectionItems: [
              {
                widget: 'monikerList',
                label: 'Curly',
                selfUriTemplate: '/acme/worker/{id}.htmld',
                instances: [{ widget: 'moniker', text: 'A', instanceId: 'w1' }],
              },
              {
                widget: 'monikerList',
                label: 'Bracket',
                selfUriTemplate: '/acme/navigable/[IID]',
                instances: [{ widget: 'moniker', text: 'B', instanceId: 'w2' }],
              },
              {
                widget: 'monikerList',
                label: 'Concrete',
                selfUriTemplate: '/acme/inst/1$715/w3',
                instances: [{ widget: 'moniker', text: 'C', instanceId: 'w3' }],
              },
            ],
          },
        ],
      },
    };
    const refs = parseTask(page).sections[0].references;
    expect(refs.find((r) => r.value === 'A')?.uri).toBe('/acme/worker/w1.htmld');
    expect(refs.find((r) => r.value === 'B')?.uri).toBe('/acme/navigable/w2');
    expect(refs.find((r) => r.value === 'C')?.uri).toBe('/acme/inst/1$715/w3');
  });

  it('prefers a moniker `target` over a template, decoding and de-SPA-ing it', () => {
    const page = {
      body: {
        cardContentSections: [
          {
            contentSectionName: 'Links',
            contentSectionItems: [
              {
                widget: 'monikerList',
                label: 'Task',
                selfUriTemplate: '/acme/inst/{id}',
                instances: [
                  {
                    widget: 'moniker',
                    text: 'Open Task',
                    instanceId: 'x1',
                    action: 'URL',
                    target: 'https%3A%2F%2Fwd5.myworkday.com%2Facme%2Fd%2Ftask%2F2997%244913.htmld',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(parseTask(page).sections[0].references[0].uri).toBe('/acme/task/2997$4913.htmld');
  });
});

describe('parseTask — report prompt forms', () => {
  // Many Workday "cards" are really PARAMETER FORMS: you must POST prompt
  // values to get results. They parse as an empty page otherwise, which reads
  // as "no data" when the truth is "this one needs inputs".
  const promptPage = {
    widget: 'root',
    title: 'Q2 Check-In Process Status',
    body: {
      widget: 'vbox',
      children: [
        {
          widget: 'panel',
          children: [
            { widget: 'monikerListInput', label: 'Organization', required: true },
            { widget: 'textInput', label: 'Worker Name' },
            { widget: 'checkBoxInput', label: 'Include Subordinate Orgs' },
            { widget: 'textArea', label: 'Comment' },
          ],
        },
      ],
    },
  };

  it('recognises a prompt form and lists the parameters it wants', () => {
    const parsed = parseTask(promptPage);
    expect(parsed.kind).toBe('prompt');
    expect(parsed.prompts).toEqual([
      { label: 'Organization', type: 'monikerListInput', required: true },
      { label: 'Worker Name', type: 'textInput' },
      { label: 'Include Subordinate Orgs', type: 'checkBoxInput' },
      { label: 'Comment', type: 'textArea' },
    ]);
  });

  it('does not mistake a data page for a prompt', () => {
    const dataPage = {
      body: {
        cardContentSections: [
          {
            contentSectionName: 'Pay',
            contentSectionItems: [{ widget: 'text', label: 'Base', value: '100' }],
          },
        ],
      },
    };
    expect(parseTask(dataPage).kind).toBe('card');
    expect(parseTask(dataPage).prompts).toBeUndefined();
  });
});
