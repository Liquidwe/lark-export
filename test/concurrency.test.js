import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { LarkClient, mapConcurrent } from '../src/lark.js';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-test-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
const { db } = await import('../src/db.js');
const { startExport } = await import('../src/extract.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (data) => Response.json({ code: 0, data });

function wikiNode(token, title, hasChild = false) {
  return { node_token: token, obj_token: `obj-${token}`, obj_type: 'docx', node_type: 'origin', title, has_child: hasChild, space_id: 'sp' };
}

// A tree whose first branch answers slowest, so discovery order differs from document order.
const TREE = {
  root: [wikiNode('a', 'A', true), wikiNode('b', 'B', true), wikiNode('c', 'C')],
  a: [wikiNode('a1', 'A1', true), wikiNode('a2', 'A2')],
  a1: [wikiNode('a1x', 'A1x')],
  b: [wikiNode('b1', 'B1')],
};
const DELAYS = { root: 0, a: 60, a1: 60, b: 0 };

test('concurrent read keeps depth-first order, depth and parents, whatever answers first', async () => {
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (url.pathname.endsWith('/get_node')) return json({ node: wikiNode('root', 'Root', true) });
      if (url.pathname.endsWith('/nodes')) {
        const parent = url.searchParams.get('parent_node_token');
        await sleep(DELAYS[parent]);
        return json({ items: TREE[parent], has_more: false });
      }
      if (url.pathname.endsWith('/blocks')) {
        // Slower than the 200ms spacing of docx reads, so workers really do overlap.
        await sleep(300);
        return json({ items: [{ block_id: 'p', block_type: 1 }], has_more: false });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    } finally {
      inFlight--;
    }
  };

  const id = startExport('https://x.larksuite.com/wiki/root');
  let job;
  for (let i = 0; i < 200; i++) {
    job = db.prepare('SELECT * FROM exports WHERE id = ?').get(id);
    if (job.status !== 'running') break;
    await sleep(50);
  }
  assert.equal(job.status, 'done', job.error);

  const rows = db
    .prepare('SELECT node_token, parent_token, depth, position, status FROM nodes WHERE export_id = ? ORDER BY position')
    .all(id);
  assert.deepEqual(rows.map((r) => r.node_token), ['root', 'a', 'a1', 'a1x', 'a2', 'b', 'b1', 'c']);
  assert.deepEqual(rows.map((r) => r.position), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 3, 2, 1, 2, 1]);
  assert.equal(rows.find((r) => r.node_token === 'a1x').parent_token, 'a1');
  assert.ok(rows.every((r) => r.status === 'done'));
  assert.ok(peak > 1, 'requests actually overlapped');
});

test('mapConcurrent respects the limit and visits every item', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    seen.push(item);
    inFlight--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test('mapConcurrent stops starting work after a failure and rethrows it', async () => {
  const started = [];
  let running = 0;
  await assert.rejects(
    mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      running++;
      await sleep(5);
      running--;
      if (item === 1) throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(running, 0, 'nothing is still running when it rejects');
  assert.ok(started.length < 6);
});

test('a 429 pauses the whole read group for the reset the server asked for', async () => {
  let calls = 0;
  const times = [];
  globalThis.fetch = async (input) => {
    if (String(input).includes('tenant_access_token')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    times.push(Date.now());
    calls++;
    if (calls === 1) {
      return new Response('{}', { status: 429, headers: { 'x-ogw-ratelimit-reset': '1' } });
    }
    return json({ ok: true });
  };
  const client = new LarkClient({ appId: 'a', appSecret: 's', apiBase: 'https://example.test' });
  await Promise.all([client.get('/docx/v1/one'), client.get('/docx/v1/two')]);
  const after429 = times.slice(1);
  assert.ok(after429.at(-1) - times[0] >= 900, 'later requests waited out the reset');
});

test('groups are throttled separately, and writes keep their own pace', () => {
  const client = new LarkClient({ appId: 'a', appSecret: 's', apiBase: 'https://example.test' });
  const docx = client.throttleGroup('GET', '/docx/v1/documents/x/blocks');
  const bitable = client.throttleGroup('GET', '/bitable/v1/apps/x/tables');
  const write = client.throttleGroup('POST', '/docx/v1/documents/x/blocks/y/descendant');
  assert.notEqual(docx.group, bitable.group);
  assert.equal(docx.interval, 200);
  assert.equal(write.group, client.throttleGroup('POST', '/docx/v1/documents/z/blocks/z/descendant').group);
  assert.notEqual(write.group, docx.group);
  assert.notEqual(write.group, client.throttleGroup('PATCH', '/docx/v1/documents/x/blocks/y').group);
  assert.notEqual(write.group, client.throttleGroup('POST', '/wiki/v2/spaces/s/nodes').group);
  assert.equal(write.interval, 250);
});
