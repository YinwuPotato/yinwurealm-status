// Author: Soidraw. Tests use mock responses; no GitHub calls or real tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

const env = { GITHUB_DISPATCH_TOKEN: 'TEST_ONLY_FAKE_TOKEN' };
const controller = iso => ({ cron: '* * * * *', scheduledTime: Date.parse(iso) });

function capture(t, reply = () => new Response(null, { status: 204 })) {
  const calls = [];
  const logs = [];
  t.mock.method(globalThis, 'fetch', async request => {
    const url = request.url;
    const options = {
      method: request.method,
      headers: { Authorization: request.headers.get('Authorization') },
      body: await request.clone().text(),
      redirect: request.redirect,
      signal: request.signal,
    };
    calls.push({ url, options });
    return reply();
  });
  t.mock.method(console, 'log', message => logs.push(message));
  t.mock.method(console, 'error', message => logs.push(message));
  return { calls, logs };
}

test('dispatch is restricted to the configured repository, branch and workflow', async t => {
  const { calls, logs } = capture(t);
  await worker.scheduled(controller('2026-10-04T23:03:00Z'), env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/YinwuPotato/yinwurealm-status/actions/workflows/uptime.yml/dispatches');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'master' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer TEST_ONLY_FAKE_TOKEN');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(logs.some(log => log.includes(env.GITHUB_DISPATCH_TOKEN)), false);
});

test('a full UTC week contains all expected tasks with no same-minute collisions', async t => {
  const { calls } = capture(t);
  const counts = {};
  const uptimeSlots = [];
  const start = Date.parse('2026-10-05T00:00:00Z');
  for (let minute = 0; minute < 7 * 24 * 60; minute++) {
    const before = calls.length;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: start + minute * 60000 }, env);
    assert.ok(calls.length - before <= 1, `overlapping tasks at minute ${minute}`);
    if (calls.length > before) {
      const workflow = new URL(calls.at(-1).url).pathname.split('/').at(-2);
      counts[workflow] = (counts[workflow] || 0) + 1;
      if (workflow === 'uptime.yml') uptimeSlots.push(minute);
    }
  }
  assert.deepEqual(counts, {
    'uptime.yml': 2016, 'response-time.yml': 28, 'summary.yml': 7,
    'graphs.yml': 7, 'site.yml': 7, 'update-template.yml': 1, 'updates.yml': 7,
  });
  for (let i = 1; i < uptimeSlots.length; i++) assert.equal(uptimeSlots[i] - uptimeSlots[i - 1], 5);
});

test('scheduled time selects maintenance correctly even when wall-clock execution is later', async t => {
  const { calls } = capture(t);
  await worker.scheduled(controller('2026-10-05T03:15:00Z'), env);
  assert.ok(calls[0].url.endsWith('/update-template.yml/dispatches'));
});

test('UTC conversion handles local dates crossing the day boundary', async t => {
  const { calls } = capture(t);
  await worker.scheduled(controller('2026-10-05T08:17:00+08:00'), env);
  assert.ok(calls[0].url.endsWith('/response-time.yml/dispatches'));
});

test('off-slot invocations perform no network requests and need no Secret', async t => {
  const { calls } = capture(t);
  await worker.scheduled(controller('2026-10-04T12:01:00Z'), {});
  assert.equal(calls.length, 0);
});

test('missing Secret, malformed time and wrong cron fail before network access', async t => {
  const { calls } = capture(t);
  await assert.rejects(worker.scheduled(controller('2026-10-04T12:03:00Z'), {}), /Missing Cloudflare Secret/);
  await assert.rejects(worker.scheduled({ cron: '* * * * *', scheduledTime: NaN }, env), /Invalid scheduledTime/);
  await assert.rejects(worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env), /Set the Cloudflare Cron Trigger/);
  assert.equal(calls.length, 0);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is reported without logging response contents or retrying`, async t => {
    const { calls, logs } = capture(t, () => new Response('TEST_ONLY_FAKE_TOKEN', { status }));
    await assert.rejects(worker.scheduled(controller('2026-10-04T12:03:00Z'), env), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1);
    assert.equal(logs.some(log => log.includes(env.GITHUB_DISPATCH_TOKEN)), false);
  });
}

test('ambiguous network failure is not retried or exposed with original error text', async t => {
  const { calls, logs } = capture(t, () => { throw new Error('TEST_ONLY_FAKE_TOKEN'); });
  await assert.rejects(worker.scheduled(controller('2026-10-04T12:03:00Z'), env), /request failed.*\(Error\)/);
  assert.equal(calls.length, 1);
  assert.equal(logs.some(log => log.includes(env.GITHUB_DISPATCH_TOKEN)), false);
});

test('request construction errors are distinguished from network failures without leaking values', async t => {
  const { calls, logs } = capture(t);
  t.mock.method(globalThis, 'Request', function () { throw new TypeError('TEST_ONLY_FAKE_TOKEN'); });
  await assert.rejects(worker.scheduled(controller('2026-10-04T12:03:00Z'), env), /request setup failed.*\(TypeError\)/);
  assert.equal(calls.length, 0);
  assert.equal(logs.some(log => log.includes(env.GITHUB_DISPATCH_TOKEN)), false);
});

test('redirect responses are refused without following them or exposing Location', async t => {
  const { calls, logs } = capture(t, () => new Response(null, {
    status: 302, headers: { Location: 'https://example.invalid/TEST_ONLY_FAKE_TOKEN' },
  }));
  await assert.rejects(worker.scheduled(controller('2026-10-04T12:03:00Z'), env), /redirect refused.*HTTP 302/);
  assert.equal(calls.length, 1);
  assert.equal(logs.some(log => log.includes(env.GITHUB_DISPATCH_TOKEN)), false);
});

test('public HTTP requests cannot dispatch workflows', async t => {
  const { calls } = capture(t);
  const response = await worker.fetch(new Request('https://example.test/'), env);
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});
