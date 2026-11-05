// Who is using the tool: admin sessions, member sessions, and the Lark accounts members authorized.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { appConfig, clientFor, LarkClient } from './lark.js';

const ADMIN_SESSION_MS = 12 * 3600 * 1000;
const MEMBER_SESSION_MS = 7 * 24 * 3600 * 1000;
const OAUTH_STATE_MS = 10 * 60 * 1000;
const MAX_ADMIN_FAILURES = 5;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
// Refresh this long before expiry, so a token cannot lapse between the check and the request.
const TOKEN_MARGIN_MS = 2 * 60 * 1000;

// offline_access is what makes Lark issue a refresh token. A migration can outlast one access token.
export const OAUTH_SCOPES = {
  source: 'offline_access wiki:wiki:readonly docx:document:readonly drive:drive:readonly sheets:spreadsheet:readonly bitable:app:readonly drive:export:readonly board:whiteboard:node:read',
  target: 'offline_access wiki:wiki docx:document drive:drive sheets:spreadsheet bitable:app board:whiteboard:node:create',
};

const sha256 = (value) => createHash('sha256').update(value).digest();
const hashToken = (token) => sha256(token).toString('hex');

export const publicUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4310}`).replace(/\/$/, '');
export const redirectUri = () => `${publicUrl()}/api/auth/lark/callback`;
export const adminEnabled = () => Boolean(process.env.ADMIN_PASSWORD);
// Without its own bot the "new organization" would be the member's current one.
export const memberTargetEnabled = () => Boolean(process.env.LARK_TARGET_APP_ID && process.env.LARK_TARGET_APP_SECRET);

// ---- sessions

export function createSession(role, userId = null) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + (role === 'admin' ? ADMIN_SESSION_MS : MEMBER_SESSION_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, role, user_id, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), role, userId, expiresAt);
  return { token, expiresAt };
}

export function readSession(token) {
  if (!token) return null;
  const session = db.prepare('SELECT role, user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now());
  return session ? { role: session.role, userId: session.user_id } : null;
}

export function endSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

// ---- admin password

const adminFailures = new Map();

// Throws when the password is wrong or the address has failed too often.
export function checkAdminPassword(password, address) {
  if (!adminEnabled()) throw new Error('管理员登录未开启，请先在 .env 中设置 ADMIN_PASSWORD');
  const record = adminFailures.get(address);
  if (record?.lockedUntil > Date.now()) throw new Error('密码错误次数过多，请 15 分钟后再试');
  const matches = timingSafeEqual(sha256(String(password ?? '')), sha256(process.env.ADMIN_PASSWORD));
  if (matches) {
    adminFailures.delete(address);
    return;
  }
  const failures = (record?.lockedUntil ? 0 : record?.failures ?? 0) + 1;
  adminFailures.set(address, failures >= MAX_ADMIN_FAILURES ? { failures, lockedUntil: Date.now() + ADMIN_LOCK_MS } : { failures });
  throw new Error('密码不正确');
}

// ---- OAuth

const oauthStates = new Map();

export function beginOAuth(side, userId = null) {
  const now = Date.now();
  for (const [key, value] of oauthStates) if (value.expiresAt < now) oauthStates.delete(key);
  const state = randomBytes(24).toString('base64url');
  oauthStates.set(state, { side, userId, expiresAt: now + OAUTH_STATE_MS });
  const { appId, accountsBase } = appConfig(side);
  const url = new URL(`${accountsBase}/open-apis/authen/v1/authorize`);
  url.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: OAUTH_SCOPES[side],
    state,
  });
  return { url: url.href, state };
}

// A state works once, so a captured callback link cannot be replayed.
export function takeOAuthState(state) {
  const value = oauthStates.get(state);
  oauthStates.delete(state);
  return value && value.expiresAt > Date.now() ? value : null;
}

async function requestToken(side, grant) {
  const { appId, appSecret, apiBase } = appConfig(side);
  const res = await fetch(`${apiBase}/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ client_id: appId, client_secret: appSecret, ...grant }),
  });
  const json = await res.json();
  if (Number(json.code) !== 0 || !json.access_token) {
    throw new Error(`Lark 授权失败: ${json.error_description || json.error || json.msg || json.code}`);
  }
  return json;
}

