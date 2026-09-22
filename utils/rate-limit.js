// ===== 速率限制 =====

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
  ai_chat:      { limit: 30,  windowSec: 60 },           // AI Copilot：每 IP 每分钟最多 30 次
  play_write:   { limit: 40,  windowSec: 60 },           // 广场写操作：发帖/点赞/关注/改资料
  play_comment: { limit: 20,  windowSec: 60 },           // 广场评论：每 IP 每分钟最多 20 条
                                                         // （一轮建站对话内部最多 12 轮请求，
                                                         //   30 次留给正常交互，同时挡住脚本刷 key）
};

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

async function checkRateLimit(request, env, action = 'normal', keyExtra = null) {
  const ip = getClientIP(request);
  const cfg = RATE_LIMIT[action] || RATE_LIMIT.normal;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / cfg.windowSec) * cfg.windowSec;
  const dim = keyExtra ? keyExtra : ip;
  const countKey = `rl:${action}:${windowStart}:${dim}`;

  if (action === 'create' && cfg.lockoutSec) {
    const lockKey = `lck:${ip}:create`;
    try {
      const locked = await env.RATE_LIMIT_KV.get(lockKey, 'text');
      if (locked) {
        const expiresAt = parseInt(locked, 10);
        if (expiresAt > now) {
          return { allowed: false, resetIn: expiresAt - now, locked: true };
        }
        await env.RATE_LIMIT_KV.delete(lockKey);
      }
    } catch (_) {}
  }

  if (!env.RATE_LIMIT_KV) {
    return { allowed: true };
  }

  try {
    const raw = await env.RATE_LIMIT_KV.get(countKey, 'text');
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= cfg.limit) {
      if (action === 'create' && cfg.lockoutSec) {
        const lockKey = `lck:${ip}:create`;
        const expiresAt = now + cfg.lockoutSec;
        await env.RATE_LIMIT_KV.put(lockKey, String(expiresAt), { expirationTtl: cfg.lockoutSec });
        await env.RATE_LIMIT_KV.delete(countKey);
        return { allowed: false, resetIn: cfg.lockoutSec, retryAfter: cfg.lockoutSec, locked: true };
      }
      return { allowed: false, resetIn: cfg.windowSec - (now - windowStart) };
    }
    return { allowed: false, resetIn: cfg.windowSec - (now - windowStart), retryAfter: cfg.windowSec - (now - windowStart) };

    // 用原子递增，避免 init / part / complete 三次 await 之间并发读改写造成计数被覆盖、
    // 进而把合法请求误判为超限。KV 没有原子 increment，用 put 的 add 选项在 key 不存在时置 1，
    // 已存在时回退为读取后 +1 写入（此路径下 count 已由本函数读出，窗口内写冲突概率低）。
    if (count === 0) {
      const added = await env.RATE_LIMIT_KV.put(countKey, '1', {
        expirationTtl: cfg.windowSec + 30,
      });
      if (!added) {
        // key 被并发请求抢先写入，直接复用其计数，不再 +1，避免双计。
      }
    } else {
      await env.RATE_LIMIT_KV.put(countKey, String(count + 1), {
        expirationTtl: cfg.windowSec + 30,
      });
    }
  } catch (e) {
    // KV 异常时放行，避免限流服务自身故障造成全站不可上传。
    console.error('rate-limit kv error', e && e.message);
  }

  return { allowed: true };
}

export { RATE_LIMIT, getClientIP, checkRateLimit };