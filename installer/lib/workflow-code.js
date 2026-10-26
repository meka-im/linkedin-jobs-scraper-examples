import { InstallerError } from './errors.js';

export const CREDENTIAL_NODE_NAMES = Object.freeze({
  apifyOAuth2Api: Object.freeze([
    'Start Actor',
    'Poll Actor Run',
    'Get Run Output',
    'Get Dataset Items',
  ]),
  googleSheetsOAuth2Api: Object.freeze([
    'Find App Spreadsheet',
    'Get Spreadsheet Metadata',
    'Create App Spreadsheet',
    'Add Jobs Worksheet',
    'Get Jobs Header',
    'Confirm Jobs Worksheet Empty',
    'Write Jobs Header',
    'Mark Spreadsheet Ready',
    'Read Existing Jobs',
    'Append Rows',
  ]),
});

export const TEMPLATE_SENTINELS = Object.freeze({
  keywords: '__MEKA_KEYWORDS__',
  location: '__MEKA_LOCATION__',
  datePosted: '__MEKA_DATE_POSTED__',
  limit: 999991,
  budgetUsd: 999992.25,
  scrapeCompany: '__MEKA_SCRAPE_COMPANY__',
  spreadsheetTitle: '__MEKA_SPREADSHEET_TITLE__',
  apifyCredential: "newCredential('__MEKA_APIFY_CREDENTIAL_NAME__', '__MEKA_APIFY_CREDENTIAL_ID__')",
  googleCredential: "newCredential('__MEKA_GOOGLE_CREDENTIAL_NAME__', '__MEKA_GOOGLE_CREDENTIAL_ID__')",
});

const DATE_POSTED = new Set(['anyTime', 'past24Hours', 'pastWeek', 'pastMonth']);
const CLOUD_CODE_LIMIT = 300_000;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InstallerError('SEARCH_SETTINGS_INVALID', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function safeInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new InstallerError(
      'SEARCH_SETTINGS_INVALID',
      `${name} must be a whole number from 1 to ${maximum}.`,
    );
  }
  return value;
}

export function validateInstallerSettings(input = {}) {
  const datePosted = requiredText(input.datePosted ?? 'pastWeek', 'datePosted');
  if (!DATE_POSTED.has(datePosted)) {
    throw new InstallerError(
      'SEARCH_SETTINGS_INVALID',
      'datePosted must be anyTime, past24Hours, pastWeek, or pastMonth.',
    );
  }

  const budgetUsd = Number(input.budgetUsd ?? 0.05);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new InstallerError('SEARCH_SETTINGS_INVALID', 'budgetUsd must be greater than zero.');
  }

  const scrapeCompany = input.scrapeCompany ?? false;
  if (typeof scrapeCompany !== 'boolean') {
    throw new InstallerError('SEARCH_SETTINGS_INVALID', 'scrapeCompany must be true or false.');
  }

  const spreadsheetTitle = String(input.spreadsheetTitle ?? 'LinkedIn jobs').trim() || 'LinkedIn jobs';
  if (spreadsheetTitle.length > 200) {
    throw new InstallerError(
      'SEARCH_SETTINGS_INVALID',
      'The spreadsheet title must be 200 characters or fewer.',
    );
  }

  return Object.freeze({
    keywords: requiredText(input.keywords, 'keywords'),
    location: requiredText(input.location, 'location'),
    datePosted,
    limit: safeInteger(input.limit ?? 10, 'limit', 1000),
    budgetUsd,
    scrapeCompany,
    spreadsheetTitle,
  });
}

export function validateCredential(candidate, expectedType, label) {
  if (
    !candidate
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || candidate.type !== expectedType
    || typeof candidate.id !== 'string'
    || !candidate.id.trim()
    || !/^[A-Za-z0-9_-]{1,200}$/u.test(candidate.id.trim())
    || typeof candidate.name !== 'string'
    || !candidate.name.trim()
  ) {
    throw new InstallerError(
      'CREDENTIAL_INVALID',
      `Select a valid ${label} credential.`,
    );
  }
  return { id: candidate.id.trim(), name: candidate.name.trim(), type: candidate.type };
}

