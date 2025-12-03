// /.netlify/functions/get-post.js
import { v2 as cloudinary } from 'cloudinary';

// Cloudinary 後端認證
cloudinary.config({
  cloud_name: process.env.CLD_CLOUD_NAME,
  api_key: process.env.CLD_API_KEY,
  api_secret: process.env.CLD_API_SECRET,
});

// CORS header
const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
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

  if (request.method !== 'GET') {
    return sendJSON({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');

    if (!slug) {
      return sendJSON({ error: 'slug required' }, 400);
    }

    const cloud = process.env.CLD_CLOUD_NAME;
    const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${encodeURIComponent(
      slug
    )}/data.json`;

    const resp = await fetch(dataUrl);
    if (!resp.ok) {
      return sendJSON({ error: 'not found' }, 404);
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      return sendJSON({ error: 'bad data.json' }, 500);
    }

    // 直接把 data.json 裡的內容回傳
    return sendJSON(data, 200);
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
