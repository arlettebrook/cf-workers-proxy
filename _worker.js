function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get("cf-connecting-ip")}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

/**
 * 解析 PROXY_HOSTNAME
 * 支持：
 *  - example.com
 *  - example.com:8443
 *  - 1.2.3.4
 *  - 1.2.3.4:8080
 */
function parseProxyHost(proxyHost) {
  if (proxyHost.includes(":")) {
    const [host, port] = proxyHost.split(":");
    return { host, port };
  }
  return { host: proxyHost, port: "" };
}

function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);

  // 修正 Host 头（IP:PORT 场景必须）
  newRequestHeaders.set("host", proxyHostname);

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

function setResponseHeaders(originalResponse, proxyHostname, originHostname, DEBUG) {
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

/**
 * 替换响应内容
 */
async function replaceResponseText(
  originalResponse,
  proxyHostname,
  pathnameRegex,
  originHostname
) {
  let text = await originalResponse.text();

  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\/+/, "");
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b(${pathnameRegex})`, "g"),
      `${originHostname}$1`
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
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body {
  width: 35em;
  margin: 0 auto;
  font-family: Tahoma, Verdana, Arial, sans-serif;
}
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
<p>Further configuration is required.</p>
<p>
<a href="http://nginx.org/">nginx.org</a><br/>
<a href="http://nginx.com/">nginx.com</a>
</p>
</body>
</html>`;
}

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

      // 访问校验
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !new RegExp(UA_WHITELIST_REGEX).test(
            (request.headers.get("user-agent") || "").toLowerCase()
          )) ||
        (UA_BLACKLIST_REGEX &&
          new RegExp(UA_BLACKLIST_REGEX).test(
            (request.headers.get("user-agent") || "").toLowerCase()
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
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
      }

      // ===== IP + PORT 处理核心 =====
      const { host, port } = parseProxyHost(PROXY_HOSTNAME);
      url.hostname = host;
      url.protocol = PROXY_PROTOCOL;
      if (port) url.port = port;

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