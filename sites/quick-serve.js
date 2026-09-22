// ===== /f/:id 快速部署文件访问 =====
// 文件本体在白云网盘，本 Worker 仅做鉴权与 Range 代理转发。
// 用户不可自选路径：id 由后端随机生成（见 sites/quick.js）。
//
// 关键约束（实测确认）：
//   - 所有接口统一信封 { code, data, msg }，业务字段全部在 data 下，无顶层平铺。
//     解析时必须先取 j.data；判错用 code !== 200，不能只看 HTTP 状态码。
//   - 网盘下载必须带 API Key，不支持匿名直链。因此不存在"一次性解析出 URL 缓存复用"的空间，
//     每个访问请求都由 Worker 代为鉴权拉流，流式透传以避免大文件在 Worker 内存中落地。
//   - 下载接口完整支持 Range（206 Partial Content, Accept-Ranges: bytes），
//     必须原样透传 Range 请求头与 Content-Range / Content-Length 响应头，
//     否则前端的大文件续传、音视频拖拽播放全部失效。
//   - 文件完成上传后 securityStatus 为 "pending"，审核通过后才变 "normal"。
//     未完成审核时下载接口仍返回 200，但内容不是源文件（占位/审核页），
//     故必须额外查一次元数据，pending 时返回 403 并明确原因。

import { jsonResp } from '../utils/response.js';

const PAN_BASE = 'https://pan.ezv.cc';

// 建议的缓存窗口。内容不会改变（上传后不可变），可大胆缓存；
// 审核中的 403 则完全不缓存，避免命中旧状态。
const CACHE_OK = 'public, max-age=86400, immutable';
const CACHE_REVALIDATE = 'public, max-age=60';

