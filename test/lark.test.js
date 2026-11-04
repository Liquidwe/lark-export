import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { LarkClient } from '../src/lark.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Serves the auth call, then answers API calls with the given statuses in turn.
function stubFetch(statuses) {
  const apiCalls = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('tenant_access_token')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    apiCalls.push(String(url));
    const status = statuses[Math.min(apiCalls.length - 1, statuses.length - 1)];
    return Response.json({ code: 0, data: { ok: true } }, { status });
  };
  return apiCalls;
}

const client = () => new LarkClient({ appId: 'a', appSecret: 's', apiBase: 'https://example.test' });

test('POST without a client token is not resent after a 5xx', async () => {
  const calls = stubFetch([500, 200]);
  await assert.rejects(client().post('/x', {}));
  assert.equal(calls.length, 1);
});

test('POST with a client token is resent after a 5xx, keeping the same token', async () => {
  const calls = stubFetch([500, 200]);
  await client().post('/x', {}, { client_token: 'tok' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.includes('client_token=tok')));
});

test('any POST is resent after a 429, since the server refused it', async () => {
  const calls = stubFetch([429, 200]);
  await client().post('/x', {});
  assert.equal(calls.length, 2);
});

test('GET is resent after a 5xx', async () => {
  const calls = stubFetch([503, 200]);
  await client().get('/x');
  assert.equal(calls.length, 2);
});
