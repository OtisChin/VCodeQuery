const MAIL_GATEWAY_DEFAULT_BASE_URL = "https://mail.970410.xyz/api";

const authCache = new Map();

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

function getGatewayAccounts(env) {
  if (env.MAIL_GATEWAY_ACCOUNTS) {
    let parsed;
    try {
      parsed = JSON.parse(env.MAIL_GATEWAY_ACCOUNTS);
    } catch {
      const error = new Error("MAIL_GATEWAY_ACCOUNTS 不是合法的 JSON。");
      error.statusCode = 500;
      throw error;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      const error = new Error("MAIL_GATEWAY_ACCOUNTS 不能为空。");
      error.statusCode = 500;
      throw error;
    }

    return parsed.map((item, index) => {
      const email = String(item?.email || "").trim();
      const password = String(item?.password || "").trim();
      if (!email || !password) {
        const error = new Error(
          `MAIL_GATEWAY_ACCOUNTS 第 ${index + 1} 项缺少 email 或 password。`
        );
        error.statusCode = 500;
        throw error;
      }

      return { email, password };
    });
  }

  if (env.MAIL_GATEWAY_LOGIN_EMAIL && env.MAIL_GATEWAY_PASSWORD) {
    return [
      {
        email: env.MAIL_GATEWAY_LOGIN_EMAIL,
        password: env.MAIL_GATEWAY_PASSWORD,
      },
    ];
  }

  return [];
}

function requireGatewayConfig(env) {
  if (getGatewayAccounts(env).length === 0) {
    const error = new Error(
      "缺少邮箱中转站登录配置，请设置 MAIL_GATEWAY_ACCOUNTS 或 MAIL_GATEWAY_LOGIN_EMAIL 和 MAIL_GATEWAY_PASSWORD。"
    );
    error.statusCode = 500;
    throw error;
  }
}

function getAuthCacheKey(env, loginAccount) {
  return `${loginAccount.email}@@${getGatewayBaseUrl(env)}`;
}

async function getGatewayToken(env, loginAccount) {
  requireGatewayConfig(env);

  const cacheKey = getAuthCacheKey(env, loginAccount);
  const cacheItem = authCache.get(cacheKey);

  if (cacheItem && cacheItem.expiresAt > Date.now()) {
    return cacheItem.token;
  }

  const response = await fetch(`${getGatewayBaseUrl(env)}/login`, {
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

async function gatewayFetch(env, loginAccount, pathname, options = {}, allowRetry = true) {
  const token = await getGatewayToken(env, loginAccount);
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
    authCache.delete(getAuthCacheKey(env, loginAccount));
    return gatewayFetch(env, loginAccount, pathname, options, false);
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

async function findMailboxAccount(env, loginAccount, targetEmail) {
  let accountId = 0;
  const allAccounts = [];

  for (;;) {
    const page = await gatewayFetch(
      env,
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

async function fetchLatestEmailForAccount(env, loginAccount, accountId) {
  const attempts = [
    `/email/list?accountId=${accountId}&emailId=0&timeSort=0&size=10&type=0`,
    `/email/latest?emailId=0&accountId=${accountId}`,
  ];

  for (const endpoint of attempts) {
    const data = await gatewayFetch(env, loginAccount, endpoint);
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

    let account = null;
    let matchedLoginAccount = null;
    for (const loginAccount of getGatewayAccounts(env)) {
      account = await findMailboxAccount(env, loginAccount, targetEmail);
      if (account) {
        matchedLoginAccount = loginAccount;
        break;
      }
    }

    if (!account || !matchedLoginAccount) {
      return jsonResponse({ error: "查询失败，请检查邮箱是否正确" }, 404);
    }

    const latestEmail = await fetchLatestEmailForAccount(
      env,
      matchedLoginAccount,
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
              latestEmail.createTime ||
              latestEmail.createdAt ||
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
          latestEmail.createTime ||
          latestEmail.createdAt ||
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
