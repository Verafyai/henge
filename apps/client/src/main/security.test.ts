import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isAllowedExternal, isAppUrl, resolveAppFile } from './security';

describe('external links', () => {
  it('allows only https to allowlisted hosts', () => {
    expect(isAllowedExternal('https://github.com/ashgrove/owr-remake')).toBe(true);
    expect(isAllowedExternal('http://github.com/')).toBe(false);
    expect(isAllowedExternal('https://github.com.evil.example/')).toBe(false);
    expect(isAllowedExternal('https://user:pw@github.com/')).toBe(false);
    expect(isAllowedExternal('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternal('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternal('not a url')).toBe(false);
  });
});

describe('in-app navigation', () => {
  it('stays on the app origin or the dev server', () => {
    expect(isAppUrl('app://henge/index.html')).toBe(true);
    expect(isAppUrl('app://other/index.html')).toBe(false);
    expect(isAppUrl('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true);
    expect(isAppUrl('http://localhost:5174/x', 'http://localhost:5173/')).toBe(false);
    expect(isAppUrl('https://www.verafy.ai/')).toBe(false);
  });
});

describe('content security policy', () => {
  it('is strict in production and names the API origin', () => {
    const csp = contentSecurityPolicy('http://localhost:3000/some/path');
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self' http://localhost:3000;");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('app protocol file resolution', () => {
  const root = path.resolve('/srv/renderer');
  it('maps paths inside the root', () => {
    expect(resolveAppFile(root, 'app://henge/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://henge/assets/a.js')).toBe(path.join(root, 'assets/a.js'));
  });
  it('refuses traversal and foreign hosts', () => {
    // The URL parser collapses dot segments, so this one is clamped inside the root.
    expect(resolveAppFile(root, 'app://henge/%2e%2e/%2e%2e/etc/passwd')).toBe(path.join(root, 'etc/passwd'));
    // Encoded slashes survive parsing and would escape after decoding, so they are refused.
    expect(resolveAppFile(root, 'app://henge/..%2f..%2fetc/passwd')).toBeNull();
    expect(resolveAppFile(root, 'app://evil/index.html')).toBeNull();
  });
});
