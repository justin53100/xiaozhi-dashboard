/**
 * AI 代理 · EdgeOne Makers 边缘函数
 * 路由：/edge-functions/api/ai.js  →  https://你的域名/api/ai
 *
 * ── 为什么要有这一层 ──
 *   浏览器不直接调模型网关，原因有二：
 *   1. Key 只能放服务端环境变量（MAKERS_MODELS_KEY），写进前端等于公开
 *   2. 顺便做账号鉴权——AI 额度是大家的，不能让拿到链接的陌生人白嫖
 *
 * ── 鉴权 ──
 *   与 /api/sync 完全同一套账号体系（auth/<uid> 的 salt+hash），
 *   前端 Sync 模块里存的用户名密码直接复用，用户不用再记第二套。
 *
 * ── 模型 ──
 *   默认 @makers/deepseek-v4-flash（内置、走平台赠送额度）。
 *   想换模型：项目 设置 → 环境变量 加 MAKERS_MODEL=<模型ID>，重新部署。
 *
 * ── 注意 ──
 *   非流式返回（实现简单、兼容性最好）。回答较短的场景完全够用；
 *   长回答会多等几秒，属于正常。
 */

import { getStore } from '@edgeone/pages-blob';

const GATEWAY = 'https://ai-gateway.edgeone.link/v1/chat/completions';
const MAX_FAIL = 5;
const LOCK_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 20;          // 一次最多带最近 20 条对话，防刷额度
const MAX_CHARS = 6000;           // 单条内容最长 6000 字

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

/* ── 环境变量读法兼容两层：Workers 风格 env 与全局 process.env ── */
function envOf(context) {
  return (context && context.env) || (typeof process !== 'undefined' ? process.env : {}) || {};
}

export async function onRequestPost(context) {
  const env = envOf(context);
  const key = env.MAKERS_MODELS_KEY || '';
  const model = env.MAKERS_MODEL || '@makers/deepseek-v4-flash';
  const s = store();

  /* ── status 不需要登录：只报告 AI 是否配置好 ── */
  let body = {};
  try { body = await context.request.json(); } catch {}

  if (body.action === 'status') {
    return json({ ok: true, configured: !!key, model });
  }

  const user = String(body.user || '').trim().toLowerCase();
  const pass = String(body.pass || '');

  if (user.length < 3 || user.length > 32) return json({ error: '用户名需要 3-32 个字符' }, 400);
  if (pass.length < 8) return json({ error: '密码至少 8 位' }, 400);

  const uid = await hex('u|' + user);
  const kAuth = `auth/${uid}`;
  const kRate = `rate/${uid}`;

  const get = k => s.get(k, { type: 'json' });
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

  /* ── 没配 Key：明确报错，别让用户对着空转的按钮猜 ── */
  if (!key) {
    return json({ error: 'AI_NOT_CONFIGURED', hint: '云端还没有配置模型密钥，请到 Makers 控制台 Models 页创建 API Key 并写入环境变量 MAKERS_MODELS_KEY，然后重新部署' }, 503);
  }

  /* ── 组装消息：system 定角色，历史截断到最近 MAX_MESSAGES 条 ── */
  let msgs = Array.isArray(body.messages) ? body.messages : [];
  msgs = msgs
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  if (!msgs.length) return json({ error: '没有可发送的内容' }, 400);

  const sys = String(body.system || '').slice(0, 2000);
  const payload = {
    model,
    messages: sys ? [{ role: 'system', content: sys }, ...msgs] : msgs,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream: false
  };

  let resp;
  try {
    resp = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json({ error: '连不上模型网关，请稍后再试' }, 502);
  }

  const j = await resp.json().catch(() => null);
  if (!resp.ok || !j) {
    const msg = (j && j.error && (j.error.message || j.error)) || ('模型返回 ' + resp.status);
    return json({ error: '模型调用失败：' + msg }, 502);
  }

  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) return json({ error: '模型没有返回内容' }, 502);

  return json({ ok: true, text, model });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
  });
}
