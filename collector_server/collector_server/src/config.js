function numberEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export const config = Object.freeze({
  port: numberEnv("PORT", 10000, 1, 65535),
  sharedSecret: String(process.env.SHARED_SECRET || "").trim(),
  openaiApiKey: String(process.env.OPENAI_API_KEY || "").trim(),
  openaiModel: String(process.env.OPENAI_MODEL || "gpt-5-mini").trim(),
  browserlessWs: String(process.env.BROWSERLESS_WS || "").trim(),
  browserlessPrimary: String(process.env.BROWSERLESS_PRIMARY || "true").toLowerCase() !== "false",
  postCount: numberEnv("POST_COUNT", 3, 1, 10),
  minBodyChars: numberEnv("MIN_BODY_CHARS", 600, 300, 5000),
  minFullPosts: numberEnv("MIN_FULL_POSTS", 1, 1, 5),
  collectorTimeoutMs: numberEnv("COLLECTOR_TIMEOUT_MS", 110000, 30000, 170000),
  navigationTimeoutMs: numberEnv("NAVIGATION_TIMEOUT_MS", 35000, 10000, 70000),
  postReadyTimeoutMs: numberEnv("POST_READY_TIMEOUT_MS", 22000, 5000, 60000),
  concurrency: numberEnv("COLLECTOR_CONCURRENCY", 1, 1, 3),
  maxPostChars: numberEnv("MAX_POST_CHARS", 16000, 3000, 30000),
  maxTotalChars: numberEnv("MAX_TOTAL_CHARS", 50000, 10000, 100000),
});

export function assertConfiguration() {
  const missing = [];
  if (!config.sharedSecret) missing.push("SHARED_SECRET");
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    throw new Error(`필수 환경변수가 없습니다: ${missing.join(", ")}`);
  }
}
