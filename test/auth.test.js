import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-auth-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  LARK_APP_ID: 'cli_source',
  LARK_APP_SECRET: 'source-secret',
  LARK_TARGET_APP_ID: 'cli_target',
  LARK_TARGET_APP_SECRET: 'target-secret',
  ADMIN_PASSWORD: 'correct horse battery',
  PUBLIC_URL: 'https://migrate.example.test',
});
const { BLOB_DIR, db } = await import('../src/db.js');
const { server } = await import('../src/server.js');

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let base;
let lark;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ok = (data) => Response.json({ code: 0, data });

// A fake Lark with one library and one Drive per organization. Requests to this server pass through.
beforeEach(() => {
  lark = { tokens: [], created: [], folders: [], docs: [], tokenUses: [], refreshes: 0, expiresIn: 7200 };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === base) return realFetch(input, init);
    const path = url.pathname.replace('/open-apis', '');
    const auth = init.headers?.Authorization;
    if (path === '/authen/v2/oauth/token') {
      const body = JSON.parse(init.body);
      lark.tokens.push(body);
      if (body.grant_type === 'refresh_token') lark.refreshes++;
      const n = lark.tokens.length;
      return Response.json({ code: 0, access_token: `user-${body.code ?? 'refreshed'}-${n}`, refresh_token: `refresh-${n}`, expires_in: lark.expiresIn, refresh_token_expires_in: 604800 });
    }
    if (path === '/authen/v1/user_info') {
      const who = auth.match(/user-([a-z]+)/)[1];
      return ok({ open_id: `ou_${who}`, name: who });
    }
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'bot', expire: 7200 });
    lark.tokenUses.push([path, auth]);
    if (path === '/wiki/v2/spaces/my_library') return ok({ space: { space_id: auth.includes('target') ? 'sp-new' : 'sp-old' } });
    if (path === '/drive/v1/metas/batch_query') return ok({ metas: [{ url: 'https://acme.larksuite.com/wiki/x' }] });
    if (path === '/wiki/v2/spaces/sp-old/nodes') {
      return ok({
        has_more: false,
        items: [
          { space_id: 'sp-old', node_token: 'r1', obj_token: 'o1', obj_type: 'docx', node_type: 'origin', title: '机密一', has_child: false },
          { space_id: 'sp-old', node_token: 'r2', obj_token: 'o2', obj_type: 'docx', node_type: 'origin', title: '机密二', has_child: false },
        ],
      });
    }
    if (path === '/wiki/v2/spaces/sp-new/nodes' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      lark.created.push(body);
      return ok({ node: { node_token: `n-${body.title}`, obj_token: `d-${lark.created.length}`, obj_type: 'docx' } });
    }
    if (path === '/drive/explorer/v2/root_folder/meta') return ok({ token: auth.includes('target') ? 'drv-new' : 'drv-old' });
    if (path === '/drive/v1/files') {
      const folder = url.searchParams.get('folder_token');
      const files = {
        'drv-old': [{ token: 'fd1', name: '资料', type: 'folder', url: 'https://acme.larksuite.com/drive/folder/fd1' }],
        fd1: [{ token: 'o3', name: '机密三', type: 'docx', url: 'https://acme.larksuite.com/docx/o3' }],
      }[folder];
      return ok({ files: files ?? [], has_more: false });
    }
    if (path === '/drive/v1/files/create_folder') {
      const body = JSON.parse(init.body);
      lark.folders.push([body.name, body.folder_token]);
      return ok({ token: `f-${body.name}` });
    }
    if (path === '/docx/v1/documents' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      lark.docs.push([body.title, body.folder_token]);
      return ok({ document: { document_id: `dd-${body.title}` } });
    }
    if (/\/documents\/o\d\/blocks$/.test(path)) return ok({ items: [{ block_id: 'p', block_type: 1, children: [] }], has_more: false });
    return ok({ block: { children: [] }, items: [], has_more: false });
  };
});

