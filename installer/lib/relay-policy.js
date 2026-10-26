import { isIP } from 'node:net';

export {
  RELAY_ALLOWED_METHODS,
  RELAY_ALLOWED_TOOLS,
  validateMcpRpcBody,
  validateRelayRoutingHeaders,
  validateRelayTarget,
} from './relay-request-policy.js';

export function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  const normalized = address.toLowerCase();
  const family = isIP(normalized);
  if (family === 0) return true;

  if (family === 4) {
    const [first, second] = normalized.split('.').map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 192 && second === 0 && normalized.startsWith('192.0.2.'))
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && normalized.startsWith('198.51.100.'))
      || (first === 203 && second === 0 && normalized.startsWith('203.0.113.'))
      || first >= 224;
  }

  let canonical;
  try {
    canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (
    canonical === '::'
    || canonical === '::1'
    || canonical.startsWith('::ffff:')
    || canonical.startsWith('::')
    || /^f[cd][0-9a-f]{2}:/u.test(canonical)
    || /^fe[89ab][0-9a-f]:/u.test(canonical)
    || /^ff[0-9a-f]{2}:/u.test(canonical)
    || /^2001:db8:/u.test(canonical)
  ) {
    return true;
  }
  return false;
}
