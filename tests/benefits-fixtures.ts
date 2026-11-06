// Benefits envelopes shared by the parser and client tests. Shapes mirror a
// production tenant captured live in 2026-11 (annual enrollment season).
// Values are invented; structure is faithful.

export const relatedTasks = {
  widget: 'relatedTasks',
  taskGroups: [
    {
      widget: 'relatedTaskGroup',
      tasks: [
        { widget: 'relatedTask', uri: '/acme/inst/247$1/rel-task/2998$5797', view: true, label: 'View Total Rewards', folder: 'Compensation' },
      ],
    },
    {
      widget: 'relatedTaskGroup',
      taskGroups: [
        {
          widget: 'relatedTaskGroup',
          label: 'Benefits',
          taskGroups: [
            {
              widget: 'relatedTaskGroup',
              tasks: [
                { widget: 'relatedTask', uri: '/acme/inst/247$1/rel-task/2997$1293', view: false, label: 'Change Benefits', folder: 'Benefits' },
                { widget: 'relatedTask', uri: '/acme/inst/247$1/rel-task/2998$3281', view: true, label: 'View My Current Benefit Elections', folder: 'Benefits' },
              ],
            },
            {
              widget: 'relatedTaskGroup',
              tasks: [{ widget: 'relatedTask', uri: '/acme/inst/247$1/rel-task/2998$6508', view: true, label: 'View Dependents', folder: 'Benefits' }],
            },
          ],
        },
      ],
    },
  ],
  instance: { instanceId: '247$1', label: 'Employee' },
};


export const enrollInbox = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Change Benefits for Open Enrollment' },
  sessionSecureToken: 'SECRET',
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'fieldSet',
        children: [
          { widget: 'richTextArea', value: 'USA Annual Enrollment 10/26/2026-11/08/2026', propertyName: 'wd:EventTypeWithStartandEndDates' },
        ],
      },
      { widget: 'text', value: 'Choose new plans or re-enroll in the plans you currently have.', propertyName: 'wd:Instructional_Text' },
      {
        widget: 'commandButton',
        label: "Let's Get Started",
        uri: '/acme/inst/2363$1/rel-task/2997$15223',
        httpMethod: 'GET',
        actionId: 'view',
      },
    ],
  },
};


export const card = (title: string, subtitle: string, label: string, taskUri: string) => ({
  widget: 'card',
  contentType: 'list card',
  title,
  subtitle,
  footerButtons: [{ widget: 'cardFooterButton', label, taskUri }],
});

export const landing = {
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
            headings: [{ widget: 'text', label: 'Formatted Total Employee Cost', value: '$500.00' }],
          },
        ],
      },
      {
        widget: 'panel',
        children: [
          {
            widget: 'panel',
            label: 'Health Care and Accounts',
            children: [
              {
                widget: 'cardContainerWidget',
                cardContainerNode: {
                  widget: 'cardContainer',
                  cards: [
                    card('USA Medical', 'Acme HSA Plan', 'Manage', '/acme/inst/8085$1/rel-task/2997$15286'),
                    card('USA Critical Illness', 'Waived', 'Enroll', '/acme/inst/8085$2/rel-task/2997$15286'),
                  ],
                },
              },
            ],
          },
          {
            widget: 'panel',
            label: 'Insurance',
            children: [
              {
                widget: 'cardContainerWidget',
                cardContainerNode: { widget: 'cardContainer', cards: [card('USA Basic Life', '2X Salary', 'Manage', '/acme/inst/8085$3/rel-task/2997$15286')] },
              },
            ],
          },
        ],
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
};


export const optionRow = (id: string, plan: string, planIid: string, elect: boolean, youPay: string, company: string) => ({
  widget: 'row',
  id,
  cellsMap: {
    '316.1': {
      widget: 'commandButton',
      label: plan,
      uri: `/acme/inst/${planIid}/rel-task/2998$43660`,
      httpMethod: 'GET',
      actionId: 'view',
    },
    '316.2': {
      widget: 'fieldSet',
      children: [
        {
          widget: 'radioGroupInput',
          children: [
            { widget: 'checkBoxInput', label: 'Select', value: elect, id: `${id}/wd:Elect` },
            { widget: 'checkBoxInput', label: 'Waive', value: !elect, id: `${id}/wd:Waive` },
          ],
        },
      ],
    },
    '316.5': { widget: 'text', label: 'You Pay (Per Pay Period (Semi-Monthly))', value: youPay },
    '316.6': { widget: 'textInput', label: 'Company Contribution (Per Pay Period (Semi-Monthly))', value: company },
  },
});

