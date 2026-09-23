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

describe('redactTree PII key names: plurals and long spellings (fleet-audit#279)', () => {
  // A worker can hold several national IDs / bank accounts, so list-valued
  // GraphQL fields are a likely shape. Each must be redacted wholesale.
  const cases: Array<[string, unknown]> = [
    ['nationalIds', [{ id: '123-45-6789' }]],
    ['nationalIdentifiers', ['123-45-6789']],
    ['nationalIdentification', '123-45-6789'],
    ['nationalIdentificationNumber', '123-45-6789'],
    ['nationalIdentifierValues', ['123-45-6789']],
    ['nationalIdNumbers', ['123-45-6789']],
    ['taxIdentificationNumber', '123-45-6789'],
    ['taxIdentifiers', ['123-45-6789']],
    ['taxIds', ['123-45-6789']],
    ['governmentId', '123-45-6789'],
    ['governmentIds', ['123-45-6789']],
    ['governmentIdentifier', '123-45-6789'],
    ['governmentIdentifiers', ['123-45-6789']],
    ['bankAccounts', [{ number: '123-45-6789' }]],
    ['bankAccount', { number: '123-45-6789' }],
    ['accountNumbers', ['123-45-6789']],
    ['bankAccountNumbers', ['123-45-6789']],
    ['routingNumbers', ['123-45-6789']],
    ['passports', [{ number: '123-45-6789' }]],
    ['passportNumbers', ['123-45-6789']],
    ['passportIds', ['123-45-6789']],
    ['licenseNumbers', ['123-45-6789']],
    ['ssns', ['123-45-6789']],
    ['socialSecurityNumbers', ['123-45-6789']],
    ['ibans', ['123-45-6789']],
  ];
  for (const [key, value] of cases) {
    it(`redacts ${key}`, () => {
      const out = redactTree({ worker: { [key]: value } }) as {
        worker: Record<string, unknown>;
      };
      expect(JSON.stringify(out)).not.toContain('123-45-6789');
      expect(out.worker[key]).toBe('[redacted]');
    });
  }

  it('keeps descriptor siblings visible', () => {
    const benign = {
      nationalIdType: 'NINO',
      nationalIdTypes: ['NINO'],
      nationalIdCountry: 'GB',
      taxIdType: 'EIN',
      governmentIdType: 'Passport',
      accountType: 'Checking',
      bankAccountType: 'Savings',
      bankName: 'First Bank',
      passportCountry: 'US',
      accountNumberFormat: 'numeric',
    };
    expect(redactTree({ worker: benign })).toEqual({ worker: benign });
  });
});
