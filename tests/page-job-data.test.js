import {
  preloadStorageKey,
  isPreloadFresh,
} from '../background/page-job-data.js';

describe('preloadStorageKey', () => {
  test('scopes cache entries per tab', () => {
    expect(preloadStorageKey(12)).toBe('jobPreload:12');
  });
});

describe('isPreloadFresh', () => {
  const now = 1_700_000_000_000;
  const data = { role: 'Engineer', company: 'Acme', url: 'https://jobs.acme.com/1' };

  test('accepts a matching fresh entry', () => {
    expect(
      isPreloadFresh(
        {
          url: 'https://jobs.acme.com/1?utm_source=x',
          data,
          cachedAt: now - 1000,
        },
        'https://jobs.acme.com/1',
        now
      )
    ).toBe(true);
  });

  test('rejects expired entries', () => {
    expect(
      isPreloadFresh(
        {
          url: 'https://jobs.acme.com/1',
          data,
          cachedAt: now - 6 * 60 * 1000,
        },
        'https://jobs.acme.com/1',
        now
      )
    ).toBe(false);
  });

  test('rejects URL mismatches', () => {
    expect(
      isPreloadFresh(
        {
          url: 'https://jobs.acme.com/1',
          data,
          cachedAt: now,
        },
        'https://jobs.acme.com/2',
        now
      )
    ).toBe(false);
  });

  test('rejects empty or incomplete entries', () => {
    expect(isPreloadFresh(null, 'https://x.com', now)).toBe(false);
    expect(isPreloadFresh({ url: '', data, cachedAt: now }, 'https://x.com', now)).toBe(
      false
    );
    expect(
      isPreloadFresh({ url: 'https://x.com', cachedAt: now }, 'https://x.com', now)
    ).toBe(false);
  });
});
