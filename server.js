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
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
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

async function findMailboxAccount(group, loginAccount, targetEmail) {
  let accountId = 0;
  const allAccounts = [];

  for (;;) {
    const page = await gatewayFetch(
      group,
      loginAccount,
      `/account/list?accountId=${accountId}&size=200`
    );
    const items = Array.isArray(page) ? page : [];

    if (items.length === 0) {
      break;
    }

    allAccounts.push(...items);
    const lastItem = items[items.length - 1];
    accountId = Number(lastItem.accountId || lastItem.id || 0);

    if (!accountId || items.length < 200) {
      break;
    }
  }

  const found = allAccounts.find((item) => {
    const candidate = String(item.email || item.address || "").trim().toLowerCase();
    return candidate === targetEmail;
  });

  if (found) {
    return found;
  }

  const maxAccountId = allAccounts.length > 0
    ? Math.max(...allAccounts.map((item) => Number(item.accountId || item.id || 0)))
    : 200;

  for (let id = 1; id <= maxAccountId + 500; id++) {
    try {
      const emails = await gatewayFetch(
        group,
        loginAccount,
        `/email/latest?emailId=0&accountId=${id}`
      );
      const items = Array.isArray(emails) ? emails : [];
      if (items.length === 0) {
        continue;
      }

      const latestEmail = items[0];
      const toEmail = String(latestEmail.toEmail || latestEmail.toAddress || "").trim().toLowerCase();
      if (toEmail === targetEmail) {
        return { accountId: id, email: toEmail };
      }
    } catch {
      continue;
    }
  }

  return null;
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

function collectCandidateText(email) {
  const preferredFields = [
    email.subject,
    email.text,
    email.content,
    email.message,
    email.html,
    email.body,
  ];

  return preferredFields
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
}

function extractVerificationCode(text) {
  const normalized = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const priorityPatterns = [
    /(?:验证码|verification code|security code|confirm(?:ation)? code|otp|one-time password)[^\d]{0,20}(\d{4,8})/i,
    /(\d{6})(?!\d)/,
    /(\d{4,8})(?!\d)/,
    /\b([A-Z0-9]{4,8})\b/,
  ];

  for (const pattern of priorityPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function fetchLatestEmailForAccount(group, loginAccount, accountId) {
  const attempts = [
    `/email/list?accountId=${accountId}&emailId=0&timeSort=0&size=10&type=0`,
    `/email/latest?emailId=0&accountId=${accountId}`,
  ];

  for (const endpoint of attempts) {
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

    let group = null;
    let account = null;
    let matchedLoginAccount = null;
    for (const gatewayGroup of getGatewayGroups()) {
      for (const loginAccount of gatewayGroup.accounts) {
        account = await findMailboxAccount(gatewayGroup, loginAccount, targetEmail);
        if (account) {
          group = gatewayGroup;
          matchedLoginAccount = loginAccount;
          break;
        }
      }

      if (account) {
        break;
      }
    }

    if (!group || !account || !matchedLoginAccount) {
      sendJson(res, 404, { error: "查询失败，请检查邮箱是否正确" });
      return;
    }

    const latestEmail = await fetchLatestEmailForAccount(
      group,
      matchedLoginAccount,
      account.accountId || account.id
    );
    if (!latestEmail) {
      sendJson(res, 404, { error: "该邮箱还没有收到邮件。" });
      return;
    }

    const sourceText = collectCandidateText(latestEmail);
    const code = extractVerificationCode(sourceText);

    if (!code) {
      sendJson(res, 404, {
        error: "找到了最新邮件，但没有识别出验证码。",
        latestEmail: {
          subject: latestEmail.subject || "",
          from: latestEmail.fromName || latestEmail.fromEmail || "",
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
      code,
      latestEmail: {
        subject: latestEmail.subject || "",
        from: latestEmail.fromName || latestEmail.fromEmail || "",
        receivedAt:
          latestEmail.createTime ||
          latestEmail.createdAt ||
          latestEmail.receivedAt ||
          latestEmail.date ||
          "",
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
