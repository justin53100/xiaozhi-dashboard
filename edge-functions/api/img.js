/**
 * AI 美学工坊 · 边缘函数（视觉分析 + 文生图）
 * 路由：/edge-functions/api/img.js  →  https://你的域名/api/img
 *
 * ── 两个通道 ──
 *   1. 智谱直连（推荐）：环境变量 ZHIPU_API_KEY
 *      · 看照片：glm-4v-flash（免费）
 *      · 生图：  cogview-3-flash（免费）
 *      · 可用 ZHIPU_VISION_MODEL / ZHIPU_IMAGE_MODEL 覆盖默认模型
 *   2. Makers 网关兜底：环境变量 MAKERS_VISION_MODEL / MAKERS_IMAGE_MODEL
 *      需在控制台 Models 页绑定支持视觉/生图的厂商模型
 *
 * ── 鉴权 ──
 *   与 /api/sync 同一套账号。照片分析走的是厂商接口，不能敞开。
 *
 * ── 隐私 ──
 *   照片只在本次请求中转发给模型厂商做分析，本函数不落盘、不进 Blob、
 *   不写日志。前端负责压缩到 700KB 以内（边缘函数请求体上限 1MB）。
 */

import { getStore } from '@edgeone/pages-blob';

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const GATEWAY_CHAT = 'https://ai-gateway.edgeone.link/v1/chat/completions';
const GATEWAY_IMG = 'https://ai-gateway.edgeone.link/v1/images/generations';
const MAX_FAIL = 5;
const LOCK_MS = 5 * 60 * 1000;
const MAX_IMG_B64 = 700 * 1024;   // dataURL 上限（前端压到 768px JPEG 约 100-200KB，留足余量）

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

function envOf(context) {
  return (context && context.env) || (typeof process !== 'undefined' ? process.env : {}) || {};
}

/* ── 鉴权（与 sync/ai 同款）── */
async function auth(context, body) {
  const s = store();
  const user = String(body.user || '').trim().toLowerCase();
  const pass = String(body.pass || '');
  if (user.length < 3 || user.length > 32) return { err: json({ error: '用户名需要 3-32 个字符' }, 400) };
  if (pass.length < 8) return { err: json({ error: '密码至少 8 位' }, 400) };

  const uid = await hex('u|' + user);
  const get = k => s.get(k, { type: 'json' });
  const kRate = `rate/${uid}`;
  const rate = (await get(kRate)) || { n: 0, until: 0 };
  const now = Date.now();
  if (rate.until && now < rate.until) {
    const mins = Math.ceil((rate.until - now) / 60000);
    return { err: json({ error: `密码错误次数过多，请 ${mins} 分钟后再试` }, 429) };
  }
  const a = await get(`auth/${uid}`);
  if (!a) return { err: json({ error: 'NO_ACCOUNT' }, 404) };
  const h = await hex(pass + '|' + a.salt);
  if (h !== a.hash) {
    const n = (rate.n || 0) + 1;
    await s.setJSON(kRate, { n, until: n >= MAX_FAIL ? now + LOCK_MS : 0 });
    const left = MAX_FAIL - n;
    return { err: json({ error: left > 0 ? `密码不对，还能试 ${left} 次` : '密码错误次数过多，已锁定 5 分钟' }, 401) };
  }
  if (rate.n) await s.setJSON(kRate, { n: 0, until: 0 });
  return { uid };
}

