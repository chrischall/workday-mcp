import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseQuestionnaire, parseRequestModel } from '../src/parse.js';

// A "Revise Request" page is the same questionnaire tree as a fresh request
// form, carrying the saved answers: text in the visible `textAreaInput`'s
// `value`, a choice as the radio list's `selectedIds` (captured live
// 2026-10; values invented).
const fresh = JSON.parse(
  readFileSync(new URL('./fixtures/request-form.json', import.meta.url), 'utf8')
) as { body: { children: any[] } };

function revised(): Record<string, unknown> {
  const page = JSON.parse(JSON.stringify(fresh));
  page.title = { widget: 'titleStaticText', text: 'Revise Request' };
  const panels = page.body.children[3].children[2].panels;
  panels[0].children[1].value = '000101';
  panels[1].children[4].selectedIds = ['1236.1226'];
  return page;
}

describe('parseQuestionnaire — saved answers', () => {
  it('reports each question\'s current answer', () => {
    const q = parseQuestionnaire(revised());
    expect(q?.questions.map((x) => x.answer)).toEqual(['000101', 'Yes', undefined]);
  });

  it('a fresh form has no answers', () => {
    expect(parseQuestionnaire(fresh)?.questions.every((x) => x.answer === undefined)).toBe(true);
  });
});

describe('parseRequestModel — the handles a write needs', () => {
  const model = parseRequestModel(revised());

  it('maps each question to the field it is answered in', () => {
    expect(model?.fields).toEqual([
      { number: 1, fieldId: '1053/wd:Answer_Text', kind: 'text' },
      {
        number: 2,
        fieldId: '1236',
        kind: 'choice',
        options: [
          { text: 'Yes', instanceId: '11431$684' },
          { text: 'No', instanceId: '11431$685' },
        ],
      },
      { number: 3, fieldId: '1365/wd:Answer_Text', kind: 'text' },
    ]);
  });

  it('finds the page id and the Submit / Save for Later buttons', () => {
    expect(model?.pageId).toBe('1579');
    expect(model?.flowKey).toBe('e1s1');
    expect(model?.bar).toEqual({ id: '1561', submit: '934$20', save: '934$14' });
  });

  it('is undefined for a page with no Submit bar (nothing to write to)', () => {
    const noBar = revised() as { body: { children: unknown[] } };
    noBar.body.children = noBar.body.children.slice(0, 4);
    expect(parseRequestModel(noBar)).toBeUndefined();
  });
});
