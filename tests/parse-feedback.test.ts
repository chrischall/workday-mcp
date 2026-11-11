import { describe, it, expect } from 'vitest';
import {
  feedbackHtml,
  fillBlanks,
  parseFeedbackForm,
  questionBlanks,
  questionFieldIds,
  summaryQuestionFields,
} from '../src/parse-feedback.js';
import { giveForm, questionRowAdded, requestForm, templateChosen, templateWithBlank } from './feedback-fixtures.js';

describe('parseFeedbackForm — Give Feedback', () => {
  it('reads the commit ids, the feedback field and the badge options', () => {
    const f = parseFeedbackForm(giveForm);
    expect(f?.pageId).toBe('944');
    expect(f?.bar).toEqual({ id: '931', submit: '934$20' });
    expect(f?.feedbackField).toBe('852/wd:Response_Comment');
    expect(f?.badge).toEqual({
      id: '850',
      options: [
        { text: 'I act decisively and get things done', instanceId: '16411$3' },
        { text: 'I own it', instanceId: '16411$2' },
        { text: 'I think like a customer', instanceId: '16411$6' },
      ],
    });
  });

  it('reports the hidden visibility defaults the form will submit with', () => {
    expect(parseFeedbackForm(giveForm)?.visibility).toEqual(['Your name is shown', 'Shared: Share with others']);
  });

  it('reads the three sharing choices, by kind, with Workday\'s own labels', () => {
    expect(parseFeedbackForm(giveForm)?.sharing).toEqual([
      { kind: 'confidential', id: '852/wd:Feedback_Confidential', label: "Don't share with Pat Doe", checked: false },
      { kind: 'private', id: '852/wd:Feedback_Private', label: 'Share with Pat Doe', checked: false },
      { kind: 'everyone', id: '852/wd:Show_Feedback_to_Everyone', label: 'Share with others', checked: true },
    ]);
  });

  it('never carries the session token', () => {
    expect(JSON.stringify(parseFeedbackForm(giveForm))).not.toContain('SECRET-TOKEN');
  });

  it('is undefined for a page without a Submit bar', () => {
    expect(parseFeedbackForm({ widget: 'root', body: { widget: 'vbox', id: '1', children: [] } })).toBeUndefined();
  });
});

describe('parseFeedbackForm — Get Feedback', () => {
  it('reads the recipients prompt, the template prompt and the question list', () => {
    const f = parseFeedbackForm(requestForm);
    expect(f?.pageId).toBe('1051');
    expect(f?.bar).toEqual({ id: '1035', submit: '934$20' });
    expect(f?.recipients).toMatchObject({ id: '948', contextId: 'c3' });
    expect(f?.template).toMatchObject({ id: '949', contextId: 'c3' });
    expect(f?.questionList).toBe('956.217');
    expect(f?.visibility).toEqual(['Not anonymous', 'Shared: Share with others']);
  });

  it('ignores hidden prompts (skills) when finding the template', () => {
    expect(parseFeedbackForm(requestForm)?.template?.label).toBe('Feedback Template');
  });
});

describe('changeSummary readers', () => {
  it('finds the new question field a row-add created', () => {
    expect(questionFieldIds(questionRowAdded('1354'))).toEqual(['1354/wd:Feedback_Question']);
  });

  it('reads a template\'s questions as plain text', () => {
    expect(summaryQuestionFields(templateChosen).map((q) => q.text)).toEqual([
      'Please provide me feedback on what I can do differently?',
      'What did I do well?',
    ]);
  });
});

describe('feedbackHtml', () => {
  it('escapes markup and makes each paragraph a <p>', () => {
    expect(feedbackHtml('Great work on <the> migration & rollout.\n\nThank you!')).toBe(
      '<p>Great work on &lt;the&gt; migration &amp; rollout.</p><p>Thank you!</p>'
    );
  });

  it('keeps single line breaks inside a paragraph', () => {
    expect(feedbackHtml('one\ntwo')).toBe('<p>one<br>two</p>');
  });
});

describe('template blanks', () => {
  it('lists each [BLANK] in a question once, in order', () => {
    expect(questionBlanks('How am I doing on [ENTER BEHAVIOR] with [TEAM]? And [TEAM] again.')).toEqual([
      'ENTER BEHAVIOR',
      'TEAM',
    ]);
    expect(questionBlanks('No blanks here.')).toEqual([]);
  });

  it('reads a template question\'s field id, its HTML and its blanks', () => {
    expect(summaryQuestionFields(templateWithBlank)).toEqual([
      {
        id: '1600/wd:Feedback_Question',
        html: '<p style="text-align:left">I’d like your feedback on how I’m doing on <b>[ENTER BEHAVIOR]</b>. What is your suggestion?</p>',
        text: 'I’d like your feedback on how I’m doing on [ENTER BEHAVIOR]. What is your suggestion?',
        blanks: ['ENTER BEHAVIOR'],
      },
    ]);
  });

  it('fills blanks by name, case-insensitively, keeping the markup and escaping the value', () => {
    expect(fillBlanks('<p>On <b>[ENTER BEHAVIOR]</b>?</p>', { 'enter behavior': 'delegating & <coaching>' })).toBe(
      '<p>On <b>delegating &amp; &lt;coaching&gt;</b>?</p>'
    );
  });

  it('leaves a blank it has no value for untouched', () => {
    expect(fillBlanks('<p>[A] and [B]</p>', { A: 'x' })).toBe('<p>x and [B]</p>');
  });
});
