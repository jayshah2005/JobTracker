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
            'Acme Inc.',
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

describe('cross-employer job id collisions', () => {
  const mappings = [
    { columnIndex: 0, header: 'Company Name', tag: 'company_name' },
    { columnIndex: 1, header: 'Job ID', tag: 'id' },
    { columnIndex: 2, header: 'Role', tag: 'role' },
  ];
  const tab = (rows) => [{ sheetName: 'S', tabName: 'T', spreadsheetId: 's', gid: '0', mappings, rows }];

  test('workday requisition ids on different tenants do not match by URL id', () => {
    expect(
      urlsMatch(
        'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/NYC/Engineer_R-1234',
        'https://globex.wd1.myworkdayjobs.com/Jobs/job/SF/Analyst_R-1234'
      )
    ).toBe(false);
  });
});

describe('rowFingerprint', () => {
  test('ignores trailing empties and stringifies cells', async () => {
    const { rowFingerprint } = await import('../lib/duplicates.js');
    expect(rowFingerprint(['a', 5, '', ''])).toBe(rowFingerprint(['a', '5']));
    expect(rowFingerprint(['a', '', 'b'])).not.toBe(rowFingerprint(['a', 'b']));
    expect(rowFingerprint(undefined)).toBe(rowFingerprint([]));
  });
});

describe('job-id match guarded by company', () => {
  const mappings = buildDefaultMappings();
  const header = mappings.map((m) => m.header);
  const mk = (company) => [
    {
      sheetName: 'T', tabName: 'J', spreadsheetId: 's', gid: '0', mappings,
      rows: [
        header,
        ['2026-01-10', '98765', company, '=HYPERLINK("https://boards.example.com/a/jobs/98765","Role")', '', 'Applied', ''],
      ],
    },
  ];
  const job = (company, url) => ({ company, url, jobId: '98765' });

  test('same id, clearly different company: no match', () => {
    const res = findExistingApplication(
      mk('Globex'),
      job('Initech Systems', 'https://boards.example.com/b/jobs/98765?x=1')
    );
    expect(res.matched).toBe(false);
  });

  test('same id, shortened/edited company still matches', () => {
    const res = findExistingApplication(
      mk('Acme Inc'),
      job('Acme', 'https://boards.example.com/b/jobs/98765?x=1')
    );
    expect(res.matched).toBe(true);
  });

  test('same id, missing company on page still matches', () => {
    const res = findExistingApplication(
      mk('Globex'),
      job('', 'https://boards.example.com/b/jobs/98765?x=1')
    );
    expect(res.matched).toBe(true);
  });

  test('identical URL matches even when company differs', () => {
    const res = findExistingApplication(
      mk('Globex'),
      job('Initech', 'https://boards.example.com/a/jobs/98765')
    );
    expect(res.matched).toBe(true);
    expect(res.matchedBy).toBe('url');
  });
});

describe('matching rows stored with a text marker', () => {
  test("'-Senior role and '=x company still match", () => {
    const mappings = buildDefaultMappings();
    const col = (tag) => mappings.find((m) => (m.tag || m.fieldTag) === tag || m.tag === tag)?.columnIndex;
    const header = mappings.map((m) => m.header);
    const companyCol = mappings.findIndex((m) => /company/i.test(m.header));
    const roleCol = mappings.findIndex((m) => /role|title/i.test(m.header));
    const row = header.map(() => '');
    row[companyCol] = "'=Acme";
    row[roleCol] = "'-Senior role";
    const res = findExistingApplication(
      [{ sheetName: 'S', tabName: 'T', spreadsheetId: 's', gid: '1', mappings, rows: [header, row] }],
      { company: '=Acme', role: '-Senior role' }
    );
    expect(res.matched).toBe(true);
    expect(res.matchedBy).toBe('company_role');
    void col;
  });
});
