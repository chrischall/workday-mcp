import { describe, it, expect } from 'vitest';
import { redactTree, SENSITIVE_VALUE_LABELS } from '../src/redact.js';

describe('redactTree', () => {
  it('drops envelope secrets by key name', () => {
    const out = redactTree({
      widget: 'root',
      title: 'Benefits',
      sessionSecureToken: 'SECRET',
      csrfToken: 'SECRET',
      flowExecutionKey: 'SECRET',
      taskId: '2998$43525',
    }) as Record<string, unknown>;
    expect(out.title).toBe('Benefits');
    expect(out.taskId).toBe('2998$43525');
    expect(out.sessionSecureToken).toBe('[redacted]');
    expect(out.csrfToken).toBe('[redacted]');
    expect(out.flowExecutionKey).toBe('[redacted]');
  });

  it('does not redact benign keys that merely contain an id', () => {
    const out = redactTree({
      instanceId: 'worker-9',
      taskIid: '2998$43525',
      pageContextId: '39330!abc',
    }) as Record<string, unknown>;
    expect(out.instanceId).toBe('worker-9');
    expect(out.taskIid).toBe('2998$43525');
    expect(out.pageContextId).toBe('39330!abc');
  });

  it('redacts a widget value whose sibling label is sensitive PII', () => {
    const out = redactTree({
      widget: 'text',
      label: 'Social Security Number',
      value: '123-45-6789',
    }) as Record<string, unknown>;
    expect(out.label).toBe('Social Security Number');
    expect(out.value).toBe('[redacted]');
  });

  it('leaves an ordinary label/value pair intact', () => {
    const out = redactTree({
      widget: 'text',
      label: 'Total Base Pay',
      value: '$100,000.00',
    }) as Record<string, unknown>;
    expect(out.value).toBe('$100,000.00');
  });

  it('recurses through arrays and nested objects', () => {
    const out = redactTree({
      body: { rows: [{ sessionSecureToken: 'SECRET', label: 'ok' }] },
    }) as any;
    expect(out.body.rows[0].sessionSecureToken).toBe('[redacted]');
    expect(out.body.rows[0].label).toBe('ok');
  });

  it('caps depth so a pathological tree cannot blow the stack', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { child: deep };
    const out = redactTree(deep, { maxDepth: 5 }) as any;
    expect(JSON.stringify(out)).toContain('[truncated: max depth]');
  });

  it('exports the PII label list it keys on', () => {
    expect(SENSITIVE_VALUE_LABELS.some((r) => r.test('social security number'))).toBe(true);
  });

  it('passes primitives through untouched', () => {
    expect(redactTree('hello')).toBe('hello');
    expect(redactTree(42)).toBe(42);
    expect(redactTree(null)).toBe(null);
  });
});
