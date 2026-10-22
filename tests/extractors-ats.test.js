/**
 * @jest-environment jsdom
 */
import { JSDOM } from 'jsdom';
import { detectAts } from '../lib/extractors/detect.js';
import { extractJobData, isLikelyJobPage } from '../lib/job-extractor.js';

function parseHtml(html, url) {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe('detectAts', () => {
  test('detects Greenhouse board URLs', () => {
    const meta = detectAts('https://boards.greenhouse.io/acme/jobs/1234567');
    expect(meta.ats).toBe('greenhouse');
    expect(meta.board).toBe('acme');
    expect(meta.jobId).toBe('1234567');
  });

  test('detects Workday tenant URLs', () => {
    const meta = detectAts(
      'https://acme.wd5.myworkdayjobs.com/External/job/NY/Software-Engineer_R123'
    );
    expect(meta.ats).toBe('workday');
    expect(meta.tenant).toBe('acme');
    expect(meta.jobId).toMatch(/Software-Engineer_R123/);
  });

  test('detects Lever and Ashby', () => {
    expect(detectAts('https://jobs.lever.co/stripe/abc-def').ats).toBe('lever');
    expect(detectAts('https://jobs.ashbyhq.com/ramp/uuid-1').ats).toBe('ashby');
  });
});

describe('ATS pipelines', () => {
  test('Greenhouse DOM extraction', () => {
    const url = 'https://boards.greenhouse.io/dataco/jobs/4001';
    const html = `
      <html><body>
        <div id="header">
          <h1 class="app-title">Staff Data Engineer</h1>
          <span class="company-name">DataCo</span>
          <div class="location">San Francisco, CA</div>
        </div>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('greenhouse');
    expect(data.role).toBe('Staff Data Engineer');
    expect(data.company).toMatch(/DataCo/i);
    expect(data.location).toMatch(/San Francisco/i);
    expect(data.jobId).toBe('4001');
    expect(data.sources.role).toMatch(/greenhouse/);
  });

  test('Greenhouse __NEXT_DATA__ extraction', () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/99';
    const payload = {
      props: {
        pageProps: {
          job: {
            title: 'Platform Engineer',
            location: { name: 'Remote' },
            absolute_url: url,
            id: 99,
            internal_job_id: 55,
          },
        },
      },
    };
    const html = `<html><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
      <h1>Ignore</h1>
    </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.role).toBe('Platform Engineer');
    expect(data.location).toMatch(/Remote/i);
    expect(data.sources.role).toMatch(/greenhouse/);
  });

  test('Workday automation-id extraction', () => {
    const url =
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US/CUDA-Engineer_JR12345';
    const html = `
      <html><body>
        <h2 data-automation-id="jobPostingHeader">CUDA Engineer</h2>
        <div data-automation-id="locations">Santa Clara, CA</div>
        <div data-automation-id="postedOn">Posted on Mar 1, 2026</div>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('workday');
    expect(data.role).toBe('CUDA Engineer');
    expect(data.location).toMatch(/Santa Clara/i);
    expect(data.company).toMatch(/Nvidia/i);
    expect(data.jobId).toMatch(/JR12345/i);
  });

  test('RBC Workday peels requisition id out of the title', () => {
    const url =
      'https://rbc.wd3.myworkdayjobs.com/en-US/RBCGLOBAL1/job/TORONTO-ON/Senior-Full-Stack-Developer_0000050007';
    const html = `
      <html><head>
        <meta property="og:title" content="Senior Full Stack Developer – 0000050007 Royal Bank of Canada" />
      </head><body>
        <h2 data-automation-id="jobPostingHeader">Senior Full Stack Developer – 0000050007</h2>
        <div data-automation-id="locations">TORONTO, Ontario, Canada</div>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('workday');
    expect(data.role).toBe('Senior Full Stack Developer');
    expect(data.role).not.toMatch(/0000050007/);
    expect(data.company).toMatch(/Royal Bank of Canada|Rbc/i);
    expect(data.company).not.toMatch(/^0000050007/);
    expect(data.jobId).toMatch(/0000050007/);
    expect(data.location).toMatch(/TORONTO/i);
  });

  test('Lever posting headline extraction', () => {
    const url = 'https://jobs.lever.co/notion/abcd-1234';
    const html = `
      <html><body>
        <div class="posting-headline"><h2>Product Designer</h2></div>
        <div class="posting-categories">
          <div class="location">New York</div>
        </div>
        <img class="main-header-logo" alt="Notion logo" />
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('lever');
    expect(data.role).toBe('Product Designer');
    expect(data.location).toMatch(/New York/i);
    expect(data.company).toMatch(/Notion/i);
  });

  test('Ashby next-data extraction', () => {
    const url = 'https://jobs.ashbyhq.com/ramp/job-uuid';
    const payload = {
      props: {
        pageProps: {
          jobPosting: {
            __typename: 'JobPosting',
            title: 'Growth Engineer',
            locationName: 'Remote - US',
            id: 'job-uuid',
            organizationName: 'Ramp',
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      payload
    )}</script>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('ashby');
    expect(data.role).toBe('Growth Engineer');
    expect(data.location).toMatch(/Remote/i);
    expect(data.company).toMatch(/Ramp/i);
  });

  test('SmartRecruiters DOM extraction', () => {
    const url = 'https://jobs.smartrecruiters.com/AcmeCorp/123-Backend-Engineer';
    const html = `
      <html><body>
        <h1 data-test="job-title">Backend Engineer</h1>
        <div data-test="job-location">Berlin, Germany</div>
        <div data-test="company-name">Acme Corp</div>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('smartrecruiters');
    expect(data.role).toBe('Backend Engineer');
    expect(data.location).toMatch(/Berlin/i);
    expect(data.company).toMatch(/Acme/i);
  });

  test('LinkedIn detail extraction', () => {
    const url = 'https://www.linkedin.com/jobs/view/4123456789';
    const html = `
      <html><body>
        <div class="job-details-jobs-unified-top-card__job-title">
          <h1>Staff Frontend Engineer</h1>
        </div>
        <div class="job-details-jobs-unified-top-card__company-name">
          <a href="/company/acme">Acme Inc</a>
        </div>
        <span class="job-details-jobs-unified-top-card__bullet">San Francisco, CA</span>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('linkedin');
    expect(data.role).toBe('Staff Frontend Engineer');
    expect(data.company).toMatch(/Acme/i);
    expect(data.jobId).toBe('4123456789');
  });

  test('Indeed detail extraction', () => {
    const url = 'https://www.indeed.com/viewjob?jk=abc123def';
    const html = `
      <html><body>
        <h1 class="jobsearch-JobInfoHeader-title">Backend Engineer</h1>
        <div data-company-name="true">Widget Co</div>
        <div data-testid="inlineHeader-companyLocation">Austin, TX</div>
      </body></html>`;
    const data = extractJobData(parseHtml(html, url), url);
    expect(data.ats).toBe('indeed');
    expect(data.role).toBe('Backend Engineer');
    expect(data.company).toMatch(/Widget/i);
    expect(data.location).toMatch(/Austin/i);
    expect(data.jobId).toBe('abc123def');
  });

  test('detectAts recognizes LinkedIn and Indeed', () => {
    expect(detectAts('https://www.linkedin.com/jobs/view/99').ats).toBe('linkedin');
    expect(detectAts('https://www.indeed.com/viewjob?jk=x').ats).toBe('indeed');
  });

  test('ATS URLs count as likely job pages', () => {
    expect(
      isLikelyJobPage('https://boards.greenhouse.io/x/jobs/1', null)
    ).toBe(true);
    expect(
      isLikelyJobPage(
        'https://acme.wd1.myworkdayjobs.com/Site/job/A/Role_R1',
        null
      )
    ).toBe(true);
  });
});

describe('regressions', () => {
  test('host matching does not accept look-alike domains', () => {
    expect(detectAts('https://notlinkedin.com/jobs/view/123').ats).toBe('general');
    expect(detectAts('https://www.linkedin.com/jobs/view/123').ats).toBe('linkedin');
  });

  test('Lever keeps company names that merely contain "lever"', () => {
    const doc = parseHtml(
      `<div class="main-header-logo"><img alt="Clever Labs logo"></div>
       <div class="posting-headline"><h2>Engineer</h2></div>`,
      'https://jobs.lever.co/clever/abc-123'
    );
    expect(extractJobData(doc, 'https://jobs.lever.co/clever/abc-123').company).toBe('Clever Labs');
  });
});
