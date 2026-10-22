/**
 * @jest-environment jsdom
 */
import { JSDOM } from 'jsdom';
import {
  extractJobData,
  isLikelyJobPage,
  extractJsonLdJobPosting,
  normalizeDate,
  pickBestExtraction,
  scoreExtraction,
} from '../lib/job-extractor.js';

function parseHtml(html, url = 'https://example.com/job') {
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

describe('extractJsonLdJobPosting', () => {
  test('extracts nested JobPosting from @graph', () => {
    const html = `
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", "name": "Careers" },
          {
            "@type": "JobPosting",
            "title": "Staff Engineer",
            "hiringOrganization": { "name": "NestedCo" },
            "jobLocation": { "address": { "addressLocality": "Austin", "addressRegion": "TX" } },
            "datePosted": "2025-08-15"
          }
        ]
      }
      </script>`;
    const doc = parseHtml(html);
    const job = extractJsonLdJobPosting(doc);
    expect(job.title).toBe('Staff Engineer');
    expect(job.hiringOrganization.name).toBe('NestedCo');
  });
});

describe('extractJobData fusion', () => {
  test('prefers JSON-LD over weaker signals', () => {
    const html = `
      <html><head>
      <meta property="og:title" content="Wrong Title at WrongCo" />
      <script type="application/ld+json">
      {"@type":"JobPosting","title":"Data Scientist","hiringOrganization":{"name":"DataCo"},
       "jobLocation":"Remote","datePosted":"2025-07-01"}
      </script>
      </head><body><h1>Ignore Me</h1></body></html>`;
    const doc = parseHtml(html, 'https://jobs.example.com/123');
    const data = extractJobData(doc, 'https://jobs.example.com/123');
    expect(data.role).toBe('Data Scientist');
    expect(data.company).toBe('DataCo');
    expect(data.location).toBe('Remote');
    expect(data.postedDate).toBe('2025-07-01');
    expect(data.confidence.role).toBe('high');
    expect(data.sources.role).toBe('json-ld');
  });

  test('reads TELECOMMUTE as Remote', () => {
    const html = `
      <script type="application/ld+json">
      {"@type":"JobPosting","title":"Writer","hiringOrganization":{"name":"InkCo"},
       "jobLocationType":"TELECOMMUTE","datePosted":"2025-01-01"}
      </script>`;
    const doc = parseHtml(html);
    const data = extractJobData(doc, 'https://inkco.example/careers/writer');
    expect(data.location).toMatch(/remote/i);
  });

  test('uses microdata when present', () => {
    const html = `
      <div itemscope itemtype="https://schema.org/JobPosting">
        <h1 itemprop="title">Frontend Engineer</h1>
        <div itemprop="hiringOrganization" itemscope>
          <span itemprop="name">UI Labs</span>
        </div>
        <span itemprop="jobLocation">Berlin, Germany</span>
        <meta itemprop="datePosted" content="2025-06-01" />
      </div>`;
    const doc = parseHtml(html);
    const data = extractJobData(doc, 'https://uilabs.example/careers/fe');
    expect(data.role).toBe('Frontend Engineer');
    expect(data.company).toBe('UI Labs');
    expect(data.location).toContain('Berlin');
  });

  test('falls back to og:title pattern', () => {
    const html = `
      <html><head>
      <meta property="og:title" content="Product Manager at StartupXYZ" />
      </head><body></body></html>`;
    const doc = parseHtml(html);
    const data = extractJobData(doc, 'https://example.com/job/1');
    expect(data.role).toBe('Product Manager');
    expect(data.company).toBe('StartupXYZ');
  });

  test('reads labeled fields from page text', () => {
    const html = `
      <html><body>
        <main>
          <h1>Open Role</h1>
          <p>Company: Acme Robotics</p>
          <p>Location: San Francisco, CA</p>
          <p>Posted: January 15, 2025</p>
          <button>Apply Now</button>
        </main>
      </body></html>`;
    const doc = parseHtml(html, 'https://careers.acmerobotics.com/jobs/1');
    const data = extractJobData(doc, 'https://careers.acmerobotics.com/jobs/1');
    expect(data.company).toMatch(/Acme/i);
    expect(data.location).toMatch(/San Francisco/i);
  });

  test('uses generic data attributes without site-specific selectors', () => {
    const html = `
      <main>
        <h1 class="posting-job-title">Business Analyst Intern</h1>
        <div data-testid="company-name">Northwind Bank</div>
        <div data-automation-id="job-location">Toronto, ON</div>
        <a href="/apply">Apply now</a>
      </main>`;
    const doc = parseHtml(html, 'https://careers.northwind.example/jobs/ba-intern');
    const data = extractJobData(doc, 'https://careers.northwind.example/jobs/ba-intern');
    expect(data.role).toMatch(/Business Analyst Intern/i);
    expect(data.company).toMatch(/Northwind/i);
    expect(data.location).toMatch(/Toronto/i);
  });

  test('prefers main content h1 over nav noise', () => {
    const html = `
      <header><h1>Careers</h1></header>
      <main>
        <h1>Machine Learning Engineer</h1>
        <p>Company: Helix AI</p>
        <button>Apply</button>
      </main>`;
    const doc = parseHtml(html, 'https://helix.example/careers/mle');
    const data = extractJobData(doc, 'https://helix.example/careers/mle');
    expect(data.role).toBe('Machine Learning Engineer');
  });

  test('falls back to h1', () => {
    const html = '<html><body><main><h1>Frontend Developer</h1></main></body></html>';
    const doc = parseHtml(html);
    const data = extractJobData(doc, 'https://careers.example.com/fe');
    expect(data.role).toBe('Frontend Developer');
  });

  test('exposes source metadata', () => {
    const html = '<html><body><main><h1>Backend Engineer</h1></main></body></html>';
    const doc = parseHtml(html);
    const data = extractJobData(doc, 'https://example.com/jobs/be');
    expect(data.sources.role).toBeTruthy();
    expect(data.sources.url).toBe('page-url');
  });

  test('does not treat host platform name as company from og:site_name', () => {
    const html = `
      <html><head>
        <meta property="og:site_name" content="LinkedIn" />
        <meta property="og:title" content="Designer at BrightStudio" />
      </head><body><main><h1>Designer</h1></main></body></html>`;
    const doc = parseHtml(html, 'https://www.linkedin.com/jobs/view/123');
    const data = extractJobData(doc, 'https://www.linkedin.com/jobs/view/123');
    expect(data.company).toMatch(/BrightStudio/i);
    expect(data.company).not.toMatch(/^LinkedIn$/i);
  });
});

describe('pickBestExtraction', () => {
  test('chooses the richer frame result', () => {
    const weak = {
      data: { role: '', company: '', url: 'https://a.example', confidence: {}, sources: {} },
      isJobPage: false,
    };
    const strong = {
      data: {
        role: 'Analyst',
        company: 'RBC',
        location: 'Toronto, ON',
        url: 'https://a.example/iframe',
        confidence: { role: 'high', company: 'high', location: 'medium' },
        sources: {},
      },
      isJobPage: true,
    };
    const best = pickBestExtraction([weak, strong], 'https://a.example');
    expect(best.role).toBe('Analyst');
    expect(best.company).toBe('RBC');
    expect(scoreExtraction(strong.data, true)).toBeGreaterThan(scoreExtraction(weak.data, false));
  });
});

describe('isLikelyJobPage', () => {
  test('detects career path URLs', () => {
    expect(isLikelyJobPage('https://company.example/careers/openings/123', null)).toBe(true);
  });

  test('detects JSON-LD job pages', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"X"}</script>`;
    const doc = parseHtml(html);
    expect(isLikelyJobPage('https://careers.co/job', doc)).toBe(true);
  });

  test('rejects generic pages', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const doc = parseHtml(html);
    expect(isLikelyJobPage('https://example.com/about', doc)).toBe(false);
  });

  test('detects a posting with no URL hint from DOM structure', () => {
    const html = `
      <main>
        <h1>Senior Product Designer</h1>
        <h2>About the role</h2><p>Design things.</p>
        <h2>Responsibilities</h2><ul><li>Ship</li></ul>
        <h2>Qualifications</h2><p>5+ years of experience. Full-time.</p>
        <p>Salary: $150k. We are an equal opportunity employer.</p>
        <a href="/form">Apply now</a>
      </main>`;
    const doc = parseHtml(html, 'https://acme.example/p/9f');
    expect(isLikelyJobPage('https://acme.example/p/9f', doc)).toBe(true);
  });

  test('rejects mail/app shells that mention jobs and apply', () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<tr role="row"><td>Job alert: Software Engineer intern at Co${i} — apply now</td>
        <td><a href="https://www.linkedin.com/jobs/view/${1000 + i}">View job</a></td></tr>`
    ).join('');
    const html = `
      <title>Inbox (40) - me@example.com - Mail</title>
      <div role="main"><table role="grid">${rows}</table>
        <button>Apply</button>
        <strong>Requirements</strong><strong>Responsibilities</strong>
      </div>`;
    const url = 'https://mail.google.com/mail/u/0/#inbox';
    expect(isLikelyJobPage(url, parseHtml(html, url))).toBe(false);
  });

  test('rejects listing pages with many posting links', () => {
    const links = Array.from(
      { length: 20 },
      (_, i) => `<li><a href="https://acme.example/jobs/role-${i}">Role ${i}</a></li>`
    ).join('');
    const html = `<main><h1>Open roles</h1><ul>${links}</ul><a href="#">Apply</a>
      <h3>Benefits</h3><p>Full-time and part-time roles.</p></main>`;
    const url = 'https://acme.example/careers';
    expect(isLikelyJobPage(url, parseHtml(html, url))).toBe(false);
  });
});

