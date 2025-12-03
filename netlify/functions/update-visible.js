// /.netlify/functions/update-visible.js
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';

cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

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
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// --- 輕量版 HS256 JWT 驗證（跟我們現在的 functions 一致）---
function decodeB64Json(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  const s = str.replace(/-/g,'+').replace(/_/g,'/') + pad;
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}

function verifyJWT(token, secret) {
  try {
    const [h,p,s] = token.split('.');
    if(!h||!p||!s) return null;

    const header = decodeB64Json(h);
    if(header.alg !== 'HS256') return null;

    const expected = crypto.createHmac('sha256', secret)
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=/g,'')
      .replace(/\+/g,'-')
      .replace(/\//g,'_');

    if(expected !== s) return null;

    const payload = decodeB64Json(p);
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

export default async (request) => {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  // 權限檢查
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  // 解析 body
  let body;
  try {
    body = await request.json();
  } catch {
    return sendJSON({ error: 'Invalid JSON body' }, 400);
  }

  const slug = body?.slug?.trim();
  // 注意：visible 可以是 false，所以不能用簡單 truthy
  const newVisible = body?.visible === false ? false : true;

  if (!slug) {
    return sendJSON({ error: 'slug required' }, 400);
  }

  try {
    // 1. 找這個 slug 對應的 data 檔在 Cloudinary 裡是哪一個 public_id
    //    我們偏好 public_id 沒 ".json" 的版本；如果同 slug 有兩個，就拿 version 最大的。
    const res = await cloudinary.api.resources({
      resource_type:'raw',
      type:'upload',
      prefix:`collages/${slug}/`,
      max_results:10,
    });

    let chosen = null;
    for (const r of res.resources || []) {
      const pid = r.public_id || '';
      const m = /^collages\/[^/]+\/data(?:\.json)?$/i.exec(pid);
      if (!m) continue;

      if (!chosen) {
        chosen = { public_id: pid, version: r.version };
      } else {
        // 同樣的選擇策略：prefer 沒 .json，或 version 較新
        const curHasJson = /\.json$/i.test(chosen.public_id);
        const newHasJson = /\.json$/i.test(pid);
        let replace = false;
        if (curHasJson && !newHasJson) {
          replace = true;
        } else if (r.version > chosen.version) {
          replace = true;
        }
        if (replace) {
          chosen = { public_id: pid, version: r.version };
        }
      }
    }

    if (!chosen) {
      return sendJSON({ error: 'data.json not found for slug ' + slug }, 404);
    }

    // 2. 下載目前 data.json（用 versioned URL，保證拿到正確的最新內容）
    const hasExt = /\.json$/i.test(chosen.public_id);
    const cloud = process.env.CLD_CLOUD_NAME;
    const getUrl = `https://res.cloudinary.com/${cloud}/raw/upload/v${chosen.version}/${encodeURIComponent(
      chosen.public_id + (hasExt ? '' : '.json')
    )}`;

    const resp = await fetch(getUrl);
    if (!resp.ok) {
      return sendJSON({ error: 'cannot fetch current data.json' }, 500);
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      return sendJSON({ error: 'bad data.json format' }, 500);
    }

    // 3. 改 visible
    data.visible = newVisible;

    // 4. 覆蓋上傳回同一個 slug 的 canonical public_id
    //
    // 我們「移除 .json」再上傳，固定 public_id 為 collages/<slug>/data
    // 這樣之後會有一個穩定版本，Cloudinary 也會 bump 版本號，list-posts.js 用 versioned URL 就會抓到最新 visible。
    const canonicalPid = chosen.public_id.replace(/\.json$/i, '');
    const jsonBase64 = Buffer.from(JSON.stringify(data)).toString('base64');

    await cloudinary.uploader.upload(
      `data:application/json;base64,${jsonBase64}`,
      {
        resource_type:'raw',
        public_id: canonicalPid, // e.g. "collages/case-927128/data"
        overwrite:true,
        format:'json',
      }
    );

    // 回傳成功
    return sendJSON({ ok: true, slug, visible: newVisible });
  } catch (err) {
    const msg =
      (err && (err.message || err.error?.message)) ||
      String(err) ||
      'Unknown error';
    return sendJSON({ error: msg }, 500);
  }
};