// Completes a login: swaps the code for tokens and finds out whose they are.
export async function finishOAuth(side, code) {
  const tokens = await requestToken(side, { grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const { apiBase } = appConfig(side);
  const res = await fetch(`${apiBase}/authen/v1/user_info`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const info = await res.json();
  if (info.code !== 0) throw new Error(`读取 Lark 账号信息失败: ${info.msg}`);
  return { tokens, profile: info.data };
}

export function upsertMember(profile) {
  db.prepare(
    `INSERT INTO users (open_id, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT (open_id) DO UPDATE SET name = excluded.name`,
  ).run(profile.open_id, profile.name ?? '', Date.now());
  return db.prepare('SELECT id FROM users WHERE open_id = ?').get(profile.open_id).id;
}

// ---- stored tokens. They can write as the member, so a copy of the database alone must not expose them.

const tokenKey = (side) => sha256(`lark-export tokens:${appConfig(side).appSecret}`);

function seal(side, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(side), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function unseal(side, sealed) {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(side), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

const expiryOf = (seconds) => (seconds ? Date.now() + seconds * 1000 : null);

export function saveAccount(userId, side, profile, tokens) {
  db.prepare(
    `INSERT OR REPLACE INTO lark_accounts
       (user_id, side, open_id, name, access_token, refresh_token, access_expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    side,
    profile.open_id,
    profile.name ?? '',
    seal(side, tokens.access_token),
    tokens.refresh_token ? seal(side, tokens.refresh_token) : null,
    expiryOf(tokens.expires_in),
    expiryOf(tokens.refresh_token_expires_in),
  );
  userClients.delete(`${userId}|${side}`);
}

export function accountOf(userId, side) {
  const row = db.prepare('SELECT name, open_id FROM lark_accounts WHERE user_id = ? AND side = ?').get(userId, side);
  return row ? { name: row.name, openId: row.open_id } : null;
}

export function removeAccount(userId, side) {
  db.prepare('DELETE FROM lark_accounts WHERE user_id = ? AND side = ?').run(userId, side);
  userClients.delete(`${userId}|${side}`);
}

const refreshes = new Map();

async function accessToken(userId, side) {
  const row = db.prepare('SELECT * FROM lark_accounts WHERE user_id = ? AND side = ?').get(userId, side);
  if (!row) throw new Error(side === 'source' ? '还没有授权读取文档库，请重新登录' : '还没有授权新组织，请先授权');
  if (row.access_expires_at > Date.now() + TOKEN_MARGIN_MS) return unseal(side, row.access_token);

  // A refresh token works once, so concurrent workers must share a single refresh.
  const key = `${userId}|${side}`;
  if (!refreshes.has(key)) {
    refreshes.set(key, refreshAccount(row, side).finally(() => refreshes.delete(key)));
  }
  return refreshes.get(key);
}

async function refreshAccount(row, side) {
  if (!row.refresh_token) throw new Error('Lark 授权已过期，请重新授权');
  let tokens;
  try {
    tokens = await requestToken(side, { grant_type: 'refresh_token', refresh_token: unseal(side, row.refresh_token) });
  } catch (err) {
    throw new Error(`Lark 授权已失效，请重新授权 (${err.message})`);
  }
  db.prepare(
    `UPDATE lark_accounts SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?
     WHERE user_id = ? AND side = ?`,
  ).run(
    seal(side, tokens.access_token),
    tokens.refresh_token ? seal(side, tokens.refresh_token) : row.refresh_token,
    expiryOf(tokens.expires_in),
    expiryOf(tokens.refresh_token_expires_in) ?? row.refresh_expires_at,
    row.user_id,
    side,
  );
  return tokens.access_token;
}

// ---- API clients

const userClients = new Map();

// Acts as the member, while sharing its app's throttle: Lark's limits apply to the app, not the person.
function userClient(userId, side) {
  const key = `${userId}|${side}`;
  if (!userClients.has(key)) {
    const { apiBase } = appConfig(side);
    const client = new LarkClient({
      apiBase,
      tokenProvider: () => accessToken(userId, side),
      nextSlots: clientFor(side, apiBase).nextSlots,
    });
    client.openId = accountOf(userId, side)?.openId;
    userClients.set(key, client);
  }
  return userClients.get(key);
}

// A member's job runs as that member. The admin's jobs run as the bot, on the link's own domain.
export const clientForJob = (side, { owner_id: ownerId, api_base: apiBase }) =>
  (ownerId === null || ownerId === undefined ? clientFor(side, apiBase) : userClient(ownerId, side));
