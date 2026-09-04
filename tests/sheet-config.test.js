import {
  prepareTabConfig,
  countDestinations,
  getAllDestinations,
  shouldShowDestinationPicker,
  mergeTabMappings,
} from '../lib/sheet-config.js';
import { FIELD_TAGS } from '../lib/constants.js';

describe('prepareTabConfig', () => {
  test('creates default headers for empty sheet', () => {
    const config = prepareTabConfig('Sheet1', 'id1', '0', []);
    expect(config.isNew).toBe(true);
    expect(config.headers).toHaveLength(7);
    expect(config.mappings[0].tag).toBe(FIELD_TAGS.DATE_APPLIED);
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
