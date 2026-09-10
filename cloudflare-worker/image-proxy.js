/**
 * Cloudflare Worker — 通用生图代理（站子B / 受限上游专用）
 *
 * 配合 ai-virtual-phone 的「Cloudflare Worker 代理」请求方式使用：
 *   前端把生图请求发到本 Worker，并在 x-upstream-base-url 头里带上真实上游 BaseURL
 *   （例如 https://154-21-194-239.sslip.io/v1）；
 *   Worker 原样转发到真实上游，并在响应上补 CORS 头，从而绕开浏览器跨域预检被上游拦截的问题。
 *
 * 这正是 BabyLink(L 小手机) 在站子B 能生图的底层链路：原生 App 走设备直连无 CORS，
 * 网页端没有这个特权，所以用 CF Worker 在「同域外」替前端完成带 CORS 头的转发。
 *
 * 部署：Cloudflare Dashboard → Workers → 新建 → 粘贴本文件 → 部署，得到 *.workers.dev 地址。
 * 然后在 ai-virtual-phone 的环境变量里设置：
 *   NEXT_PUBLIC_IMAGE_GEN_PROXY_URL = https://你的worker.workers.dev
 * 并在「生图设置 → 请求方式」选择「Cloudflare Worker 代理」。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-upstream-base-url, x-requested-with",
  "Access-Control-Expose-Headers": "Content-Type, Content-Length",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    const allowOrigin = origin || "*";

    // 预检：浏览器对带 Authorization / 自定义头的跨域请求会先发 OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": allowOrigin, ...CORS_HEADERS },
      });
    }

    const upstreamBase = request.headers.get("x-upstream-base-url");
    if (!upstreamBase) {
      return corsResponse(400, JSON.stringify({ error: "缺少 x-upstream-base-url 头" }), {
        "Content-Type": "application/json",
      });
    }

    // 用 Worker 收到的路径(/images/generations 或 /images/edits)拼接真实上游
    const url = new URL(request.url);
    const target = upstreamBase.replace(/\/+$/, "") + url.pathname;

    // 转发原请求：保留 Authorization / Content-Type，去掉 host / 内部头 / content-length
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (["host", "x-upstream-base-url", "origin", "referer", "content-length"].includes(lower)) {
        continue;
      }
      forwardHeaders.set(key, value);
    }

    const hasBody = request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
    const init = {
      method: request.method,
      headers: forwardHeaders,
      redirect: "follow",
    };
    if (hasBody && request.body) {
      init.body = request.body; // 流式转发，兼容 JSON 与大体积参考图 multipart
    }

    try {
      const upstreamRes = await fetch(target, init);
      const respHeaders = new Headers(upstreamRes.headers);
      respHeaders.set("Access-Control-Allow-Origin", allowOrigin);
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        respHeaders.set(key, value);
      }
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return corsResponse(502, JSON.stringify({ error: "代理转发失败: " + (err && err.message ? err.message : String(err)) }), {
        "Content-Type": "application/json",
      });
    }
  },
};