export async function onRequestPost(context) {
  const env = envOf(context);
  const s = store();

  let body = {};
  try { body = await context.request.json(); } catch {}

  /* ── 状态查询：不需要登录 ── */
  if (body.action === 'status') {
    return json({
      ok: true,
      vision: !!(env.ZHIPU_API_KEY || env.MAKERS_VISION_MODEL),
      image: !!(env.ZHIPU_API_KEY || env.MAKERS_IMAGE_MODEL),
      via: env.ZHIPU_API_KEY ? 'zhipu' : 'gateway'
    });
  }

  const a = await auth(context, body);
  if (a.err) return a.err;

  const action = String(body.action || '');

  /* ════ 看照片：视觉模型分析 ════ */
  if (action === 'vision') {
    const image = String(body.image || '');
    if (!image.startsWith('data:image/')) return json({ error: '照片格式不对' }, 400);
    if (image.length > MAX_IMG_B64) return json({ error: '照片太大了，请重试（会自动压缩）' }, 413);

    const sys = String(body.system || '').slice(0, 2000);
    const prompt = String(body.prompt || '').slice(0, 4000);
    if (!prompt) return json({ error: '没有分析指令' }, 400);

    const content = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image } }
    ];

    /* 通道 1：智谱直连 */
    if (env.ZHIPU_API_KEY) {
      const r = await fetch(ZHIPU_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.ZHIPU_API_KEY}` },
        body: JSON.stringify({
          model: env.ZHIPU_VISION_MODEL || 'glm-4v-flash',
          messages: sys ? [{ role: 'system', content: sys }, { role: 'user', content }] : [{ role: 'user', content }],
          temperature: 0.4,
          stream: false
        })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || ('视觉模型返回 ' + r.status);
        return json({ error: '分析失败：' + msg }, 502);
      }
      const text = j.choices?.[0]?.message?.content || '';
      return text ? json({ ok: true, text }) : json({ error: '模型没有返回内容' }, 502);
    }

    /* 通道 2：Makers 网关（需绑定厂商并设置 MAKERS_VISION_MODEL） */
    if (env.MAKERS_MODELS_KEY && env.MAKERS_VISION_MODEL) {
      const r = await fetch(GATEWAY_CHAT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.MAKERS_MODELS_KEY}` },
        body: JSON.stringify({
          model: env.MAKERS_VISION_MODEL,
          messages: sys ? [{ role: 'system', content: sys }, { role: 'user', content }] : [{ role: 'user', content }],
          stream: false
        })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || ('视觉模型返回 ' + r.status);
        return json({ error: '分析失败：' + msg }, 502);
      }
      const text = j.choices?.[0]?.message?.content || '';
      return text ? json({ ok: true, text }) : json({ error: '模型没有返回内容' }, 502);
    }

    return json({ error: 'VISION_NOT_CONFIGURED', hint: '云端还没有配置能看照片的模型。去 Makers 控制台 项目设置 → 环境变量 添加 ZHIPU_API_KEY（智谱免费 Key，glm-4v-flash 免费用），然后重新部署' }, 503);
  }

  /* ════ 文生图 ════ */
  if (action === 'gen') {
    const prompt = String(body.prompt || '').trim().slice(0, 1000);
    if (!prompt) return json({ error: '没有画面描述' }, 400);
    const size = String(body.size || '').trim();

    /* 通道 1：智谱直连 cogview */
    if (env.ZHIPU_API_KEY) {
      const model = env.ZHIPU_IMAGE_MODEL || 'cogview-3-flash';
      const reqBody = { model, prompt };
      if (size) reqBody.size = size;
      let r = await fetch(ZHIPU_BASE + '/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.ZHIPU_API_KEY}` },
        body: JSON.stringify(reqBody)
      });
      /* 有的模型不支持自定义尺寸：去掉 size 再试一次 */
      if (!r.ok && size) {
        r = await fetch(ZHIPU_BASE + '/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.ZHIPU_API_KEY}` },
          body: JSON.stringify({ model, prompt })
        });
      }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || ('生图模型返回 ' + r.status);
        return json({ error: '生成失败：' + msg }, 502);
      }
      const url = j.data?.[0]?.url || '';
      return url ? json({ ok: true, url, model }) : json({ error: '生图接口没有返回图片' }, 502);
    }

    /* 通道 2：Makers 网关 */
    if (env.MAKERS_MODELS_KEY && env.MAKERS_IMAGE_MODEL) {
      const reqBody = { model: env.MAKERS_IMAGE_MODEL, prompt };
      if (size) reqBody.size = size;
      const r = await fetch(GATEWAY_IMG, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${env.MAKERS_MODELS_KEY}` },
        body: JSON.stringify(reqBody)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || ('生图接口返回 ' + r.status);
        return json({ error: '生成失败：' + msg }, 502);
      }
      const url = j.data?.[0]?.url || '';
      return url ? json({ ok: true, url, model: env.MAKERS_IMAGE_MODEL }) : json({ error: '生图接口没有返回图片' }, 502);
    }

    return json({ error: 'IMAGE_NOT_CONFIGURED', hint: '云端还没有配置生图模型。去 Makers 控制台 项目设置 → 环境变量 添加 ZHIPU_API_KEY（智谱免费 Key，cogview-3-flash 免费用），然后重新部署' }, 503);
  }

  return json({ error: '未知操作' }, 400);
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
  });
}
