import { findExistingApplication, urlsMatch, extractJobId } from '../lib/duplicates.js';
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
        ['Date Applied', 'Job ID', 'Company Name', 'Role', 'Location', 'Application Status'],
        [
          '2026-01-10',
          '1',
          'Acme',
          '=HYPERLINK("https://jobs.acme.com/open/99","Engineer")',
          'NYC',
          'Interview',
        ],
      ],
    },
  ];

  test('finds a prior application by URL in the Role hyperlink', () => {
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

  test('still matches after company and role label were edited in the sheet', () => {
    const editedTabs = [
      {
        ...tabs[0],
        rows: [
          tabs[0].rows[0],
          [
            '2026-01-10',
            '99',
            'Acme Corporation',
            '=HYPERLINK("https://jobs.acme.com/open/99","Software Engineer II")',
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

  test('matches via Role HYPERLINK when there is no URL column', () => {
    const hit = findExistingApplication(tabs, {
      url: 'https://jobs.acme.com/open/99',
      company: 'Acme',
      role: 'Engineer',
    });
    expect(hit.matched).toBe(true);
    expect(hit.matchedBy).toBe('url');
    expect(hit.role).toBe('Engineer');
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
            '=HYPERLINK("https://old-ats.example.com/archived/xyz","Edited Role")',
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
    const plainTabs = [
      {
        ...tabs[0],
        rows: [
          tabs[0].rows[0],
          [
            '2026-01-10',
            '1',
            'Acme',
            'Engineer',
            'NYC',
            'Interview',
          ],
        ],
      },
    ];
    const hit = findExistingApplication(plainTabs, {
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

  test('destination filter ignores matches in other sheets', () => {
    const multi = [
      tabs[0],
      {
        sheetName: 'Other',
        tabName: 'Backup',
        spreadsheetId: 's2',
        gid: '1',
        mappings,
        rows: [tabs[0].rows[0]],
      },
    ];
    const elsewhere = findExistingApplication(
      multi,
      { url: 'https://jobs.acme.com/open/99' },
      { spreadsheetId: 's2', gid: '1' }
    );
    expect(elsewhere.matched).toBe(false);

    const sameTab = findExistingApplication(
      multi,
      { url: 'https://jobs.acme.com/open/99' },
      { spreadsheetId: 's1', gid: '0' }
    );
    expect(sameTab.matched).toBe(true);
    expect(sameTab.spreadsheetId).toBe('s1');
  });
});

describe('extractJobId robustness', () => {
  test('matches id query params case-insensitively', () => {
    expect(extractJobId('https://example.com/view?JobID=abc123')).toBe('abc123');
  });

  test('survives malformed percent-escapes in the path', () => {
    expect(extractJobId('https://example.com/%E0%A4%A/jobs/987654')).toBe('987654');
  });
});

describe('URL / id normalisation edge cases', () => {
  test('LinkedIn slugged, bare-id and currentJobId URLs match', () => {
    const a = 'https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3812345678?trackingId=x&refId=y';
    expect(urlsMatch(a, 'https://linkedin.com/jobs/view/3812345678/')).toBe(true);
    expect(
      urlsMatch(a, 'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3812345678')
    ).toBe(true);
  });

  test('Workday ignores source param and /apply is the same req id', () => {
    expect(
      extractJobId('https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/NYC/Software-Engineer_R-12345/apply')
    ).toBe('R-12345');
    expect(
      urlsMatch(
        'https://acme.wd5.myworkdayjobs.com/Careers/job/NYC/Software-Engineer_R-12345?source=LinkedIn',
        'https://acme.wd5.myworkdayjobs.com/Careers/job/NYC/Software-Engineer_R-12345/'
      )
    ).toBe(true);
  });

  test('Lever UUID ids and lever-source tracking', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(extractJobId(`https://jobs.lever.co/acme/${id}/apply`)).toBe(id);
    expect(
      urlsMatch(`https://jobs.lever.co/acme/${id}?lever-source=x`, `https://jobs.lever.co/acme/${id}`)
    ).toBe(true);
  });

  test('Greenhouse gh_src is tracking; same numeric id on different sites does not match', () => {
    expect(
      urlsMatch(
        'https://boards.greenhouse.io/acme/jobs/4012345005?gh_src=abc',
        'https://boards.greenhouse.io/acme/jobs/4012345005'
      )
    ).toBe(true);
    expect(
      urlsMatch('https://acme.com/careers/jobs/4012345005', 'https://other.com/careers/jobs/4012345005')
    ).toBe(false);
  });

  test('Indeed country subdomains with the same jk match', () => {
    expect(
      urlsMatch('https://uk.indeed.com/viewjob?jk=abc123def456&from=serp', 'https://uk.indeed.com/rc/clk?jk=abc123def456')
    ).toBe(true);
  });
});
