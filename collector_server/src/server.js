import express from "express";
import { config, assertConfiguration } from "./config.js";
import { collectFullBlog } from "./collector.js";
import { createDiagnosis } from "./diagnosis.js";
import { AppError, safeError } from "./errors.js";

assertConfiguration();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "dearme-fulltext-collector",
    version: "4.1.0",
    fulltextOnly: true,
    browserlessConfigured: Boolean(config.browserlessWs),
    browserlessPrimary: Boolean(config.browserlessWs && config.browserlessPrimary),
    concurrency: config.concurrency,
    model: config.openaiModel,
  });
});

app.post("/v1/collect-diagnose", authenticate, async (req, res) => {
  const startedAt = Date.now();
  try {
    const payload = validatePayload(req.body);
    const result = await withTimeout(async () => {
      const collection = await collectFullBlog(payload.blogUrl);
      const diagnosis = await createDiagnosis(payload, collection);
      return { collection, diagnosis };
    }, config.collectorTimeoutMs);

    res.json({
      ok: true,
      fulltextOnly: true,
      elapsedMs: Date.now() - startedAt,
      collection: result.collection,
      diagnosis: result.diagnosis,
    });
  } catch (rawError) {
    const error = safeError(rawError);
    console.error(JSON.stringify({
      level: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    }));
    res.status(error.status || 500).json({
      ok: false,
      fulltextOnly: true,
      code: error.code,
      error: error.message,
      retryable: error.retryable,
      details: error.details,
      elapsedMs: Date.now() - startedAt,
    });
  }
});

app.use((error, _req, res, _next) => {
  const normalized = safeError(error);
  res.status(normalized.status || 500).json({
    ok: false,
    code: normalized.code,
    error: normalized.message,
    retryable: normalized.retryable,
  });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`디어미 전문 수집 서버 v4.1 listening on 0.0.0.0:${config.port}`);
});

function authenticate(req, _res, next) {
  const supplied = String(req.get("x-dearme-secret") || "");
  if (!supplied || supplied !== config.sharedSecret) {
    return next(new AppError("UNAUTHORIZED", "수집 서버 인증에 실패했습니다.", {
      status: 401,
      retryable: false,
    }));
  }
  next();
}

function validatePayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  const required = ["applicationId", "blogUrl", "businessType", "targetCustomer", "targetInquiry"];
  for (const key of required) {
    if (!String(payload[key] || "").trim()) {
      throw new AppError("INVALID_REQUEST", `필수 항목 누락: ${key}`, {
        status: 400,
        retryable: false,
      });
    }
  }
  return payload;
}

async function withTimeout(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError(
          "COLLECTOR_TIMEOUT",
          "전문 수집 시간이 제한을 초과했습니다. 자동 재시도합니다.",
          { status: 504, retryable: true },
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
