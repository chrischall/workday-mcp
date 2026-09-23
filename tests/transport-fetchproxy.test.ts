import { describe, it, expect, vi } from 'vitest';
import { FetchproxyTransport, splitHost } from '../src/transport-fetchproxy.js';

describe('splitHost', () => {
  it('splits a Workday data-center host into domain + subdomain', () => {
    expect(splitHost('wd5.myworkday.com')).toEqual({
      subdomain: 'wd5',
      domain: 'myworkday.com',
    });
    expect(splitHost('wd103a1.myworkday.com')).toEqual({
      subdomain: 'wd103a1',
      domain: 'myworkday.com',
    });
  });

  it('returns a bare two-label host as the domain with no subdomain', () => {
    expect(splitHost('myworkday.com')).toEqual({ domain: 'myworkday.com' });
  });
});

describe('FetchproxyTransport.fetch retryOnTimeout pass-through', () => {
  function withStubInner() {
    const t = new FetchproxyTransport({ host: 'wd5.myworkday.com', version: '0.0.0' });
    const fetch = vi.fn(async () => ({ status: 200, body: '{}', url: 'https://wd5.myworkday.com/x' }));
    (t as unknown as { inner: { fetch: typeof fetch; role: string } }).inner = { fetch, role: 'owner' };
    return { t, fetch };
  }

  it('forwards retryOnTimeout: true for a read-only POST', async () => {
    const { t, fetch } = withStubInner();
    await t.fetch({ path: '/wday/pex/graphql/graphql', method: 'POST', body: '{}', retryOnTimeout: true });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', retryOnTimeout: true }));
  });

  it('omits retryOnTimeout when the caller does not opt in (writes)', async () => {
    const { t, fetch } = withStubInner();
    await t.fetch({ path: '/acme/task/save.htmld', method: 'POST', body: '{}' });
    const init = (fetch.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect('retryOnTimeout' in init).toBe(false);
  });
});
