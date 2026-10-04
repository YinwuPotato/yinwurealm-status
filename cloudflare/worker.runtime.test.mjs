// Author: Soidraw. Real workerd runtime; all outbound traffic stays in the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, Log, LogLevel } from 'miniflare';

test('Cloudflare runtime validates request options and scheduled dispatch', async t => {
  const source = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const calls = [];
  let status = 204;
  const mf = new Miniflare({
    compatibilityDate: '2026-07-30',
    cf: false,
    log: new Log(LogLevel.ERROR),
    modules: [
      {
        type: 'ESModule', path: 'test-entry.mjs', contents: `
          import worker from './worker.mjs';
          export default {
            async fetch(request, env) {
              const url = new URL(request.url);
              try {
                if (url.pathname === '/legacy') {
                  new Request('https://api.github.com/', { redirect: 'error' });
                  return Response.json({ unexpectedSuccess: true });
                }
                if (url.pathname === '/public') return worker.fetch(request, env);
                await worker.scheduled({
                  cron: '* * * * *',
                  scheduledTime: Date.parse(url.searchParams.get('time') || '2026-10-04T15:53:24Z'),
                }, env);
                return Response.json({ ok: true });
              } catch (error) {
                return Response.json({ name: error.name, message: error.message }, { status: 500 });
              }
            },
          };
        `,
      },
      { type: 'ESModule', path: 'worker.mjs', contents: source },
    ],
    bindings: { GITHUB_DISPATCH_TOKEN: 'TEST_ONLY_FAKE_TOKEN' },
    outboundService: async request => {
      calls.push({ url: request.url, method: request.method, body: await request.text(),
        authorization: request.headers.get('Authorization') });
      return new Response(status === 204 ? null : 'TEST_ONLY_FAKE_TOKEN', {
        status, headers: status === 302 ? { Location: 'https://example.invalid/TEST_ONLY_FAKE_TOKEN' } : {},
      });
    },
  });
  t.after(() => mf.dispose());

  await t.test('old redirect option reproduces immediate TypeError before any outbound request', async () => {
    const response = await mf.dispatchFetch('https://test.invalid/legacy');
    const error = await response.json();
    assert.equal(error.name, 'TypeError');
    assert.match(error.message, /Invalid redirect value/);
    assert.equal(calls.length, 0);
  });

  await t.test('fixed scheduled handler reaches the fixed endpoint and accepts HTTP 204', async () => {
    const response = await mf.dispatchFetch('https://test.invalid/scheduled');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/YinwuPotato/yinwurealm-status/actions/workflows/uptime.yml/dispatches');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { ref: 'master' });
    assert.equal(calls[0].authorization, 'Bearer TEST_ONLY_FAKE_TOKEN');
  });

  await t.test('redirect is not followed, even to another origin', async () => {
    status = 302;
    const before = calls.length;
    const response = await mf.dispatchFetch('https://test.invalid/scheduled');
    const error = await response.json();
    assert.match(error.message, /redirect refused.*HTTP 302/);
    assert.equal(error.message.includes('TEST_ONLY_FAKE_TOKEN'), false);
    assert.equal(calls.length, before + 1);
  });

  await t.test('GitHub authorization failure remains distinct and is not retried', async () => {
    status = 401;
    const before = calls.length;
    const response = await mf.dispatchFetch('https://test.invalid/scheduled');
    const error = await response.json();
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes('TEST_ONLY_FAKE_TOKEN'), false);
    assert.equal(calls.length, before + 1);
  });

  await t.test('idle minute and public HTTP requests cannot dispatch', async () => {
    const before = calls.length;
    const response = await mf.dispatchFetch('https://test.invalid/scheduled?time=2026-10-04T15:54:24Z');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await mf.dispatchFetch('https://test.invalid/public')).status, 404);
    assert.equal(calls.length, before);
  });
});
