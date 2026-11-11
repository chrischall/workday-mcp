import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';
import { groupFeedback, parseRequestLabel } from '../src/feedback-view.js';
import { requestedPage, requestedFlatPage, receivedPage } from './feedback-grid-fixtures.js';

describe('groupFeedback — requested', () => {
  const out = groupFeedback('requested', parseTask(requestedPage).grids);

  it('makes one entry per request, telling same-day same-label requests apart by instance id', () => {
    expect(out.map((r) => r.request)).toEqual([
      'Feedback Request: Pat Doe requested by Pat Doe',
      'Feedback Request: Pat Doe requested by Pat Doe',
      'Feedback Request: Pat Doe requested by Pat Doe',
    ]);
    expect(out[0]).toMatchObject({ about: 'Pat Doe', requestedBy: 'Pat Doe', 'Request Date': '11/10/2026', Status: 'In Progress' });
  });

  it('names who was asked and who has yet to answer', () => {
    expect(out[0]).toMatchObject({ asked: ['Sam Roe', 'Lee Ray'], answeredBy: ['Lee Ray'], waitingOn: ['Sam Roe'] });
    expect(out[1]).toMatchObject({ asked: ['Kim Fox'], answeredBy: [], waitingOn: ['Kim Fox'] });
    expect(out[2]).toMatchObject({ asked: ['Lee Ray'], answeredBy: ['Lee Ray'], waitingOn: [] });
  });

  it('puts each answer, with its author, under its question', () => {
    expect(out[0]!.questions).toEqual([
      { question: 'How am I doing?', answers: [{ from: 'Lee Ray', feedback: 'You are doing **great**.' }] },
      { question: 'What should I keep doing?', answers: [{ from: 'Lee Ray', feedback: '- Unblocking us\n- Being _approachable_' }] },
    ]);
    expect(out[1]!.questions).toEqual([{ question: 'What could I do better?', answers: [] }]);
  });

  it('states the visibility once per request when every response agrees', () => {
    expect(out[0]).toMatchObject({ 'Private: Shared with Feedback Recipient': 'Yes' });
    expect(out[1]).toMatchObject({ 'Private: Shared with Feedback Recipient': 'No' });
    expect(JSON.stringify(out[0]!.questions)).not.toContain('Private');
  });
});

describe('groupFeedback — requested, one responder (no column group)', () => {
  const [one] = groupFeedback('requested', parseTask(requestedFlatPage).grids);

  it('still reads From, Feedback and visibility as the response', () => {
    expect(one).toMatchObject({
      about: 'Sam Roe',
      requestedBy: 'Pat Doe',
      'Confidential: Not Shared with Feedback Recipient': 'Yes',
      asked: ['Kim Fox'],
      answeredBy: ['Kim Fox'],
      waitingOn: [],
    });
    expect(one!.questions).toEqual([
      { question: 'How has Sam done?', answers: [] },
      { question: 'What should Sam keep doing?', answers: [{ from: 'Kim Fox', feedback: 'Shipping on time.' }] },
    ]);
  });
});

describe('groupFeedback — received', () => {
  const out = groupFeedback('received', parseTask(receivedPage).grids);

  it('makes one entry per response, its author and date on the entry, every answer under it', () => {
    expect(out).toEqual([
      {
        Date: '11/11/2026',
        From: 'Lee Ray',
        Type: 'Requested by Self',
        'Private: Shared with Feedback Recipient': 'Yes',
        answers: [
          { question: 'How am I doing?', feedback: 'You are doing **great**.' },
          { question: 'What should I keep doing?', feedback: '- Unblocking us\n- Being _approachable_' },
        ],
      },
      {
        Date: '01/02/2024',
        From: 'Kim Fox',
        Type: 'Unsolicited',
        'Private: Shared with Feedback Recipient': 'No',
        answers: [{ feedback: 'Thanks for the help!' }],
      },
    ]);
  });
});

describe('parseRequestLabel', () => {
  it('reads who a request is about and who made it', () => {
    expect(parseRequestLabel('Feedback Request: Xi Sanderson requested by Chris Hall')).toEqual({
      about: 'Xi Sanderson',
      requestedBy: 'Chris Hall',
    });
    expect(parseRequestLabel('Something else')).toEqual({});
  });
});
