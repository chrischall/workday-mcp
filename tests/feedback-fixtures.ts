// Shapes mirror a production tenant's Give Feedback, Get Feedback on Self and
// Get Feedback on Associate flows, captured live 2026-11-10 (up to Submit,
// then cancelled). Values are invented; structure is faithful.

const sharing = (who: string, prefix: string) => ({
  widget: 'radioGroupInput',
  id: `${prefix}.141`,
  label: 'Feedback Sharing',
  required: true,
  children: [
    { widget: 'checkBoxInput', id: `${prefix}/wd:Feedback_Confidential`, label: `Don't share with ${who}`, required: true, hideAdvice: 'ALWAYS', value: false },
    { widget: 'checkBoxInput', id: `${prefix}/wd:Feedback_Private`, label: `Share with ${who}`, required: true, hideAdvice: 'ALWAYS', value: false },
    { widget: 'checkBoxInput', id: `${prefix}/wd:Show_Feedback_to_Everyone`, label: 'Share with others', required: true, hideAdvice: 'ALWAYS', value: true },
  ],
});

const bar = (id: string) => ({
  widget: 'bpfButtonBar',
  id,
  required: true,
  bpfButtons: [
    { widget: 'bpfButton', label: 'Submit', valueIid: '934$20' },
    { widget: 'bpfButton', label: 'Save for Later', valueIid: '934$14' },
  ],
});

/** The associate prompt that opens Give Feedback / Get Feedback on Associate. */
export const associatePrompt = {
  widget: 'root',
  flowExecutionKey: 'e5s1',
  sessionSecureToken: 'SECRET-TOKEN',
  body: {
    widget: 'vbox',
    id: '72',
    children: [{ widget: 'monikerListInput', id: '66', label: 'Associates', contextId: 'c0', required: true }],
  },
};

export const giveForm = {
  widget: 'root',
  flowExecutionKey: 'e5s2',
  sessionSecureToken: 'SECRET-TOKEN',
  body: {
    widget: 'vbox',
    id: '944',
    children: [
      {
        widget: 'fieldSet',
        id: '944.63',
        label: 'Give Feedback to',
        children: [{ widget: 'monikerList', id: '819', instances: [{ widget: 'moniker', instanceId: '247$7', text: 'Pat Doe' }] }],
      },
      {
        widget: 'panel',
        id: '852',
        children: [
          { widget: 'checkBoxInput', id: '852/wd:Display_Name_of_Responder', label: 'Show my name?', hideAdvice: 'ALWAYS', value: true },
          sharing('Pat Doe', '852'),
          { widget: 'richTextAreaInput', id: '852/wd:Response_Comment', label: 'Feedback', required: true },
        ],
      },
      {
        widget: 'dropDownSelectList',
        id: '850',
        label: 'Badge',
        instances: [
          { widget: 'dropDownSelectOption', id: '850.948', instanceId: '16411$3', text: 'I act decisively and get things done' },
          { widget: 'dropDownSelectOption', id: '850.951', instanceId: '16411$2', text: 'I own it' },
          { widget: 'dropDownSelectOption', id: '850.953', instanceId: '16411$6', text: 'I think like a customer' },
        ],
      },
      { widget: 'monikerListInput', id: '851', label: 'Associates to Notify', contextId: 'c1', hideAdvice: 'ALWAYS' },
      bar('931'),
    ],
  },
};

export const requestForm = {
  widget: 'root',
  flowExecutionKey: 'e7s1',
  sessionSecureToken: 'SECRET-TOKEN',
  body: {
    widget: 'vbox',
    id: '1051',
    children: [
      { widget: 'monikerList', id: '891', label: 'Associate', instances: [{ widget: 'moniker', instanceId: '247$1', text: 'Me Myself' }] },
      { widget: 'monikerListInput', id: '948', label: 'Who do you want to request feedback from?', required: true, contextId: 'c3' },
      { widget: 'dateInput', id: '956/wd:Get_Feedback_Expiration_Date', label: 'Expiration Date', hideAdvice: 'ALWAYS' },
      { widget: 'checkBoxInput', id: '956/wd:Anonymous_Feedback', label: 'Make Feedback Anonymous', hideAdvice: 'ALWAYS', value: false },
      sharing('Me Myself', '956'),
      {
        widget: 'fieldSet',
        id: '1051.80',
        label: 'Questions',
        children: [
          { widget: 'monikerListInput', id: '949', label: 'Feedback Template', contextId: 'c3' },
          { widget: 'monikerListInput', id: '950', label: 'Skills for Endorsement', contextId: 'c3', hideAdvice: 'ALWAYS' },
          { widget: 'editPanelList', id: '956.217', rowCount: 0 },
        ],
      },
      bar('1035'),
    ],
  },
};

/** changeSummary for adding an empty question row. */
export const questionRowAdded = (id: string) => ({
  widget: 'changeSummary',
  changes: [
    {
      widget: 'addChild',
      fieldName: 'panels',
      children: [
        {
          widget: 'panel',
          id,
          children: [
            { widget: 'richTextAreaInput', required: true, label: 'Question', id: `${id}/wd:Feedback_Question` },
            { widget: 'monikerList', hideAdvice: 'ALWAYS', label: 'Question Type', id: `${Number(id) + 1}` },
          ],
        },
      ],
      containerId: '956.217',
    },
  ],
});

/** changeSummary for choosing a template: its questions replace the rows. */
export const templateChosen = {
  widget: 'changeSummary',
  changes: [
    { widget: 'addChild', fieldName: 'instances', children: [{ widget: 'moniker', instanceId: '12503$1', text: 'Feedback on Me', id: '1362' }], containerId: '949' },
    { widget: 'removeChild', fieldName: 'panels', removeIds: ['1354'], containerId: '956.217' },
    {
      widget: 'addChild',
      fieldName: 'panels',
      children: [
        {
          widget: 'panel',
          id: '1533',
          children: [
            {
              widget: 'richTextAreaInput',
              label: 'Question',
              value: '<p style="text-align:left">Please provide me feedback on what I can do differently?</p>​',
              id: '1533/wd:Feedback_Question',
            },
          ],
        },
        {
          widget: 'panel',
          id: '1540',
          children: [
            { widget: 'richTextAreaInput', label: 'Question', value: '<p>What did I do well?</p>', id: '1540/wd:Feedback_Question' },
          ],
        },
      ],
      containerId: '956.217',
    },
  ],
};

/** A template whose question carries a blank to fill in — the live
 *  "Aspiring Leader" template's shape. */
export const templateWithBlank = {
  widget: 'changeSummary',
  changes: [
    { widget: 'addChild', fieldName: 'instances', children: [{ widget: 'moniker', instanceId: '12503$4', text: 'Aspiring Leader', id: '1370' }], containerId: '949' },
    {
      widget: 'addChild',
      fieldName: 'panels',
      children: [
        {
          widget: 'panel',
          id: '1600',
          allowRemove: true,
          children: [
            {
              widget: 'richTextAreaInput',
              label: 'Question',
              value: '<p style="text-align:left">I’d like your feedback on how I’m doing on <b>[ENTER BEHAVIOR]</b>. What is your suggestion?</p>',
              id: '1600/wd:Feedback_Question',
            },
          ],
        },
      ],
      containerId: '956.217',
    },
  ],
};
