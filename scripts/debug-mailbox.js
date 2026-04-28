const fs = require("node:fs");
const path = require("node:path");

loadDotEnv();

const targetEmail = String(process.argv[2] || "").trim().toLowerCase();
if (!targetEmail) {
  console.error("Usage: node scripts/debug-mailbox.js <email>");
  process.exit(1);
}

const MAIL_GATEWAY_BASE_URL = (
  process.env.MAIL_GATEWAY_BASE_URL || "https://mail.970410.xyz/api"
).replace(/\/+$/, "");
const MAIL_GATEWAY_GROUPS = process.env.MAIL_GATEWAY_GROUPS || "";
const MAIL_GATEWAY_ACCOUNTS = process.env.MAIL_GATEWAY_ACCOUNTS || "";
const MAIL_GATEWAY_LOGIN_EMAIL = process.env.MAIL_GATEWAY_LOGIN_EMAIL || "";
const MAIL_GATEWAY_PASSWORD = process.env.MAIL_GATEWAY_PASSWORD || "";

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
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

function parseAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [];
  }

  return accounts
    .map((item) => ({
      email: String(item?.email || "").trim(),
      password: String(item?.password || "").trim(),
    }))
    .filter((item) => item.email && item.password);
}

function getGatewayGroups() {
  if (MAIL_GATEWAY_GROUPS) {
    const groups = JSON.parse(MAIL_GATEWAY_GROUPS);
    return groups.map((group) => ({
      baseUrl: String(group?.baseUrl || "").trim().replace(/\/+$/, ""),
      accounts: parseAccounts(group.accounts),
    }));
  }

  if (MAIL_GATEWAY_ACCOUNTS) {
    return [
      {
        baseUrl: MAIL_GATEWAY_BASE_URL,
        accounts: parseAccounts(JSON.parse(MAIL_GATEWAY_ACCOUNTS)),
      },
    ];
  }

  if (MAIL_GATEWAY_LOGIN_EMAIL && MAIL_GATEWAY_PASSWORD) {
    return [
      {
        baseUrl: MAIL_GATEWAY_BASE_URL,
        accounts: [
          {
            email: MAIL_GATEWAY_LOGIN_EMAIL,
            password: MAIL_GATEWAY_PASSWORD,
          },
        ],
      },
    ];
  }

  return [];
}

async function login(baseUrl, account) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(account),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200 || !body?.data?.token) {
    throw new Error(body?.message || `login failed: ${response.status}`);
  }

  return body.data.token;
}

async function gatewayFetch(baseUrl, token, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: token,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 200) {
    return { ok: false, status: response.status, body };
  }

  return { ok: true, data: body.data };
}

async function inspectAccountList(baseUrl, token) {
  let accountId = 0;
  let pageCount = 0;
  let total = 0;
  let maxAccountId = 0;
  let matched = null;

  for (;;) {
    const result = await gatewayFetch(
      baseUrl,
      token,
      `/account/list?accountId=${accountId}&size=1000`
    );
    if (!result.ok) {
      return { error: result };
    }

    const items = Array.isArray(result.data) ? result.data : [];
    pageCount += 1;
    total += items.length;
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      const candidate = String(item.email || item.address || "")
        .trim()
        .toLowerCase();
      const currentId = Number(item.accountId || item.id || 0);
      if (candidate === targetEmail) {
        matched = item;
      }
      if (currentId > maxAccountId) {
        maxAccountId = currentId;
      }
    }

    const lastItem = items[items.length - 1];
    accountId = Number(lastItem.accountId || lastItem.id || 0);
    if (!accountId || items.length < 1000) {
      break;
    }
  }

  return { pageCount, total, maxAccountId, matched };
}

async function inspectForwardProbe(baseUrl, token, maxAccountId, limit = 20) {
  for (let offset = 1; offset <= limit; offset++) {
    const currentId = maxAccountId + offset;
    const result = await gatewayFetch(
      baseUrl,
      token,
      `/email/latest?emailId=0&accountId=${currentId}`
    );
    if (!result.ok) {
      continue;
    }

    const items = Array.isArray(result.data) ? result.data : [];
    if (items.length === 0) {
      continue;
    }

    const latestEmail = items[0];
    const toEmail = String(latestEmail.toEmail || latestEmail.toAddress || "")
      .trim()
      .toLowerCase();
    if (toEmail === targetEmail) {
      return {
        matched: true,
        accountId: currentId,
        subject: latestEmail.subject || "",
      };
    }
  }

  return { matched: false };
}

async function main() {
  const groups = getGatewayGroups();
  if (groups.length === 0) {
    throw new Error("missing gateway config");
  }

  for (const group of groups) {
    for (const account of group.accounts) {
      console.log(`\n== ${group.baseUrl} | ${account.email} ==`);
      try {
        const token = await login(group.baseUrl, account);
        const listResult = await inspectAccountList(group.baseUrl, token);
        console.log(JSON.stringify(listResult, null, 2));

        if (!listResult.error && !listResult.matched && listResult.maxAccountId > 0) {
          const probeResult = await inspectForwardProbe(
            group.baseUrl,
            token,
            listResult.maxAccountId,
            20
          );
          console.log(JSON.stringify({ probeResult }, null, 2));
        }
      } catch (error) {
        console.log(
          JSON.stringify(
            {
              error: error.message || String(error),
            },
            null,
            2
          )
        );
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
