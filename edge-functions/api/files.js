/**
 * 课件存储 · EdgeOne Makers 边缘函数
 * 路由：/edge-functions/api/files.js  →  https://你的域名/api/files
 *
 * ── 为什么要分块 ──
 *   边缘函数的请求体上限是 1MB，一个 8MB 的 PDF 直接传必然失败。
 *   所以前端把文件切成 600KB 一块，一块一次请求，
 *   云端按 files/<uid>/<fileId>/<序号> 逐块落进 Blob。
 *   下载时按序号逐块取回、本地拼装，用户感知不到分块的存在。
 *
 * ── 元数据 ──
 *   files/<uid> 存一份 JSON 清单（文件名、大小、块数、时间）。
 *   前端列表以云端清单为准，设备之间天然一致，不走 /api/sync。
 *
 * ── 限制 ──
 *   单文件 ≤ 20MB（约 34 块）；总数 ≤ 50 个，防止免费额度被意外刷爆。
 */

import { getStore } from '@edgeone/pages-blob';

const MAX_FAIL = 5;
const LOCK_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_B64 = 1024 * 1024;      // 单块 base64 上限（对应 600KB 原始数据绰绰有余）

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function store() {
  return getStore({ name: 'dashboard', consistency: 'strong' });
}

async function hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function delKey(s, k) {
  try { if (s.delete) { await s.delete(k); return; } } catch {}
  try { await s.setJSON(k, { del: true }); } catch {}
}

export async function onRequestPost(context) {
  const { request } = context;
  const s = store();

  let body;
  try { body = await request.json(); }
  catch { return json({ error: '请求格式不对' }, 400); }

  const user = String(body.user || '').trim().toLowerCase();
  const pass = String(body.pass || '');
  const action = String(body.action || 'list');

  if (user.length < 3 || user.length > 32) return json({ error: '用户名需要 3-32 个字符' }, 400);
  if (pass.length < 8) return json({ error: '密码至少 8 位' }, 400);

  const uid = await hex('u|' + user);
  const kAuth = `auth/${uid}`;
  const kRate = `rate/${uid}`;
  const kMeta = `files/${uid}`;

  const get = k => s.get(k, { type: 'json' });

  /* ── 鉴权：与 /api/sync 同一套账号 ── */
  const rate = (await get(kRate)) || { n: 0, until: 0 };
  const now = Date.now();
  if (rate.until && now < rate.until) {
    const mins = Math.ceil((rate.until - now) / 60000);
    return json({ error: `密码错误次数过多，请 ${mins} 分钟后再试` }, 429);
  }
  const auth = await get(kAuth);
  if (!auth) return json({ error: 'NO_ACCOUNT' }, 404);
  const h = await hex(pass + '|' + auth.salt);
  if (h !== auth.hash) {
    const n = (rate.n || 0) + 1;
    await s.setJSON(kRate, { n, until: n >= MAX_FAIL ? now + LOCK_MS : 0 });
    const left = MAX_FAIL - n;
    return json({ error: left > 0 ? `密码不对，还能试 ${left} 次` : '密码错误次数过多，已锁定 5 分钟' }, 401);
  }
  if (rate.n) await s.setJSON(kRate, { n: 0, until: 0 });

  const meta = (await get(kMeta)) || { files: [] };

  /* ── 列表 ── */
  if (action === 'list') {
    return json({ ok: true, files: meta.files });
  }

  /* ── 登记新文件 ── */
  if (action === 'init') {
    const name = String(body.name || '未命名').slice(0, 120);
    const size = Number(body.size) || 0;
    const chunks = Number(body.chunks) || 0;
    const mime = String(body.mime || 'application/octet-stream').slice(0, 100);
    if (size <= 0 || size > MAX_FILE_BYTES) return json({ error: '文件大小须在 20MB 以内' }, 400);
    if (!chunks || chunks < 1 || chunks > 100) return json({ error: '分块数不对' }, 400);
    if (meta.files.length >= MAX_FILES) return json({ error: `课件最多存 ${MAX_FILES} 个，先删一些再传` }, 400);
    if (meta.files.some(f => f.name === name)) return json({ error: '已有一个同名课件，先删掉或改个名' }, 400);

    const id = 'f' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    meta.files.push({ id, name, size, chunks, mime, createdAt: now });
    await s.setJSON(kMeta, meta);
    return json({ ok: true, id });
  }

  /* ── 传一块 ── */
  if (action === 'put') {
    const id = String(body.fileId || '');
    const idx = Number(body.idx);
    const data = String(body.data || '');
    const f = meta.files.find(x => x.id === id);
    if (!f) return json({ error: '文件未登记' }, 404);
    if (!Number.isInteger(idx) || idx < 0 || idx >= f.chunks) return json({ error: '块序号不对' }, 400);
    if (!data || data.length > MAX_B64) return json({ error: '块数据太大' }, 413);
    await s.setJSON(`files/${uid}/${id}/${idx}`, { d: data });
    return json({ ok: true, idx });
  }

  /* ── 取一块 ── */
  if (action === 'chunk') {
    const id = String(body.fileId || '');
    const idx = Number(body.idx);
    const f = meta.files.find(x => x.id === id);
    if (!f) return json({ error: '文件不存在' }, 404);
    const c = await get(`files/${uid}/${id}/${idx}`);
    if (!c || !c.d) return json({ error: 'CHUNK_MISSING' }, 404);
    return json({ ok: true, idx, data: c.d });
  }

  /* ── 删除 ── */
  if (action === 'del') {
    const id = String(body.fileId || '');
    const f = meta.files.find(x => x.id === id);
    if (!f) return json({ error: '文件不存在' }, 404);
    for (let i = 0; i < f.chunks; i++) {
      await delKey(s, `files/${uid}/${id}/${i}`);
    }
    meta.files = meta.files.filter(x => x.id !== id);
    await s.setJSON(kMeta, meta);
    return json({ ok: true });
  }

  return json({ error: '未知操作' }, 400);
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
  });
}
