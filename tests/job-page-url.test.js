import {
  urlLooksLikeJobPosting,
  isKnownAtsJobUrl,
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
    expect(urlLooksLikeJobPosting('https://example.com/positions/99')).toBe(
      true
    );
  });

  test('matches ATS hosts with board + slug paths', () => {
    expect(
      urlLooksLikeJobPosting('https://boards.greenhouse.io/acme/jobs/12345')
    ).toBe(true);
    expect(urlLooksLikeJobPosting('https://jobs.lever.co/acme/abc-def')).toBe(
      true
    );
    expect(
      urlLooksLikeJobPosting(
        'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/R123'
      )
    ).toBe(true);
  });

  test('matches ATS job-id query params', () => {
    expect(
      urlLooksLikeJobPosting(
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=99'
      )
    ).toBe(true);
  });

  test('rejects unrelated pages', () => {
    expect(urlLooksLikeJobPosting('https://example.com/about')).toBe(false);
    expect(urlLooksLikeJobPosting('https://boards.greenhouse.io/')).toBe(false);
  });

  test('isKnownAtsJobUrl aliases urlLooksLikeJobPosting', () => {
    const url = 'https://example.com/jobs/1';
    expect(isKnownAtsJobUrl(url)).toBe(urlLooksLikeJobPosting(url));
  });
});
