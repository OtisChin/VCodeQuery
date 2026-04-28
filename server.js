const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

loadDotEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const MAIL_GATEWAY_BASE_URL = (
  process.env.MAIL_GATEWAY_BASE_URL || "https://mail.970410.xyz/api"
).replace(/\/+$/, "");
const MAIL_GATEWAY_GROUPS = process.env.MAIL_GATEWAY_GROUPS || "";
const MAIL_GATEWAY_ACCOUNTS = process.env.MAIL_GATEWAY_ACCOUNTS || "";
const MAIL_GATEWAY_LOGIN_EMAIL = process.env.MAIL_GATEWAY_LOGIN_EMAIL || "";
const MAIL_GATEWAY_PASSWORD = process.env.MAIL_GATEWAY_PASSWORD || "";
const staticMimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const authCache = new Map();

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = rawLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = rawLine.slice(separatorIndex + 1).trim();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";

    if (quote) {
      while (!value.endsWith(quote) && index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;
      }
      value = value.trim();
      if (value.startsWith(quote) && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
      continue;
    }

    const openBrackets =
      (value.match(/\[/g) || []).length - (value.match(/\]/g) || []).length;
    const openBraces =
      (value.match(/\{/g) || []).length - (value.match(/\}/g) || []).length;

    if (openBrackets > 0 || openBraces > 0) {
      let balanceBrackets = openBrackets;
      let balanceBraces = openBraces;

      while ((balanceBrackets > 0 || balanceBraces > 0) && index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;
        balanceBrackets +=
          (lines[index].match(/\[/g) || []).length -
          (lines[index].match(/\]/g) || []).length;
        balanceBraces +=
          (lines[index].match(/\{/g) || []).length -
          (lines[index].match(/\}/g) || []).length;
      }
    }

    process.env[key] = value.trim();
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法的 JSON");
  }
}