export const managePage = (rows: unknown[]) => ({
  widget: 'root',
  flowExecutionKey: 'FLOW-SECRET',
  title: { widget: 'titleMonikerList', text: 'USA Medical' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'hbox',
        children: [
          {
            widget: 'fieldSet',
            label: 'Plans Available',
            children: [
              { widget: 'text', value: 'Select a plan or Waive to opt out of USA Medical.', propertyName: 'wd:Help_Text' },
              {
                widget: 'chunkedEditGrid',
                columns: [
                  { widget: 'column', label: 'Benefit Plan', columnId: '316.1' },
                  { widget: 'column', label: 'Selection', columnId: '316.2' },
                  { widget: 'column', label: 'You Pay (Per Pay Period (Semi-Monthly))', columnId: '316.5' },
                  { widget: 'column', label: 'Company Contribution (Per Pay Period (Semi-Monthly))', columnId: '316.6' },
                ],
                rows,
                // Workday's layout hints — duplicates of a real row that must not be read as plans.
                maxLengthValueRow: optionRow('max-length-row', 'Ghost Plan', '1$1', true, '$999.00', '$0.00'),
                maxWordLengthValueRow: optionRow('max-length-row', 'Ghost Plan', '1$1', true, '$999.00', '$0.00'),
              },
            ],
          },
          {
            widget: 'fieldSet',
            label: 'Health Care Instructions',
            children: [
              {
                widget: 'panel',
                children: [
                  { widget: 'text', value: 'You can select either Plan A or the Health Care FSA, but not both.', propertyName: 'wd:Benefit_Message' },
                  { widget: 'richTextArea', value: '<p>Pick a plan. <b>EPO is in-network only.</b></p>', propertyName: 'wd:Enrollment_Instructional_Text' },
                ],
              },
            ],
          },
        ],
      },
      {
        widget: 'mutexButtonBar',
        children: [{ widget: 'mutexButton', mutex: { widget: 'checkBoxInput', label: 'Confirm and Continue', value: true } }],
      },
    ],
  },
});


export const ratePanel = (cost: string, tier: string) => ({
  widget: 'panel',
  children: [
    {
      widget: 'fieldSet',
      horizontal: true,
      children: [
        { widget: 'text', value: cost, propertyName: 'wd:Formatted_Currency' },
        { widget: 'monikerList', instances: [{ widget: 'moniker', instanceId: '546$1', text: tier }] },
      ],
    },
  ],
});

export const planDetails = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Acme PPO' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'fieldSet',
        label: 'Resources',
        children: [
          {
            widget: 'panel',
            children: [
              {
                widget: 'monikerList',
                label: 'Provider Website',
                instances: [{ widget: 'moniker', instanceId: '840$1', text: 'Acme Health', action: 'URL', target: 'https%3A%2F%2Fwww.acme-health.example%2F' }],
              },
            ],
          },
        ],
      },
      {
        widget: 'fieldSet',
        label: 'You Pay (Per Pay Period (Semi-Monthly))',
        children: [
          {
            widget: 'panelList',
            panels: [ratePanel('$80.00', 'Associate'), ratePanel('$250.00', 'Associate + Spouse'), ratePanel('$380.00', 'Associate + Family')],
          },
        ],
      },
    ],
  },
};


// ---------------------------------------------------------------------------
// Write-side pages. Protocol captured live 2026-11 from the web app while the
// user made their own 2027 elections (ids and values invented):
//   pick a plan    → _eventId_validate=<row>/wd:Elect, <row>/wd:Elect=1,
//                    change-summary (the paired Waive → 0)
//   confirm a type → _eventId_submit=<page body id>  (Confirm and Continue)
//   an amount      → _eventId_validate=<id>/wd:Annual_Contribution, <id>=7800,
//                    then _eventId_submit=<contribute page body id>
//   close a type   → POST the page's seamlessSaveCancelUri
//   save           → POST "Save for Later" button, then _eventId_submit=<modal
//                    body id> + change-summary (the modal's Confirm → 1)
//   submit         → POST "Review and Sign" button, _eventId_validate the
//                    signature =1, _eventId_add the Submit bpfButton, commit
// ---------------------------------------------------------------------------

