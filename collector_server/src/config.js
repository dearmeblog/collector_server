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
  postCount: numberEnv("POST_COUNT", 5, 1, 10),
  minBodyChars: numberEnv("MIN_BODY_CHARS", 600, 300, 5000),
  minFullPosts: numberEnv("MIN_FULL_POSTS", 1, 1, 5),
  collectorTimeoutMs: numberEnv("COLLECTOR_TIMEOUT_MS", 50000, 20000, 110000),
  navigationTimeoutMs: numberEnv("NAVIGATION_TIMEOUT_MS", 18000, 8000, 45000),
  maxPostChars: numberEnv("MAX_POST_CHARS", 12000, 3000, 30000),
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