describe('normalizeDate', () => {
  test('keeps ISO dates', () => {
    expect(normalizeDate('2025-08-15T12:00:00Z')).toBe('2025-08-15');
  });
});

describe('regressions', () => {
  test('normalizeDate rejects year-less strings that Date() would coerce to 2001', () => {
    expect(normalizeDate('12')).toBe('');
    expect(normalizeDate('Jan 5', new Date(2026, 5, 1))).toBe('2026-01-05');
    expect(normalizeDate('Jan 5, 2024')).toBe('2024-01-05');
  });

  test('keeps non-Latin company names (key was empty before)', () => {
    const doc = parseHtml(
      `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer",
        "hiringOrganization":{"name":"株式会社テスト"}}</script>`,
      'https://example.com/jobs/123456'
    );
    expect(extractJobData(doc, 'https://example.com/jobs/123456').company).toBe('株式会社テスト');
  });
});

describe('normalizeDate policy: no date beats a wrong date', () => {
  test.each([
    ['2025-08-15', '2025-08-15'],
    ['2025-08-15T23:59:00-05:00', '2025-08-15'],
    ['Aug 15, 2025', '2025-08-15'],
    ['August 15th, 2025', '2025-08-15'],
    ['15 August 2025', '2025-08-15'],
    ['Posted on Sept 3, 2024', '2024-09-03'],
    ['25/12/2024', '2024-12-25'],
    ['12/25/2024', '2024-12-25'],
    ['03/03/2024', '2024-03-03'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  test.each([
    '03/04/2025', // d/m vs m/d ambiguous
    '1.2.2025',
    '1/5/24', // two-digit year
    '12',
    '20250815',
    '1723680000',
    '1995-03-01',
    '1999-12-31',
    '2999-01-01',
    '2025-13-45',
    '2025-02-30',
    'Jan 5, 2024 - Feb 1, 2024', // several different dates
    'Updated 3/4/2025',
    null,
    undefined,
    '',
  ])('rejects %p', (input) => {
    expect(normalizeDate(input)).toBe('');
  });

  test('extractJobData drops a relative/ambiguous JSON-LD datePosted', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer",
      "hiringOrganization":{"name":"Acme"},"datePosted":"03/04/2025"}</script>`;
    const data = extractJobData(parseHtml(html, 'https://acme.com/jobs/engineer-1234567'), 'https://acme.com/jobs/engineer-1234567');
    expect(data.postedDate).toBe('');
  });

  test('extractJobData resolves "Posted 3 days ago" and drops ambiguous 04/05/2025', () => {
    const html = '<body><h1>Engineer</h1><p>Posted 3 days ago</p><p>Posted: 04/05/2025</p></body>';
    const data = extractJobData(parseHtml(html, 'https://acme.com/jobs/engineer-1234567'), 'https://acme.com/jobs/engineer-1234567');
    expect(data.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('title / company cleaning', () => {
  test('Apply button text is stripped from the role', () => {
    const url = 'https://acme.com/jobs/engineer-1234567';
    const html = `<body><h1>Senior Engineer<button>Apply</button></h1>
      <script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"name":"Acme"}}</script></body>`;
    expect(extractJobData(parseHtml(html, url), url).role).toBe('Senior Engineer');
  });

  test('company suffixes like "Careers" are removed', () => {
    const url = 'https://acme.com/jobs/engineer-1234567';
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer",
      "hiringOrganization":{"name":"Acme Careers"}}</script>`;
    expect(extractJobData(parseHtml(html, url), url).company).toBe('Acme');
  });

  test('a company on its own domain is not penalised as a platform brand', () => {
    const url = 'https://www.stripe.com/jobs/listing/engineer/5678901';
    const html = `<head><meta property="og:site_name" content="Stripe"></head><body><h1>Engineer</h1></body>`;
    expect(extractJobData(parseHtml(html, url), url).company).toBe('Stripe');
  });
});
