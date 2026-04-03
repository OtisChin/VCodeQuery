const form = document.getElementById("query-form");
const emailInput = document.getElementById("email");
const submitButton = document.getElementById("submit-button");
const statusLine = document.getElementById("status");
const statusExtra = document.getElementById("status-extra");
const quickLink = document.getElementById("quick-link");
const resultCard = document.getElementById("result");
const resultCode = document.getElementById("result-code");
const resultSubject = document.getElementById("result-subject");
const resultFrom = document.getElementById("result-from");
const resultTime = document.getElementById("result-time");
const helperCopyDefault = document.getElementById("helper-copy-default");
const helperCopySuccess = document.getElementById("helper-copy-success");

function setStatus(message, type = "") {
  statusLine.textContent = message;
  statusLine.className = "status-line";
  if (type) {
    statusLine.classList.add(`is-${type}`);
  }
}

function setStatusExtraVisible(visible) {
  statusExtra.classList.toggle("is-hidden-inline", !visible);
}

function setQuickLinkVisible(visible) {
  quickLink.classList.toggle("is-hidden-inline", !visible);
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.textContent = loading ? "查询中..." : "立即查询";
}

function formatShanghaiDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatReceivedTime(value) {
  if (!value) {
    return "最新邮件";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const naiveMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (naiveMatch) {
      const [, year, month, day, hour, minute, second] = naiveMatch;
      const utcDate = new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        )
      );
      return formatShanghaiDate(utcDate);
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatShanghaiDate(date);
}

function showResult(payload) {
  resultCard.classList.remove("is-hidden");
  resultCode.textContent = payload.code || "------";
  resultSubject.textContent = payload.latestEmail?.subject || "无主题";
  resultFrom.textContent = payload.latestEmail?.from || "未知发件人";
  resultTime.textContent = formatReceivedTime(payload.latestEmail?.receivedAt);
  helperCopyDefault.classList.add("is-hidden-inline");
  helperCopySuccess.classList.remove("is-hidden-inline");
}

function hideResult() {
  resultCard.classList.add("is-hidden");
  helperCopyDefault.classList.remove("is-hidden-inline");
  helperCopySuccess.classList.add("is-hidden-inline");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = emailInput.value.trim();
  if (!email) {
    setStatus("请输入邮箱地址。", "error");
    setStatusExtraVisible(false);
    setQuickLinkVisible(true);
    hideResult();
    return;
  }

  setLoading(true);
  setStatus("正在查询最新邮件并提取验证码...");
  setStatusExtraVisible(false);
  setQuickLinkVisible(true);
  hideResult();

  try {
    const response = await fetch("/api/query-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "查询失败。");
    }

    showResult(payload);
    setStatus("验证码已提取。", "success");
    setStatusExtraVisible(true);
    setQuickLinkVisible(false);
  } catch (error) {
    setStatus(error.message || "查询失败。", "error");
    setStatusExtraVisible(false);
    setQuickLinkVisible(true);
    hideResult();
  } finally {
    setLoading(false);
  }
});
