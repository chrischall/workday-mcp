// Shapes mirror a production tenant captured live in 2026-11 (a custom
// position-management report and a "Year End Dashboard" landing page).
// Values are invented; structure is faithful.

export const promptPage = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Position Report' },
  flowExecutionKey: 'e1s1',
  sessionSecureToken: 'SECRET-TOKEN',
  body: {
    widget: 'vbox',
    id: '189',
    children: [
      { widget: 'textArea', id: '189/wd:Instructions', label: 'Instructions', value: 'Pick an org.' },
      {
        widget: 'panel',
        id: '187',
        children: [
          { widget: 'monikerListInput', id: '184', label: 'Acquisition', contextId: 'c6' },
          { widget: 'dateInput', id: '187/wd:Effective_Time', label: 'Effective as of Date and Time' },
          {
            widget: 'monikerListInput',
            id: '180',
            label: 'Staffing Status',
            contextId: 'c6',
            instances: [
              { widget: 'moniker', id: '177', instanceId: '4477$2', text: 'Filled' },
              { widget: 'moniker', id: '178', instanceId: '4477$4', text: 'Open' },
            ],
          },
          {
            widget: 'monikerListInput',
            id: '174',
            label: 'Supervisory Organization',
            contextId: 'c6',
            required: true,
            instances: [{ widget: 'moniker', id: '173', instanceId: '2500$1', text: 'Executive - CEO (Top Boss)' }],
          },
          {
            widget: 'checkBoxInput',
            id: '187/wd:Include_Subordinate_Organizations',
            label: 'Include Subordinate Organizations',
            value: true,
          },
        ],
      },
    ],
  },
};

export const dashboardTab = {
  widget: 'root',
  body: {
    widget: 'landingPage',
    children: [
      {
        widget: 'landingPageWorklet',
        label: 'Increase Summary by Performance Rating',
        taskIid: '3001$26',
        workletIid: '1422$6224',
      },
      { widget: 'landingPageWorklet', label: 'Budget Utilization', taskIid: '3001$26', workletIid: '1422$3981' },
    ],
    landingPageMenu: {
      widget: 'landingPageMenu',
      landingPageMenuSections: [
        {
          widget: 'landingPageMenuGroup',
          label: 'Links to Reports',
          landingPageMenuItems: [
            {
              widget: 'landingPageMenuItem',
              button: {
                widget: 'commandButton',
                label: 'Compensation Review Process View Organization',
                uri: '/acme/task/2997$10377',
                taskId: '2997$10377',
                httpMethod: 'GET',
              },
            },
            {
              widget: 'landingPageMenuItem',
              button: { widget: 'commandButton', label: 'Do Something', uri: '/acme/button/9$9', httpMethod: 'POST' },
            },
            {
              widget: 'landingPageMenuItem',
              link: {
                widget: 'monikerList',
                instances: [
                  {
                    widget: 'moniker',
                    text: 'Budget Report by Country',
                    instanceId: '1422$6216',
                    target: 'https%3A%2F%2Fwd5.myworkday.com%2Facme%2Fd%2Ftask%2F1422%246216.htmld',
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  },
};

