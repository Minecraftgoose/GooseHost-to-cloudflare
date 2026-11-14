// ===== 访问控制：封锁规则判定（热路径）=====
//
// 事实来源：public.gh_block_rules（Postgres），后台写规则时把整包编译成快照
// 写到 Workers KV 的 gh:block:rules:current。本模块每个请求只读一次 KV binding，
// 不做跨请求内存缓存（上一轮已证实 isolate 内 Map 会跨实例不一致）。
//
// KV 最终一致：规则变更后最多约 60 秒全网可见（用户已确认可接受）。
// 这是「低频写的配置」，不是强一致业务数据，所以不需要 invalidate 动作。
//
// 安全要点：
//   · 客户端 IP 只认 CF-Connecting-IP，绝不回退 X-Forwarded-For（可伪造）
//   · 公开站点访问 /s/ /p/ /md/ 默认不拦（误伤正常读者代价更大）
//   · 规则管理接口自身不拦，避免管理员把自己锁在后台外
//   · BLOCK_SAFE_IPS 里的 IP / CIDR 永远放行

export const BLOCK_SNAPSHOT_KEY = 'gh:block:rules:current';

const EMPTY = Object.freeze({ version: 0, generatedAt: null, rules: [] });
const memo = new WeakMap();   // per-request：同一次请求内多次判定只读一次 KV

/** 读快照。KV 故障一律返回空快照 + 结构化日志，绝不静默当成「无规则」却不留痕 */
export async function loadBlockSnapshot(env, request) {
  if (request && memo.has(request)) return memo.get(request);
  const p = (async () => {
    const kv = env?.RATE_LIMIT_KV;
    if (!kv || typeof kv.get !== 'function') {
      console.warn('[block] RATE_LIMIT_KV 未绑定，封锁规则暂不生效');
      return EMPTY;
    }
    try {
      const raw = await kv.get(BLOCK_SNAPSHOT_KEY, 'json');
      if (!raw || !Array.isArray(raw.rules)) return EMPTY;
      return raw;
    } catch (err) {
      // fail-open 但留痕：旧版 rate-limit.js 的 catch(_) {} 就是这么把限流弄没的
      console.error('[block] 快照读取失败（本次放行）:', err?.message || err);
      return EMPTY;
    }
  })();
  if (request) memo.set(request, p);
  return p;
}

/** 供后台管理接口调用：绕过 per-request memo，强制拿最新值 */
export async function peekBlockSnapshot(env) {
  const kv = env?.RATE_LIMIT_KV;
  if (!kv || typeof kv.get !== 'function') return EMPTY;
  try {
    const raw = await kv.get(BLOCK_SNAPSHOT_KEY, 'json');
    return raw && Array.isArray(raw.rules) ? raw : EMPTY;
  } catch { return EMPTY; }
}

// ---------------------------------------------------------------------
// IP 解析：IPv4 / IPv6 → BigInt；支持 :: 压缩与 IPv4-mapped IPv6
// ---------------------------------------------------------------------
function parseIpv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return { bits: 32, num: n };
}

