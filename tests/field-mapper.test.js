import {
  guessTagFromHeader,
  buildDefaultMappings,
  buildMappingsFromHeaders,
  isSheetEmpty,
  getUniqueColumnValues,
  buildRowFromMappings,
  getFieldsNeedingInput,
  generateNextId,
  formatDate,
  resolveFieldTag,
  normalizeDropdownOptions,
  mergeDropdownOptions,
  buildColumnUniques,
  buildHyperlinkFormula,
  hyperlinkLabel,
} from '../lib/field-mapper.js';
import { FIELD_TAGS } from '../lib/constants.js';

describe('guessTagFromHeader', () => {
  test('maps known headers', () => {
    expect(guessTagFromHeader('Company Name')).toBe(FIELD_TAGS.COMPANY_NAME);
    expect(guessTagFromHeader('job title')).toBe(FIELD_TAGS.ROLE);
    expect(guessTagFromHeader('Status')).toBe(FIELD_TAGS.CUSTOM_DROPDOWN);
  });

  test('maps date applied case-insensitively', () => {
    expect(guessTagFromHeader('Date Applied')).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(guessTagFromHeader('DATE APPLIED')).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(guessTagFromHeader('date_applied')).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(guessTagFromHeader('  date applied  ')).toBe(FIELD_TAGS.DATE_APPLIED);
  });

  test('maps job id headers', () => {
    expect(guessTagFromHeader('Job ID')).toBe(FIELD_TAGS.ID);
    expect(guessTagFromHeader('ID')).toBe(FIELD_TAGS.ID);
  });

  test('defaults unknown headers to custom text; notes to textbox', () => {
    expect(guessTagFromHeader('Source')).toBe(FIELD_TAGS.CUSTOM_TEXT);
    expect(guessTagFromHeader('Notes')).toBe(FIELD_TAGS.CUSTOM_TEXTBOX);
  });
});

describe('isSheetEmpty', () => {
  test('empty array is empty', () => {
    expect(isSheetEmpty([])).toBe(true);
    expect(isSheetEmpty([[]])).toBe(true);
    expect(isSheetEmpty([['', '']])).toBe(true);
  });

  test('row with headers is not empty', () => {
    expect(isSheetEmpty([['Company', 'Role']])).toBe(false);
  });
});

describe('buildDefaultMappings', () => {
  test('creates 7 default mappings', () => {
    const mappings = buildDefaultMappings();
    expect(mappings).toHaveLength(7);
    expect(mappings[0].tag).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(mappings[2].tag).toBe(FIELD_TAGS.COMPANY_NAME);
    const status = mappings.find((m) => m.header === 'Application Status');
    expect(status.tag).toBe(FIELD_TAGS.CUSTOM_DROPDOWN);
    expect(status.dropdownOptions).toEqual(
      expect.arrayContaining(['Applied', 'Interviewing', 'Offer'])
    );
    expect(status.dropdownDefault).toBe('Applied');
  });
});

describe('buildMappingsFromHeaders', () => {
  test('maps custom headers', () => {
    const mappings = buildMappingsFromHeaders(['Company', 'Notes', 'Source']);
    expect(mappings[0].tag).toBe(FIELD_TAGS.COMPANY_NAME);
    expect(mappings[1].tag).toBe(FIELD_TAGS.CUSTOM_TEXTBOX);
    expect(mappings[2].tag).toBe(FIELD_TAGS.CUSTOM_TEXT);
  });
});

describe('getUniqueColumnValues', () => {
  const rows = [
    ['Status'],
    ['Applied'],
    ['Interview'],
    ['Applied'],
    [''],
  ];

  test('returns unique sorted values skipping header', () => {
    expect(getUniqueColumnValues(rows, 0)).toEqual(['Applied', 'Interview']);
  });
});

describe('generateNextId', () => {
  test('increments from existing IDs', () => {
    const rows = [['ID'], ['1'], ['5'], ['3']];
    expect(generateNextId(rows, 0)).toBe('6');
  });

  test('starts at 1 for empty sheet', () => {
    expect(generateNextId([['ID']], 0)).toBe('1');
  });
});

