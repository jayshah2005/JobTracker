import { FIELD_TAGS, DEFAULT_HEADERS } from './constants.js';
import {
  buildDefaultMappings,
  buildMappingsFromHeaders,
  isSheetEmpty,
  enrichMappingsWithDropdownOptions,
  rowLooksLikeHeaders,
  guessTagFromHeader,
  migrateApplicationStatusMapping,
  mergeDropdownOptions,
  normalizeDropdownDefault,
  isApplicationStatusHeader,
} from './field-mapper.js';

/**
 * Prepare a tab configuration from raw sheet data.
 * Creates default headers if empty, or maps existing headers.
 */
export function prepareTabConfig(tabName, sheetId, gid, rows) {
  const empty = isSheetEmpty(rows);

  if (empty) {
    return {
      tabName,
      sheetId,
      gid,
      isNew: true,
      headers: [...DEFAULT_HEADERS],
      mappings: buildDefaultMappings(),
      rows: [],
    };
  }

  const headers = rowLooksLikeHeaders(rows[0])
    ? rows[0].map((h) => String(h ?? '').trim())
    : DEFAULT_HEADERS;

  const mappings = enrichMappingsWithDropdownOptions(
    buildMappingsFromHeaders(headers),
    rows
  );

  return {
    tabName,
    sheetId,
    gid,
    isNew: false,
    headers,
    mappings,
    rows,
  };
}

/**
 * Prefer saved mapping choices, but re-infer tags when a header clearly
 * means Date Applied / Date Posted (or other known aliases still marked custom).
 */
export function mergeTabMappings(existingMappings, freshMappings) {
  if (!existingMappings?.length) return freshMappings;
  if (!freshMappings?.length) return existingMappings;

  return freshMappings.map((fresh, index) => {
    const existingRaw =
      existingMappings.find((m) => m.columnIndex === fresh.columnIndex) ||
      existingMappings[index];
    if (!existingRaw) return fresh;

    const existing = migrateApplicationStatusMapping(existingRaw);
    const guessed = guessTagFromHeader(fresh.header);
    let tag = existing.tag;

    if (existingRaw.tag === FIELD_TAGS.APPLICATION_STATUS) {
      tag = FIELD_TAGS.CUSTOM_DROPDOWN;
    } else if (
      guessed === FIELD_TAGS.DATE_APPLIED ||
      guessed === FIELD_TAGS.JOB_POSTED_DATE
    ) {
      tag = guessed;
    } else if (
      existing.tag === FIELD_TAGS.CUSTOM_TEXTBOX ||
      existing.tag === FIELD_TAGS.CUSTOM_DROPDOWN
    ) {
      // Keep explicit multi-line / dropdown choices.
      tag = existing.tag;
    } else if (
      (existing.tag === FIELD_TAGS.CUSTOM_TEXT ||
        existing.tag === FIELD_TAGS.IGNORE) &&
      guessed !== FIELD_TAGS.CUSTOM_TEXT
    ) {
      tag = guessed;
    }

    const dropdownOptions =
      tag === FIELD_TAGS.CUSTOM_DROPDOWN
        ? mergeDropdownOptions(
            existing.dropdownOptions,
            fresh.dropdownOptions
          )
        : existing.dropdownOptions || [];

    return {
      ...existing,
      header: fresh.header,
      columnIndex: fresh.columnIndex,
      tag,
      dropdownOptions,
      dropdownDefault: normalizeDropdownDefault(
        dropdownOptions,
        existing.dropdownDefault ||
          fresh.dropdownDefault ||
          (isApplicationStatusHeader(fresh.header) ? 'Applied' : '')
      ),
    };
  });
}

/**
 * Count total destinations (tabs) across all configured sheets.
 */
export function countDestinations(sheets) {
  let count = 0;
  for (const sheet of sheets) {
    count += sheet.tabs?.length ?? 0;
  }
  return count;
}

/**
 * Return flat list of all tab destinations for selection UI.
 */
export function getAllDestinations(sheets) {
  const destinations = [];
  for (const sheet of sheets) {
    for (const tab of sheet.tabs ?? []) {
      destinations.push({
        sheetId: sheet.spreadsheetId,
        sheetName: sheet.name || sheet.spreadsheetId,
        sheetUrl: sheet.url,
        tabName: tab.tabName,
        gid: tab.gid,
        tabId: tab.tabId,
        mappings: tab.mappings,
      });
    }
  }
  return destinations;
}

/**
 * Whether destination picker should be shown (more than one tab).
 */
export function shouldShowDestinationPicker(sheets) {
  return countDestinations(sheets) > 1;
}

/**
 * Find a specific destination by sheetId and tabId/gid.
 */
export function findDestination(sheets, sheetId, tabIdOrGid) {
  const all = getAllDestinations(sheets);
  return all.find(
    (d) =>
      d.sheetId === sheetId &&
      (d.tabId === tabIdOrGid || d.gid === tabIdOrGid)
  );
}
