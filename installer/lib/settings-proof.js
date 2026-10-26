import { InstallerError } from './errors.js';
import { randomToken } from './pkce.js';

const SEARCH_SETTING_NAMES = Object.freeze([
  'keywords',
  'location',
  'datePosted',
  'limit',
  'budgetUsd',
  'scrapeCompany',
  'spreadsheetTitle',
]);

function encoded(value) {
  return JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function canonicalPayload(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new InstallerError('SEARCH_SETTINGS_INVALID', 'The search settings are invalid.');
  }
  return encoded(Object.fromEntries(
    SEARCH_SETTING_NAMES.map((name) => {
      if (!Object.hasOwn(settings, name)) {
        throw new InstallerError('SEARCH_SETTINGS_INVALID', `The search setting ${name} is missing.`);
      }
      return [name, settings[name]];
    }),
  ));
}

async function digest(settings, salt) {
  const bytes = new TextEncoder().encode(`${salt}\n${canonicalPayload(settings)}`);
  const hash = await globalThis.crypto?.subtle?.digest('SHA-256', bytes);
  if (!hash) {
    throw new InstallerError(
      'CRYPTO_UNAVAILABLE',
      'This browser cannot protect the search settings recovery proof.',
    );
  }
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function searchSettingsFromAssignments(assignments) {
  if (!Array.isArray(assignments)) {
    throw new InstallerError('WORKFLOW_READBACK_INVALID', 'Search settings assignments are missing.');
  }
  const settings = {};
  for (const name of SEARCH_SETTING_NAMES) {
    const matches = assignments.filter((assignment) => assignment?.name === name);
    if (matches.length !== 1) {
      throw new InstallerError(
        'WORKFLOW_READBACK_INVALID',
        `Search setting ${name} is missing or duplicated.`,
      );
    }
    settings[name] = matches[0].value;
  }
  return settings;
}

export async function createSettingsProof(settings) {
  const salt = randomToken(32);
  return {
    version: 1,
    algorithm: 'SHA-256',
    salt,
    digest: await digest(settings, salt),
  };
}

export async function verifySettingsProof(settings, proof) {
  if (
    !proof
    || proof.version !== 1
    || proof.algorithm !== 'SHA-256'
    || typeof proof.salt !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(proof.salt)
    || typeof proof.digest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(proof.digest)
  ) {
    throw new InstallerError(
      'INSTALL_RECOVERY_UNAVAILABLE',
      'The saved search-settings proof is invalid.',
    );
  }
  const actual = await digest(settings, proof.salt);
  if (actual !== proof.digest) {
    throw new InstallerError(
      'WORKFLOW_SEARCH_SETTINGS_MISMATCH',
      'The workflow search settings do not match the values submitted by the installer.',
    );
  }
}