// A tiny browser: keeps cookies, and never follows redirects so they can be inspected.
function browser() {
  const jar = new Map();
  const call = async (path, { body, method } = {}) => {
    const res = await realFetch(base + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return res;
  };
  return { call, jar };
}

async function signIn(who, b = browser()) {
  const start = await b.call('/api/auth/lark/login');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await b.call(`/api/auth/lark/callback?code=${who}&state=${state}`);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/');
  return b;
}

async function authorizeTarget(b, who) {
  const start = await b.call('/api/auth/lark/target');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return b.call(`/api/auth/lark/callback?code=${who}&state=${state}`);
}

async function adminBrowser() {
  const b = browser();
  const res = await b.call('/api/auth/admin', { body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(res.status, 200);
  return b;
}

async function readLibrary(b) {
  const { id } = await (await b.call('/api/library/export', { body: {} })).json();
  for (let i = 0; i < 300; i++) {
    const job = await (await b.call(`/api/exports/${id}`)).json();
    if (job.status === 'done') return job;
    await sleep(20);
  }
  assert.fail('read did not finish');
}

test('every data route needs a session, and the login page data does not', async () => {
  const b = browser();
  for (const path of ['/api/exports', '/api/exports/1', '/api/admin/members']) {
    assert.equal((await b.call(path)).status, 401, path);
  }
  assert.equal((await b.call('/api/exports', { body: { url: 'https://x.larksuite.com/wiki/a' } })).status, 401);
  assert.equal((await b.call('/api/health')).status, 200);
  const me = await (await b.call('/api/me')).json();
  assert.deepEqual(me, { role: null, adminEnabled: true, memberEnabled: true });
});

test('the login redirect asks for the registered callback, and the state must match', async () => {
  const b = browser();
  const start = await b.call('/api/auth/lark/login');
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin, 'https://accounts.larksuite.com');
  assert.equal(location.searchParams.get('client_id'), 'cli_source');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://migrate.example.test/api/auth/lark/callback');
  assert.match(location.searchParams.get('scope'), /offline_access/);
  assert.match(start.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax.*Secure/);

  const stranger = browser();
  const state = location.searchParams.get('state');
  const forged = await stranger.call(`/api/auth/lark/callback?code=eve&state=${state}`);
  assert.match(forged.headers.get('location'), /error=state/);
  assert.equal(lark.tokens.length, 0, 'no code is exchanged for a mismatched state');

  const first = await b.call(`/api/auth/lark/callback?code=alice&state=${state}`);
  assert.equal(first.headers.get('location'), '/');
  const again = browser();
  again.jar.set('lark_oauth_state', state);
  const replay = await again.call(`/api/auth/lark/callback?code=alice&state=${state}`);
  assert.match(replay.headers.get('location'), /error=state/, 'a state works once');
});

test('members cannot use links or reach admin routes', async () => {
  const b = await signIn('alice');
  const me = await (await b.call('/api/me')).json();
  assert.equal(me.role, 'member');
  assert.equal(me.name, 'alice');
  assert.equal((await b.call('/api/exports', { body: { url: 'https://x.larksuite.com/wiki/a' } })).status, 403);
  assert.equal((await b.call('/api/admin/members')).status, 403);
  const job = await readLibrary(b);
  for (const path of [`/api/exports/${job.id}/migrations`, `/api/exports/${job.id}/migration-preview`]) {
    assert.equal((await b.call(path, { body: { url: 'https://x.larksuite.com/wiki/a' } })).status, 403, path);
  }
});

test('a member reads the whole library with their own token, and others cannot touch it', async () => {
  const alice = await signIn('alice');
  const job = await readLibrary(alice);
  assert.deepEqual(job.nodes.map((n) => [n.title, n.parent_token]), [
    ['机密一', null],
    ['机密二', null],
    ['我的空间', null],
    ['资料', 'drv-old'],
    ['机密三', 'fd1'],
  ]);
  assert.equal(job.nodes.find((n) => n.title === '机密三').status, 'done');
  assert.equal(job.host, 'https://acme.larksuite.com');
  assert.ok(lark.tokenUses.every(([, auth]) => auth.includes('user-alice')), 'never the bot');

  const bob = await signIn('bob');
  assert.deepEqual(await (await bob.call('/api/exports')).json(), []);
  assert.equal((await bob.call(`/api/exports/${job.id}`)).status, 404);
  for (const action of ['pause', 'resume', 'delete', 'library-migration', `nodes/${job.nodes[0].id}/retry`]) {
    assert.equal((await bob.call(`/api/exports/${job.id}/${action}`, { body: {} })).status, 404, action);
  }

  const admin = await adminBrowser();
  assert.equal((await admin.call(`/api/exports/${job.id}`)).status, 404, 'the admin cannot open it either');
  assert.ok(!(await (await admin.call('/api/exports')).json()).some((row) => row.id === job.id));
});

test('the admin sees member status but no titles, errors or tokens', async () => {
  const alice = await signIn('alice');
  const job = await readLibrary(alice);
  db.prepare(`UPDATE nodes SET error = '机密一 读取失败' WHERE export_id = ?`).run(job.id);
  const admin = await adminBrowser();
  const res = await admin.call('/api/admin/members');
  const text = await res.text();
  const row = JSON.parse(text).find((member) => member.name === 'alice');
  assert.equal(row.read.total, 5);
  assert.doesNotMatch(text, /机密|我的文档库|node_token|access_token|ou_/);
});

test('a member writes to their new library only after authorizing it, at the top level, as themselves', async () => {
  const carol = await signIn('carol');
  const job = await readLibrary(carol);
  const refused = await carol.call(`/api/exports/${job.id}/library-migration`, { body: {} });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /授权新组织/);

  const authorized = await authorizeTarget(carol, 'target');
  assert.equal(authorized.headers.get('location'), '/');
  const me = await (await carol.call('/api/me')).json();
  assert.equal(me.target.name, 'target');
  assert.equal(me.name, 'carol', 'still signed in as themselves');

  lark.tokenUses.length = 0;
  const { id } = await (await carol.call(`/api/exports/${job.id}/library-migration`, { body: {} })).json();
  let migration;
  for (let i = 0; i < 400; i++) {
    migration = (await (await carol.call(`/api/exports/${job.id}`)).json()).migrations.find((m) => m.id === id);
    if (migration.status !== 'running') break;
    await sleep(20);
  }
  assert.equal(migration.status, 'done', migration.error);
  assert.deepEqual(lark.created.map((body) => [body.title, body.parent_node_token]), [['机密一', undefined], ['机密二', undefined]]);
  // My Space becomes one folder in the new Drive root, with its own folders and files inside.
  assert.deepEqual(lark.folders, [['我的空间', 'drv-new'], ['资料', 'f-我的空间']]);
  assert.deepEqual(lark.docs, [['机密三', 'f-资料']]);
  assert.equal(migration.items.find((item) => item.title === '机密三').url, 'https://acme.larksuite.com/docx/dd-机密三');
  assert.ok(lark.tokenUses.every(([, auth]) => auth.includes('user-target')), 'writes use the new account');
  assert.equal(migration.target_host, 'https://acme.larksuite.com');
  assert.match(migration.items[0].url, /^https:\/\/acme\.larksuite\.com\/wiki\/n-/);
});

test('a target authorization cannot land on someone else', async () => {
  const dave = await signIn('dave');
  const start = await dave.call('/api/auth/lark/target');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const erin = await signIn('erin');
  erin.jar.set('lark_oauth_state', state);
  const res = await erin.call(`/api/auth/lark/callback?code=target&state=${state}`);
  assert.match(res.headers.get('location'), /error=state/);
  assert.equal((await (await erin.call('/api/me')).json()).target, null);
  assert.equal((await (await dave.call('/api/me')).json()).target, null);
});

test('tokens are not stored in the clear, and concurrent requests share one single-use refresh', async () => {
  lark.expiresIn = 1;
  const frank = await signIn('frank');
  const row = db.prepare(`SELECT a.* FROM lark_accounts a JOIN users u ON u.id = a.user_id WHERE u.name = 'frank'`).get();
  assert.doesNotMatch(row.access_token, /user-frank/);
  assert.doesNotMatch(Buffer.from(row.refresh_token, 'base64').toString(), /refresh-/);

  lark.expiresIn = 7200;
  const { clientForJob } = await import('../src/auth.js');
  const client = clientForJob('source', { owner_id: row.user_id, api_base: 'https://open.larksuite.com/open-apis' });
  const tokens = await Promise.all([client.token(), client.token(), client.token()]);
  assert.equal(lark.refreshes, 1);
  assert.equal(new Set(tokens).size, 1);

  const refreshBody = lark.tokens.at(-1);
  assert.match(refreshBody.refresh_token, /^refresh-/);
  const saved = db.prepare('SELECT refresh_token FROM lark_accounts WHERE user_id = ? AND side = ?').get(row.user_id, 'source');
  assert.notEqual(saved.refresh_token, row.refresh_token, 'the rotated refresh token is kept');
  assert.equal(await client.token(), tokens[0], 'no second refresh while the token is valid');
  assert.equal(lark.refreshes, 1);
});

test('a member can delete their read, which removes the stored documents', async () => {
  const gina = await signIn('gina');
  const job = await readLibrary(gina);
  const dir = join(BLOB_DIR, String(job.id));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  assert.equal((await gina.call(`/api/exports/${job.id}/delete`, { body: {} })).status, 200);
  assert.equal((await gina.call(`/api/exports/${job.id}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE export_id = ?').get(job.id).n, 0);
  assert.equal(existsSync(dir), false);
});

test('logging out ends the session on the server', async () => {
  const b = await adminBrowser();
  const copied = browser();
  copied.jar.set('lark_session', b.jar.get('lark_session'));
  await b.call('/api/auth/logout', { body: {} });
  assert.equal((await copied.call('/api/exports')).status, 401);
});

// Last, because it locks this test client's address out of admin login.
test('wrong admin passwords are refused, then locked out even with the right one', async () => {
  const b = browser();
  for (let i = 0; i < 5; i++) {
    const res = await b.call('/api/auth/admin', { body: { password: `guess ${i}` } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  const res = await b.call('/api/auth/admin', { body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /15 分钟/);
});
