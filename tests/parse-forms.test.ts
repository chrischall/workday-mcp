import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseTask,
  parseQuestionnaire,
  parseFormValues,
  parseWizardSections,
  hasSubmitBar,
  stripHtml,
} from '../src/parse.js';

// Fixtures mirror widget shapes captured live from a production tenant
// (2026-10, review + promotion season). VALUES are invented; STRUCTURE is
// faithful — the questionnaire fixture is the real form's widget tree with
// every question's prose replaced.
const requestForm = JSON.parse(
  readFileSync(new URL('./fixtures/request-form.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

describe('stripHtml', () => {
  it('turns Workday rich text into readable plain text', () => {
    expect(
      stripHtml('<p><b>Title</b></p><br /><p>Line one&#x2019;s &amp; two</p><ul><li>a</li><li>b</li></ul>')
    ).toBe("Title\n\nLine one’s & two\n- a\n- b");
  });

  it('decodes the encoded newline Workday puts in comments', () => {
    expect(stripHtml('Please fill out goals.&#xa;')).toBe('Please fill out goals.');
  });

  it('drops a lone &nbsp; placeholder to empty', () => {
    expect(stripHtml('&nbsp;')).toBe('');
  });

  it('drops the semicolon-less &nbsp Workday uses as a blank label', () => {
    // Live: a review belief statement's richTextArea is labelled "&nbsp".
    expect(stripHtml('&nbsp')).toBe('');
    expect(stripHtml('a&nbsp b')).toBe('a b');
  });
});

describe('parseQuestionnaire — a Workday request questionnaire form', () => {
  const q = parseQuestionnaire(requestForm);

  it('reads the title and plain-text instructions', () => {
    expect(q?.title).toBe('2026 Example Request Form');
    expect(q?.instructions).toBe(
      'Purpose of this form\n\nExplain the recommendation.\n- Use specific examples.\n- Align with your leader first.'
    );
  });

  it('lists every question in order with its help text and required flag', () => {
    expect(q?.questions).toEqual([
      {
        number: 1,
        question: 'Numerical Employee ID number',
        help: 'Can be found on the individual’s Workday Profile.',
        required: true,
        answerType: 'text',
      },
      {
        number: 2,
        question: 'My manager supports this promotion',
        required: true,
        answerType: 'choice',
        options: ['Yes', 'No'],
      },
      {
        number: 3,
        question: 'Organization Impact',
        help: 'If this is a people-manager promotion, describe the scope.\nConsider: number of direct reports.',
        required: false,
        answerType: 'text',
      },
    ]);
  });

  it('omits the request-level fields Workday hides on this form', () => {
    expect(JSON.stringify(q)).not.toContain('On Behalf Of');
    expect(JSON.stringify(q)).not.toContain('Describe the Request');
  });

  it('never carries the envelope token', () => {
    expect(JSON.stringify(q)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('returns undefined for a page that is not a questionnaire', () => {
    expect(parseQuestionnaire({ widget: 'root', body: { widget: 'vbox', children: [] } })).toBeUndefined();
  });
});

describe('hasSubmitBar — the business-process Submit/Save bar', () => {
  it('detects the bar on a loaded form', () => {
    expect(hasSubmitBar(requestForm)).toBe(true);
  });

  it('is false for the Create Request prompt page', () => {
    const prompt = {
      widget: 'root',
      body: {
        widget: 'vbox',
        id: '72',
        children: [{ widget: 'monikerListInput', label: 'Request Type', required: true, id: '66' }],
      },
    };
    expect(hasSubmitBar(prompt)).toBe(false);
  });
});

// A review wizard section ("TU Beliefs"-style): a belief statement panel, then
// manager and employee summaries side by side. Ratings are dropDownSelectLists
// whose SELECTED option is named by `selectedIds` (an option `id`), and
// comments are richTextAreaInputs whose value is the comment HTML.
const reviewSection = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Values' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'radioGroupInput',
        children: [{ widget: 'checkBoxInput', label: 'Save for Later', value: false }],
      },
      {
        widget: 'editPanelList',
        panels: [
          {
            widget: 'panel',
            children: [
              { widget: 'richTextArea', label: '&nbsp;', value: '<p><b>Think like a customer</b></p>' },
              { widget: 'numberInput', label: 'Weighting', value: 0 },
            ],
          },
        ],
      },
      {
        widget: 'panel',
        children: [
          {
            widget: 'hbox',
            children: [
              {
                widget: 'fieldSet',
                children: [
                  {
                    widget: 'panel',
                    label: 'Manager Summary',
                    title: { widget: 'titleStaticText', text: 'Manager Summary' },
                    children: [
                      { widget: 'number', label: 'Overall Rating Weight', value: 0 },
                      { widget: 'text', label: 'Calculated Rating' },
                      {
                        widget: 'dropDownSelectList',
                        label: 'Rating',
                        selectedIds: ['1668.1755'],
                        instances: [
                          { widget: 'dropDownSelectOption', instanceId: '672$69', text: 'Leading', id: '1668.1754' },
                          { widget: 'dropDownSelectOption', instanceId: '672$70', text: 'Performing', id: '1668.1755' },
                        ],
                      },
                      { widget: 'richTextAreaInput', label: 'Comment', value: '<p>Great customer focus.</p>' },
                    ],
                  },
                ],
              },
              {
                widget: 'fieldSet',
                children: [
                  {
                    widget: 'panel',
                    label: 'Employee Summary',
                    children: [
                      {
                        widget: 'dropDownSelectList',
                        label: 'Rating',
                        instances: [
                          { widget: 'dropDownSelectOption', instanceId: '672$69', text: 'Leading', id: '1650.1754' },
                        ],
                      },
                      { widget: 'richTextAreaInput', label: 'Comment', value: '<p>I listen to users.</p>' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('parseFormValues — the filled-in values of a read-only form page', () => {
  const values = parseFormValues(reviewSection);

  it('reads selected ratings and comments under their panel heading', () => {
    expect(values).toContainEqual({ group: 'Manager Summary', label: 'Rating', value: 'Performing' });
    expect(values).toContainEqual({ group: 'Manager Summary', label: 'Comment', value: 'Great customer focus.' });
    expect(values).toContainEqual({ group: 'Employee Summary', label: 'Comment', value: 'I listen to users.' });
  });

  it('numbers repeating items (goals, beliefs) and keeps their unlabelled text', () => {
    expect(values).toContainEqual({ group: 'Values', item: 1, label: '', value: 'Think like a customer' });
  });

  it('skips the Save for Later control, unselected dropdowns, empty text and zero defaults', () => {
    expect(values.map((v) => v.label)).not.toContain('Save for Later');
    expect(values.filter((v) => v.group === 'Employee Summary' && v.label === 'Rating')).toEqual([]);
    expect(values.map((v) => v.label)).not.toContain('Calculated Rating');
    expect(values.map((v) => v.label)).not.toContain('Weighting');
    expect(values.map((v) => v.label)).not.toContain('Overall Rating Weight');
  });

  it('reads moniker inputs, dates and non-zero numbers', () => {
    const goal = {
      widget: 'root',
      title: 'Goals',
      body: {
        widget: 'vbox',
        children: [
          { widget: 'dateInput', label: 'Due Date', value: '2026-06-01' },
          { widget: 'numberInput', label: 'Weighting', value: 25 },
          {
            widget: 'monikerListInput',
            label: 'Category',
            instances: [{ widget: 'moniker', text: 'Organizational Alignment', instanceId: '3$1' }],
          },
          { widget: 'textAreaInput', label: 'Status Note', value: 'Done' },
        ],
      },
    };
    expect(parseFormValues(goal)).toEqual([
      { group: 'Goals', label: 'Due Date', value: '2026-06-01' },
      { group: 'Goals', label: 'Weighting', value: '25' },
      { group: 'Goals', label: 'Category', value: 'Organizational Alignment' },
      { group: 'Goals', label: 'Status Note', value: 'Done' },
    ]);
  });
});

describe('parseWizardSections — a printable review is a task wizard', () => {
  const wizard = {
    widget: 'root',
    title: { widget: 'titleStaticText', text: 'View Printable Employee Review' },
    body: {
      widget: 'vbox',
      children: [
        {
          widget: 'taskWizard',
          children: [
            { widget: 'taskWizardSection', taskName: 'Goals', uri: '/acme/task-wizard/c29/2998$1/context/X1' },
            { widget: 'taskWizardSection', taskName: 'Values', uri: '/acme/task-wizard/c29/2998$2/context/X1.htmld' },
          ],
        },
        {
          widget: 'monikerList',
          label: 'Sub-Heading Instance',
          instances: [{ widget: 'moniker', text: 'Manager Evaluation: 2026 Mid-Year: Pat Doe', instanceId: '1007$1' }],
        },
      ],
    },
  };

  it('lists each section with a fetchable uri', () => {
    expect(parseWizardSections(wizard)).toEqual([
      { label: 'Goals', uri: '/acme/task-wizard/c29/2998$1/context/X1.htmld' },
      { label: 'Values', uri: '/acme/task-wizard/c29/2998$2/context/X1.htmld' },
    ]);
  });
});

describe('parseTask grid cells — review lists and feedback', () => {
  const page = {
    widget: 'root',
    title: 'Performance Reviews',
    body: {
      widget: 'vbox',
      children: [
        {
          widget: 'grid',
          label: 'Completed',
          columns: [
            { widget: 'column', columnId: 'c1', label: 'Review' },
            { widget: 'column', columnId: 'c2', label: 'View Review' },
            { widget: 'column', columnId: 'c3', label: 'Feedback' },
            { widget: 'column', columnId: 'c4', label: 'Create Review PDF' },
          ],
          rows: [
            {
              widget: 'row',
              cellsMap: {
                c1: {
                  widget: 'monikerList',
                  selfUriTemplate: '/acme/inst/1$2471/671$1',
                  instances: [{ widget: 'moniker', text: '2026 Mid-Year: Pat Doe', instanceId: '671$1' }],
                },
                c2: { widget: 'commandButton', label: 'View', uri: '/acme/inst/671$1/rel-task/2997$1498' },
                c3: { widget: 'compactRichTextArea', value: '<p>Strong quarter &amp; great delivery.</p>' },
                c4: { widget: 'commandButton', label: 'Create New PDF', uri: '/acme/button/c27/143/208' },
              },
            },
          ],
        },
      ],
    },
  };
  const grid = parseTask(page).grids[0];

  it('turns a commandButton cell into a fetchable reference named by its column', () => {
    expect(grid.rows[0].references).toContainEqual({
      label: 'View Review',
      value: 'View',
      uri: '/acme/inst/671$1/rel-task/2997$1498.htmld',
    });
  });

  it('never offers a /button/ command endpoint as a reference', () => {
    expect(JSON.stringify(grid.rows[0].references)).not.toContain('/button/');
  });

  it('keys cells under a columnGroup by their own column labels', () => {
    // Live "View Feedback Received": Feedback and Badge sit inside a
    // "Feedback Received" columnGroup whose `columns` nest one level down.
    const grouped = parseTask({
      widget: 'root',
      body: {
        widget: 'grid',
        columns: [
          { widget: 'column', columnId: '148.3', label: 'From' },
          {
            widget: 'columnGroup',
            columnId: '148.5',
            label: 'Feedback Received',
            columns: [
              { widget: 'column', columnId: '124.2', label: 'Feedback' },
              { widget: 'column', columnId: '124.3', label: 'Badge' },
            ],
          },
        ],
        rows: [
          {
            widget: 'row',
            cellsMap: {
              '148.3': { widget: 'text', value: 'Alex Kim' },
              '124.2': { widget: 'compactRichTextArea', value: '<p>Great work.</p>' },
              '124.3': { widget: 'monikerList', instances: [{ widget: 'moniker', text: 'Innovator' }] },
            },
          },
        ],
      },
    }).grids[0];
    expect(grouped.columns).toEqual(['From', 'Feedback', 'Badge']);
    expect(grouped.rows[0].cells).toEqual({ From: 'Alex Kim', Feedback: 'Great work.', Badge: 'Innovator' });
  });

  it('reads rich-text cells as plain text', () => {
    expect(grid.rows[0].cells.Feedback).toBe('Strong quarter & great delivery.');
  });
});
