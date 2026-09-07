import {
  FIELD_TAGS,
  HEADER_ALIASES,
  DEFAULT_HEADERS,
  FIELD_TAG_LABELS,
  DEFAULT_APPLICATION_STATUSES,
} from './constants.js';
import { extractJobId } from './job-url.js';

/**
 * Normalize a sheet header for alias matching (case/punctation insensitive).
 */
export function normalizeHeaderKey(header) {
  if (!header || typeof header !== 'string') return '';
  return header
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Guess field tag from a column header name.
 */
export function guessTagFromHeader(header) {
  const normalized = normalizeHeaderKey(header);
  if (!normalized) return FIELD_TAGS.CUSTOM_TEXT;

  if (HEADER_ALIASES[normalized]) {
    return HEADER_ALIASES[normalized];
  }

  // Flexible matches for common date columns
  if (/(^| )date applied( |$)/.test(normalized) || normalized === 'applied date') {
    return FIELD_TAGS.DATE_APPLIED;
  }
  if (
    /(^| )date posted( |$)/.test(normalized) ||
    normalized === 'posted date' ||
    normalized === 'job posted date'
  ) {
    return FIELD_TAGS.JOB_POSTED_DATE;
  }

  return FIELD_TAGS.CUSTOM_TEXT;
}

/**
 * Effective tag used when saving/filling a column.
 * If the header clearly means Date Applied / Date Posted (or another known
 * alias) and the stored tag is still a default custom text/ignore, infer it.
 * Explicit Custom Textbox / Custom Dropdown choices are kept.
 * Legacy Application Status tags are treated as Custom Dropdown.
 */
export function resolveFieldTag(mapping) {
  if (!mapping) return FIELD_TAGS.CUSTOM_TEXT;
  const guessed = guessTagFromHeader(mapping.header);
  let tag = mapping.tag || FIELD_TAGS.CUSTOM_TEXT;

  // Legacy dedicated status type → custom dropdown.
  if (tag === FIELD_TAGS.APPLICATION_STATUS) {
    tag = FIELD_TAGS.CUSTOM_DROPDOWN;
  }

  if (
    guessed === FIELD_TAGS.DATE_APPLIED ||
    guessed === FIELD_TAGS.JOB_POSTED_DATE
  ) {
    return guessed;
  }

  if (
    tag === FIELD_TAGS.CUSTOM_TEXTBOX ||
    tag === FIELD_TAGS.CUSTOM_DROPDOWN
  ) {
    return tag;
  }

  if (
    (tag === FIELD_TAGS.CUSTOM_TEXT || tag === FIELD_TAGS.IGNORE) &&
    guessed !== FIELD_TAGS.CUSTOM_TEXT &&
    !isCustomFreeformTag(guessed)
  ) {
    return guessed;
  }

  return tag;
}

/** Single-line text or multi-line textbox. */
export function isCustomFreeformTag(tag) {
  return tag === FIELD_TAGS.CUSTOM_TEXT || tag === FIELD_TAGS.CUSTOM_TEXTBOX;
}

/** Headers that mean application status (seeded as a Custom Dropdown). */
export function isApplicationStatusHeader(header) {
  const normalized = normalizeHeaderKey(header);
  return (
    normalized === 'status' ||
    normalized === 'application status' ||
    normalized === 'app status' ||
    /(^| )application status( |$)/.test(normalized)
  );
}

/**
 * Default dropdown choices for a header/tag (e.g. Application Status).
 */
export function seedDropdownOptionsForHeader(header, tag = '') {
  const effective =
    tag === FIELD_TAGS.APPLICATION_STATUS
      ? FIELD_TAGS.CUSTOM_DROPDOWN
      : tag || guessTagFromHeader(header);
  if (
    effective === FIELD_TAGS.CUSTOM_DROPDOWN &&
    isApplicationStatusHeader(header)
  ) {
    return [...DEFAULT_APPLICATION_STATUSES];
  }
  return [];
}

/**
 * Normalize a legacy Application Status mapping into a Custom Dropdown.
 */
export function migrateApplicationStatusMapping(mapping) {
  if (!mapping) return mapping;
  if (
    mapping.tag !== FIELD_TAGS.APPLICATION_STATUS &&
    !(
      mapping.tag === FIELD_TAGS.CUSTOM_DROPDOWN &&
      isApplicationStatusHeader(mapping.header) &&
      !normalizeDropdownOptions(mapping.dropdownOptions).length
    )
  ) {
    return mapping;
  }

  return {
    ...mapping,
    tag: FIELD_TAGS.CUSTOM_DROPDOWN,
    dropdownOptions: mergeDropdownOptions(
      mapping.dropdownOptions,
      seedDropdownOptionsForHeader(mapping.header, FIELD_TAGS.CUSTOM_DROPDOWN)
    ),
    dropdownDefault:
      normalizeDropdownDefault(
        mergeDropdownOptions(
          mapping.dropdownOptions,
          seedDropdownOptionsForHeader(mapping.header, FIELD_TAGS.CUSTOM_DROPDOWN)
        ),
        mapping.dropdownDefault || 'Applied'
      ) || 'Applied',
  };
}

/**
 * Build default field mappings for empty sheets using DEFAULT_HEADERS.
 */
export function buildDefaultMappings() {
  return DEFAULT_HEADERS.map((header, index) => {
    const tag = guessTagFromHeader(header);
    const dropdownOptions = seedDropdownOptionsForHeader(header, tag);
    return {
      columnIndex: index,
      header,
      tag,
      dropdownOptions,
      dropdownDefault: normalizeDropdownDefault(
        dropdownOptions,
        isApplicationStatusHeader(header) ? 'Applied' : ''
      ),
    };
  });
}

/**
 * Build field mappings from existing sheet headers.
 */
export function buildMappingsFromHeaders(headers) {
  return headers.map((header, index) => {
    const name = header || `Column ${index + 1}`;
    const tag = header ? guessTagFromHeader(header) : FIELD_TAGS.IGNORE;
    const dropdownOptions = seedDropdownOptionsForHeader(name, tag);
    return {
      columnIndex: index,
      header: name,
      tag,
      dropdownOptions,
      dropdownDefault: normalizeDropdownDefault(
        dropdownOptions,
        isApplicationStatusHeader(name) ? 'Applied' : ''
      ),
    };
  });
}

/**
 * Check if a row looks like headers (non-empty strings, no pure numbers).
 */
export function rowLooksLikeHeaders(row) {
  if (!row || row.length === 0) return false;
  const nonEmpty = row.filter((cell) => cell != null && String(cell).trim() !== '');
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((cell) => isNaN(Number(cell)) || String(cell).length > 4);
}

/**
 * Check if sheet tab is effectively empty (no headers / no data).
 */
export function isSheetEmpty(rows) {
  if (!rows || rows.length === 0) return true;
  const firstRow = rows[0] || [];
  const hasContent = firstRow.some((cell) => cell != null && String(cell).trim() !== '');
  return !hasContent;
}

/**
 * Extract unique non-empty values from a column for dropdown options.
 * If `columnIndex` yields nothing, optionally fall back to locating the column
 * by header name in the first row (helps when indices drifted).
 */
export function getUniqueColumnValues(rows, columnIndex, skipHeader = true, headerHint = '') {
  const collect = (index) => {
    const start = skipHeader ? 1 : 0;
    const values = new Set();
    for (let i = start; i < (rows?.length || 0); i++) {
      const cell = rows[i]?.[index];
      if (cell != null && String(cell).trim() !== '') {
        values.add(String(cell).trim());
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  };

  const primary = collect(columnIndex);
  if (primary.length || !headerHint || !rows?.length) return primary;

  const needle = String(headerHint).trim().toLowerCase();
  const idx = (rows[0] || []).findIndex(
    (h) => String(h ?? '').trim().toLowerCase() === needle
  );
  if (idx < 0 || idx === columnIndex) return primary;
  return collect(idx);
}

/**
 * Unique values per column index from sheet rows (skips header row).
 */
export function buildColumnUniques(rows) {
  if (!rows?.length) return [];
  const width = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const uniques = [];
  for (let c = 0; c < width; c++) {
    uniques[c] = getUniqueColumnValues(rows, c, true);
  }
  return uniques;
}

/**
 * Normalize a list of dropdown choices (trim, drop blanks, unique, stable order).
 */
export function normalizeDropdownOptions(options) {
  const raw = Array.isArray(options)
    ? options
    : String(options || '')
        .split(/[,;\n]/)
        .map((s) => s.trim());
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Keep a dropdown default only if it still exists in the options list.
 */
export function normalizeDropdownDefault(options, defaultValue) {
  const opts = normalizeDropdownOptions(options);
  const raw = String(defaultValue || '').trim();
  if (!raw) return '';
  const match = opts.find((o) => o.toLowerCase() === raw.toLowerCase());
  return match || '';
}

/**
 * Merge configured dropdown options with values already present in the sheet column.
 */
export function mergeDropdownOptions(configured, fromSheet) {
  return normalizeDropdownOptions([
    ...(configured || []),
    ...(fromSheet || []),
  ]);
}

/**
 * Apply dropdown options to mappings based on sheet data.
 * Keeps user choices and adds any new unique values found in the column.
 * Migrates legacy Application Status fields to Custom Dropdown.
 */
export function enrichMappingsWithDropdownOptions(mappings, rows) {
  return mappings.map((raw) => {
    const mapping = migrateApplicationStatusMapping(raw);
    if (mapping.tag !== FIELD_TAGS.CUSTOM_DROPDOWN) return mapping;
    const seeded = seedDropdownOptionsForHeader(mapping.header, mapping.tag);
    const configured = normalizeDropdownOptions(mapping.dropdownOptions);
    const fromSheet = getUniqueColumnValues(
      rows,
      mapping.columnIndex,
      true,
      mapping.header
    );
    return {
      ...mapping,
      dropdownOptions: mergeDropdownOptions(
        mergeDropdownOptions(seeded, configured),
        fromSheet
      ),
      dropdownDefault: normalizeDropdownDefault(
        mergeDropdownOptions(
          mergeDropdownOptions(seeded, configured),
          fromSheet
        ),
        mapping.dropdownDefault ||
          (isApplicationStatusHeader(mapping.header) ? 'Applied' : '')
      ),
    };
  });
}

/**
 * Format today's date as YYYY-MM-DD.
 */
export function formatDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Resolve the job ID to store in the sheet (page extraction, then URL).
 */
export function resolveJobId(extractedData = {}) {
  const fromPage = String(extractedData.jobId || '').trim();
  if (fromPage) return fromPage;
  return extractJobId(extractedData.url || '') || '';
}

/**
 * Generate next sequential ID based on existing ID column values.
 * Kept for legacy sheets; new saves prefer job ID from the posting.
 */
export function generateNextId(rows, idColumnIndex) {
  let max = 0;
  for (let i = 1; i < rows.length; i++) {
    const val = parseInt(rows[i]?.[idColumnIndex], 10);
    if (!isNaN(val) && val > max) max = val;
  }
  return String(max + 1);
}

/**
 * Build a Google Sheets HYPERLINK formula (USER_ENTERED).
 * Returns plain text when url or label is missing.
 */
export function buildHyperlinkFormula(url, label) {
  const href = String(url || '').trim();
  const text = String(label || '').trim();
  if (!href && !text) return '';
  if (!href) return text;
  if (!text) return href;
  const esc = (s) => String(s).replace(/"/g, '""');
  return `=HYPERLINK("${esc(href)}","${esc(text)}")`;
}

/**
 * Display text from a cell that may be a HYPERLINK formula or plain value.
 */
export function hyperlinkLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(
    /^\s*=\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*\)\s*$/i
  );
  if (!match) return raw;
  return match[2].replace(/""/g, '"');
}

/**
 * Resolve the job posting URL from form inputs / extraction / URL column.
 */
export function resolveJobUrl(mappings = [], extractedData = {}, userInputs = {}) {
  const urlMapping = mappings.find(
    (m) => resolveFieldTag(m) === FIELD_TAGS.URL
  );
  if (urlMapping) {
    const colKey = `col_${urlMapping.columnIndex}`;
    if (Object.prototype.hasOwnProperty.call(userInputs, colKey)) {
      const fromCol = String(userInputs[colKey] ?? '').trim();
      if (fromCol) return fromCol;
    }
  }
  return (
    String(
      userInputs[FIELD_TAGS.URL] ??
        userInputs.url ??
        extractedData.url ??
        ''
    ).trim()
  );
}

/**
 * Build a row array from field mappings and extracted job data.
 */
export function buildRowFromMappings(mappings, rows, extractedData, userInputs = {}) {
  const columnCount = Math.max(
    mappings.length,
    ...mappings.map((m) => m.columnIndex + 1)
  );
  const row = new Array(columnCount).fill('');
  const jobId = resolveJobId(extractedData);
  const jobUrl = resolveJobUrl(mappings, extractedData, userInputs);

  for (const mapping of mappings) {
    const { columnIndex } = mapping;
    const tag = resolveFieldTag(mapping);
    let value = '';

    switch (tag) {
      case FIELD_TAGS.DATE_APPLIED:
      case FIELD_TAGS.CURRENT_DATE:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? formatDate();
        break;
      case FIELD_TAGS.ID:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? jobId;
        break;
      case FIELD_TAGS.COMPANY_NAME:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? extractedData.company ?? '';
        break;
      case FIELD_TAGS.ROLE:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? extractedData.role ?? '';
        break;
      case FIELD_TAGS.URL:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? extractedData.url ?? '';
        break;
      case FIELD_TAGS.LOCATION:
        value = userInputs[tag] ?? userInputs[mapping.tag] ?? extractedData.location ?? '';
        break;
      case FIELD_TAGS.JOB_POSTED_DATE:
        value =
          userInputs[tag] ??
          userInputs[mapping.tag] ??
          extractedData.postedDate ??
          '';
        break;
      case FIELD_TAGS.CUSTOM_DROPDOWN:
        value =
          userInputs[`dropdown_${columnIndex}`] ??
          userInputs[`col_${columnIndex}`] ??
          userInputs[tag] ??
          '';
        break;
      case FIELD_TAGS.CUSTOM_TEXT:
      case FIELD_TAGS.CUSTOM_TEXTBOX:
        value =
          userInputs[`text_${columnIndex}`] ??
          userInputs[`col_${columnIndex}`] ??
          userInputs[tag] ??
          userInputs[FIELD_TAGS.CUSTOM_TEXT] ??
          userInputs[FIELD_TAGS.CUSTOM_TEXTBOX] ??
          '';
        break;
      case FIELD_TAGS.IGNORE:
        value = '';
        break;
      default:
        value =
          userInputs[`col_${columnIndex}`] ??
          userInputs[tag] ??
          '';
    }

    // Prefer an explicit per-column form value when present (avoids collisions
    // when several Custom Text fields would otherwise share one tag key).
    if (
      tag !== FIELD_TAGS.IGNORE &&
      Object.prototype.hasOwnProperty.call(userInputs, `col_${columnIndex}`)
    ) {
      value = userInputs[`col_${columnIndex}`] ?? '';
    }

    if (
      tag === FIELD_TAGS.CUSTOM_DROPDOWN &&
      !String(value).trim()
    ) {
      value =
        normalizeDropdownDefault(
          mapping.dropdownOptions,
          mapping.dropdownDefault
        ) ||
        (isApplicationStatusHeader(mapping.header)
          ? userInputs.defaultApplicationStatus ||
            extractedData.applicationStatus ||
            'Applied'
          : '');
    }

    // Optionally embed the posting URL in Role / Title as a clickable link.
    if (
      tag === FIELD_TAGS.ROLE &&
      value &&
      userInputs.embedRoleHyperlink !== false
    ) {
      value = buildHyperlinkFormula(jobUrl, value);
    }

    row[columnIndex] = value;
  }

  return row;
}

/** Maps field tags to keys used in extractedData.confidence */
const CONFIDENCE_KEYS = {
  [FIELD_TAGS.COMPANY_NAME]: 'company',
  [FIELD_TAGS.ROLE]: 'role',
  [FIELD_TAGS.URL]: 'url',
  [FIELD_TAGS.LOCATION]: 'location',
  [FIELD_TAGS.JOB_POSTED_DATE]: 'postedDate',
  [FIELD_TAGS.ID]: 'jobId',
  [FIELD_TAGS.APPLICATION_STATUS]: 'applicationStatus',
};

function getConfidence(extractedData, tag) {
  const key = CONFIDENCE_KEYS[tag] ?? tag;
  return extractedData.confidence?.[key] ?? extractedData.confidence?.[tag];
}

/**
 * Auto value for a mapped field (used when saving and when showing the form).
 */
export function getAutoValueForTag(tag, extractedData = {}, settings = {}) {
  switch (tag) {
    case FIELD_TAGS.DATE_APPLIED:
    case FIELD_TAGS.CURRENT_DATE:
      return formatDate();
    case FIELD_TAGS.ID:
      return resolveJobId(extractedData);
    case FIELD_TAGS.COMPANY_NAME:
      return extractedData.company || '';
    case FIELD_TAGS.ROLE:
      return extractedData.role || '';
    case FIELD_TAGS.URL:
      return extractedData.url || '';
    case FIELD_TAGS.LOCATION:
      return extractedData.location || '';
    case FIELD_TAGS.JOB_POSTED_DATE:
      return extractedData.postedDate || '';
    case FIELD_TAGS.APPLICATION_STATUS:
      return (
        extractedData.applicationStatus ||
        settings.defaultApplicationStatus ||
        'Applied'
      );
    default:
      return '';
  }
}

/**
 * Fields to show in the save form. Auto-filled values are included so the
 * user can see and edit them before saving.
 */
export function getFieldsNeedingInput(mappings, extractedData, settings = {}) {
  const needsInput = [];

  for (const mapping of mappings) {
    const { header, columnIndex, dropdownOptions } = mapping;
    const tag = resolveFieldTag(mapping);
    if (tag === FIELD_TAGS.IGNORE) continue;

    if (tag === FIELD_TAGS.CUSTOM_DROPDOWN) {
      const options = normalizeDropdownOptions([
        ...(dropdownOptions || []),
        ...seedDropdownOptionsForHeader(header, tag),
      ]);
      const configuredDefault = normalizeDropdownDefault(
        options,
        mapping.dropdownDefault
      );
      const fallbackStatus =
        settings.defaultApplicationStatus ||
        extractedData.applicationStatus ||
        'Applied';
      const suggestedValue =
        configuredDefault ||
        (isApplicationStatusHeader(header) ? fallbackStatus : '');
      needsInput.push({
        type: 'dropdown',
        tag,
        header,
        columnIndex,
        options,
        suggestedValue,
        required: false,
        autoFilled: Boolean(suggestedValue),
        hint: 'Click to search all options. Type to filter, add, or remove choices.',
      });
      continue;
    }

    if (tag === FIELD_TAGS.CUSTOM_TEXT || tag === FIELD_TAGS.CUSTOM_TEXTBOX) {
      needsInput.push({
        type: tag === FIELD_TAGS.CUSTOM_TEXTBOX ? 'textarea' : 'text',
        tag,
        header,
        columnIndex,
        required: false,
        autoFilled: false,
        hint:
          tag === FIELD_TAGS.CUSTOM_TEXTBOX
            ? 'Multi-line text — use for notes or longer answers'
            : undefined,
      });
      continue;
    }

    const autoValue = getAutoValueForTag(tag, extractedData, settings);
    const hasValue = Boolean(autoValue);
    const lowConfidence = getConfidence(extractedData, tag) === 'low';

    needsInput.push({
      type: 'text',
      tag,
      header: header || FIELD_TAG_LABELS?.[tag] || tag,
      columnIndex,
      suggestedValue: autoValue,
      required: !hasValue && tag !== FIELD_TAGS.ID,
      lowConfidence: hasValue && lowConfidence,
      autoFilled: hasValue,
    });
  }

  return needsInput;
}
