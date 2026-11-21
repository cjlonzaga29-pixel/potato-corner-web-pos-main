// POS-PERF-P62 — how req.ip is derived from X-Forwarded-For under the real
// app's `trust proxy` setting, over real local HTTP. The loopback peer plays
// the one trusted hop (Render's proxy). This is a LOCAL simulation only: what
// Vercel's rewrite and Render's proxy actually send is not verified here (P62
// runbook §4, staging checklist). No diagnostic route is added to the real app;
// the echo route lives on a throwaway app that copies its trust setting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { app } = await import('./app.js');
const { API_LIMIT_PER_IP_PER_MINUTE } = await import('./middleware/rate-limiter.js');

function listen(target: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = target.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

describe('proxy trust (local simulation)', () => {
  let echo: { server: Server; base: string };
  let real: { server: Server; base: string };

  beforeAll(async () => {
    const mirror = express();
    mirror.set('trust proxy', app.get('trust proxy'));
    mirror.get('/ip', (req, res) => { res.json({ ip: req.ip, ips: req.ips }); });
    echo = await listen(mirror);
    real = await listen(app);
  });

  afterAll(async () => {
    await new Promise((r) => echo.server.close(r));
    await new Promise((r) => real.server.close(r));
  });

  const ipFor = async (xff?: string) => {
    const res = await fetch(`${echo.base}/ip`, { headers: xff ? { 'X-Forwarded-For': xff } : {} });
    return ((await res.json()) as { ip: string }).ip;
  };

  it('trusts exactly one hop', () => {
    expect(app.get('trust proxy')).toBe(1);
  });

  it('without a forwarding header, req.ip is the socket peer', async () => {
    expect(await ipFor()).toMatch(/127\.0\.0\.1$/);
  });

  it('through one trusted proxy, req.ip is the address that proxy appended', async () => {
    expect(await ipFor('203.0.113.7')).toBe('203.0.113.7');
  });

  it('client-supplied entries to the left of the trusted hop are ignored', async () => {
    expect(await ipFor('1.1.1.1, 8.8.8.8, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('with two proxies in front (e.g. Vercel then Render), req.ip is the first proxy, not the client', async () => {
    // XFF as Render would pass it if Vercel forwarded "client" and Render
    // appended Vercel's egress address. Documents the hosted risk; whether
    // that is what really happens must be checked on staging.
    expect(await ipFor('198.51.100.20, 192.0.2.50')).toBe('192.0.2.50');
  });

  it('the real app\'s per-IP budget follows req.ip: a spoofed prefix does not buy a fresh bucket', async () => {
    const hop = '203.0.113.99';
    let last = 0;
    for (let n = 0; n <= API_LIMIT_PER_IP_PER_MINUTE; n += 1) {
      const res = await fetch(`${real.base}/api/p62-no-such-route`, { headers: { 'X-Forwarded-For': `10.0.${n >> 8}.${n & 255}, ${hop}` } });
      last = res.status;
      await res.arrayBuffer();
    }
    expect(last).toBe(429);
    const other = await fetch(`${real.base}/api/p62-no-such-route`, { headers: { 'X-Forwarded-For': '203.0.113.100' } });
    expect(other.status).not.toBe(429);
  }, 60_000);
});
