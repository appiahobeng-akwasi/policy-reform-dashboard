// One-time sign-in links made by npm run users:link (decision 88).
import { describe, expect, it } from 'vitest';
import { signInLinkUrl } from '../../src/lib/auth/sign-in-link';

describe('signInLinkUrl', () => {
  it('has the same shape as the link in the sign-in email', () => {
    expect(signInLinkUrl('https://ggp.example.org', 'abc_123-x')).toBe('https://ggp.example.org/auth/confirm?token_hash=abc_123-x&type=email');
  });

  it('ignores a trailing slash and keeps a sub-path', () => {
    expect(signInLinkUrl('https://host.example/app/', 'tok')).toBe('https://host.example/app/auth/confirm?token_hash=tok&type=email');
  });

  it('refuses a token that could change the address', () => {
    expect(() => signInLinkUrl('https://ggp.example.org', 'a&next=https://evil.example')).toThrow();
    expect(() => signInLinkUrl('https://ggp.example.org', '')).toThrow();
  });
});