function textResp(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

export async function handleServeQuick(request, env, id) {
  if (!id || id.includes('/') || id.includes('.')) {
    return textResp(404, 'Not Found');
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, If-Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });

  const key = (env && (env.PAN_API_KEY || env.PAN_APIKEY || env.EZV_API_KEY || '')) || '';
  if (!key) return textResp(503, '快速部署服务未配置', cors);

  const auth = { Authorization: `Bearer ${key}` };

  // 1) 用 public_id 反查网盘端 file id 与真实扩展名。建表即 O(1)；未建表则退化为列表遍历。
  //    realExt 与 storeExt 分离：网盘上存为 <id>.<ext>.txt（绕过扩展名白名单），
  //    但对外必须按真实扩展名给 MIME，否则浏览器会把 HTML 当成纯文本下载。
  const resolved = await resolvePanFileId(env, id);
  if (!resolved) return textResp(404, 'Not Found', cors);
  const { fileId, realExt } = resolved;

  // 2) 审核状态预检。所有业务字段都在 data 下，不存在顶层平铺，故只取 j.data。
  //    实测：pending 期间下载接口仍会返回 200，但内容不是源文件（占位/审核页），
  //    所以必须先查一次元数据，pending 时提前拒掉，不能把内容透传给用户。
  //    代价是多一次往返，换来状态语义准确；若元数据接口本身失败，则降级放行，
  //    把判断交给上游真实响应，不做粗暴阻断。
  const statusResp = await fetch(`${PAN_BASE}/api/pan/files/${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: auth,
  });
  if (statusResp.ok) {
    try {
      const j = await statusResp.json();
      const data = j && j.data;
      // 仅认定 "normal" 为可访问；其余一律视为审核中（pending / checking / 其他未知值）。
      // 不做 toLowerCase：该字段是固定枚举值，且避免 "NORMAL" 之类误判为放行。
      if (!data || data.securityStatus !== 'normal') {
        return textResp(403, '文件正在安全审核中，稍后重试', {
          ...cors,
          'Cache-Control': 'no-store',
          'Retry-After': '30',
          'X-Security-Status': data && data.securityStatus ? String(data.securityStatus) : 'pending',
        });
      }
    } catch (_) { /* 元数据解析失败不阻断下载 */ }
  }

  // 3) 拉取文件流，Range 完整透传。
  const upstreamHeaders = { ...auth };
  const range = request.headers.get('range');
  if (range) upstreamHeaders['Range'] = range;
  const ifRange = request.headers.get('if-range');
  if (ifRange) upstreamHeaders['If-Range'] = ifRange;

  const upstream = await fetch(`${PAN_BASE}/api/pan/files/${encodeURIComponent(fileId)}/download`, {
    method: request.method === 'HEAD' ? 'GET' : request.method,
    headers: upstreamHeaders,
    redirect: 'follow',
  });

  // 401 说明本 Worker 的 Key 失效或权限被收回，报 503 而不是伪造内容。
  if (upstream.status === 401) return textResp(503, '上游鉴权失效', cors);
  if (!upstream.ok && upstream.status !== 206) {
    const t = await upstream.text().catch(() => '');
    return textResp(upstream.status, '上游拉取失败', { ...cors, 'X-Upstream-Detail': t.slice(0, 200) });
  }

  // MIME 还原：网盘按 .txt 返回 Content-Type: text/plain，
  // 但对外必须声明真实扩展名对应的类型，否则浏览器把 HTML 当纯文本下载。
  // 落盘扩展绝不可作为推断依据——.html.txt 的真实类型仍是 text/html。
  // 未知扩展统一兜底为 text/plain，不做兜底成 html 的假设。
  const MIME = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
  };
  const isHtml = realExt === 'html' || realExt === 'htm';

  const respHeaders = new Headers();
  // 必须透传的四项：Range 客户端（视频、下载器、断点续传）完全依赖这些头。
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
    const v = upstream.headers.get(name);
    if (v) respHeaders.set(name, v);
  }
  // Content-Type 不走透传：上游按落盘扩展名给的 text/plain 对我们无效。
  respHeaders.set('content-type', MIME[realExt] || 'text/plain; charset=utf-8');
  // 响应侧允许浏览器读取 Range 相关头，否则前端代码拿不到这些信息。
  respHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, ETag');
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('X-Content-Type-Options', 'nosniff');
  if (!respHeaders.has('cache-control')) respHeaders.set('cache-control', CACHE_REVALIDATE);
  else if (String(upstream.status) === '206') {
    // 分片响应沿用上游缓存策略，但把可变部分补强。上游若返回 no-store，尊重它。
    respHeaders.set('cache-control', upstream.headers.get('cache-control') || CACHE_REVALIDATE);
  }
  // HTML 页面绝不走浏览器缓存：HTML 是部署产物，内容随时可能更新，
  // 而用户又可能在同一会话内重新部署覆盖同一 id。max-age=0 + must-revalidate
  // 让浏览器每次回源校验，代价是每次访问多一次 ETag 校验请求，换来内容新鲜。
  if (isHtml) {
    respHeaders.set('cache-control', 'no-cache, no-store, must-revalidate');
    respHeaders.set('pragma', 'no-cache');
    respHeaders.set('expires', '0');
  }

  // HEAD 与 206 都不能有 body；流式返回 upstream.body，避免大文件进 Worker 内存。
  if (request.method === 'HEAD' || upstream.status === 206) {
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  }
  return new Response(upstream.body, { status: 200, headers: respHeaders });
}

// 反查网盘 file id 与真实扩展名。优先走本地映射表，命中即 O(1) 且不依赖网盘列表接口。
// 返回 { fileId, realExt }；映射表不可用时返回 { fileId, realExt: null }，由调用方兜底为 text/plain。
async function resolvePanFileId(env, publicId) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { makeSupabase } = await import('../utils/supabase.js');
      const supabase = makeSupabase(env);
      const { data } = await supabase.from('gh_quick').select('pan_file_id,ext').eq('public_id', publicId).maybeSingle();
      if (data && data.pan_file_id) return { fileId: String(data.pan_file_id), realExt: data.ext || null };
    } catch (e) { console.error('resolvePanFileId db error', e.message); }
  }

  // 兜底：遍历网盘文件列表（慢、受分页限制，仅在映射表缺失时使用）。
  // 落盘命名约定为 <publicId>.<ext>.txt，故取全部点之前的部分作 stem 匹配。
  try {
    const key = (env && (env.PAN_API_KEY || env.PAN_APIKEY || env.EZV_API_KEY || '')) || '';
    const listResp = await fetch(`${PAN_BASE}/api/pan/files?pageSize=100`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (listResp.ok) {
      const j = await listResp.json();
      const rows = j.data?.rows || j.data?.files || j.data?.items || j.data?.list || j.rows || j.files || j.items || [];
      for (const r of rows) {
        if (!r.name) continue;
        const stem = r.name.endsWith('.') ? r.name.slice(0, -1) : r.name.split('.').slice(0, -1).join('.');
        if (stem === publicId) return { fileId: String(r.id || r.fileId), realExt: null };
      }
    }
  } catch (e) { console.error('resolvePanFileId list error', e.message); }
  return null;
}
