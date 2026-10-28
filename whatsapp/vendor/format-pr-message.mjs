const STATUS_LABELS = Object.freeze({
  opened: "已创建",
  updated: "已更新",
  ready: "待审核",
  merged: "已合并",
  closed: "已关闭"
});

function oneLine(value) {
  return value.replace(/\s+/gu, " ").trim();
}

export function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PR_URL_INVALID");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PR_URL_INVALID");
  }

  return parsed.toString();
}

export function formatPrMessage({
  title,
  url,
  status = "ready",
  repository,
  branch,
  summary
}) {
  const normalizedTitle = oneLine(title);
  if (!normalizedTitle) throw new Error("PR_TITLE_REQUIRED");
  if (!(status in STATUS_LABELS)) throw new Error("PR_STATUS_INVALID");

  const lines = [
    `PR ${STATUS_LABELS[status]}`,
    `标题：${normalizedTitle}`
  ];

  if (repository?.trim()) lines.push(`仓库：${oneLine(repository)}`);
  if (branch?.trim()) lines.push(`分支：${oneLine(branch)}`);
  if (summary?.trim()) lines.push(`说明：${oneLine(summary)}`);
  lines.push(`链接：${assertHttpUrl(url)}`);

  const message = lines.join("\n");
  if (message.length > 4000) throw new Error("PR_NOTIFICATION_TOO_LONG");
  return message;
}
