import { describe, it, expect } from 'vitest';
import { parseTask } from '../src/parse.js';
import { requestedPage, receivedPage } from './feedback-grid-fixtures.js';

describe('grids with a columnGroup (live feedback grids)', () => {
  const requested = parseTask(requestedPage).grids[0]!;
  const received = parseTask(receivedPage).grids[0]!;

  it('names an unlabelled column from its propertyName, not its opaque id', () => {
    expect(requested.columns).toContain('Feedback Requested');
    expect(requested.columns).not.toContain('102.1');
    expect(requested.rows[0]!.cells['Feedback Requested']).toBe('Feedback Request: Pat Doe requested by Pat Doe');
  });

  it('reads a fieldSet cell (the responder) as the text inside it', () => {
    expect(requested.rows[0]!.cells['From']).toBe('Sam Roe');
    expect(requested.rows[1]!.cells['From']).toBe('Lee Ray');
  });

  it('lists the columns that sit under a group', () => {
    expect(requested.groupColumns).toEqual(['From', 'Feedback', 'Private: Shared with Feedback Recipient']);
    expect(received.groupColumns).toEqual(['Question', 'Feedback']);
  });

  it('fills a continuation row in from the row above it, and marks it', () => {
    const second = requested.rows[1]!;
    expect(second.continuation).toBe(true);
    expect(second.cells).toMatchObject({
      'Feedback Requested': 'Feedback Request: Pat Doe requested by Pat Doe',
      Question: 'How am I doing?',
      Status: 'In Progress',
      'Request Date': '11/10/2026',
      From: 'Lee Ray',
      Feedback: 'You are doing **great**.',
    });
    // The request's instance id rides along, so two same-day requests with
    // the same label can still be told apart.
    expect(second.references.some((r) => r.instanceId === '9735$1')).toBe(true);
    expect(requested.rows[0]!.continuation).toBeUndefined();
    expect(requested.rows[4]!.continuation).toBeUndefined();
  });

  it('never carries the group columns of the row above into a continuation', () => {
    const received2 = received.rows[1]!;
    expect(received2.continuation).toBe(true);
    expect(received2.cells).toMatchObject({ From: 'Lee Ray', Date: '11/11/2026', Question: 'What should I keep doing?' });
    expect(received2.cells['Feedback']).toBe('- Unblocking us\n- Being _approachable_');
    // Row 3 starts a new item: nothing of Lee's leaks into it.
    expect(received.rows[2]!.cells).toEqual({
      Date: '01/02/2024',
      From: 'Kim Fox',
      Type: 'Unsolicited',
      'Private: Shared with Feedback Recipient': 'No',
      Feedback: 'Thanks for the help!',
    });
  });
});
