import { describe, it, expect } from 'vitest';
import { splitHost } from '../src/transport-fetchproxy.js';

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
