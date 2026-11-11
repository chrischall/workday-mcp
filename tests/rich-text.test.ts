import { describe, it, expect } from 'vitest';
import { readRichText, readPlainText, toWorkdayHtml, WORKDAY_TAGS } from '../src/rich-text.js';

// Every shape below is one Workday produced (captured live 2026-11-11 from 91
// rich-text values on feedback and review pages), with the words replaced.
const CAPTURED = {
  paragraphs: '<p>First thought.</p><p>Second thought.</p>',
  emptyParagraph: '<p>One.</p><p></p><p>Two.</p>',
  brBetweenParagraphs: '<p>One. </p><br /><p>Two.</p>',
  doubleBr: 'One. <br /><br />Two.',
  spans: '<span>One.</span><br /><br /><span>Two.</span>',
  list: '<ul><li>first;</li><li>second.</li></ul>',
  listOfParagraphs: '<ul><li><p>first;</p></li><li><p>second.</p></li></ul>',
  bold: '<p><b>Title:</b> the rest.</p>',
  aligned: '<p style="text-align:left">Please share feedback?</p>',
  entities: '<p>It&#39;s &#34;fine&#34; ’quoted’</p>',
  zeroWidthTail: '<p>What did I do well?</p>​',
  questionnaire: '<p><b>Numerical ID</b></p><br /><p>Found on the profile.</p> (Required)',
};

describe('readRichText (prose → Markdown)', () => {
  it.each([
    ['paragraphs', 'First thought.\n\nSecond thought.'],
    ['emptyParagraph', 'One.\n\nTwo.'],
    ['brBetweenParagraphs', 'One.\n\nTwo.'],
    ['list', '- first;\n- second.'],
    ['listOfParagraphs', '- first;\n- second.'],
    ['bold', '**Title:** the rest.'],
    ['aligned', 'Please share feedback?'],
    ['entities', 'It\'s "fine" ’quoted’'],
    ['zeroWidthTail', 'What did I do well?'],
  ] as const)('%s', (key, want) => {
    expect(readRichText(CAPTURED[key])).toBe(want);
  });

  it('keeps a <br /><br /> paragraph break between spans or bare text', () => {
    expect(readRichText(CAPTURED.doubleBr)).toMatch(/^One\.\s*\n\s*\n?Two\.$/);
    expect(readRichText(CAPTURED.spans)).toMatch(/^One\.\s*\n\s*\n?Two\.$/);
  });

  it('reads `&#xa;` (Workday\'s newline in process comments) as a line break', () => {
    expect(readRichText('Approved.&#xa;Thanks')).toBe('Approved.\nThanks');
  });
});

describe('readPlainText (labels, questions → text)', () => {
  it('keeps paragraph breaks as a blank line', () => {
    expect(readPlainText(CAPTURED.emptyParagraph)).toBe('One.\n\nTwo.');
    expect(readPlainText(CAPTURED.doubleBr)).toBe('One.\n\nTwo.');
  });

  it('reads lists of paragraphs as one bullet per line', () => {
    expect(readPlainText(CAPTURED.listOfParagraphs)).toBe('- first;\n- second.');
  });

  it('decodes Workday\'s semicolon-less `&nbsp` and drops invisible characters', () => {
    expect(readPlainText('Blank&nbsp label')).toBe('Blank label');
    expect(readPlainText(CAPTURED.zeroWidthTail)).toBe('What did I do well?');
  });

  it('keeps the questionnaire layout splitQuestion depends on', () => {
    // Text after the last </p> is a paragraph of its own; splitQuestion strips
    // the trailing "(Required)" either way.
    expect(readPlainText(CAPTURED.questionnaire)).toBe('Numerical ID\n\nFound on the profile.\n\n(Required)');
  });
});

describe('toWorkdayHtml (Markdown → the tags Workday stores)', () => {
  const tagsIn = (html: string) => [...html.matchAll(/<([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());

  it('writes paragraphs and line breaks the way it always has', () => {
    expect(toWorkdayHtml('Great work.\n\nThank you!')).toBe('<p>Great work.</p><p>Thank you!</p>');
    expect(toWorkdayHtml('one\ntwo')).toBe('<p>one<br>two</p>');
  });

  it('escapes anything that looks like markup', () => {
    expect(toWorkdayHtml('Great <work> & more')).toBe('<p>Great &lt;work&gt; &amp; more</p>');
  });

  it('writes bold as <b> — the tag Workday\'s own editor uses', () => {
    expect(toWorkdayHtml('**Justin:** steady.')).toBe('<p><b>Justin:</b> steady.</p>');
  });

  it('writes a bulleted list as <ul><li>', () => {
    expect(toWorkdayHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('keeps a numbered list\'s numbers, since Workday has shown no <ol>', () => {
    expect(readRichText(toWorkdayHtml('1. one\n2. two'))).toBe('1. one\n2. two');
  });

  it('keeps a link\'s address in the text, since Workday has shown no <a>', () => {
    expect(readRichText(toWorkdayHtml('See [the doc](https://example.com/d).'))).toBe('See the doc (https://example.com/d).');
  });

  it('keeps italic, strike and code as their text', () => {
    expect(readRichText(toWorkdayHtml('*soon* ~~never~~ `npm test`'))).toBe('soon never npm test');
  });

  it('never emits a tag outside the captured set', () => {
    const md = '**b** *i* ~~s~~ `c`\n\n1. one\n   - nested\n\n```\nx = 1\n```\n\n[l](https://e.test) - a\n- b';
    for (const t of tagsIn(toWorkdayHtml(md))) expect(WORKDAY_TAGS).toContain(t);
  });

  it('round-trips through the reader for write verification', () => {
    const md = '**Q1.** How did the *launch* go?\n\n- one\n- two';
    expect(readRichText(toWorkdayHtml(md))).toBe('**Q1.** How did the launch go?\n\n- one\n- two');
  });
});
