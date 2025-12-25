function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get(
      "cf-connecting-ip"
    )}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (typeof value === "string" && value.includes(originHostname)) {
      newRequestHeaders.set(
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
    headers: newRequestHeaders,
    body: request.body,
    redirect: "follow",
  });
}

function setResponseHeaders(
  originalResponse,
  proxyHostname,
  originHostname,
  DEBUG
) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (typeof value === "string" && value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  return newResponseHeaders;
}

async function replaceResponseText(
  originalResponse,
  proxyHostname,
  pathnameRegex,
  originHostname
) {
  let text = await originalResponse.text();
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  } else {
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
      originHostname
    );
  }
}

async function nginx() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;
}

/* ===================== WebSocket 代理 ===================== */
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

  const closeBoth = () => {
    try { worker.close(); } catch {}
    try { target.close(); } catch {}
  };

  worker.addEventListener("close", closeBoth);
  worker.addEventListener("error", closeBoth);
  target.addEventListener("close", closeBoth);
  target.addEventListener("error", closeBoth);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/* ===================== 主入口 ===================== */
export default {
  async fetch(request, env, ctx) {
    try {
      const {
        PROXY_HOSTNAME,
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        KEEP_PATH = false,
        DEBUG = false,
      } = env;

      const url = new URL(request.url);
      const originHostname = url.hostname;

      /* ============ WebSocket 分支 ============ */
      const upgrade = request.headers.get("Upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        url.hostname = PROXY_HOSTNAME;
        url.protocol = PROXY_PROTOCOL === "http" ? "ws:" : "wss:";
        return handleWebSocket(request, url.toString());
      }

      /* ============ 原有 HTTP 校验逻辑（保持不变） ============ */
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !new RegExp(UA_WHITELIST_REGEX).test(
            request.headers.get("user-agent")?.toLowerCase() || ""
          )) ||
        (UA_BLACKLIST_REGEX &&
          new RegExp(UA_BLACKLIST_REGEX).test(
            request.headers.get("user-agent")?.toLowerCase() || ""
          )) ||
        (IP_WHITELIST_REGEX &&
          !new RegExp(IP_WHITELIST_REGEX).test(
            request.headers.get("cf-connecting-ip") || ""
          )) ||
        (IP_BLACKLIST_REGEX &&
          new RegExp(IP_BLACKLIST_REGEX).test(
            request.headers.get("cf-connecting-ip") || ""
          )) ||
        (REGION_WHITELIST_REGEX &&
          !new RegExp(REGION_WHITELIST_REGEX).test(
            request.headers.get("cf-ipcountry") || ""
          )) ||
        (REGION_BLACKLIST_REGEX &&
          new RegExp(REGION_BLACKLIST_REGEX).test(
            request.headers.get("cf-ipcountry") || ""
          ))
      ) {
        logError(request, "Invalid");
        return URL302
          ? Response.redirect(
              KEEP_PATH
                ? (URL302 + "/" + url.pathname).replace(/\/+/g, "/")
                : URL302,
              302
            )
          : new Response(await nginx(), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
              },
            });
      }

      /* ============ 原有 HTTP 代理逻辑 ============ */
      url.host = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;

      const newRequest = createNewRequest(
        request,
        url,
        PROXY_HOSTNAME,
        originHostname
      );

      const originalResponse = await fetch(newRequest);

      const newResponseHeaders = setResponseHeaders(
        originalResponse,
        PROXY_HOSTNAME,
        originHostname,
        DEBUG
      );

      const contentType = newResponseHeaders.get("content-type") || "";
      let body;

      if (contentType.includes("text/")) {
        body = await replaceResponseText(
          originalResponse,
          PROXY_HOSTNAME,
          PATHNAME_REGEX,
          originHostname
        );
      } else {
        body = originalResponse.body;
      }

      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders,
      });
    } catch (error) {
      logError(request, `Fetch error: ${error.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};