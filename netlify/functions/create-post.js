// /.netlify/functions/create-post.js
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

// Cloudinary 後端認證
cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// ---- CORS ----
const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function errorJSON(err, status = 500) {
  const msg =
    (err && (err.message || err.error?.message)) ||
    String(err) ||
    'Unknown error';
  try {
    console.error('[create-post] error:', err);
  } catch {}
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: CORS_HEADERS,
  });
}

// ---- JWT 驗證 (HS256) - 和 list-posts.js 同一套 ----
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlJson(str) {
  const pad =
    str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = b64urlJson(h);
    if (header.alg !== 'HS256') return null;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    if (expected !== s) return null;

    const payload = b64urlJson(p);
    // 過期檢查 (exp 是秒)
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;

    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(request) {
  const authHeader = request.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const secret = process.env.ADMIN_JWT_SECRET || '';
  if (!secret) return null;

  const payload = verifyJWT(m[1], secret);
  if (!payload) return null;
  if (payload.role !== 'admin') return null;

  return payload;
}

// ---- Handler ----
export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();

  if (request.method !== 'POST') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  // 確認你是管理員
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  // 解析 body
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return sendJSON({ error: 'Invalid JSON body' }, 400);
  }

  const { title, date, desc, tags, slug, items, visible } = body || {};

  // 基本驗證
  if (!slug || !String(slug).trim()) {
    return sendJSON({ error: 'slug required' }, 400);
  }
  if (!Array.isArray(items) || items.length === 0) {
    return sendJSON({ error: 'items required' }, 400);
  }

  // 第一張圖當預覽縮圖
  const previewUrl = items[0]?.url || null;

  // 我們要儲存的資料格式
  const record = {
    slug,
    title,
    date,
    desc: desc || '',
    tags,
    items, // [{ url, caption }, ...]
    created_at: new Date().toISOString(),
    preview: previewUrl,
    visible: typeof visible === 'boolean' ? visible : true, // 預設上架，除非前端指定隱藏
  };

  try {
    // 上傳成 raw JSON 到 Cloudinary
    const jsonBase64 = Buffer.from(JSON.stringify(record)).toString(
      'base64'
    );

    await cloudinary.uploader.upload(
      `data:application/json;base64,${jsonBase64}`,
      {
        resource_type: 'raw',
        public_id: `collages/${slug}/data`,
        overwrite: true,
        format: 'json',
      }
    );

    return sendJSON({ ok: true, slug }, 200);
  } catch (err) {
    return errorJSON(err, 500);
  }
};
