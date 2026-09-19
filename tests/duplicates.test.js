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
    expect(hit.row).toEqual(tabs[0].rows[1]);
  });

  test('still matches after company and role were edited in the sheet', () => {
    const editedTabs = [
      {
        ...tabs[0],
        rows: [
          tabs[0].rows[0],
          [
            '2026-01-10',
            '99',
            'Acme Corporation',
            'Software Engineer II',
            'https://jobs.acme.com/open/99',
            'NYC',
            'Applied',
          ],
        ],
      },
    ];
    const hit = findExistingApplication(editedTabs, {
      url: 'https://jobs.acme.com/open/99',
      company: 'Acme',
      role: 'Engineer',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('url');
  });

  test('matches via Role HYPERLINK when URL column is empty', () => {
    const linkTabs = [
      {
        ...tabs[0],
        rows: [
          tabs[0].rows[0],
          [
            '2026-01-10',
            '99',
            'Edited Co',
            '=HYPERLINK("https://jobs.acme.com/open/99","Edited Role")',
            '',
            'NYC',
            'Applied',
          ],
        ],
      },
    ];
    const hit = findExistingApplication(linkTabs, {
      url: 'https://jobs.acme.com/open/99',
      company: 'Acme',
      role: 'Engineer',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('url');
    expect(hit.role).toBe('Edited Role');
  });

  test('matches by job id when URL and titles differ', () => {
    const idTabs = [
      {
        ...tabs[0],
        rows: [
          tabs[0].rows[0],
          [
            '2026-01-10',
            'REQ-998877',
            'Edited Co',
            'Edited Role',
            'https://old-ats.example.com/archived/xyz',
            'NYC',
            'Applied',
          ],
        ],
      },
    ];
    const hit = findExistingApplication(idTabs, {
      url: 'https://boards.example.com/jobs/new-path',
      company: 'Acme',
      role: 'Engineer',
      jobId: 'REQ-998877',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('job_id');
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
