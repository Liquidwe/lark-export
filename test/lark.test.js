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

test('a wiki lock rejection is resent, and a rate limit holds back the whole write group', async () => {
  const client = new LarkClient({ appId: 'a', appSecret: 's', apiBase: 'https://example.test' });
  const answers = [
    Response.json({ code: 131009, msg: 'lock contention' }, { status: 400 }),
    Response.json({ code: 99991400, msg: 'frequency limit' }, { status: 400, headers: { 'x-ogw-ratelimit-reset': '3' } }),
    Response.json({ code: 0, data: { node: { node_token: 'n' } } }),
  ];
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    return answers[calls++];
  };
  const pauses = [];
  const realPause = client.pauseGroup.bind(client);
  client.pauseGroup = (...args) => {
    pauses.push(args[1]);
    realPause(...args);
  };
  try {
    const data = await client.post('/wiki/v2/spaces/s/nodes', {});
    assert.equal(data.node.node_token, 'n');
    assert.equal(calls, 3);
    assert.deepEqual(pauses, ['/wiki/v2/spaces/s/nodes'], 'only the rate limit pauses the group');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('code 131001 is resent only when it says it was rate limited', async () => {
  const client = new LarkClient({ appId: 'a', appSecret: 's', apiBase: 'https://example.test' });
  const answers = [
    Response.json({ code: 131001, msg: 'rpc fail: method rate limit' }, { status: 400 }),
    Response.json({ code: 0, data: { ok: 1 } }),
    Response.json({ code: 131001, msg: 'rpc fail' }, { status: 400 }),
  ];
  let calls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    return answers[calls++];
  };
  assert.deepEqual(await client.post('/wiki/v2/spaces/s/nodes', {}), { ok: 1 });
  assert.equal(calls, 2);
  await assert.rejects(client.post('/wiki/v2/spaces/s/nodes', {}), /rpc fail/);
  assert.equal(calls, 3);
});

test('a permission error names the bot that was refused, and other errors do not', async () => {
  const client = new LarkClient({ appId: 'cli_target', appSecret: 's', apiBase: 'https://example.test' });
  const answers = [
    Response.json({ code: 131006, msg: 'permission denied: node permission denied, tenant needs read permission.' }, { status: 400 }),
    Response.json({ code: 99991672, msg: 'no scope', error: { permission_violations: [{ subject: 'wiki:wiki' }] } }, { status: 400 }),
    Response.json({ code: 1770002, msg: 'not found' }, { status: 400 }),
  ];
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    return answers.shift();
  };
  await assert.rejects(client.get('/wiki/v2/spaces/get_node'), (err) => {
    assert.match(err.message, /code=131006/);
    assert.match(err.message, /App ID: cli_target/);
    assert.equal(err.code, 131006);
    return true;
  });
  await assert.rejects(client.get('/wiki/v2/spaces/get_node'), /wiki:wiki.*App ID: cli_target/);
  await assert.rejects(client.get('/docx/v1/documents/x'), (err) => !err.message.includes('App ID'));
});

test('a transient Lark error (600) is resent on reads, but not on writes', async () => {
  const answers = [{ code: 600, msg: 'expired resource deleted by ka' }, { code: 0, data: { ok: true } }];
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    return Response.json(answers[Math.min(calls++, answers.length - 1)]);
  };
  assert.deepEqual(await client().get('/docx/v1/documents/d/blocks'), { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(client().post('/x', {}), /expired resource/);
  assert.equal(calls, 1);
});
