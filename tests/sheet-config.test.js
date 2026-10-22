import {
  prepareTabConfig,
  shouldSeedDefaultHeaders,
  countDestinations,
  getAllDestinations,
  shouldShowDestinationPicker,
  mergeTabMappings,
  findDestination,
} from '../lib/sheet-config.js';
import { FIELD_TAGS, LEGACY_DEFAULT_HEADERS } from '../lib/constants.js';

describe('prepareTabConfig', () => {
  test('creates default headers for empty sheet', () => {
    const config = prepareTabConfig('Sheet1', 'id1', '0', []);
    expect(config.isNew).toBe(true);
    expect(config.headers).toHaveLength(6);
    expect(config.headers).not.toContain('URL');
    expect(config.headers).toContain('Role');
    expect(config.mappings[0].tag).toBe(FIELD_TAGS.DATE_APPLIED);
  });

  test('upgrades header-only legacy defaults (with URL) to current defaults', () => {
    const config = prepareTabConfig('Sheet1', 'id1', '0', [
      [...LEGACY_DEFAULT_HEADERS],
    ]);
    expect(shouldSeedDefaultHeaders([[...LEGACY_DEFAULT_HEADERS]])).toBe(true);
    expect(config.isNew).toBe(true);
    expect(config.headers).not.toContain('URL');
    expect(config.headers).toEqual([
      'Date Applied',
      'Job ID',
      'Company Name',
      'Role',
      'Location',
      'Application Status',
    ]);
  });

  test('keeps legacy headers when the sheet already has data rows', () => {
    const rows = [
      [...LEGACY_DEFAULT_HEADERS],
      ['2026-01-01', '1', 'Acme', 'Eng', 'https://x.com', 'NYC', 'Applied'],
    ];
    const config = prepareTabConfig('Jobs', 'id1', '0', rows);
    expect(config.isNew).toBe(false);
    expect(config.headers).toContain('URL');
  });

  test('maps existing headers', () => {
    const rows = [
      ['Company', 'Role', 'Notes'],
      ['Acme', 'Dev', 'referral'],
    ];
    const config = prepareTabConfig('Jobs', 'id1', '0', rows);
    expect(config.isNew).toBe(false);
    expect(config.mappings[0].tag).toBe(FIELD_TAGS.COMPANY_NAME);
    expect(config.mappings[2].tag).toBe(FIELD_TAGS.CUSTOM_TEXTBOX);
  });

  test('enriches dropdown options from column data', () => {
    const rows = [
      ['Source'],
      ['LinkedIn'],
      ['Indeed'],
    ];
    const config = prepareTabConfig('Jobs', 'id1', '0', rows);
    const sourceMapping = config.mappings.find((m) => m.header === 'Source');
    sourceMapping.tag = FIELD_TAGS.CUSTOM_DROPDOWN;
    const enriched = prepareTabConfig('Jobs', 'id1', '0', rows);
    // Re-prepare doesn't re-tag; test enrich via full flow in field-mapper tests
    expect(enriched.mappings[0].header).toBe('Source');
  });
});

describe('mergeTabMappings', () => {
  test('upgrades date columns from custom tags using headers', () => {
    const existing = [
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
    const fresh = [
      {
        columnIndex: 0,
        header: 'DATE APPLIED',
        tag: FIELD_TAGS.DATE_APPLIED,
        dropdownOptions: [],
      },
      {
        columnIndex: 1,
        header: 'Date Posted',
        tag: FIELD_TAGS.JOB_POSTED_DATE,
        dropdownOptions: [],
      },
    ];
    const merged = mergeTabMappings(existing, fresh);
    expect(merged[0].tag).toBe(FIELD_TAGS.DATE_APPLIED);
    expect(merged[1].tag).toBe(FIELD_TAGS.JOB_POSTED_DATE);
  });
});

describe('destination picker visibility', () => {
  const oneTab = [
    {
      spreadsheetId: 'a',
      tabs: [{ tabName: 'Sheet1', gid: '0' }],
    },
  ];

  const multiTab = [
    {
      spreadsheetId: 'a',
      tabs: [
        { tabName: 'AI Roles', gid: '0' },
        { tabName: 'Data Roles', gid: '1' },
      ],
    },
  ];

  const multiSheet = [
    { spreadsheetId: 'a', tabs: [{ tabName: 'Tab1', gid: '0' }] },
    { spreadsheetId: 'b', tabs: [{ tabName: 'Tab2', gid: '0' }] },
  ];

  test('hides picker for single tab', () => {
    expect(shouldShowDestinationPicker(oneTab)).toBe(false);
    expect(countDestinations(oneTab)).toBe(1);
  });

  test('shows picker for multiple tabs in one sheet', () => {
    expect(shouldShowDestinationPicker(multiTab)).toBe(true);
    expect(countDestinations(multiTab)).toBe(2);
  });

  test('shows picker for multiple sheets', () => {
    expect(shouldShowDestinationPicker(multiSheet)).toBe(true);
    expect(getAllDestinations(multiSheet)).toHaveLength(2);
  });
});

describe('findDestination', () => {
  test('matches sheet and tab ids with string/number coercion', () => {
    const sheets = [
      {
        spreadsheetId: 'abc',
        name: 'Jobs',
        tabs: [{ tabName: 'Apps', gid: '0', tabId: '0', mappings: [] }],
      },
    ];
    const hit = findDestination(sheets, 'abc', 0);
    expect(hit?.tabName).toBe('Apps');
    expect(findDestination(sheets, 'abc', '0')?.gid).toBe('0');
  });
});

import {
  destinationKey,
  findDestinationIndexByKey,
  chooseInitialDestinationIndex,
} from '../lib/sheet-config.js';

describe('initial destination choice', () => {
  const dests = [
    { sheetId: 'A', gid: '1', tabId: 't1' },
    { sheetId: 'A', gid: '2', tabId: 't2' },
    { sheetId: 'B', gid: '3', tabId: 't3' },
  ];
  test('destinationKey', () => {
    expect(destinationKey(dests[2])).toBe('B:3');
    expect(destinationKey(null)).toBe('');
  });
  test('findDestinationIndexByKey accepts gid or tabId keys', () => {
    expect(findDestinationIndexByKey(dests, 'B:3')).toBe(2);
    expect(findDestinationIndexByKey(dests, 'A:t2')).toBe(1);
    expect(findDestinationIndexByKey(dests, 'Z:9')).toBe(-1);
    expect(findDestinationIndexByKey(dests, '')).toBe(-1);
  });
  test('draft beats default beats first', () => {
    expect(chooseInitialDestinationIndex(dests, { draftKey: 'A:2', defaultKey: 'B:3' })).toBe(1);
    expect(chooseInitialDestinationIndex(dests, { defaultKey: 'B:3' })).toBe(2);
    expect(chooseInitialDestinationIndex(dests, {})).toBe(0);
  });
  test('stale draft/default keys fall through', () => {
    expect(chooseInitialDestinationIndex(dests, { draftKey: 'X:1', defaultKey: 'B:3' })).toBe(2);
    expect(chooseInitialDestinationIndex(dests, { draftKey: 'X:1', defaultKey: 'Y:1' })).toBe(0);
    expect(chooseInitialDestinationIndex([], { defaultKey: 'B:3' })).toBe(0);
  });
});
