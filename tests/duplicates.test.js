import { findExistingApplication, urlsMatch } from '../lib/duplicates.js';
import { buildDefaultMappings } from '../lib/field-mapper.js';

describe('normalize / match URLs', () => {
  test('treats tracking params as the same job', () => {
    expect(
      urlsMatch(
        'https://www.linkedin.com/jobs/view/12345/?utm_source=share',
        'https://linkedin.com/jobs/view/12345'
      )
    ).toBe(true);
  });

  test('indeed jk param identifies the same posting', () => {
    expect(
      urlsMatch(
        'https://www.indeed.com/viewjob?jk=abc123&from=web',
        'https://www.indeed.com/viewjob?jk=abc123'
      )
    ).toBe(true);
  });

  test('different jobs do not match', () => {
    expect(
      urlsMatch(
        'https://linkedin.com/jobs/view/1',
        'https://linkedin.com/jobs/view/2'
      )
    ).toBe(false);
  });
});

describe('findExistingApplication', () => {
  const mappings = buildDefaultMappings();
  const tabs = [
    {
      sheetName: 'Tracker',
      tabName: 'Jobs',
      spreadsheetId: 's1',
      gid: '0',
      mappings,
      rows: [
        ['Date Applied', 'ID', 'Company Name', 'Role', 'URL', 'Location', 'Application Status'],
        [
          '2026-01-10',
          '1',
          'Acme',
          'Engineer',
          'https://jobs.acme.com/open/99',
          'NYC',
          'Interview',
        ],
      ],
    },
  ];

  test('finds a prior application by URL', () => {
    const hit = findExistingApplication(tabs, {
      url: 'https://jobs.acme.com/open/99?utm_campaign=x',
      company: 'Other',
      role: 'Other',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('url');
    expect(hit.status).toBe('Interview');
    expect(hit.dateApplied).toBe('2026-01-10');
    expect(hit.tabName).toBe('Jobs');
  });

  test('falls back to company + role', () => {
    const hit = findExistingApplication(tabs, {
      url: 'https://careers.acme.com/different-path',
      company: 'Acme',
      role: 'Engineer',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('company_role');
  });

  test('returns unmatched for a new job', () => {
    const hit = findExistingApplication(tabs, {
      url: 'https://jobs.newco.com/1',
      company: 'NewCo',
      role: 'PM',
    });
    expect(hit.matched).toBe(false);
  });
});
