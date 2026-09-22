// ===== 快速部署（免登录）=====
// 文件经本 Worker 代理上传至白云网盘（pan.ezv.cc），
// 文件本体不进入 GooseHost 的 Supabase Storage。
// 生成的公开访问地址固定为 page.goose.cc.cd/f/<随机ID>，不由用户自选。
//
// 白云网盘接口约定（实测）：
//   - 统一信封 { code, data, msg }，业务字段全部在 data 下，无顶层平铺
//   - 鉴权 Authorization: Bearer <API_KEY>（兼容 ?api_key= 旧参数）
//   - 判错依据：code !== 200，HTTP 200 也可能包着业务失败
//   - POST /api/pan/uploads         创建会话 -> { data: { id, chunkBytes, partCount, partConcurrency } }
//   - PUT  /api/pan/uploads/:id/parts/:index  提交分片（index 从 0 开始，实测 partConcurrency=1 即串行）
//   - POST /api/pan/uploads/:id/complete      完成（幂等，重复调用返回同一 fileId）
//         -> { data: { fileId, name, size, md5, sha256, securityStatus, ... } }
//   - 完成瞬间 securityStatus 为 "pending"，审核通过后变为 "normal"（不是 "approved"）
//   - GET  /api/pan/files/:id       元数据 -> { data: { fileId, byteSize, securityStatus, ... } }
//   - GET  /api/pan/files/:id/download  下载，完整支持 Range（206 Partial Content），必须带 API Key
//   - 注意：上传/完成用 size，元数据接口此处为 byteSize，两处字段名不同，不要混用

import { jsonResp } from '../utils/response.js';

const PAN_BASE = 'https://pan.ezv.cc';
const UPLOAD_PREFIX = 'f';
const ID_LEN = 10;

// 2MB 上限是有意的：本入口不登录、不限用户身份，
// 一旦放行大文件就变成公开的匿名带宽与存储通道。
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 255;
const ALLOWED_EXT = /^(html?|md|markdown|txt|css|js|json|xml|svg)$/i;

// 文件类型白名单即内容安全边界：只允许能安全内联的静态资源，
// 不接受 zip / exe / 二进制，避免本入口被当作任意文件托管。
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml; charset=utf-8',
};

function randId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  const buf = new Uint8Array(ID_LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < ID_LEN; i++) out += chars[buf[i] % chars.length];
  return out;
}

// 取网盘凭证：env 中仅 PAN_API_KEY 由 CI 推送，其余两个是兼容旧手配的兜底。
function panKey(env) {
  const k = (env && (env.PAN_API_KEY || env.PAN_APIKEY || env.EZV_API_KEY || '')) || '';
  if (!k) throw Object.assign(new Error('后端未配置 PAN_API_KEY'), { status: 500 });
  return k;
}

// 统一解包网盘的 { code, data, msg } 信封。
// code !== 200 一律视为失败并抛出，调用方按 HTTP 透传，避免 200 外壳掩盖业务错误。
async function panJson(resp, op) {
  const text = await resp.text();
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!resp.ok || (j && typeof j === 'object' && 'code' in j && j.code !== 200)) {
    const msg = (j && (j.msg || j.message)) || resp.statusText || 'unknown';
    throw Object.assign(new Error(`${op}失败：${msg}`), { status: resp.status || 502, detail: text.slice(0, 300) });
  }
  return j;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1);
}

// GET /api/quick/info —— 前端判断是否开放本入口
export async function handleQuickInfo(request, env, corsHeaders) {
  return jsonResp({
    enabled: !!(env && (env.PAN_API_KEY || env.PAN_APIKEY || env.EZV_API_KEY)),
    prefix: UPLOAD_PREFIX,
    maxBytes: MAX_BYTES,
    allowedExt: ALLOWED_EXT.toString().slice(1, -3),
  }, 200, corsHeaders);
}

