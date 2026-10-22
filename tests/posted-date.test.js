/**
 * @jest-environment jsdom
 */
import { JSDOM } from 'jsdom';
import { normalizeDate } from '../lib/extractors/shared.js';
import { extractJobData } from '../lib/job-extractor.js';

const NOW = new Date(2026, 9, 21, 12, 0, 0); // 2026-10-21 local noon
const JAN = new Date(2026, 0, 3, 12, 0, 0); // 2026-01-03

describe('year-less dates', () => {
  test.each([
    ['Jan 5', '2026-01-05'],
    ['January 5th', '2026-01-05'],
    ['5 Jan', '2026-01-05'],
    ['Posted Mar 3', '2026-03-03'],
    ['Oct 22', '2026-10-22'], // +1 day is fine
  ])('current year: %s', (i, e) => expect(normalizeDate(i, NOW)).toBe(e));

  test('far-future month/day falls back to previous year', () => {
    expect(normalizeDate('Dec 28', JAN)).toBe('2025-12-28');
    expect(normalizeDate('Dec 28', NOW)).toBe('2025-12-28');
  });
  test('Feb 29 resolves to a leap year only', () => {
    expect(normalizeDate('Feb 29', new Date(2026, 5, 1))).toBe('');
  });
});

describe('relative dates', () => {
  test.each([
    ['3 days ago', '2026-10-18'],
    ['Posted 2 weeks ago', '2026-10-07'],
    ['1 month ago', '2026-09-21'],
    ['yesterday', '2026-10-20'],
    ['today', '2026-10-21'],
    ['Just posted', '2026-10-21'],
    ['30+ days ago', '2026-09-21'],
    ['30+ Days Ago', '2026-09-21'],
    ['a day ago', '2026-10-20'],
    ['an hour ago', '2026-10-21'],
    ['Posted 5 hours ago', '2026-10-21'],
    ['Posted today', '2026-10-21'],
  ])('%s', (i, e) => expect(normalizeDate(i, NOW)).toBe(e));

  test('hours ago can cross midnight', () => {
    expect(normalizeDate('5 hours ago', new Date(2026, 9, 21, 2, 0, 0))).toBe('2026-10-20');
  });
});

describe('still rejected', () => {
  test.each([
    '03/04/2025', '1/5/24', '12', '20250815', '1995-03-01', '2999-01-01', '2025-02-30',
    'Jan 5, 2024 - Feb 1, 2024',
    'responded 3 days ago',
    'We responded to candidates within 3 days ago',
    'Jan 5 kickoff meeting',
    'Jan 5 or Feb 7',
    '3 days',
    'Foo 5',
  ])('%p', (i) => expect(normalizeDate(i, NOW)).toBe(''));
});

describe('body text scanning', () => {
  const url = 'https://acme.com/jobs/engineer-1234567';
  const run = (body) => {
    const doc = new JSDOM(`<body>${body}</body>`, { url }).window.document;
    return extractJobData(doc, url).postedDate;
  };
  test('anchored "Posted 3 days ago" is used', () => {
    expect(run('<h1>Engineer</h1><p>Posted 3 days ago</p>')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test('anchored year-less "Posted on Jan 5" is used', () => {
    expect(run('<h1>Engineer</h1><p>Posted on Jan 5</p>')).toMatch(/^\d{4}-01-05$/);
  });
  test('unrelated "3 days ago" in prose yields nothing', () => {
    expect(run('<main><h1>Engineer</h1><p>Our recruiter responded 3 days ago to everyone.</p></main>')).toBe('');
  });
});
