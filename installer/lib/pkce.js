import { InstallerError } from './errors.js';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomBytes(length) {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new InstallerError(
      'CRYPTO_UNAVAILABLE',
      'This browser cannot create the secure OAuth values required by n8n Cloud.',
    );
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(byteLength = 32) {
  return bytesToBase64Url(randomBytes(byteLength));
}

export async function createPkcePair() {
  const verifier = randomToken(64);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: bytesToBase64Url(new Uint8Array(digest)),
    method: 'S256',
  };
}
