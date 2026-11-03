import { isOriginAllowed } from './cors-origins';

describe('isOriginAllowed', () => {
  it('allows temporary Cloudflare development tunnel origins by default', () => {
    expect(
      isOriginAllowed('https://example.trycloudflare.com', {
        NODE_ENV: 'development',
      }),
    ).toBe(true);
  });

  it('accepts explicitly configured wildcard origins', () => {
    expect(
      isOriginAllowed('https://app.example.com', {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com,https://*.example.com',
      }),
    ).toBe(true);
  });

  it('rejects untrusted origins', () => {
    expect(
      isOriginAllowed('https://evil.example.com', {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      }),
    ).toBe(false);
  });
});