function jsString(value) {
  return JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1 || source.indexOf(search, first + search.length) !== -1) {
    throw new InstallerError(
      'TEMPLATE_INVALID',
      `The trusted workflow template has an invalid ${label} marker. Rebuild the installer.`,
    );
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

export function credentialNodeCounts(code) {
  return {
    apify: code.split(TEMPLATE_SENTINELS.apifyCredential).length - 1,
    google: code.split(TEMPLATE_SENTINELS.googleCredential).length - 1,
  };
}

export function renderWorkflowCode({
  template,
  settings,
  apifyCredential,
  googleCredential,
}) {
  if (typeof template !== 'string' || !template) {
    throw new InstallerError('TEMPLATE_INVALID', 'The workflow template is unavailable.');
  }
  const safeSettings = validateInstallerSettings(settings);
  const apify = validateCredential(apifyCredential, 'apifyOAuth2Api', 'Apify OAuth');
  const google = validateCredential(googleCredential, 'googleSheetsOAuth2Api', 'Google Sheets OAuth');

  const markerCounts = credentialNodeCounts(template);
  if (
    markerCounts.apify !== CREDENTIAL_NODE_NAMES.apifyOAuth2Api.length
    || markerCounts.google !== CREDENTIAL_NODE_NAMES.googleSheetsOAuth2Api.length
  ) {
    throw new InstallerError(
      'TEMPLATE_INVALID',
      'The workflow template does not contain the expected 14 credential bindings.',
    );
  }

  let code = template;
  code = code.replaceAll(TEMPLATE_SENTINELS.apifyCredential, `newCredential(${jsString(apify.name)}, ${jsString(apify.id)})`);
  code = code.replaceAll(TEMPLATE_SENTINELS.googleCredential, `newCredential(${jsString(google.name)}, ${jsString(google.id)})`);
  code = replaceExactlyOnce(code, `'${TEMPLATE_SENTINELS.keywords}'`, jsString(safeSettings.keywords), 'keywords');
  code = replaceExactlyOnce(code, `'${TEMPLATE_SENTINELS.location}'`, jsString(safeSettings.location), 'location');
  code = replaceExactlyOnce(code, `'${TEMPLATE_SENTINELS.datePosted}'`, jsString(safeSettings.datePosted), 'datePosted');
  code = replaceExactlyOnce(code, String(TEMPLATE_SENTINELS.limit), String(safeSettings.limit), 'limit');
  code = replaceExactlyOnce(code, String(TEMPLATE_SENTINELS.budgetUsd), String(safeSettings.budgetUsd), 'budgetUsd');
  code = replaceExactlyOnce(code, `'${TEMPLATE_SENTINELS.scrapeCompany}'`, String(safeSettings.scrapeCompany), 'scrapeCompany');
  code = replaceExactlyOnce(
    code,
    `'${TEMPLATE_SENTINELS.spreadsheetTitle}'`,
    jsString(safeSettings.spreadsheetTitle),
    'spreadsheetTitle',
  );

  if (code.length > CLOUD_CODE_LIMIT) {
    throw new InstallerError(
      'WORKFLOW_CODE_TOO_LARGE',
      'The configured workflow is too large for the n8n Cloud create tool.',
    );
  }

  if (
    (code.match(/googleSheetsOAuth2Api: newCredential\(/gu) ?? []).length
      !== CREDENTIAL_NODE_NAMES.googleSheetsOAuth2Api.length
    || (code.match(/apifyOAuth2Api: newCredential\(/gu) ?? []).length
      !== CREDENTIAL_NODE_NAMES.apifyOAuth2Api.length
  ) {
    throw new InstallerError(
      'TEMPLATE_INVALID',
      'The rendered workflow does not contain all explicit credential bindings.',
    );
  }

  return code;
}