async function serveStaticFile(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.join(PUBLIC_DIR, pathname);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(normalizedPath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }

    const extension = path.extname(normalizedPath).toLowerCase();
    const stream = fs.createReadStream(normalizedPath);
    res.writeHead(200, {
      "Content-Type": staticMimeTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    stream.pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

function parseAccounts(accounts, configLabel) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    const error = new Error(`${configLabel} 不能为空。`);
    error.statusCode = 500;
    throw error;
  }

  return accounts.map((item, index) => {
    const email = String(item?.email || "").trim();
    const password = String(item?.password || "").trim();
    if (!email || !password) {
      const error = new Error(
        `${configLabel} 第 ${index + 1} 项缺少 email 或 password。`
      );
      error.statusCode = 500;
      throw error;
    }

    return { email, password };
  });
}

function getGatewayGroups() {
  if (MAIL_GATEWAY_GROUPS) {
    let parsed;
    try {
      parsed = JSON.parse(MAIL_GATEWAY_GROUPS);
    } catch {
      const error = new Error("MAIL_GATEWAY_GROUPS 不是合法的 JSON。");
      error.statusCode = 500;
      throw error;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      const error = new Error("MAIL_GATEWAY_GROUPS 不能为空。");
      error.statusCode = 500;
      throw error;
    }

    return parsed.map((group, index) => {
      const baseUrl = String(group?.baseUrl || "").trim().replace(/\/+$/, "");
      if (!baseUrl) {
        const error = new Error(
          `MAIL_GATEWAY_GROUPS 第 ${index + 1} 项缺少 baseUrl。`
        );
        error.statusCode = 500;
        throw error;
      }

      return {
        baseUrl,
        accounts: parseAccounts(
          group.accounts,
          `MAIL_GATEWAY_GROUPS 第 ${index + 1} 项 accounts`
        ),
      };
    });
  }

  return [
    {
      baseUrl: MAIL_GATEWAY_BASE_URL,
      accounts: getGatewayAccounts(),
    },
  ];
}

function getGatewayAccounts() {
  if (MAIL_GATEWAY_ACCOUNTS) {
    let parsed;
    try {
      parsed = JSON.parse(MAIL_GATEWAY_ACCOUNTS);
    } catch {
      const error = new Error("MAIL_GATEWAY_ACCOUNTS 不是合法的 JSON。");
      error.statusCode = 500;
      throw error;
    }

    return parseAccounts(parsed, "MAIL_GATEWAY_ACCOUNTS");
  }

  if (MAIL_GATEWAY_LOGIN_EMAIL && MAIL_GATEWAY_PASSWORD) {
    return [
      {
        email: MAIL_GATEWAY_LOGIN_EMAIL,
        password: MAIL_GATEWAY_PASSWORD,
      },
    ];
  }

  return [];
}

function requireGatewayConfig() {
  if (getGatewayGroups().length === 0) {
    const error = new Error(
      "缺少邮箱中转站登录配置，请设置 MAIL_GATEWAY_GROUPS、MAIL_GATEWAY_ACCOUNTS 或 MAIL_GATEWAY_LOGIN_EMAIL 和 MAIL_GATEWAY_PASSWORD。"
    );
    error.statusCode = 500;
    throw error;
  }
}

function getAuthCacheKey(group, loginAccount) {
  return `${loginAccount.email}@@${group.baseUrl}`;
}

async function gatewayFetch(group, loginAccount, pathname, options = {}, allowRetry = true) {
  const token = await getGatewayToken(group, loginAccount);
  const response = await fetch(`${group.baseUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: token,
      ...(options.headers || {}),
    },
  });

  const body = await response.json().catch(() => null);

  if (body && body.code === 401 && allowRetry) {
    authCache.delete(getAuthCacheKey(group, loginAccount));
    return gatewayFetch(group, loginAccount, pathname, options, false);
  }

  if (!response.ok) {
    const error = new Error(body?.message || `上游接口错误: ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  if (!body || typeof body !== "object") {
    const error = new Error("邮箱中转站返回了无法识别的数据。");
    error.statusCode = 502;
    throw error;
  }

  if (body.code !== 200) {
    const error = new Error(body.message || "邮箱中转站请求失败。");
    error.statusCode = body.code === 401 ? 401 : 502;
    throw error;
  }

  return body.data;
}

async function getGatewayToken(group, loginAccount) {
  requireGatewayConfig();

  const cacheKey = getAuthCacheKey(group, loginAccount);
  const cacheItem = authCache.get(cacheKey);

  if (cacheItem && cacheItem.expiresAt > Date.now()) {
    return cacheItem.token;
  }

  const response = await fetch(`${group.baseUrl}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: loginAccount.email,
      password: loginAccount.password,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 200 || !body.data?.token) {
    const error = new Error(body?.message || "邮箱中转站登录失败。");
    error.statusCode = 502;
    throw error;
  }

  authCache.set(cacheKey, {
    token: body.data.token,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return body.data.token;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function pickLatestEmail(items) {
  return [...items].sort((left, right) => {
    const rightTime = parseTimestamp(
      right.createTime ||
        right.createdAt ||
        right.receivedAt ||
        right.date ||
        right.sendTime ||
        right.updatedAt
    );
    const leftTime = parseTimestamp(
      left.createTime ||
        left.createdAt ||
        left.receivedAt ||
        left.date ||
        left.sendTime ||
        left.updatedAt
    );

    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    return Number(right.emailId || right.id || 0) - Number(left.emailId || left.id || 0);
  })[0];
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function isLikelyJsonText(value) {
  const text = String(value || "").trim();
  return (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  );
}

function isLikelyHtmlText(value) {
  const text = String(value || "").trim();
  return /<html[\s>]|<body[\s>]|<head[\s>]|<div[\s>]|<table[\s>]|<p[\s>]|<br\s*\/?>/i.test(
    text
  );
}

function extractTextFromStructuredContent(value) {
  if (!isLikelyJsonText(value)) {
    return "";
  }

  try {
    const parsed = JSON.parse(value);
    const candidates = [
      parsed?.text,
      parsed?.content,
      parsed?.html,
      parsed?.body,
      parsed?.message,
      Array.isArray(parsed?.blocks)
        ? parsed.blocks
            .map((item) => item?.text || item?.content || item?.html || "")
            .filter(Boolean)
            .join("\n")
        : "",
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        if (candidate.includes("<")) {
          return htmlToPlainText(candidate);
        }
        return candidate.trim();
      }
    }
  } catch {
    return "";
  }

  return "";
}

function extractHtmlFromStructuredContent(value) {
  if (!isLikelyJsonText(value)) {
    return "";
  }

  try {
    const parsed = JSON.parse(value);
    const candidates = [
      parsed?.html,
      parsed?.content,
      Array.isArray(parsed?.blocks)
        ? parsed.blocks
            .map((item) => item?.html || item?.content || "")
            .filter((item) => typeof item === "string" && item.includes("<"))
            .join("\n")
        : "",
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() && candidate.includes("<")) {
        return candidate.trim();
      }
    }
  } catch {
    return "";
  }

  return "";
}

function collectEmailContent(email) {
  const plainFields = [email.text, email.message, email.body];
  for (const field of plainFields) {
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }

  if (typeof email.html === "string" && email.html.trim()) {
    return htmlToPlainText(email.html);
  }

  if (typeof email.content === "string" && email.content.trim()) {
    const structuredText = extractTextFromStructuredContent(email.content);
    if (structuredText) {
      return structuredText;
    }

    if (isLikelyHtmlText(email.content)) {
      return htmlToPlainText(email.content);
    }

    if (!isLikelyJsonText(email.content)) {
      return email.content.trim();
    }
  }

  return "";
}

function collectEmailHtml(email) {
  const htmlFields = [email.html];
  for (const field of htmlFields) {
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }

  if (typeof email.content === "string" && email.content.trim()) {
    const structuredHtml = extractHtmlFromStructuredContent(email.content);
    if (structuredHtml) {
      return structuredHtml;
    }

    if (isLikelyHtmlText(email.content)) {
      return email.content.trim();
    }
  }

  return "";
}

function collectEmailFrom(email) {
  const name = String(email.fromName || email.name || "").trim();
  const address = String(email.fromEmail || email.sendEmail || email.from || "").trim();

  if (name && address) {
    return `${name} <${address}>`;
  }

  return address || name || "";
}

async function searchLatestEmailByAddress(group, loginAccount, targetEmail) {
  const query = new URLSearchParams({
    accountEmail: targetEmail,
    type: "receive",
    size: "20",
    timeSort: "0",
  });
  const data = await gatewayFetch(
    group,
    loginAccount,
    `/allEmail/list?${query.toString()}`
  );
  const items = Array.isArray(data?.list) ? data.list : [];
  const exactMatches = items.filter((item) => {
    const candidate = String(item.toEmail || item.toAddress || "")
      .trim()
      .toLowerCase();
    return candidate === targetEmail;
  });

  if (exactMatches.length === 0) {
    return null;
  }

  return pickLatestEmail(exactMatches);
}

async function findAccountByEmail(group, loginAccount, targetEmail) {
  let accountId = 0;

  for (;;) {
    const items = await gatewayFetch(
      group,
      loginAccount,
      `/account/list?accountId=${accountId}&size=1000`
    );
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      return null;
    }

    const matched = list.find((item) => {
      const email = String(item.email || item.address || "")
        .trim()
        .toLowerCase();
      return email === targetEmail;
    });
    if (matched) {
      return matched;
    }

    const lastItem = list[list.length - 1];
    accountId = Number(lastItem.accountId || lastItem.id || 0);
    if (!accountId || list.length < 1000) {
      return null;
    }
  }
}

async function fetchLatestEmailForAccount(group, loginAccount, accountId) {
  const endpoints = [
    `/email/list?accountId=${accountId}&emailId=0&timeSort=0&size=10&type=0`,
    `/email/latest?emailId=0&accountId=${accountId}`,
  ];

  for (const endpoint of endpoints) {
    const data = await gatewayFetch(group, loginAccount, endpoint);
    const items = Array.isArray(data) ? data : [];
    if (items.length > 0) {
      return pickLatestEmail(items);
    }
  }

  return null;
}

async function handleQueryCode(req, res) {
  try {
    const body = await readRequestBody(req);
    const targetEmail = String(body.email || "").trim().toLowerCase();

    if (!targetEmail) {
      sendJson(res, 400, { error: "请输入邮箱地址。" });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      sendJson(res, 400, { error: "邮箱格式不正确。" });
      return;
    }

    let latestEmail = null;
    for (const gatewayGroup of getGatewayGroups()) {
      for (const loginAccount of gatewayGroup.accounts) {
        try {
          latestEmail = await searchLatestEmailByAddress(
            gatewayGroup,
            loginAccount,
            targetEmail
          );
          if (!latestEmail) {
            const account = await findAccountByEmail(
              gatewayGroup,
              loginAccount,
              targetEmail
            );
            if (account) {
              latestEmail = await fetchLatestEmailForAccount(
                gatewayGroup,
                loginAccount,
                account.accountId || account.id
              );
            }
          }
        } catch {
          latestEmail = null;
        }

        if (latestEmail) {
          break;
        }
      }

      if (latestEmail) {
        break;
      }
    }

    if (!latestEmail) {
      sendJson(res, 404, { error: "查询失败，请检查邮箱是否正确" });
      return;
    }

    const sourceText = collectEmailContent(latestEmail);
    if (!sourceText) {
      sendJson(res, 404, {
        error: "找到了最新邮件，但邮件内容为空。",
        latestEmail: {
          subject: latestEmail.subject || "",
          from: collectEmailFrom(latestEmail),
          receivedAt:
            latestEmail.createTime ||
            latestEmail.createdAt ||
            latestEmail.receivedAt ||
            latestEmail.date ||
            "",
        },
      });
      return;
    }

    sendJson(res, 200, {
      latestEmail: {
        subject: latestEmail.subject || "",
        from: collectEmailFrom(latestEmail),
        receivedAt:
          latestEmail.createTime ||
          latestEmail.createdAt ||
          latestEmail.receivedAt ||
          latestEmail.date ||
          "",
        content: sourceText,
        html: collectEmailHtml(latestEmail),
      },
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "服务器内部错误。",
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendText(res, 400, "Bad Request");
    return;
  }

  if (req.method === "POST" && req.url === "/api/query-code") {
    await handleQueryCode(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStaticFile(req, res);
    return;
  }

  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Verification code site running at http://127.0.0.1:${PORT}`);
});
