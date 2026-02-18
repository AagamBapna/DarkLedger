const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

function normalizeBaseUrl() {
  const value = process.env.BACKEND_PUBLIC_URL;
  if (!value) return null;
  return value.replace(/\/$/, "");
}

function appendQuery(url, query) {
  for (const [key, rawValue] of Object.entries(query)) {
    if (key === "path") continue;
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        url.searchParams.append(key, String(item));
      }
    } else if (rawValue !== undefined) {
      url.searchParams.append(key, String(rawValue));
    }
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function copyResponseHeaders(upstreamHeaders, res) {
  upstreamHeaders.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
}

export function createProxyHandler(prefix) {
  return async function proxyHandler(req, res) {
    const baseUrl = normalizeBaseUrl();
    if (!baseUrl) {
      res.status(500).json({
        error: "BACKEND_PUBLIC_URL is not configured",
      });
      return;
    }

    const pathSegments = req.query.path;
    const joinedPath = Array.isArray(pathSegments)
      ? pathSegments.join("/")
      : pathSegments || "";

    const upstreamUrl = new URL(`${baseUrl}/${prefix}/${joinedPath}`);
    appendQuery(upstreamUrl, req.query);

    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) {
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        delete headers[key];
      }
    }

    let body;
    if (!METHODS_WITHOUT_BODY.has(req.method || "GET")) {
      const payload = await readRawBody(req);
      if (payload.length > 0) {
        body = payload;
        headers["content-length"] = String(payload.length);
      } else {
        delete headers["content-length"];
      }
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    copyResponseHeaders(upstreamResponse.headers, res);
    res.status(upstreamResponse.status).send(responseBuffer);
  };
}
