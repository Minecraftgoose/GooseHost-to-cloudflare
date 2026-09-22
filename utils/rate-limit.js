// ===== 速率限制 =====
//
// 设计要点：
// 1. 固定窗口计数，按 action 分桶。桶 key 为 rl:<action>:<windowStart>:<dim>，
//    windowStart 由当前秒向下取整得到，窗口内计数超过 limit 即拒绝。
// 2. 维度默认为客户端 IP，部分场景（找回密码按邮箱）可传 keyExtra 覆盖。
// 3. KV 故障时一律放行——限流组件本身不能成为全站单点。
// 4. create 类接口超额后进入 lockout：锁定期间所有请求直接 429；锁定
//    过期时会顺手把计数桶清掉，否则会出现"刚解锁又立刻再被锁"的循环。

const RATE_LIMIT = {
  rapid:  { limit: 10, windowSec: 10 },
  // 快速部署（免登录单文件上传）。一次部署触发 init + part + complete 多次后端调用，
  // 窗口与 limit 必须宽松，否则正常用户也会被拦。该入口另由文件大小与类型白名单兜底。
  quick:  { limit: 5,  windowSec: 60 },
  create: { limit: 2,  windowSec: 60, lockoutSec: 600 },
  reg_ip: { limit: 5,  windowSec: 3600, lockoutSec: 3600 },
  update: { limit: 10, windowSec: 60 },
  normal: { limit: 100, windowSec: 60 },
  login:  { limit: 20, windowSec: 60 },
  forgot_ip:    { limit: 5,  windowSec: 3600 },          // 每 IP 每小时最多 5 次找回密码
  forgot_email: { limit: 3,  windowSec: 3600 },          // 每邮箱每小时最多 3 次
  reset:        { limit: 10, windowSec: 3600 },          // 每 IP 每小时最多 10 次重置密码
  me_update:    { limit: 20, windowSec: 60 },            // 昵称修改：每 IP 每分钟最多 20 次
  delete_acct:  { limit: 3,  windowSec: 3600 },          // 注销账号：每 IP 每小时最多 3 次
  ai_chat:      { limit: 30, windowSec: 60 },            // AI Copilot：每 IP 每分钟最多 30 次
  play_write:   { limit: 40, windowSec: 60 },            // 广场写操作：发帖/点赞/关注/改资料
  play_comment: { limit: 20, windowSec: 60 },            // 广场评论：每 IP 每分钟最多 20 条
                                                         // （一轮建站对话内部最多 12 轮请求，
                                                         //   30 次留给正常交互，同时挡住脚本刷 key）
};

// 反代/网关出口 IP 白名单：命中后继续往后取更靠客户端的地址。
// 通过 wrangler.toml 的 [vars] 配置 RATE_LIMIT_GATEWAY_IPS="1.2.3.4,5.6.7.8"。
// 未配置时本集合为空，不影响正常逻辑；配错了也只是多取一层地址，不会误伤。
const GATEWAY_IPS = new Set(
  (process.env.RATE_LIMIT_GATEWAY_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

// 开发态调试开关。设为 '1' 后命中限流时会打印 action / ip / count / limit，
// 用于判断"是真被刷了"还是"IP 维度失效导致全站共享计数"。
// 日志量 = 请求量，长期开启会让 KV 读取成本翻倍，验证完务必关掉。
const DEBUG = process.env.RATE_LIMIT_DEBUG === '1';

function getClientIP(request) {
  const cands = [
    request.headers.get('CF-Connecting-IP'),
    (request.headers.get('X-Forwarded-For') || '').split(',').map((s) => s.trim()).filter(Boolean)[0],
    request.headers.get('X-Real-IP'),
    request.headers.get('True-Client-IP'),
    request.headers.get('X-Client-IP'),
  ].filter(Boolean);

  for (const v of cands) {
    if (!GATEWAY_IPS.has(v)) return v;
  }

  if (DEBUG && cands.length) {
    console.log('[rl] all candidates are gateway IPs, fell back to ' + cands[0]);
  }
  return cands[0] || 'unknown';
}

async function checkRateLimit(request, env, action = 'normal', keyExtra = null) {
  // 未绑定 KV 时完全跳过限流，避免未配置环境（本地 dev / 配置缺失）下误伤。
  // 注意：这里语义是"没 KV 就放行"，与部分人直觉相反，切勿改成反向判断。
  if (!env || !env.RATE_LIMIT_KV) {
    if (DEBUG) console.log('[rl] skip: no RATE_LIMIT_KV');
    return { allowed: true };
  }

  const ip = getClientIP(request);
  const cfg = RATE_LIMIT[action] || RATE_LIMIT.normal;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / cfg.windowSec) * cfg.windowSec;
  const dim = keyExtra || ip;
  const countKey = `rl:${action}:${windowStart}:${dim}`;

  // ---- create 类：超额后进入 lockout ----
  if (cfg.lockoutSec) {
    const lockKey = `lck:${ip}:${action}`;
    try {
      const locked = await env.RATE_LIMIT_KV.get(lockKey, 'text');
      if (locked) {
        const expiresAt = parseInt(locked, 10);
        if (expiresAt > now) {
          // 仍在锁定期内：直接拒绝，不消耗计数。
          return { allowed: false, resetIn: expiresAt - now, locked: true };
        }
        // 锁定已过期：清理锁，并顺手清掉计数桶，
        // 否则同一窗口内 count 早已 >= limit，解锁后会立刻再次被锁。
        await env.RATE_LIMIT_KV.delete(lockKey).catch(() => {});
        await env.RATE_LIMIT_KV.delete(countKey).catch(() => {});
      }
    } catch (_) {
      // 锁状态读取失败不阻断请求，降级放行。
    }
  }

  try {
    const raw = await env.RATE_LIMIT_KV.get(countKey, 'text');
    const count = raw ? parseInt(raw, 10) : 0;

    if (DEBUG) {
      console.log(`[rl] action=${action} ip=${ip} count=${count} limit=${cfg.limit} key=${countKey}`);
    }

    if (count >= cfg.limit) {
      // create 类超额时建立 lockout 并清空当前窗口计数，下一窗口才能恢复。
      if (cfg.lockoutSec) {
        const lockKey = `lck:${ip}:${action}`;
        const expiresAt = now + cfg.lockoutSec;
        await env.RATE_LIMIT_KV.put(lockKey, String(expiresAt), { expirationTtl: cfg.lockoutSec }).catch(() => {});
        await env.RATE_LIMIT_KV.delete(countKey).catch(() => {});
        return { allowed: false, resetIn: cfg.lockoutSec, retryAfter: cfg.lockoutSec, locked: true };
      }
      return { allowed: false, resetIn: cfg.windowSec - (now - windowStart) };
    }

    // ---- 原子递增 ----
    // KV 没有原生 increment。此处先读后写存在并发读改写覆盖的可能，
    // 但 init / part / complete 之间的并发冲突概率低，业务上允许少量误差；
    // 需要严格精确时改用 Durable Object 或 Lua 脚本。
    if (count === 0) {
      await env.RATE_LIMIT_KV.put(countKey, '1', {
        expirationTtl: cfg.windowSec + 30,
      });
    } else {
      await env.RATE_LIMIT_KV.put(countKey, String(count + 1), {
        expirationTtl: cfg.windowSec + 30,
      });
    }

    return { allowed: true };
  } catch (e) {
    // KV 异常时放行，避免限流服务自身故障造成全站不可用。
    console.error('rate-limit kv error', e && e.message);
    return { allowed: true };
  }
}

export { RATE_LIMIT, getClientIP, checkRateLimit };
