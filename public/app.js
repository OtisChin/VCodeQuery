const form = document.getElementById("query-form");
const emailInput = document.getElementById("email");
const submitButton = document.getElementById("submit-button");
const statusLine = document.getElementById("status");
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

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.textContent = loading ? "查询中..." : "立即查询";
}

function showResult(payload) {
  resultCard.classList.remove("is-hidden");
  resultCode.textContent = payload.code || "------";
  resultSubject.textContent = payload.latestEmail?.subject || "无主题";
  resultFrom.textContent = payload.latestEmail?.from || "未知发件人";
  resultTime.textContent = payload.latestEmail?.receivedAt || "最新邮件";
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
    hideResult();
    return;
  }

  setLoading(true);
  setStatus("正在查询最新邮件并提取验证码...");
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
  } catch (error) {
    setStatus(error.message || "查询失败。", "error");
    hideResult();
  } finally {
    setLoading(false);
  }
});
