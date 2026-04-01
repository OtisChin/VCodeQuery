const MAIL_GATEWAY_DEFAULT_BASE_URL = "https://mail.970410.xyz/api";

const authCache = {
  token: null,
  expiresAt: 0,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/query-code") {
      return handleQueryCode(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Assets binding is not configured.", { status: 500 });
  },
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("请求体不是合法的 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function getGatewayBaseUrl(env) {
  return String(env.MAIL_GATEWAY_BASE_URL || MAIL_GATEWAY_DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

function requireGatewayConfig(env) {
  if (!env.MAIL_GATEWAY_LOGIN_EMAIL || !env.MAIL_GATEWAY_PASSWORD) {
    const error = new Error(
      "缺少邮箱中转站登录配置，请设置 MAIL_GATEWAY_LOGIN_EMAIL 和 MAIL_GATEWAY_PASSWORD。"
    );
    error.statusCode = 500;
    throw error;
  }
}

async function getGatewayToken(env) {
  requireGatewayConfig(env);

  if (authCache.token && authCache.expiresAt > Date.now()) {
    return authCache.token;
  }

  const response = await fetch(`${getGatewayBaseUrl(env)}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: env.MAIL_GATEWAY_LOGIN_EMAIL,
      password: env.MAIL_GATEWAY_PASSWORD,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 200 || !body.data?.token) {
    const error = new Error(body?.message || "邮箱中转站登录失败。");
    error.statusCode = 502;
    throw error;
  }

  authCache.token = body.data.token;
  authCache.expiresAt = Date.now() + 10 * 60 * 1000;
  return authCache.token;
}

async function gatewayFetch(env, pathname, options = {}, allowRetry = true) {
  const token = await getGatewayToken(env);
  const response = await fetch(`${getGatewayBaseUrl(env)}${pathname}`, {
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
    authCache.token = null;
    authCache.expiresAt = 0;
    return gatewayFetch(env, pathname, options, false);
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

async function findMailboxAccount(env, targetEmail) {
  let accountId = 0;
  const allAccounts = [];

  for (;;) {
    const page = await gatewayFetch(
      env,
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

  return allAccounts.find((item) => {
    const candidate = String(item.email || item.address || "").trim().toLowerCase();
    return candidate === targetEmail;
  });
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
      right.createdAt ||
        right.createTime ||
        right.receivedAt ||
        right.date ||
        right.sendTime ||
        right.updatedAt
    );
    const leftTime = parseTimestamp(
      left.createdAt ||
        left.createTime ||
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
  const visited = new WeakSet();
  const pieces = [];

  function visit(value) {
    if (value == null) {
      return;
    }

    if (typeof value === "string") {
      const text = value.trim();
      if (text) {
        pieces.push(text);
      }
      return;
    }

    if (typeof value === "number") {
      pieces.push(String(value));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (
        /password|token|authorization|headers|cookie|attachment|binary|raw/i.test(key)
      ) {
        continue;
      }
      visit(nested);
    }
  }

  visit(email);
  return pieces.join("\n");
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

async function fetchLatestEmailForAccount(env, accountId) {
  const attempts = [
    `/email/list?accountId=${accountId}&emailId=0&timeSort=0&size=10&type=0`,
    `/email/latest?emailId=0&accountId=${accountId}`,
  ];

  for (const endpoint of attempts) {
    const data = await gatewayFetch(env, endpoint);
    const items = Array.isArray(data) ? data : [];
    if (items.length > 0) {
      return pickLatestEmail(items);
    }
  }

  return null;
}

async function handleQueryCode(request, env) {
  try {
    const body = await readJson(request);
    const targetEmail = String(body.email || "").trim().toLowerCase();

    if (!targetEmail) {
      return jsonResponse({ error: "请输入邮箱地址。" }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return jsonResponse({ error: "邮箱格式不正确。" }, 400);
    }

    const account = await findMailboxAccount(env, targetEmail);
    if (!account) {
      return jsonResponse({ error: "查询失败，请检查邮箱是否正确" }, 404);
    }

    const latestEmail = await fetchLatestEmailForAccount(
      env,
      account.accountId || account.id
    );
    if (!latestEmail) {
      return jsonResponse({ error: "该邮箱还没有收到邮件。" }, 404);
    }

    const sourceText = collectCandidateText(latestEmail);
    const code = extractVerificationCode(sourceText);

    if (!code) {
      return jsonResponse(
        {
          error: "找到了最新邮件，但没有识别出验证码。",
          latestEmail: {
            subject: latestEmail.subject || "",
            from: latestEmail.fromName || latestEmail.fromEmail || "",
            receivedAt:
              latestEmail.createdAt ||
              latestEmail.createTime ||
              latestEmail.receivedAt ||
              latestEmail.date ||
              "",
          },
        },
        404
      );
    }

    return jsonResponse({
      code,
      latestEmail: {
        subject: latestEmail.subject || "",
        from: latestEmail.fromName || latestEmail.fromEmail || "",
        receivedAt:
          latestEmail.createdAt ||
          latestEmail.createTime ||
          latestEmail.receivedAt ||
          latestEmail.date ||
          "",
      },
    });
  } catch (error) {
    return jsonResponse(
      { error: error.message || "服务器内部错误。" },
      error.statusCode || 500
    );
  }
}
