import { InstallerError } from './errors.js';

export const APIFY_CREDENTIAL_TYPE = 'apifyOAuth2Api';
export const GOOGLE_CREDENTIAL_TYPE = 'googleSheetsOAuth2Api';

function credentialData(result) {
  if (!result || !Array.isArray(result.data)) {
    throw new InstallerError(
      'CREDENTIAL_LIST_INVALID',
      'n8n returned an invalid credential list.',
    );
  }
  if (Number(result.count) > result.data.length) {
    throw new InstallerError(
      'CREDENTIAL_LIST_TRUNCATED',
      'The credential list was truncated. Narrow it in n8n and try again.',
    );
  }
  return result.data;
}

export async function listCredentialCandidates(client, type) {
  const result = await client.callTool('list_credentials', {
    type,
    limit: 200,
  });
  return credentialData(result)
    .filter((credential) => credential?.type === type)
    .map((credential) => ({
      id: String(credential.id ?? '').trim(),
      name: String(credential.name ?? '').trim(),
      type: credential.type,
      isManaged: credential.isManaged === true,
      isGlobal: credential.isGlobal === true,
    }))
    .filter((credential) => credential.id && credential.name);
}

export function chooseCredential(candidates, selectedId, label, type) {
  const exact = candidates.filter((credential) => credential.type === type);
  if (exact.length === 0) {
    throw new InstallerError(
      'CREDENTIAL_NOT_FOUND',
      `No ${label} credential was found. Create or connect it in n8n, then refresh the credential list.`,
    );
  }
  if (selectedId) {
    const selected = exact.find((credential) => credential.id === selectedId);
    if (!selected) {
      throw new InstallerError(
        'CREDENTIAL_SELECTION_INVALID',
        `The selected ${label} credential is not available to this n8n user.`,
      );
    }
    return selected;
  }
  if (exact.length === 1) return exact[0];
  throw new InstallerError(
    'CREDENTIAL_SELECTION_REQUIRED',
    `Choose which ${label} credential the workflow should use.`,
  );
}

export function credentialChoices(candidates, type) {
  return candidates
    .filter((credential) => credential.type === type)
    .map(({ id, name, isManaged, isGlobal }) => ({ id, name, isManaged, isGlobal }));
}
