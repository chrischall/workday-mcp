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

describe('redactTree list-card rows (fleet-audit#278)', () => {
  // workday_fetch returns the raw envelope; a list-card row keeps its human
  // label in the `label` COLUMN widget's `.value`, so the datum in the sibling
  // `value` / `secondaryValue` widgets must be withheld too.
  it('redacts the value widgets of a row whose label widget names PII', () => {
    const out = redactTree({
      contentSectionItems: [
        {
          label: { widget: 'text', label: 'Label', value: 'National ID' },
          value: { widget: 'text', label: 'Value', value: '123-45-6789' },
          secondaryValue: { widget: 'text', label: 'Secondary Value', value: 'AB123456C' },
        },
        {
          label: { widget: 'text', label: 'Label', value: 'Medical' },
          value: { widget: 'text', label: 'Value', value: '$120.00' },
        },
      ],
    }) as any;
    const [pii, benign] = out.contentSectionItems;
    expect(pii.label.value).toBe('National ID');
    expect(pii.value).toEqual({ widget: 'text', label: 'Value', value: '[redacted]' });
    expect(pii.secondaryValue.value).toBe('[redacted]');
    expect(benign.value.value).toBe('$120.00');
  });

  it('redacts a moniker value widget under a PII label widget', () => {
    const out = redactTree({
      label: { widget: 'text', value: 'Bank Account' },
      value: { widget: 'moniker', text: '****9999 First Bank' },
    }) as any;
    expect(JSON.stringify(out)).not.toContain('9999');
  });

  it('drops a PII moniker\'s navigation keys (instanceId, target, uri templates)', () => {
    const out = redactTree({
      label: { widget: 'text', value: 'Bank Account' },
      value: {
        widget: 'monikerList',
        label: 'Accounts',
        selfUriTemplate: '/acme/inst/{id}.htmld',
        instances: [
          { widget: 'moniker', text: '****9999', instanceId: 'IID-LEAK', target: 'TARGET-LEAK' },
          { widget: 'link', text: 'Open', uri: '/acme/URI-LEAK.htmld' },
        ],
      },
    }) as any;
    const json = JSON.stringify(out);
    for (const leak of ['9999', 'IID-LEAK', 'TARGET-LEAK', 'URI-LEAK', 'inst/{id}']) {
      expect(json).not.toContain(leak);
    }
    // Shape survives so the parser still recognises the widgets.
    expect(out.value.widget).toBe('monikerList');
    expect(out.value.instances[0]).toEqual({ widget: 'moniker', text: '[redacted]' });
  });
});

describe('redactTree identity-document collections (fleet-audit#1140)', () => {
  // Workday exposes identity documents as collections whose container key and
  // inner datum keys (`number`, `idNumber`, `documentNumber`, `idValue`) match
  // none of the older PII key patterns — and a GraphQL response carries no
  // label or grid column for the other rules to fire on.
  it('redacts a driversLicenses { number } GraphQL response', () => {
    const out = redactTree({
      data: { worker: { driversLicenses: [{ number: 'D123-4567-8901', issuingCountry: 'US' }] } },
    }) as { data: { worker: Record<string, unknown> } };
    expect(JSON.stringify(out)).not.toContain('D123-4567-8901');
    expect(out.data.worker.driversLicenses).toBe('[redacted]');
  });

  const containers: Array<[string, unknown]> = [
    ['driversLicenses', [{ number: 'X-000-111' }]],
    ['driversLicense', { number: 'X-000-111' }],
    ['driversLicences', [{ number: 'X-000-111' }]],
    ['identifications', [{ idNumber: 'X-000-111' }]],
    ['identification', { idNumber: 'X-000-111' }],
    ['visas', [{ documentNumber: 'X-000-111' }]],
    ['visa', { documentNumber: 'X-000-111' }],
    ['customIds', [{ idValue: 'X-000-111' }]],
    ['customId', { idValue: 'X-000-111' }],
  ];
  for (const [key, value] of containers) {
    it(`redacts the ${key} container wholesale`, () => {
      const out = redactTree({ worker: { [key]: value } }) as {
        worker: Record<string, unknown>;
      };
      expect(JSON.stringify(out)).not.toContain('X-000-111');
      expect(out.worker[key]).toBe('[redacted]');
    });
  }

  // The datum keys themselves, wherever they surface (e.g. under a container
  // name Workday spells some other way).
  for (const key of ['idNumber', 'idNumbers', 'documentNumber', 'documentNumbers', 'idValue']) {
    it(`redacts a bare ${key}`, () => {
      const out = redactTree({ doc: { [key]: 'X-000-111', type: 'Visa' } }) as {
        doc: Record<string, unknown>;
      };
      expect(out.doc[key]).toBe('[redacted]');
      expect(out.doc.type).toBe('Visa');
    });
  }

  it('keeps benign look-alikes visible', () => {
    const benign = { id: 'abc', workerId: 'W1', employeeId: 'E1', visaType: 'H-1B', number: 3 };
    expect(redactTree({ worker: benign })).toEqual({ worker: benign });
  });
});