// POST /api/quick/deploy —— 单文件快速部署
// 表单字段：file（File / Blob）
//
// 注意：本入口免登录，不做速率限制。防刷能力改为由文件白名单（类型、
// 扩展名、大小上限 2MB）与随机访问路径承担——前者堵住任意文件托管，
// 后者让刷量无法指定目标路径。若日后需要恢复限流，取消下面的注释即可。
export async function handleQuickDeploy(request, env, corsHeaders) {
  let key;
  try { key = panKey(env); } catch (e) { return jsonResp({ error: '快速部署暂不可用，请联系管理员' }, 503, corsHeaders); }

  if (request.method !== 'POST') return jsonResp({ error: '仅支持 POST' }, 405, corsHeaders);

  let form;
  try { form = await request.formData(); } catch { form = null; }
  if (!form) return jsonResp({ error: '请求格式错误，请使用 multipart/form-data 上传文件' }, 400, corsHeaders);

  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) {
    return jsonResp({ error: '请选择要部署的文件' }, 400, corsHeaders);
  }
  if (file.size > MAX_BYTES) {
    return jsonResp({ error: `文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 限制` }, 413, corsHeaders);
  }
  // 0 字节文件在分片上传里会产生空切片，直接拒绝更省一次网盘往返。
  if (file.size === 0) return jsonResp({ error: '文件为空' }, 400, corsHeaders);

  let name = String(file.name || 'index.html').slice(0, MAX_NAME) || 'index.html';
  name = name.split(/[/\\]/).pop(); // 只保留文件名，丢弃路径，防止 path traversal
  const ext = extOf(name);
  if (!ALLOWED_EXT.test(ext)) {
    return jsonResp({ error: `不支持的文件类型 .${ext}（仅支持 html/htm/md/txt/css/js/json/xml/svg）` }, 400, corsHeaders);
  }

  // 随机生成访问路径，用户不可自选；碰撞则换新 id，最多重试 3 次。
  let id = randId();
  let filename = `${id}.${ext}`;

  const auth = { Authorization: `Bearer ${key}` };

  // 1) 创建上传会话，会话 id 由网盘生成（实测 8MB 切片、partConcurrency=1 即串行）。
  //    文件名仅用于网盘侧展示，真正的公开路径是后端随机 id，与文件名无关。
  const initResp = await fetch(`${PAN_BASE}/api/pan/uploads`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: filename, size: file.size }),
  });

  let session;
  try {
    session = await panJson(initResp, '创建上传会话');
  } catch (e) {
    if (initResp.status === 409) {
      // 文件名冲突理论上不会发生（id 是随机的），发生时换新 id 重试一次。
      id = randId();
      filename = `${id}.${ext}`;
      const r2 = await fetch(`${PAN_BASE}/api/pan/uploads`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: filename, size: file.size }),
      });
      try { session = await panJson(r2, '创建上传会话（重试）'); }
      catch (e2) { return jsonResp({ error: e2.message }, 502, corsHeaders); }
    } else {
      return jsonResp({ error: e.message, detail: e.detail }, 502, corsHeaders);
    }
  }

  // 信封解包：所有接口统一是 { code, data, msg }。
  const sessionData = session.data || session;
  const fileId = sessionData.id || sessionData.uploadId;
  if (!fileId) return jsonResp({ error: '网盘未返回上传会话 ID', detail: JSON.stringify(session).slice(0, 300) }, 502, corsHeaders);

  const chunkBytes = Number(sessionData.chunkBytes) || Number(sessionData.chunkSize) || 8 * 1024 * 1024;
  const arrayBuffer = await file.arrayBuffer();

  // 2) 分片提交。partConcurrency 实测为 1，串行即可；为保险仍按服务端返回的 partCount 控制上限。
  const partCount = Number(sessionData.partCount) || Math.ceil(arrayBuffer.byteLength / chunkBytes);
  let offset = 0, partIndex = 0;
  while (offset < arrayBuffer.byteLength) {
    if (partCount && partIndex >= partCount) break;
    const end = Math.min(offset + chunkBytes, arrayBuffer.byteLength);
    const slice = arrayBuffer.slice(offset, end);
    const partResp = await fetch(
      `${PAN_BASE}/api/pan/uploads/${encodeURIComponent(fileId)}/parts/${partIndex}`,
      { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: slice }
    );
    if (!partResp.ok) {
      const t = await partResp.text().catch(() => '');
      return jsonResp({ error: `分片 ${partIndex} 上传失败`, detail: t.slice(0, 300) }, 502, corsHeaders);
    }
    offset = end;
    partIndex++;
  }

  // 3) 完成。该接口幂等（重复调用返回同一 fileId），这里不重试：
  //    若 5xx 网络抖动，前端提示用户重试即可，重试会复用同一网盘对象，不会重复占空间。
  const doneResp = await fetch(`${PAN_BASE}/api/pan/uploads/${encodeURIComponent(fileId)}/complete`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
  });
  let done;
  try { done = await panJson(doneResp, '上传完成确认'); }
  catch (e) { return jsonResp({ error: '上传完成确认失败', detail: e.detail || e.message }, 502, corsHeaders); }

  // complete 信封为 { code, data, msg }，业务字段全部在 data 下：
  //   data.fileId        网盘文件 id（幂等，重复 complete 返回同一值）
  //   data.size     -> 注意：元数据接口此处为 byteSize，只有 complete 用 size
  //   data.securityStatus  pending -> normal（不是 "approved"）
  const record = (done && done.data) ? done.data : done;
  const panFileId = String(record.fileId || fileId);
  const securityStatus = record.securityStatus || 'pending';

  const publicUrl = `https://page.goose.cc.cd/${UPLOAD_PREFIX}/${id}`;

  // 落库失败不阻断返回：链接本身仍可用，只是后台看不到这条记录、也无法联动删除。
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { makeSupabase } = await import('../utils/supabase.js');
      const supabase = makeSupabase(env);
      await supabase.from('gh_quick').insert({
        public_id: id,
        ext,
        filename: name,
        pan_file_id: panFileId,
        size: file.size,
        security_status: securityStatus,
        ip_address: getClientIP(request),
        created_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.error('gh_quick insert error', error.message); });
    } catch (e) { console.error('gh_quick insert exception', e.message); }
  }

  return jsonResp({
    success: true,
    url: publicUrl,
    id,
    filename: name,
    size: file.size,
    // 立即返回 pending 状态，前端据此告知用户"审核中，约 30 秒后可访问"，
    // 而不是显示"部署成功"造成可访问的假象。
    status: securityStatus,
  }, 200, corsHeaders);
}

// POST /api/quick/delete —— 仅管理员：按 public_id 删除网盘文件
export async function handleQuickDelete(request, env, corsHeaders, id) {
  if (!id) return jsonResp({ error: '缺少 public_id' }, 400, corsHeaders);
  let key;
  try { key = panKey(env); } catch (e) { return jsonResp({ error: '后端未配置 PAN_API_KEY' }, 503, corsHeaders); }

  const { makeSupabase } = await import('../utils/supabase.js');
  const supabase = makeSupabase(env);
  const { data: row } = await supabase.from('gh_quick').select('pan_file_id').eq('public_id', id).maybeSingle();
  if (!row || !row.pan_file_id) return jsonResp({ error: '记录不存在' }, 404, corsHeaders);

  const resp = await fetch(`${PAN_BASE}/api/pan/files/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [String(row.pan_file_id)] }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return jsonResp({ error: '删除失败', detail: t.slice(0, 300) }, 502, corsHeaders);
  }
  await supabase.from('gh_quick').delete().eq('public_id', id);
  return jsonResp({ success: true }, 200, corsHeaders);
}
