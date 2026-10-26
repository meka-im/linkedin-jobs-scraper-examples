export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://*.app.n8n.cloud",
  "base-uri 'none'",
  "form-action 'self' https://*.app.n8n.cloud",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join('; ');

export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});
