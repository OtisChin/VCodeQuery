const MAIL_GATEWAY_DEFAULT_BASE_URL = "https://mail.970410.xyz/api";

const authCache = new Map();
const mailboxAccountCache = new Map();

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

function getFallbackAccountIdRange(env) {
  const rawStart = Number(env.MAIL_GATEWAY_FALLBACK_ACCOUNT_ID_START || 1);
  const rawEnd = Number(env.MAIL_GATEWAY_FALLBACK_ACCOUNT_ID_END || 2000);
  const start = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
  const end = Number.isFinite(rawEnd)
    ? Math.max(start, Math.floor(rawEnd))
    : Math.max(start, 2000);

  return { start, end };
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

function getGatewayGroups(env) {
  if (env.MAIL_GATEWAY_GROUPS) {
    let parsed;
    try {
      parsed = JSON.parse(env.MAIL_GATEWAY_GROUPS);
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
      baseUrl: getGatewayBaseUrl(env),
      accounts: getGatewayAccounts(env),
    },
  ];
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

    return parseAccounts(parsed, "MAIL_GATEWAY_ACCOUNTS");
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
  if (getGatewayGroups(env).length === 0) {
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

function getMailboxCacheKey(group, loginAccount, targetEmail) {
  return `${getAuthCacheKey(group, loginAccount)}@@${targetEmail}`;
}

function rememberMailboxAccount(group, loginAccount, targetEmail, account) {
  if (!account) {
    return;
  }

  mailboxAccountCache.set(
    getMailboxCacheKey(group, loginAccount, targetEmail),
    account
  );
}

function getRememberedMailboxAccount(group, loginAccount, targetEmail) {
  return (
    mailboxAccountCache.get(
      getMailboxCacheKey(group, loginAccount, targetEmail)
    ) || null
  );
}

async function getGatewayToken(env, group, loginAccount) {
  requireGatewayConfig(env);

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

async function gatewayFetch(env, group, loginAccount, pathname, options = {}, allowRetry = true) {
  const token = await getGatewayToken(env, group, loginAccount);
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
    return gatewayFetch(env, group, loginAccount, pathname, options, false);
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

async function findMailboxByLatestEmail(env, group, loginAccount, targetEmail) {
  const { start, end } = getFallbackAccountIdRange(env);

  for (let id = start; id <= end; id++) {
    try {
      const emails = await gatewayFetch(
        env,
        group,
        loginAccount,
        `/email/latest?emailId=0&accountId=${id}`
      );
      const items = Array.isArray(emails) ? emails : [];
      if (items.length === 0) {
        continue;
      }

      const latestEmail = items[0];
      const toEmail = String(
        latestEmail.toEmail || latestEmail.toAddress || ""
      )
        .trim()
        .toLowerCase();
      if (toEmail === targetEmail) {
        return { accountId: id, email: toEmail };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function findMailboxAccount(env, group, loginAccount, targetEmail) {
  const remembered = getRememberedMailboxAccount(group, loginAccount, targetEmail);
  if (remembered) {
    return remembered;
  }

  let accountId = 0;
  const allAccounts = [];

  for (;;) {
    const page = await gatewayFetch(
      env,
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
    rememberMailboxAccount(group, loginAccount, targetEmail, found);
    return found;
  }

  const fallbackMatch = await findMailboxByLatestEmail(
    env,
    group,
    loginAccount,
    targetEmail
  );
  if (fallbackMatch) {
    rememberMailboxAccount(group, loginAccount, targetEmail, fallbackMatch);
    return fallbackMatch;
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

async function fetchLatestEmailForAccount(env, group, loginAccount, accountId) {
  const attempts = [
    `/email/list?accountId=${accountId}&emailId=0&timeSort=0&size=10&type=0`,
    `/email/latest?emailId=0&accountId=${accountId}`,
  ];

  for (const endpoint of attempts) {
    const data = await gatewayFetch(env, group, loginAccount, endpoint);
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

    let group = null;
    let account = null;
    let matchedLoginAccount = null;
    for (const gatewayGroup of getGatewayGroups(env)) {
      for (const loginAccount of gatewayGroup.accounts) {
        account = await findMailboxAccount(env, gatewayGroup, loginAccount, targetEmail);
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
      return jsonResponse({ error: "查询失败，请检查邮箱是否正确" }, 404);
    }

    const latestEmail = await fetchLatestEmailForAccount(
      env,
      group,
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