function parseIpv6(s) {
  // 去掉可能的 zone id 与端口括号
  let str = String(s).replace(/^\[|\]$/g, '').split('%')[0];
  // IPv4-mapped：::ffff:1.2.3.4 → 按 IPv4 处理
  const mapped = str.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return parseIpv4(mapped[1]);

  if (!str.includes(':')) return null;
  const dc = str.indexOf('::');
  if (dc >= 0 && str.indexOf('::', dc + 2) >= 0) return null;

  // 一侧的 ":" 分隔段；末段可能内嵌 IPv4，展开成 2 个 16 位组
  const expand = (side) => {
    if (!side) return [];
    const out = [];
    for (const g of side.split(':')) {
      if (g.includes('.')) {
        const v4 = parseIpv4(g);
        if (!v4) return null;
        out.push(Number((v4.num >> 16n) & 0xffffn), Number(v4.num & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  const left = expand(dc >= 0 ? str.slice(0, dc) : str);
  const right = dc >= 0 ? expand(str.slice(dc + 2)) : [];
  if (!left || !right) return null;

  const fill = 8 - left.length - right.length;
  let groups;
  if (dc >= 0) {
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill(0), ...right];
  } else {
    if (fill !== 0) return null;
    groups = left;
  }
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return { bits: 128, num: n };
}

export function parseIp(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  return t.includes(':') ? parseIpv6(t) : parseIpv4(t);
}

/** 解析 "1.2.3.0/24" / "2001:db8::/32"；无斜杠视为单 IP（全掩码） */
export function parseCidr(value) {
  const t = String(value || '').trim();
  const slash = t.indexOf('/');
  const addr = slash >= 0 ? t.slice(0, slash) : t;
  const ip = parseIp(addr);
  if (!ip) return null;
  let prefix = ip.bits;
  if (slash >= 0) {
    const p = Number(t.slice(slash + 1));
    if (!Number.isInteger(p) || p < 0 || p > ip.bits) return null;
    prefix = p;
  }
  const shift = BigInt(ip.bits - prefix);
  return { bits: ip.bits, prefix, net: shift === 0n ? ip.num : ip.num >> shift };
}

/** 预编译快照，避免每个请求重复解析几百条规则 */
export function compileSnapshot(snap) {
  const out = { version: snap?.version || 0, ips: new Map(), cidrs: [], domains: new Map() };
  for (const r of (snap?.rules || [])) {
    if (r.mode !== 'block' && r.mode !== 'observe') continue;
    if (r.expiresAt && Number(r.expiresAt) <= Date.now()) continue;
    if (r.kind === 'email_domain') {
      out.domains.set(String(r.value).toLowerCase(), r);
    } else if (r.kind === 'ip') {
      const ip = parseIp(r.value);
      if (ip) out.ips.set(`${ip.bits}:${ip.num}`, r);
    } else if (r.kind === 'cidr') {
      const c = parseCidr(r.value);
      if (c) out.cidrs.push({ ...c, rule: r });
    }
  }
  return out;
}

export function matchIp(ip, compiled) {
  const parsed = parseIp(ip);
  if (!parsed || !compiled) return null;
  const exact = compiled.ips.get(`${parsed.bits}:${parsed.num}`);
  if (exact) return exact;
  for (const c of compiled.cidrs) {
    if (c.bits !== parsed.bits) continue;
    const shift = BigInt(parsed.bits - c.prefix);
    const net = shift === 0n ? parsed.num : parsed.num >> shift;
    if (net === c.net) return c.rule;
  }
  return null;
}

/** 域名精确 + 子域匹配：rules 里存 evil.com，a.evil.com 也命中 */
export function matchEmail(email, compiled) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0 || !compiled) return null;
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  if (!domain) return null;
  const exact = compiled.domains.get(domain);
  if (exact) return exact;
  let dot = domain.indexOf('.');
  while (dot >= 0) {
    const parent = domain.slice(dot + 1);
    const hit = compiled.domains.get(parent);
    if (hit) return hit;
    dot = domain.indexOf('.', dot + 1);
  }
  return null;
}

export function getClientIp(request) {
  // 只认 Cloudflare 注入的头。X-Forwarded-For 客户端可自行伪造，
  // 用它判断封锁等于给攻击者留了绕过开关。
  return String(request.headers.get('CF-Connecting-IP') || '').trim();
}

export function isPublicSitePath(pathParts) {
  return pathParts[0] === 's' || pathParts[0] === 'p' || pathParts[0] === 'md';
}

export function isSelfManagePath(pathname) {
  return pathname === '/api/admin/block-rules' ||
    pathname.startsWith('/api/admin/block-rules/');
}

/** 安全 IP 白名单：env.BLOCK_SAFE_IPS，逗号分隔的 IP 或 CIDR */
function inSafeList(ip, env) {
  const raw = String(env?.BLOCK_SAFE_IPS || '').trim();
  if (!raw) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const item of raw.split(',')) {
    const c = parseCidr(item);
    if (!c || c.bits !== parsed.bits) continue;
    const shift = BigInt(parsed.bits - c.prefix);
    const net = shift === 0n ? parsed.num : parsed.num >> shift;
    if (net === c.net) return true;
  }
  return false;
}

/**
 * 统一拦截层入口。
 * @returns {Promise<{mode:string, rule:object, kind:string, ip:string}|null>}
 *          null = 放行；mode='observe' 表示只记日志不拦。
 */
export async function evaluateBlock(request, env, pathname, pathParts) {
  if (isPublicSitePath(pathParts)) return null;          // 公开站点访问不拦
  if (isSelfManagePath(pathname)) return null;            // 避免管理员把自己锁外面
  const ip = getClientIp(request);
  if (!ip) return null;
  if (inSafeList(ip, env)) return null;

  const snap = await loadBlockSnapshot(env, request);
  if (!snap.rules || !snap.rules.length) return null;
  const compiled = compileSnapshot(snap);
  const rule = matchIp(ip, compiled);
  if (!rule) return null;
  return { mode: rule.mode, rule, kind: 'ip', ip };
}

/**
 * 注册入口用：邮箱后缀判定。只拦新注册，已有账号的封禁走 Supabase ban_duration。
 * @returns {Promise<{mode:string, rule:object}|null>}
 */
export async function evaluateEmail(request, env, email) {
  const snap = await loadBlockSnapshot(env, request);
  if (!snap.rules || !snap.rules.length) return null;
  const compiled = compileSnapshot(snap);
  const rule = matchEmail(email, compiled);
  if (!rule) return null;
  return { mode: rule.mode, rule };
}

/** 归一化规则输入，管理接口与自测共用 */
export function normalizeRule(input) {
  const kind = String(input?.kind || '').trim();
  const raw = String(input?.value || '').trim();
  if (!['ip', 'cidr', 'email_domain'].includes(kind)) {
    return { error: '规则类型无效（ip / cidr / email_domain）' };
  }
  if (!raw || raw.length > 255) return { error: '规则值不能为空且不超过 255 字符' };

  let value = raw;
  if (kind === 'email_domain') {
    value = raw.toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (!/^[a-z0-9]([a-z0-9.\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9.\-]*[a-z0-9])?)+$/.test(value)) {
      return { error: '邮箱域名格式不正确' };
    }
  } else if (kind === 'ip') {
    if (!parseIp(raw)) return { error: 'IP 地址格式不正确（支持 IPv4 / IPv6）' };
    value = raw.toLowerCase();
  } else {
    if (!parseCidr(raw)) return { error: 'CIDR 格式不正确（如 1.2.3.0/24 或 2001:db8::/32）' };
    value = raw.toLowerCase();
  }

  const mode = input?.mode === 'block' ? 'block' : 'observe';
  let expiresAt = null;
  if (input?.expiresAt != null && input.expiresAt !== '') {
    const t = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(t)) return { error: '过期时间格式不正确' };
    if (t > Date.now()) expiresAt = new Date(t).toISOString();
  }
  return {
    kind, value, mode,
    note: String(input?.note || '').slice(0, 200),
    expiresAt,
    enabled: input?.enabled !== false,
  };
}