describe('buildRowFromMappings', () => {
  const mappings = buildDefaultMappings();
  const rows = [
    ['Date Applied', 'ID', 'Company Name', 'Role', 'URL', 'Location', 'Application Status'],
    ['2025-01-01', '1', 'Acme', 'Engineer', 'http://a.com', 'NYC', 'Applied'],
  ];

  test('builds row from extracted data', () => {
    const row = buildRowFromMappings(
      mappings,
      rows,
      {
        company: 'Google',
        role: 'SWE',
        url: 'https://careers.google.com/jobs/results/998877',
        jobId: '998877',
        location: 'Mountain View',
      },
      { defaultApplicationStatus: 'Applied' }
    );
    expect(row[1]).toBe('998877');
    expect(row[2]).toBe('Google');
    expect(row[3]).toBe(
      '=HYPERLINK("https://careers.google.com/jobs/results/998877","SWE")'
    );
    expect(row[4]).toBe('https://careers.google.com/jobs/results/998877');
    expect(row[5]).toBe('Mountain View');
    expect(row[6]).toBe('Applied');
  });

  test('fills job id from the posting URL when not extracted on-page', () => {
    const row = buildRowFromMappings(
      mappings,
      rows,
      {
        company: 'Acme',
        role: 'Intern',
        url: 'https://boards.example.com/jobs/445566',
      },
      { defaultApplicationStatus: 'Applied' }
    );
    expect(row[1]).toBe('445566');
  });

  test('user inputs override extracted data', () => {
    const row = buildRowFromMappings(
      mappings,
      rows,
      { company: 'Auto', role: 'Auto' },
      { company_name: 'Manual Co', role: 'Manual Role' }
    );
    expect(row[2]).toBe('Manual Co');
    // No URL available → plain role text
    expect(row[3]).toBe('Manual Role');
  });

  test('role embeds posting URL as a Sheets hyperlink', () => {
    const row = buildRowFromMappings(
      mappings,
      rows,
      {
        company: 'Acme',
        role: 'Backend Engineer',
        url: 'https://jobs.example.com/posting/99',
      },
      {}
    );
    expect(row[3]).toBe(
      '=HYPERLINK("https://jobs.example.com/posting/99","Backend Engineer")'
    );
  });

  test('role stays plain text when embedRoleHyperlink is off', () => {
    const row = buildRowFromMappings(
      mappings,
      rows,
      {
        company: 'Acme',
        role: 'Backend Engineer',
        url: 'https://jobs.example.com/posting/99',
      },
      { embedRoleHyperlink: false }
    );
    expect(row[3]).toBe('Backend Engineer');
  });

  test('buildHyperlinkFormula escapes quotes', () => {
    expect(buildHyperlinkFormula('https://x.com', 'Eng "II"')).toBe(
      '=HYPERLINK("https://x.com","Eng ""II""")'
    );
    expect(hyperlinkLabel('=HYPERLINK("https://x.com","Eng ""II""")')).toBe(
      'Eng "II"'
    );
  });

  test('custom dropdown uses user input', () => {
    const customMappings = [
      {
        columnIndex: 0,
        header: 'Source',
        tag: FIELD_TAGS.CUSTOM_DROPDOWN,
        dropdownOptions: ['LinkedIn', 'Indeed'],
        dropdownDefault: 'Indeed',
      },
    ];
    const row = buildRowFromMappings(customMappings, [], {}, {
      dropdown_0: 'LinkedIn',
    });
    expect(row[0]).toBe('LinkedIn');
  });

  test('custom dropdown uses configured default when empty', () => {
    const customMappings = [
      {
        columnIndex: 0,
        header: 'Source',
        tag: FIELD_TAGS.CUSTOM_DROPDOWN,
        dropdownOptions: ['LinkedIn', 'Indeed'],
        dropdownDefault: 'Indeed',
      },
    ];
    const row = buildRowFromMappings(customMappings, [], {}, {});
    expect(row[0]).toBe('Indeed');
  });

  test('custom text uses per-column input keys (not a shared tag)', () => {
    const customMappings = [
      {
        columnIndex: 0,
        header: 'Notes',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
      {
        columnIndex: 1,
        header: 'Priority',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
    ];
    const row = buildRowFromMappings(
      customMappings,
      [],
      {},
      {
        text_0: 'Follow up Friday',
        text_1: 'High',
        // Shared tag would previously overwrite every custom text column.
        custom_textbox: 'SHOULD_NOT_WIN',
      }
    );
    expect(row[0]).toBe('Follow up Friday');
    expect(row[1]).toBe('High');
  });

  test('col_N form values win for custom text', () => {
    const customMappings = [
      {
        columnIndex: 3,
        header: 'Notes',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
    ];
    const row = buildRowFromMappings(
      customMappings,
      [],
      {},
      { col_3: 'From the form', text_3: 'ignored when col set' }
    );
    expect(row[3]).toBe('From the form');
  });

  test('infers date applied and date posted from header names', () => {
    const customMappings = [
      {
        columnIndex: 0,
        header: 'DATE APPLIED',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
      {
        columnIndex: 1,
        header: 'Date Posted',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
    ];
    const row = buildRowFromMappings(
      customMappings,
      [],
      { postedDate: '2025-03-01' },
      {}
    );
    expect(row[0]).toBe(formatDate());
    expect(row[1]).toBe('2025-03-01');
  });
});

describe('resolveFieldTag', () => {
  test('prefers date headers over a stale custom tag', () => {
    expect(
      resolveFieldTag({
        header: 'date applied',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
      })
    ).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(
      resolveFieldTag({
        header: 'Date Posted',
        tag: FIELD_TAGS.IGNORE,
      })
    ).toBe(FIELD_TAGS.JOB_POSTED_DATE);
  });
});

describe('getFieldsNeedingInput', () => {
  const mappings = buildDefaultMappings();

  test('shows auto-filled fields so the user can edit them', () => {
    const fields = getFieldsNeedingInput(
      mappings,
      {
        company: 'Acme',
        role: 'Engineer',
        url: 'https://jobs.acme.com/jobs/12345',
        jobId: '12345',
        location: 'NYC',
      },
      { defaultApplicationStatus: 'Applied' }
    );
    const byTag = Object.fromEntries(fields.map((f) => [f.tag, f]));
    expect(byTag[FIELD_TAGS.DATE_APPLIED].autoFilled).toBe(true);
    expect(byTag[FIELD_TAGS.DATE_APPLIED].suggestedValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byTag[FIELD_TAGS.ID].suggestedValue).toBe('12345');
    expect(byTag[FIELD_TAGS.COMPANY_NAME].suggestedValue).toBe('Acme');
    expect(byTag[FIELD_TAGS.ROLE].suggestedValue).toBe('Engineer');
  });

  test('marks missing values as required', () => {
    const fields = getFieldsNeedingInput(mappings, { url: 'http://x.com' }, {});
    const company = fields.find((f) => f.tag === FIELD_TAGS.COMPANY_NAME);
    const role = fields.find((f) => f.tag === FIELD_TAGS.ROLE);
    expect(company.required).toBe(true);
    expect(role.required).toBe(true);
    expect(company.autoFilled).toBe(false);
  });

  test('includes custom dropdown fields', () => {
    const custom = [
      {
        columnIndex: 0,
        header: 'Source',
        tag: FIELD_TAGS.CUSTOM_DROPDOWN,
        dropdownOptions: ['A', 'B'],
      },
    ];
    const fields = getFieldsNeedingInput(custom, {}, {});
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('dropdown');
    expect(fields[0].options).toEqual(['A', 'B']);
  });

  test('includes custom text and textbox fields', () => {
    const custom = [
      {
        columnIndex: 0,
        header: 'Referral',
        tag: FIELD_TAGS.CUSTOM_TEXT,
        dropdownOptions: [],
      },
      {
        columnIndex: 1,
        header: 'Notes',
        tag: FIELD_TAGS.CUSTOM_TEXTBOX,
        dropdownOptions: [],
      },
    ];
    const fields = getFieldsNeedingInput(custom, {}, {});
    expect(fields).toHaveLength(2);
    expect(fields[0].type).toBe('text');
    expect(fields[1].type).toBe('textarea');
  });

  test('flags low-confidence values but still shows them editable', () => {
    const fields = getFieldsNeedingInput(
      mappings,
      {
        company: 'Maybe Co',
        role: 'Dev',
        url: 'http://x.com',
        confidence: { company: 'low' },
      },
      {}
    );
    const company = fields.find((f) => f.tag === FIELD_TAGS.COMPANY_NAME);
    expect(company).toBeTruthy();
    expect(company.suggestedValue).toBe('Maybe Co');
    expect(company.lowConfidence).toBe(true);
    expect(company.autoFilled).toBe(true);
  });
});

describe('normalizeDropdownOptions', () => {
  test('trims, dedupes, and drops blanks', () => {
    expect(normalizeDropdownOptions([' A ', 'B', 'a', '', 'C'])).toEqual(['A', 'B', 'C']);
    expect(normalizeDropdownOptions('LinkedIn, Indeed; Referral\nOther')).toEqual([
      'LinkedIn',
      'Indeed',
      'Referral',
      'Other',
    ]);
  });
});

describe('mergeDropdownOptions / column uniques', () => {
  test('merges configured choices with sheet values', () => {
    expect(mergeDropdownOptions(['High'], ['High', 'Low', ' Medium '])).toEqual([
      'High',
      'Low',
      'Medium',
    ]);
  });

  test('buildColumnUniques skips header row', () => {
    const rows = [
      ['Priority', 'Source'],
      ['High', 'LinkedIn'],
      ['Low', 'LinkedIn'],
      ['High', 'Referral'],
    ];
    expect(buildColumnUniques(rows)[0]).toEqual(['High', 'Low']);
    expect(buildColumnUniques(rows)[1]).toEqual(['LinkedIn', 'Referral']);
  });

  test('getUniqueColumnValues can fall back to header name', () => {
    const rows = [
      ['Company', 'Priority'],
      ['Acme', 'High'],
      ['Beta', 'Low'],
    ];
    // Empty index, header hint finds the Priority column.
    expect(getUniqueColumnValues(rows, 9, true, 'Priority')).toEqual([
      'High',
      'Low',
    ]);
  });
});

describe('formatDate', () => {
  test('formats as YYYY-MM-DD', () => {
    expect(formatDate(new Date(2025, 8, 2))).toBe('2025-09-02');
  });
});
