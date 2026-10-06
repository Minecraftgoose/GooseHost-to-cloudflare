// ===== CORS 配置 =====

const ALLOWED_ORIGINS = [
  'https://host.goose.cc.cd',
];

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // ⚠️ 关键：跨域响应默认只暴露 7 个「安全」响应头（Cache-Control、Content-Type 等）。
    //    前端想读自定义头，必须在 Expose-Headers 里显式列出，
    //    否则 res.headers.get(...) 一律返回 null —— 连「头不存在」和「被 CORS 挡住」都分不清。
    //    这里漏了 X-Copilot-Model，导致前端永远读不到实际使用的模型名，
    //    模型标签一直显示「闲着呢」。（注：前端域名与 API 域名不同源，必过 CORS。）
    'Access-Control-Expose-Headers': [
      'X-Copilot-Model',
      'X-Copilot-Key',
      'X-Copilot-Fallback',
      'X-Copilot-Search',
      'X-Copilot-Elapsed',
      'Retry-After'
    ].join(', '),
    'Access-Control-Max-Age': '86400',
  };
}

export { ALLOWED_ORIGINS, getCorsHeaders };
