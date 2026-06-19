import { describe, it, expect } from 'vitest';
import {
  WorkdayClient,
  WorkdayConfigError,
  SessionNotAuthenticatedError,
  stripJsonGuard,
} from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';

class FakeTransport implements WorkdayTransport {
  next: FetchResult = { status: 200, body: '{}', url: 'https://wd5.myworkday.com/x' };
  lastInit?: FetchInit;
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.lastInit = init;
    return this.next;
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

function makeClient(over?: { tenant?: string; host?: string }) {
  const transport = new FakeTransport();
  const client = new WorkdayClient({
    transport,
    tenant: over && 'tenant' in over ? over.tenant : 'acme',
    host: over?.host ?? 'wd5.myworkday.com',
  });
  return { client, transport };
}

describe('stripJsonGuard', () => {
  it('passes clean JSON through and strips a leading guard', () => {
    expect(stripJsonGuard('{"a":1}')).toBe('{"a":1}');
    expect(stripJsonGuard(')]}\n{"a":1}')).toBe('{"a":1}');
  });
});

describe('WorkdayClient deferred config', () => {
  it('boots without a tenant but throws WorkdayConfigError on use', () => {
    const transport = new FakeTransport();
    const client = new WorkdayClient({ transport, tenant: undefined, host: 'wd5.myworkday.com' });
    expect(() => client.tenant).toThrow(WorkdayConfigError);
    return expect(client.getTask('/x')).rejects.toThrow(WorkdayConfigError);
  });
});

describe('WorkdayClient.resolvePath', () => {
  const { client } = makeClient();
  it('prefixes a bare suffix with the tenant', () => {
    expect(client.resolvePath('quickaccess/fetch.htmld')).toBe('/acme/quickaccess/fetch.htmld');
  });
  it('trims a trailing #fragment', () => {
    expect(client.resolvePath('/acme/card/all/x.htmld#backheader=true')).toBe(
      '/acme/card/all/x.htmld'
    );
  });
  it('converts a copied SPA /d/ URL to its JSON data endpoint', () => {
    expect(client.resolvePath('/acme/d/inst/13102!ABC/cacheable-task/2998$1.htmld')).toBe(
      '/acme/inst/13102!ABC/cacheable-task/2998$1.htmld'
    );
  });
});

describe('WorkdayClient.fetchJson', () => {
  it('parses a clean JSON body', async () => {
    const { client, transport } = makeClient();
    transport.next = { status: 200, body: '{"widget":"root","title":"Hi"}', url: 'https://wd5.myworkday.com/acme/x.htmld' };
    expect(await client.fetchJson('/acme/x.htmld')).toEqual({ widget: 'root', title: 'Hi' });
  });

  it('maps 401/403 to SessionNotAuthenticatedError', async () => {
    const { client, transport } = makeClient();
    transport.next = { status: 403, body: 'forbidden', url: 'https://wd5.myworkday.com/acme/x.htmld' };
    await expect(client.fetchJson('/acme/x.htmld')).rejects.toThrow(SessionNotAuthenticatedError);
  });

  it('treats an off-host (SSO redirect) landing as a sign-out', async () => {
    const { client, transport } = makeClient();
    transport.next = {
      status: 200,
      body: '<html>...</html>',
      url: 'https://idp.examplecorp.com/idp/SSO.saml2',
    };
    await expect(client.fetchJson('/acme/x.htmld')).rejects.toThrow(SessionNotAuthenticatedError);
  });

  it('treats an on-host SAML login body as a sign-out', async () => {
    const { client, transport } = makeClient();
    transport.next = {
      status: 200,
      body: '<html><form><input name="SAMLRequest" value="..."/></form></html>',
      url: 'https://wd5.myworkday.com/acme/login',
    };
    await expect(client.fetchJson('/acme/x.htmld')).rejects.toThrow(SessionNotAuthenticatedError);
  });

  it('raises a helpful error on a non-JSON 200 (SPA shell)', async () => {
    const { client, transport } = makeClient();
    transport.next = {
      status: 200,
      body: '<!DOCTYPE html><html>app shell</html>',
      url: 'https://wd5.myworkday.com/acme/d/home.htmld',
    };
    await expect(client.fetchJson('/acme/d/home.htmld')).rejects.toThrow(/non-JSON body/);
  });

  it('surfaces other non-2xx via formatApiError', async () => {
    const { client, transport } = makeClient();
    transport.next = { status: 500, body: 'boom', url: 'https://wd5.myworkday.com/acme/x.htmld' };
    await expect(client.fetchJson('/acme/x.htmld')).rejects.toThrow(/500/);
  });
});

describe('WorkdayClient.getTask', () => {
  it('fetches, resolves the path, and parses into a task', async () => {
    const { client, transport } = makeClient();
    transport.next = {
      status: 200,
      url: 'https://wd5.myworkday.com/acme/inst/13102!ABC/cacheable-task/2998$1.htmld',
      body: JSON.stringify({
        widget: 'root',
        title: 'Compensation',
        taskId: '2998$1',
        sessionSecureToken: 'LEAK-ME-NOT',
        body: {
          widget: 'card',
          cardContentSections: [
            {
              widget: 'cardContentSection',
              contentSectionName: 'Salary',
              contentSectionItems: [
                { widget: 'text', label: 'Annual', value: '$120,000.00' },
              ],
            },
          ],
        },
      }),
    };
    const task = await client.getTask('/acme/d/inst/13102!ABC/cacheable-task/2998$1.htmld#x');
    // path was normalized (no /d/, no #fragment)
    expect(transport.lastInit?.path).toBe('/acme/inst/13102!ABC/cacheable-task/2998$1.htmld');
    expect(task.title).toBe('Compensation');
    expect(task.sections[0]).toEqual({
      name: 'Salary',
      fields: [{ label: 'Annual', value: '$120,000.00' }],
      references: [],
    });
    expect(JSON.stringify(task)).not.toContain('LEAK-ME-NOT');
  });
});
