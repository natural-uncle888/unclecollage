// /.netlify/functions/list-posts.js
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

// ---- Cloudinary 設定 ----
cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// ---- CORS + 回傳工具 ----
const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
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
  try { console.error('[list-posts] error:', err); } catch {}
  return sendJSON({ error: msg }, status);
}

// ---- JWT 驗證，跟 update-visible.js 同一套 HS256 ----
function decodeB64Json(str) {
  const pad = str.length % 4 === 2 ? '==' :
              str.length % 4 === 3 ? '='  : '';
  const s = str.replace(/-/g,'+').replace(/_/g,'/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function verifyJWT(token, secret) {
  try {
    const [h,p,s] = token.split('.');
    if (!h || !p || !s) return null;

    const header = decodeB64Json(h);
    if (header.alg !== 'HS256') return null;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g,'')
      .replace(/\+/g,'-')
      .replace(/\//g,'_');

    if (expected !== s) return null;

    const payload = decodeB64Json(p);
    // exp 是秒
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

// ---- 主 handler ----
export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const cloud = process.env.CLD_CLOUD_NAME;
    if (!cloud || !process.env.CLD_API_KEY || !process.env.CLD_API_SECRET) {
      return errorJSON('Missing Cloudinary env vars', 500);
    }

    // 讀取 query 參數 showHidden=1 嗎？
    const url = new URL(request.url);
    const wantShowHidden = url.searchParams.get('showHidden') === '1';

    // 如果有要求 showHidden=1，就檢查是不是管理員
    let allowShowHidden = false;
    if (wantShowHidden) {
      const adminPayload = requireAdmin(request);
      if (!adminPayload) {
        return sendJSON({ error: 'Unauthorized' }, 401);
      }
      allowShowHidden = true; // 有管理員 token，OK 顯示全部
    }

    // ----------------------------
    // STEP 1: 把 collages/ 底下所有 raw 檔列出來（分頁抓完）
    // ----------------------------
    const rawResources = [];
    let nextCursor;

    do {
      const res = await cloudinary.api.resources({
        resource_type: 'raw',
        type: 'upload',
        prefix: 'collages/',
        max_results: 100,
        next_cursor: nextCursor,
      });

      rawResources.push(...(res.resources || []));
      nextCursor = res.next_cursor || undefined;
    } while (nextCursor);

    // ----------------------------
    // STEP 2: 找出每個 slug 目前應該用哪一個 data 檔
    // - 同 slug 可能有 data.json / data
    // - 我們偏好沒副檔名的 public_id (collages/<slug>/data)
    // - 如果有多個版本，拿 version 最大的
    // 結果放到 bySlug: slug -> { slug, public_id, version }
    // ----------------------------
    const bySlug = new Map();

    for (const r of rawResources) {
      const pid = r.public_id || '';   // e.g. "collages/case-927128/data"
      const ver = r.version;           // Cloudinary version number
      const m = /^collages\/([^/]+)\/data(?:\.json)?$/i.exec(pid);
      if (!m) continue;
      const slug = m[1];

      const current = bySlug.get(slug);
      if (!current) {
        bySlug.set(slug, { slug, public_id: pid, version: ver });
      } else {
        const currentHasJson = /\.json$/i.test(current.public_id);
        const incomingHasJson = /\.json$/i.test(pid);
        let replace = false;

        // 規則 1: 如果現在的是 .json 但新的是沒 .json，換成沒 .json
        if (currentHasJson && !incomingHasJson) {
          replace = true;
        // 規則 2: 否則比 version，version 較新就取代
        } else if (ver > current.version) {
          replace = true;
        }

        if (replace) {
          bySlug.set(slug, { slug, public_id: pid, version: ver });
        }
      }
    }

    // ----------------------------
    // STEP 3: 平行抓每個 slug 的 data.json（用 versioned URL，避開舊快取）
    // ----------------------------
    const targets = Array.from(bySlug.values()); // [{slug, public_id, version}, ...]

    const results = await Promise.all(
      targets.map(async ({ slug, public_id, version }) => {
        try {
          const hasExt = /\.json$/i.test(public_id);
          // 版本化 URL：v${version}，確保拿到最新 visible
          const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/v${version}/${encodeURIComponent(
            public_id + (hasExt ? '' : '.json')
          )}`;

          const resp = await fetch(dataUrl);
          if (!resp.ok) return null;

          const data = await resp.json().catch(() => null);
          if (!data) return null;

          // 決定縮圖：preview -> cover -> items[0].url
          const previewUrl =
            data.preview ||
            data.cover ||
            (Array.isArray(data.items) && data.items[0]?.url) ||
            null;

          const item = {
            slug,
            title: data.title || data.titile || slug,
            date: data.date || data.created_at,
            created_at: data.created_at,
            tags: data.tags || [],
            items: Array.isArray(data.items) ? data.items : [],
            visible: data.visible !== false, // 沒寫就當 true
            preview: previewUrl,
          };

          return item;
        } catch {
          return null;
        }
      })
    );

    // ----------------------------
    // STEP 4: 過濾掉抓失敗的，排序，然後依照 visible 決定要不要顯示
    // ----------------------------
    let items = results
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.date || b.created_at || 0) -
          new Date(a.date || a.created_at || 0)
      );

    // 如果不是管理員模式(showHidden=1 並且通過驗證)，就只回傳公開的
    if (!allowShowHidden) {
      items = items.filter(it => it.visible !== false);
    }

    // ----------------------------
    // STEP 5: 回傳給前端
    // ----------------------------
    return sendJSON({ items });
  } catch (e) {
    return errorJSON(e, 500);
  }
};
