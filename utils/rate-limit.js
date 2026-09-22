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

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

async function checkRateLimit(request, env, action = 'normal', keyExtra = null) {
  if (!env || !env.RATE_LIMIT_KV) {
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
        await env.RATE_LIMIT_KV.delete(lockKey);
        await env.RATE_LIMIT_KV.delete(countKey);
      }
    } catch (_) {
      // 锁状态读取失败不阻断请求，降级放行。
    }
  }

  try {
    const raw = await env.RATE_LIMIT_KV.get(countKey, 'text');
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= cfg.limit) {
      // create 类超额时建立 lockout 并清空当前窗口计数，下一窗口才能恢复。
      if (cfg.lockoutSec) {
        const lockKey = `lck:${ip}:${action}`;
        const expiresAt = now + cfg.lockoutSec;
        await env.RATE_LIMIT_KV.put(lockKey, String(expiresAt), { expirationTtl: cfg.lockoutSec });
        await env.RATE_LIMIT_KV.delete(countKey);
        return { allowed: false, resetIn: cfg.lockoutSec, retryAfter: cfg.lockoutSec, locked: true };
      }
      return { allowed: false, resetIn: cfg.windowSec - (now - windowStart) };
    }

    // ---- 计数递增 ----
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