/**
 * 安全白名单自保：不允许把 BLOCK_SAFE_IPS 里的地址写进封锁表，
 * 也不允许新增一个会覆盖白名单 IP 的网段。纯函数，供管理接口与自测共用。
 */
export function hitsSafeList(value, kind, env) {
  const raw = String(env?.BLOCK_SAFE_IPS || '').trim();
  if (!raw || kind === 'email_domain') return false;
  const items = raw.split(',').map(x => x.trim()).filter(Boolean);

  if (kind === 'ip') {
    const ip = parseIp(value);
    if (!ip) return false;
    for (const item of items) {
      const safe = parseCidr(item);
      if (!safe || safe.bits !== ip.bits) continue;
      const shift = BigInt(ip.bits - safe.prefix);
      if ((shift === 0n ? ip.num : ip.num >> shift) === safe.net) return true;
    }
    return false;
  }

  // 待加的是 CIDR：任一白名单 IP 落在里面就拒绝。
  // parseCidr(...).net 已右移过，所以这里从白名单项重新 parseIp 取完整地址。
  const target = parseCidr(value);
  if (!target) return false;
  const shift = BigInt(target.bits - target.prefix);
  for (const item of items) {
    const safeIp = parseIp(item.split('/')[0].trim());
    if (!safeIp || safeIp.bits !== target.bits) continue;
    const net = shift === 0n ? safeIp.num : safeIp.num >> shift;
    if (net === target.net) return true;
  }
  return false;
}
