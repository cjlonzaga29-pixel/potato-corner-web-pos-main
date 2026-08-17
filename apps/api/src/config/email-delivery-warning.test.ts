import { describe, expect, it, vi, afterEach } from 'vitest';
import { warnIfEmailDeliveryMisconfigured } from './index.js';

const BASE = { NODE_ENV: 'production', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'no-reply@example.com', NEXT_PUBLIC_APP_URL: 'https://example.com' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warnIfEmailDeliveryMisconfigured', () => {
  it('warns about nothing when fully configured in production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured(BASE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when RESEND_API_KEY is missing outside development', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured({ ...BASE, RESEND_API_KEY: undefined });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY'));
  });

  it('warns when EMAIL_FROM is missing outside development', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured({ ...BASE, EMAIL_FROM: undefined });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EMAIL_FROM'));
  });

  it('warns when NEXT_PUBLIC_APP_URL still points at localhost outside development', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured({ ...BASE, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('localhost'));
  });

  it('stays silent in development regardless of missing config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured({ NODE_ENV: 'development', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays silent in test regardless of missing config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnIfEmailDeliveryMisconfigured({ NODE_ENV: 'test', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
