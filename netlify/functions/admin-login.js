// /.netlify/functions/admin-login.js
import jwt from 'jsonwebtoken';

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

export default async (request) => {
  // CORS 預檢
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  // 讀 body.password
  let body = null;
  try {
    body = await request.json();
  } catch (_) {}

  const password = body?.password || '';

  // 比對環境變數
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return sendJSON({ error: 'Unauthorized' }, 401);
  }

  // 簽一顆 JWT，12 小時過期
  const token = jwt.sign(
    { role: 'admin' },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: '12h' } // 例如 12 小時有效
  );

  return sendJSON({ token });
};