/** A plan type's page as the write path reads it (flow key, body id, row ids). */
export const planTypeForm = (rows: unknown[], extra: Record<string, unknown> = {}) => {
  const page = managePage(rows) as Record<string, any>;
  page.body.id = '655';
  page.flowExecutionKey = 'e1s1';
  page.sessionSecureToken = 'TOKEN-1';
  page.seamlessSaveCancelUri = '/acme/seamless/cancel/task:2997$15286,instance:8085$1,created:1';
  return { ...page, ...extra };
};

export const contributePage = (annual: string, extra: Record<string, unknown> = {}) => ({
  widget: 'root',
  flowExecutionKey: 'e1s2',
  title: { widget: 'titleMonikerList', text: 'USA Health Savings Account - HSA Bank' },
  body: {
    widget: 'vbox',
    id: '659',
    children: [
      {
        widget: 'fieldSet',
        label: 'Contribute',
        children: [
          { widget: 'currencyInput', label: 'Per Paycheck', value: 300, id: '647/wd:Per_Paycheck_Contribution', propertyName: 'wd:Per_Paycheck_Contribution' },
          { widget: 'currencyInput', label: 'Annual', value: Number(annual), id: '648/wd:Annual_Contribution', propertyName: 'wd:Annual_Contribution' },
          { widget: 'text', label: 'Maximum Annual Amount', value: 'Maximum Annual Amount: $9,000.00' },
        ],
      },
    ],
  },
  ...extra,
});

export const slimConclusion = {
  widget: 'root',
  flowExecutionKey: 'e1s3',
  body: { widget: 'vbox', id: '700', children: [{ widget: 'slimConclusion' }] },
};

export const changeSummary = (nodeId: string, value: unknown) => ({
  widget: 'changeSummary',
  changes: [{ widget: 'update', nodeId, node: { value } }],
  flowKey: 'e1s1',
});

export const saveModal = {
  widget: 'root',
  flowExecutionKey: 'e2s1',
  title: { widget: 'titleStaticText', text: 'Save Without Submitting?' },
  body: {
    widget: 'vbox',
    id: '87',
    children: [
      { widget: 'text', value: 'You haven’t completed your enrollment.', propertyName: 'wd:Save_for_Later_Modal_Text' },
      {
        widget: 'mutexButtonBar',
        children: [
          { widget: 'mutexButton', mutex: { widget: 'checkBoxInput', label: 'Save Without Submitting', value: false, id: '85/wd:Confirm' } },
        ],
      },
    ],
  },
};

export const savedConfirmation = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Save For Later Confirmation' },
  xmlName: 'Save_for_Later_Confirmation',
  body: { widget: 'vbox', children: [{ widget: 'text', value: 'You’ve saved your benefits in a draft.', propertyName: 'wd:Save_for_Later_Confirmation_Text' }] },
};

export const signPage = {
  widget: 'root',
  flowExecutionKey: 'e3s1',
  title: { widget: 'titleStaticText', text: 'View Summary' },
  body: {
    widget: 'vbox',
    id: '1632',
    children: [
      { widget: 'richTextArea', value: '<p>By submitting your benefit choices you authorize deductions.</p>', propertyName: 'wd:Electronic_Signature_Text' },
      { widget: 'checkBoxInput', label: 'I Accept', value: false, id: '1630/wd:Employee_Enrollment_Event_Electronic_Signature', propertyName: 'wd:Employee_Enrollment_Event_Electronic_Signature' },
      {
        widget: 'bpfButtonBar',
        id: '1618',
        bpfButtons: [
          { widget: 'bpfButton', label: 'Submit', valueIid: '934$20' },
          { widget: 'bpfButton', label: 'Cancel', valueIid: '934$9' },
        ],
      },
    ],
  },
};

export const submittedPage = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: "You've submitted your elections." },
  xmlName: 'Benefits_Enrollment_Submitted_Successfully_View',
  body: { widget: 'vbox', children: [] },
};
