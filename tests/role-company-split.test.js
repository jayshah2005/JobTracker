/**
 * @jest-environment jsdom
 */
import { JSDOM } from 'jsdom';
import { extractJobData } from '../lib/job-extractor.js';
import {
  looksLikeRole,
  looksLikeCompany,
  roleScore,
  isLocationPart,
  splitTitleSegments,
} from '../lib/role-likelihood.js';

function extractFromTitle(title, url = 'https://jobs.io/posting/12345-opening', { og = false } = {}) {
  const head = og
    ? `<meta property="og:title" content="${title}"><title>x</title>`
    : `<title>${title}</title>`;
  const dom = new JSDOM(`<html><head>${head}</head><body><p>Apply now</p></body></html>`, { url });
  return extractJobData(dom.window.document, url);
}

describe('looksLikeRole / looksLikeCompany', () => {
  test.each([
    'Software Engineer',
    'Senior Data Analyst',
    'Sr. Product Manager',
    'Head of Marketing',
    'Staff Designer',
    'Registered Nurse',
    'Delivery Driver',
    'VP of Engineering',
    'Account Executive',
    'Marketing Intern',
    'Principal Architect',
    'Recruiter',
  ])('%s is a role', (t) => expect(looksLikeRole(t)).toBe(true));

  test.each([
    'Acme Inc',
    'Acme Corp',
    'Globex LLC',
    'Initech Ltd',
    'Umbrella GmbH',
    'Acme Technologies',
    'Foo Labs',
    'Bar Holdings',
    'Baz Solutions',
    'Acme Careers',
    'IBM',
    'Wayne Enterprises',
  ])('%s is a company', (t) => expect(looksLikeCompany(t)).toBe(true));

  test('false-positive guards', () => {
    expect(looksLikeRole('Lead Generation Inc')).toBe(false);
    expect(looksLikeCompany('Lead Generation Inc')).toBe(true);
    expect(looksLikeRole('Engineers Without Borders')).toBe(false);
    expect(looksLikeRole('Data Systems Inc')).toBe(false);
    expect(looksLikeRole('Product Hunt')).toBe(false);
    expect(looksLikeRole('Systems Engineer')).toBe(true);
    expect(looksLikeCompany('Systems Engineer')).toBe(false);
  });

  test('host match favours company', () => {
    expect(roleScore('Stripe', 'stripe.com')).toBeLessThan(roleScore('Stripe', 'example.com'));
  });

  test('location parts and segments', () => {
    expect(isLocationPart('Remote')).toBe(true);
    expect(isLocationPart('Austin, TX')).toBe(true);
    expect(isLocationPart('Software Engineer')).toBe(false);
    expect(splitTitleSegments('Software Engineer - Remote | Acme')).toEqual(['Software Engineer', 'Acme']);
    expect(splitTitleSegments('Acme: Data Analyst')).toEqual(['Acme', 'Data Analyst']);
  });
});

describe('ambiguous title splitting', () => {
  const cases = [
    // [title, role, company]
    ['Software Engineer - Acme', 'Software Engineer', 'Acme'],
    ['Acme - Software Engineer', 'Software Engineer', 'Acme'],
    ['Software Engineer | Acme', 'Software Engineer', 'Acme'],
    ['Acme | Software Engineer', 'Software Engineer', 'Acme'],
    ['Software Engineer – Acme', 'Software Engineer', 'Acme'],
    ['Acme – Software Engineer', 'Software Engineer', 'Acme'],
    ['Acme: Senior Data Analyst', 'Senior Data Analyst', 'Acme'],
    ['Senior Data Analyst: Acme', 'Senior Data Analyst', 'Acme'],
    ['Acme Inc | Product Manager', 'Product Manager', 'Acme Inc'],
    ['Product Manager | Acme Inc', 'Product Manager', 'Acme Inc'],
    ['Globex Corp - Marketing Specialist', 'Marketing Specialist', 'Globex Corp'],
    ['Foo Technologies - Staff Engineer', 'Staff Engineer', 'Foo Technologies'],
    ['Initech Labs | Head of Design', 'Head of Design', 'Initech Labs'],
    ['Software Engineer - Remote | Acme', 'Software Engineer', 'Acme'],
    ['Acme | Software Engineer - Remote', 'Software Engineer', 'Acme'],
    ['Acme - Software Engineer - Austin, TX', 'Software Engineer', 'Acme'],
    ['Software Engineer - Austin, TX - Acme', 'Software Engineer', 'Acme'],
    ['Acme Careers | Data Scientist', 'Data Scientist', 'Acme'],
    ['Lead Generation Inc - Sales Representative', 'Sales Representative', 'Lead Generation Inc'],
    ['Sales Representative - Lead Generation Inc', 'Sales Representative', 'Lead Generation Inc'],
    ['Engineers Without Borders - Program Manager', 'Program Manager', 'Engineers Without Borders'],
    ['Program Manager | Engineers Without Borders', 'Program Manager', 'Engineers Without Borders'],
    ['Registered Nurse - Mercy Hospital', 'Registered Nurse', 'Mercy Hospital'],
    ['ACME - Recruiter', 'Recruiter', 'ACME'],
  ];

  test.each(cases)('document title: %s', (title, role, company) => {
    const r = extractFromTitle(title);
    expect(r.role).toBe(role);
    expect(r.company).toBe(company);
  });

  test.each(cases.slice(0, 12))('og:title: %s', (title, role, company) => {
    const r = extractFromTitle(title, undefined, { og: true });
    expect(r.role).toBe(role);
    expect(r.company).toBe(company);
  });

  test('role with "(Remote)" suffix does not make Remote the company', () => {
    const r = extractFromTitle('Software Engineer (Remote)');
    expect(r.role).toMatch(/^Software Engineer/);
    expect(r.company).not.toBe('Remote');
  });

  test('explicit "at" still wins', () => {
    const r = extractFromTitle('Backend Developer at Acme - Remote');
    expect(r.role).toBe('Backend Developer');
    expect(r.company).toBe('Acme');
  });

  test('host-matching name is the company even without keywords', () => {
    const r = extractFromTitle('Stripe | Operations Lead', 'https://stripe.com/jobs/listing/ops/123456');
    expect(r.company).toBe('Stripe');
    expect(r.role).toBe('Operations Lead');
  });

  test('ties keep legacy orientation (left = role)', () => {
    const r = extractFromTitle('Zorblax | Quuxify');
    expect(r.role).toBe('Zorblax');
  });
});
