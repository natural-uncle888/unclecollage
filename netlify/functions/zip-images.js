import JSZip from 'jszip';

function errorJSON(msg, status=500){
  return new Response(JSON.stringify({error:msg}),{
    status, headers:{'content-type':'application/json'}
  });
}

function safeName(s){
  return String(s||'').trim().replace(/\s+/g,' ').replace(/[^\p{L}\p{N} _-]+/gu,'').replace(/[ ]+/g,'_').slice(0,80) || 'untitled';
}
function yyyymmdd(input){
  try{ const d=new Date(input); if(isNaN(d.getTime())) return ''; return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0'); }catch{ return ''; }
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }});
  if (request.method === 'OPTIONS') return json({}, 204);
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');
    if (!slug) return errorJSON('slug required',400);

    const cloud = process.env.CLD_CLOUD_NAME;
    const dataUrl = `https://res.cloudinary.com/${cloud}/raw/upload/collages/${slug}/data.json`;
    const r = await fetch(dataUrl);
    if (!r.ok) return errorJSON('not found',404);
    const data = await r.json();
    const items = Array.isArray(data.items)? data.items : [];
    if (items.length === 0) return errorJSON('no items',400);

    const title = safeName(data.title || '');
    const date  = yyyymmdd(data.date || '');
    const base  = [title, date, slug].filter(Boolean).join('-') || slug;

    const zip = new JSZip();
    zip.file('README.txt', `Title: ${data.title||''}
Date: ${data.date||''}
Slug: ${slug}
Count: ${items.length}
`);

    let idx = 1;
    for (const it of items) {
      const url = it.url;
      if (!url) continue;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buf = new Uint8Array(await resp.arrayBuffer());
      const m = url.match(/\.(jpg|jpeg|png|webp)(\?.*)?$/i);
      const ext = m ? m[1].toLowerCase() : 'jpg';
      const safeCaption = safeName(it.caption||'').slice(0,40);
      const name = `${String(idx).padStart(2,'0')}${safeCaption ? '_'+safeCaption : ''}.${ext}`;
      zip.file(name, buf);
      idx++;
    }

    const content = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });

    const asciiFallback = base.replace(/[^ -~]+/g, '_') + '.zip';
    const utf8Encoded = encodeURIComponent(base + '.zip');

    return new Response(content, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
        'cache-control': 'no-store'
      }
    });
  } catch (e) {
    return errorJSON(String(e && e.message || e),500);
  }
}
