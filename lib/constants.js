/** Default column headers created when a sheet tab is empty. */
export const DEFAULT_HEADERS = [
  'Date Applied',
  'Job ID',
  'Company Name',
  'Role',
  'URL',
  'Location',
  'Application Status',
];

/**
 * Field tag types users can assign to sheet columns.
 * Each tag defines how the extension fills that column when saving a job.
 */
export const FIELD_TAGS = {
  DATE_APPLIED: 'date_applied',
  ID: 'id',
  COMPANY_NAME: 'company_name',
  ROLE: 'role',
  URL: 'url',
  LOCATION: 'location',
  APPLICATION_STATUS: 'application_status',
  JOB_POSTED_DATE: 'job_posted_date',
  CURRENT_DATE: 'current_date',
  CUSTOM_DROPDOWN: 'custom_dropdown',
  CUSTOM_TEXT: 'custom_text',
  CUSTOM_TEXTBOX: 'custom_textbox',
  IGNORE: 'ignore',
};

/** Human-readable labels for field tags (shown in options UI). */
export const FIELD_TAG_LABELS = {
  [FIELD_TAGS.DATE_APPLIED]: 'Date Applied',
  [FIELD_TAGS.ID]: 'Job ID',
  [FIELD_TAGS.COMPANY_NAME]: 'Company Name',
  [FIELD_TAGS.ROLE]: 'Role / Title',
  [FIELD_TAGS.URL]: 'Job URL',
  [FIELD_TAGS.LOCATION]: 'Location',
  [FIELD_TAGS.JOB_POSTED_DATE]: 'Job Posted Date',
  [FIELD_TAGS.CURRENT_DATE]: 'Current Date (today)',
  [FIELD_TAGS.CUSTOM_DROPDOWN]: 'Custom Dropdown',
  [FIELD_TAGS.CUSTOM_TEXT]: 'Custom Text',
  [FIELD_TAGS.CUSTOM_TEXTBOX]: 'Custom Textbox',
  [FIELD_TAGS.IGNORE]: 'Ignore Column',
};

/** Default choices for Application Status columns (Custom Dropdown). */
export const DEFAULT_APPLICATION_STATUSES = [
  'Applied',
  'Interviewing',
  'Offer',
  'Rejected',
  'Withdrawn',
];

/** Tags that receive auto-extracted job data. */
export const AUTO_FILL_TAGS = new Set([
  FIELD_TAGS.DATE_APPLIED,
  FIELD_TAGS.ID,
  FIELD_TAGS.COMPANY_NAME,
  FIELD_TAGS.ROLE,
  FIELD_TAGS.URL,
  FIELD_TAGS.LOCATION,
  FIELD_TAGS.JOB_POSTED_DATE,
  FIELD_TAGS.CURRENT_DATE,
]);

/** Maps common header text (lowercase) to default field tags for auto-detection. */
export const HEADER_ALIASES = {
  'date applied': FIELD_TAGS.DATE_APPLIED,
  'applied date': FIELD_TAGS.DATE_APPLIED,
  'application date': FIELD_TAGS.DATE_APPLIED,
  id: FIELD_TAGS.ID,
  'job id': FIELD_TAGS.ID,
  'company name': FIELD_TAGS.COMPANY_NAME,
  company: FIELD_TAGS.COMPANY_NAME,
  employer: FIELD_TAGS.COMPANY_NAME,
  role: FIELD_TAGS.ROLE,
  title: FIELD_TAGS.ROLE,
  'job title': FIELD_TAGS.ROLE,
  position: FIELD_TAGS.ROLE,
  url: FIELD_TAGS.URL,
  link: FIELD_TAGS.URL,
  'job url': FIELD_TAGS.URL,
  location: FIELD_TAGS.LOCATION,
  city: FIELD_TAGS.LOCATION,
  'application status': FIELD_TAGS.CUSTOM_DROPDOWN,
  status: FIELD_TAGS.CUSTOM_DROPDOWN,
  'posted date': FIELD_TAGS.JOB_POSTED_DATE,
  'job posted date': FIELD_TAGS.JOB_POSTED_DATE,
  'date posted': FIELD_TAGS.JOB_POSTED_DATE,
  notes: FIELD_TAGS.CUSTOM_TEXTBOX,
  note: FIELD_TAGS.CUSTOM_TEXTBOX,
  comments: FIELD_TAGS.CUSTOM_TEXTBOX,
  comment: FIELD_TAGS.CUSTOM_TEXTBOX,
  description: FIELD_TAGS.CUSTOM_TEXTBOX,
  'cover letter': FIELD_TAGS.CUSTOM_TEXTBOX,
};

export const STORAGE_KEYS = {
  SHEETS: 'configuredSheets',
  SETTINGS: 'settings',
  UNDO_STACK: 'schemaUndoStack',
  OAUTH_CLIENT_ID: 'oauthClientId',
  OAUTH_CLIENT_SECRET: 'oauthClientSecret',
  OAUTH_PKCE: 'oauthPkce',
  GOOGLE_TOKEN: 'googleToken',
};

export const DEFAULT_SETTINGS = {
  autoShowPopup: true,
  defaultApplicationStatus: 'Applied',
  dateFormat: 'YYYY-MM-DD',
  confirmBeforeSave: true,
  /** Write Role / Title as a clickable HYPERLINK to the job posting. */
  embedRoleHyperlink: true,
};
