// /.netlify/functions/delete-post.js
import { v2 as cloudinary } from 'cloudinary';
import jwt from 'jsonwebtoken';

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
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// 驗證管理員 JWT
function requireAdmin(request) {
  const authHeader = request.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const decoded = jwt.verify(m[1], process.env.ADMIN_JWT_SECRET);
    if (decoded && decoded.role === 'admin') return decoded;
  } catch (_) {}
  return null;
}

export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  // 檢查權限
  const admin = requireAdmin(request);
  if (!admin) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  // parse body
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return sendJSON({ error: 'Invalid JSON body' }, 400);
  }

  const slug = body?.slug?.trim();
  if (!slug) {
    return sendJSON({ error: 'slug required' }, 400);
  }

  try {
    const folderPrefix = `collages/${slug}/`;

    // 1. 刪掉這個 slug 底下的「圖片 (resource_type:image)」
    // 2. 刪掉這個 slug 底下的「raw 檔案 (data.json)」
    // 我們用 delete_resources_by_prefix 會全清該 prefix 底下所有 public_id
    await cloudinary.api.delete_resources_by_prefix(folderPrefix, {
      resource_type: 'image',
      type: 'upload',
    });

    await cloudinary.api.delete_resources_by_prefix(folderPrefix, {
      resource_type: 'raw',
      type: 'upload',
    });

    // 3. 嘗試刪掉資料夾本身
    //   Cloudinary 的管理 API 支援 delete_folder 來清理空資料夾
    await cloudinary.api.delete_folder(folderPrefix);

    return sendJSON({ ok: true, slug });
  } catch (err) {
    return sendJSON(
      {
        error:
          (err && (err.message || err.error?.message)) ||
          String(err) ||
          'Unknown error',
      },
      500
    );
  }
};
