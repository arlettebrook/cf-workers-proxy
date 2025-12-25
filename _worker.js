function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get(
      "cf-connecting-ip"
    )}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

function isAllowed(request, env, url) {
  const {
    PATHNAME_REGEX,
    UA_WHITELIST_REGEX,
    UA_BLACKLIST_REGEX,
    IP_WHITELIST_REGEX,
    IP_BLACKLIST_REGEX,
    REGION_WHITELIST_REGEX,
    REGION_BLACKLIST_REGEX,
  } = env;

  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const ip = request.headers.get("cf-connecting-ip") || "";
  const region = request.headers.get("cf-ipcountry") || "";

  if (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) return false;
  if (UA_WHITELIST_REGEX && !new RegExp(UA_WHITELIST_REGEX).test(ua)) return false;
  if (UA_BLACKLIST_REGEX && new RegExp(UA_BLACKLIST_REGEX).test(ua)) return false;
  if (IP_WHITELIST_REGEX && !new RegExp(IP_WHITELIST_REGEX).test(ip)) return false;
  if (IP_BLACKLIST_REGEX && new RegExp(IP_BLACKLIST_REGEX).test(ip)) return false;
  if (REGION_WHITELIST_REGEX && !new RegExp(REGION_WHITELIST_REGEX).test(region)) return false;
  if (REGION_BLACKLIST_REGEX && new RegExp(REGION_BLACKLIST_REGEX).test(region)) return false;

  return true;
}

function createNewRequest(request, url, proxyHostname, originHostname) {
  const headers = new Headers(request.headers);
  for (const [key, value] of headers) {
    if (value.includes(originHostname)) {
      headers.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originHostname}\\b`, "g"),
          proxyHostname
        )
      );
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
  });
}

function setResponseHeaders(response, proxyHostname, originHostname, DEBUG) {
  const headers = new Headers(response.headers);
  for (const [key, value] of headers) {
    if (value.includes(proxyHostname)) {
      headers.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  if (DEBUG) headers.delete("content-security-policy");
  return headers;
}

async function replaceResponseText(response, proxyHostname, pathnameRegex, originHostname) {
  let text = await response.text();
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  }
  return text.replace(
    new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
    originHostname
  );
}

async function nginx() {
  return `<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
<body><h1>Welcome to nginx!</h1></body>
</html>`;
}

/* ================= WebSocket 代理 ================= */

async function handleWebSocket(request, targetUrl) {
  const pair = new WebSocketPair();
  const [client, worker] = Object.values(pair);

  worker.accept();
  const target = new WebSocket(targetUrl);

  worker.addEventListener("message", (e) => {
    if (target.readyState === WebSocket.OPEN) {
      target.send(e.data);
    }
  });

  target.addEventListener("message", (e) => {
    if (worker.readyState === WebSocket.OPEN) {
      worker.send(e.data);
    }
  });

  const close = () => {
    try { worker.close(); } catch {}
    try { target.close(); } catch {}
  };

  worker.addEventListener("close", close);
  worker.addEventListener("error", close);
  target.addEventListener("close", close);
  target.addEventListener("error", close);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/* ================= Worker 入口 ================= */

export default {
  async fetch(request, env, ctx) {
    try {
      const {
        PROXY_HOSTNAME,
        PROXY_PROTOCOL = "https",
        URL302,
        KEEP_PATH = false,
        DEBUG = false,
      } = env;

      if (!PROXY_HOSTNAME) return new Response("Missing PROXY_HOSTNAME", { status: 500 });

      const url = new URL(request.url);

      /* ===== WebSocket ===== */
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        if (!isAllowed(request, env, url)) {
          return new Response("Forbidden", { status: 403 });
        }

        url.hostname = PROXY_HOSTNAME;
        url.protocol = PROXY_PROTOCOL === "http" ? "ws:" : "wss:";

        return handleWebSocket(request, url.toString());
      }

      /* ===== HTTP ===== */
      if (!isAllowed(request, env, url)) {
        logError(request, "Invalid");
        return URL302
          ? Response.redirect(
              KEEP_PATH
                ? (URL302 + "/" + url.pathname).replace(/\/+/g, "/")
                : URL302,
              302
            )
          : new Response(await nginx(), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
      }

      const originHostname = url.hostname;
      url.hostname = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;

      const newRequest = createNewRequest(
        request,
        url,
        PROXY_HOSTNAME,
        originHostname
      );

      const originalResponse = await fetch(newRequest);
      const headers = setResponseHeaders(
        originalResponse,
        PROXY_HOSTNAME,
        originHostname,
        DEBUG
      );

      const contentType = headers.get("content-type") || "";
      const body = contentType.includes("text/")
        ? await replaceResponseText(
            originalResponse,
            PROXY_HOSTNAME,
            env.PATHNAME_REGEX,
            originHostname
          )
        : originalResponse.body;

      return new Response(body, {
        status: originalResponse.status,
        headers,
      });
    } catch (e) {
      logError(request, `Fetch error: ${e.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};