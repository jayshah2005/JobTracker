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
});

describe('normalizeDate', () => {
  test('keeps ISO dates', () => {
    expect(normalizeDate('2025-08-15T12:00:00Z')).toBe('2025-08-15');
  });
});
