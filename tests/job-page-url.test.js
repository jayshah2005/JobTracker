import {
  classifyJobUrl,
  urlLooksLikeJobPosting,
} from '../lib/job-page-url.js';

describe('urlLooksLikeJobPosting', () => {
  test('matches generic /jobs/ paths on any host', () => {
    expect(
      urlLooksLikeJobPosting(
        'https://job-boards.greenhouse.io/khanacademy/jobs/8250259'
      )
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting('https://careers.example.com/jobs/backend-engineer')
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting('https://www.linkedin.com/jobs/view/123456')
    ).toBe(true);
  });

  test('matches generic careers/openings paths', () => {
    expect(
      urlLooksLikeJobPosting('https://example.com/careers/openings/42')
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting('https://example.com/en-us/careers/senior-designer')
    ).toBe(true);
  });

  test('weak job words need a jobs host', () => {
    expect(urlLooksLikeJobPosting('https://example.com/positions/99')).toBe(false);
    expect(urlLooksLikeJobPosting('https://careers.example.com/positions/99')).toBe(
      true
    );
  });

  test('matches jobs hosts with board + id paths', () => {
    expect(
      urlLooksLikeJobPosting('https://boards.greenhouse.io/acme/jobs/12345')
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting(
        'https://jobs.lever.co/acme/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f'
      )
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting(
        'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/R123'
      )
    ).toBe(true);
  });

  test('matches job-id query params', () => {
    expect(
      urlLooksLikeJobPosting(
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=99'
      )
    ).toBe(true);
    expect(
      urlLooksLikeJobPosting('https://www.linkedin.com/jobs/search/?currentJobId=42')
    ).toBe(true);
    expect(urlLooksLikeJobPosting('https://www.indeed.com/viewjob?jk=abc123')).toBe(
      true
    );
    expect(urlLooksLikeJobPosting('https://acme.com/careers?gh_jid=555')).toBe(true);
  });

  test('rejects unrelated pages', () => {
    expect(urlLooksLikeJobPosting('https://example.com/about')).toBe(false);
    expect(urlLooksLikeJobPosting('https://boards.greenhouse.io/')).toBe(false);
  });

  test('ignores the #hash used by web-app routers', () => {
    expect(
      urlLooksLikeJobPosting('https://mail.google.com/mail/u/0/#search/jobs/FMfcgz123')
    ).toBe(false);
    expect(urlLooksLikeJobPosting('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
  });

  test('landing and listing pages are careers, not postings', () => {
    expect(classifyJobUrl('https://example.com/careers').kind).toBe('careers');
    expect(classifyJobUrl('https://example.com/careers/teams/engineering-2').kind).toBe(
      'careers'
    );
    expect(classifyJobUrl('https://www.linkedin.com/jobs/').kind).toBe('careers');
    expect(classifyJobUrl('https://example.com/about').kind).toBe('none');
  });

});
