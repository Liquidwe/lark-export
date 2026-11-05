// Minimal Lark Open API client: tenant auth, throttling, retries, pagination, upload/download.

const DEFAULT_RATE_LIMIT_PAUSE_MS = 1000;
// Reads per second, kept below the limits measured against the live API:
// docx 6, board 10, sheets about 10, bitable 20, wiki and drive not reached at 20.
const READ_RATES = [
  [/^\/docx\//, 5],
  [/^\/board\//, 8],
  [/^\/sheets\//, 8],
  [/^\/bitable\//, 15],
  [/^\/wiki\//, 15],
];
const DEFAULT_READ_RATE = 8;
// Writes per second, also below what was measured: docx create 5 and patch about 3.5 (these two
// do not share a limit), wiki create 5, uploads and board not reached at 20, bitable at least 14.
const WRITE_RATES = [
  [/^\/docx\/.*\/descendant$/, 4],
  [/^\/docx\//, 3],
  [/^\/wiki\//, 4],
  [/^\/board\//, 15],
  [/^\/bitable\//, 10],
  [/^\/drive\/v1\/(medias|files)\/upload/, 15],
];
const DEFAULT_WRITE_RATE = 4;
const MAX_RETRIES = 6;
const SINGLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
// All of these reject the request without applying it, so resending cannot duplicate anything.
// 131009 is a lock on the wiki tree, seen when nodes are created too quickly.
const RATE_LIMIT_CODES = new Set([99991400, 1254290]);
const RETRYABLE_CODES = new Set([...RATE_LIMIT_CODES, 1770064, 90217, 131009]);

export class LarkApiError extends Error {
  constructor(message, { code, status, scopes, logId } = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.status = status;
    this.scopes = scopes || [];
    this.logId = logId;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parses a wiki URL into its host, token and the matching API base.
export function parseWikiUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error('链接格式不正确');
  }
  const match = url.pathname.match(/^\/wiki\/([A-Za-z0-9]+)/);
  if (!match || match[1] === 'settings') {
    throw new Error('目前仅支持知识库链接，形如 https://xxx.larksuite.com/wiki/<token>');
  }
  const isFeishu = /(^|\.)feishu\.cn$/.test(url.hostname);
  const isLark = /(^|\.)larksuite\.com$/.test(url.hostname);
  if (!isFeishu && !isLark) throw new Error('链接不是 Lark 或飞书域名');
  return {
    host: url.origin,
    token: match[1],
    apiBase: isFeishu ? 'https://open.feishu.cn/open-apis' : 'https://open.larksuite.com/open-apis',
  };
}

export class LarkClient {
  constructor({ appId, appSecret, apiBase }) {
    if (!appId || !appSecret) throw new Error('缺少机器人的 App ID 或 App Secret 环境变量');
    this.appId = appId;
    this.appSecret = appSecret;
    this.apiBase = apiBase;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
    this.pendingToken = null;
    this.nextSlots = new Map();
  }

  async token() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken;
    // Concurrent callers share one refresh.
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  async fetchToken() {
    const res = await fetch(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const json = await res.json();
    if (json.code !== 0) throw new LarkApiError(`机器人鉴权失败: ${json.msg}`, { code: json.code });
    this.cachedToken = json.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (json.expire - 120) * 1000;
    return this.cachedToken;
  }

  // Requests are spaced per group, because each API family has its own limit.
  throttleGroup(method, path) {
    const [kind, rates, fallback] = method === 'GET' ? ['read', READ_RATES, DEFAULT_READ_RATE] : ['write', WRITE_RATES, DEFAULT_WRITE_RATE];
    const match = rates.find(([pattern]) => pattern.test(path));
    return { group: `${kind}:${match ? match[0].source : 'other'}`, interval: 1000 / (match ? match[1] : fallback) };
  }

  async throttle(method, path) {
    const { group, interval } = this.throttleGroup(method, path);
    const now = Date.now();
    const slot = Math.max(now, this.nextSlots.get(group) ?? 0);
    this.nextSlots.set(group, slot + interval);
    if (slot > now) await sleep(slot - now);
  }

  // Holds back the whole group, so concurrent workers stop together rather than each hitting the limit.
  pauseGroup(method, path, res) {
    const { group } = this.throttleGroup(method, path);
    const seconds = Number(res.headers.get('x-ogw-ratelimit-reset'));
    const pause = seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_PAUSE_MS;
    this.nextSlots.set(group, Math.max(this.nextSlots.get(group) ?? 0, Date.now() + pause));
  }

  buildUrl(path, query) {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    return url;
  }

  // Sends a request with retries. makeBody is a function so multipart bodies can be rebuilt.
  async send(method, path, { query, makeBody, json } = {}) {
    // A 5xx or dropped connection may follow a write that did apply, so a POST is only
    // resent when a duplicate is impossible. Uploads are safe: a repeat just orphans a file.
    const canResend = method !== 'POST' || Boolean(makeBody) || Boolean(query?.client_token);
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt) await sleep(Math.min(500 * 2 ** attempt, 15000));
      await this.throttle(method, path);
      const headers = { Authorization: `Bearer ${await this.token()}` };
      if (json !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      let res;
      try {
        res = await fetch(this.buildUrl(path, query), {
          method,
          headers,
          body: json !== undefined ? JSON.stringify(json) : makeBody?.(),
        });
      } catch (err) {
        if (!canResend) throw err;
        lastError = err;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new LarkApiError(`HTTP ${res.status}: ${path}`, { status: res.status });
        await res.body?.cancel();
        if (res.status === 429) this.pauseGroup(method, path, res);
        else if (!canResend) throw lastError;
        continue;
      }
      return res;
    }
    throw lastError;
  }

  async request(method, path, { query, body, makeBody } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(method, path, { query, json: body, makeBody });
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LarkApiError(`接口返回非 JSON (HTTP ${res.status}): ${path}`, { status: res.status });
      }
      if (payload.code === 0) return payload.data ?? {};
      // 131001 is a generic failure that may have applied, so only its rate-limit form is resent.
      const rateLimited = RATE_LIMIT_CODES.has(payload.code) || (payload.code === 131001 && /rate limit/i.test(payload.msg));
      if ((rateLimited || RETRYABLE_CODES.has(payload.code)) && attempt < MAX_RETRIES) {
        if (rateLimited) this.pauseGroup(method, path, res);
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
        continue;
      }
      throw toApiError(payload, res.status, path);
    }
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  post(path, body, query) {
    return this.request('POST', path, { body: body ?? {}, query });
  }

  patch(path, body, query) {
    return this.request('PATCH', path, { body, query });
  }

  delete(path, query) {
    return this.request('DELETE', path, { query });
  }

  async all(path, query = {}, itemsKey = 'items') {
    const items = [];
    let pageToken;
    do {
      const data = await this.get(path, { ...query, page_token: pageToken });
      items.push(...(data[itemsKey] || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async download(path, query) {
    const res = await this.send('GET', path, { query });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await res.json();
      throw toApiError(payload, res.status, path);
    }
    if (!res.ok) throw new LarkApiError(`下载失败 HTTP ${res.status}: ${path}`, { status: res.status });
    const disposition = res.headers.get('content-disposition') || '';
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType,
      fileName: parseFileName(disposition),
    };
  }

  // Uploads via medias (or files) API, switching to chunked mode above the single-request limit.
  async upload({ api = 'medias', buffer, fileName, parentType, parentNode, extra }) {
    if (buffer.length <= SINGLE_UPLOAD_LIMIT) {
      const data = await this.request('POST', `/drive/v1/${api}/upload_all`, {
        makeBody: () => {
          const form = new FormData();
          form.set('file_name', fileName);
          form.set('parent_type', parentType);
          if (parentNode !== undefined) form.set('parent_node', parentNode);
          form.set('size', String(buffer.length));
          if (extra) form.set('extra', extra);
          form.set('file', new Blob([buffer]), fileName);
          return form;
        },
      });
      return data.file_token;
    }
    const prepared = await this.post(`/drive/v1/${api}/upload_prepare`, {
      file_name: fileName,
      parent_type: parentType,
      parent_node: parentNode,
      size: buffer.length,
      extra,
    });
    for (let seq = 0; seq < prepared.block_num; seq++) {
      const chunk = buffer.subarray(seq * prepared.block_size, (seq + 1) * prepared.block_size);
      await this.request('POST', `/drive/v1/${api}/upload_part`, {
        makeBody: () => {
          const form = new FormData();
          form.set('upload_id', prepared.upload_id);
          form.set('seq', String(seq));
          form.set('size', String(chunk.length));
          form.set('file', new Blob([chunk]), fileName);
          return form;
        },
      });
    }
    const finished = await this.post(`/drive/v1/${api}/upload_finish`, {
      upload_id: prepared.upload_id,
      block_num: prepared.block_num,
    });
    return finished.file_token;
  }
}

function toApiError(payload, status, path) {
  const violations = payload.error?.permission_violations || [];
  const scopes = violations.map((v) => v.subject);
  const fields = (payload.error?.field_violations || []).map((v) => `${v.field}: ${v.description}`).join('; ');
  let message = `${payload.msg || '接口错误'}${fields ? ` [${fields}]` : ''} (code=${payload.code}, ${path})`;
  if (scopes.length) message = `机器人缺少权限，需要以下任一权限: ${scopes.join(', ')} (${path})`;
  return new LarkApiError(message, {
    code: payload.code,
    status,
    scopes,
    logId: payload.error?.log_id,
  });
}

function parseFileName(disposition) {
  const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

// Converts a 1-based column index to spreadsheet letters (1 -> A, 27 -> AA).
export function columnName(index) {
  let name = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function pollDelay(attempt) {
  return sleep(Math.min(1000 + attempt * 500, 5000));
}

// Runs fn over items with at most `limit` in flight. After a failure it starts nothing new,
// waits for what is running, then rethrows, so no work continues behind the caller's back.
// shouldStop is checked before each item, and stopping that way is not an error.
export async function mapConcurrent(items, limit, fn, { shouldStop = () => false } = {}) {
  let next = 0;
  let failed = false;
  let firstError;
  const worker = async () => {
    while (!failed && next < items.length && !shouldStop()) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        if (!failed) firstError = err;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
}

// Runs tasks with at most `limit` in flight. Unlike mapConcurrent, tasks can be added as others finish.
export function limiter(limit) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export function concurrencyFromEnv(name, fallback, max) {
  const value = Number.parseInt(process.env[name], 10);
  return value >= 1 ? Math.min(value, max) : fallback;
}

const clients = new Map();

// Source and target bots may differ: a cross-org migration needs one app in each tenant.
// Lark's limits are per app, so every job using the same app shares one client and its throttle.
export function clientFor(role, apiBase) {
  const useTarget = role === 'target' && process.env.LARK_TARGET_APP_ID;
  const appId = useTarget ? process.env.LARK_TARGET_APP_ID : process.env.LARK_APP_ID;
  const key = `${appId}|${apiBase}`;
  if (!clients.has(key)) {
    const appSecret = useTarget ? process.env.LARK_TARGET_APP_SECRET : process.env.LARK_APP_SECRET;
    clients.set(key, new LarkClient({ appId, appSecret, apiBase }));
  }
  return clients.get(key);
}
