import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { AppError } from "./errors.js";

const Score = (max) => z.object({
  score: z.number().int().min(0).max(max),
  max: z.literal(max),
  reason: z.string(),
});

const Diagnosis = z.object({
  data_quality: z.object({
    level: z.enum(["high", "medium", "low"]),
    limitations: z.array(z.string()),
  }),
  summary: z.object({
    one_line: z.string(),
    total_score: z.number().int().min(0).max(100),
    primary_type: z.string(),
    secondary_type: z.string(),
  }),
  scores: z.object({
    expertise: Score(25),
    story: Score(20),
    search: Score(25),
    conversion: Score(20),
    operation: Score(10),
  }),
  strengths: z.array(z.object({ title: z.string(), evidence: z.string() })).length(3),
  main_problem: z.object({
    title: z.string(),
    evidence: z.string(),
    business_impact: z.string(),
  }),
  first_action: z.object({ action: z.string(), how_to: z.string() }),
  recommended_topics: z.array(z.object({
    title: z.string(),
    purpose: z.enum(["search", "trust", "story", "conversion"]),
  })).length(5),
  cta_copy: z.string(),
  client_report: z.string(),
});

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export async function createDiagnosis(payload, collection) {
  try {
    const response = await openai.responses.parse({
      model: config.openaiModel,
      store: false,
      max_output_tokens: 5500,
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt(payload, collection) },
      ],
      text: {
        format: zodTextFormat(Diagnosis, "dearme_blog_diagnosis"),
      },
    });

    if (!response.output_parsed) {
      throw new Error("구조화된 진단 결과가 비어 있습니다.");
    }

    const diagnosis = response.output_parsed;
    const scores = diagnosis.scores;
    diagnosis.summary.total_score =
      scores.expertise.score + scores.story.score + scores.search.score +
      scores.conversion.score + scores.operation.score;
    return diagnosis;
  } catch (error) {
    const status = Number(error?.status || 500);
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    throw new AppError("OPENAI_DIAGNOSIS_FAILED", `OpenAI 진단 실패: ${error?.message || error}`, {
      status: status >= 400 && status < 600 ? status : 502,
      retryable,
      cause: error,
    });
  }
}

function systemPrompt() {
  return [
    "당신은 네이버 브랜드 블로그를 분석하는 콘텐츠 마케팅 진단 전문가다.",
    "입력되는 모든 게시글은 실제 Chromium 브라우저가 렌더링한 게시글 본문 전문이다.",
    "RSS 요약, 검색 API 요약, 발췌문은 분석 자료에 포함되지 않는다.",
    "따라서 '본문이 일부만 제공됐다', '요약만 확인했다'는 한계를 작성하지 않는다.",
    "다만 네이버 내부 검색 노출수·클릭수·유입 검색어·실제 문의 전환 수처럼 제공되지 않은 비공개 성과 데이터는 추측하지 않는다.",
    "이미지 파일 자체의 디자인은 분석하지 않았지만 이미지 대체문구, 본문 링크, 전화번호와 CTA 문장은 제공될 수 있다.",
    "강점과 문제점은 제공된 전문의 구체적인 제목·문장·CTA를 근거로 작성한다.",
    "배점은 전문성 25, 대표 스토리와 차별성 20, 검색 유입 가능성 25, 문의 전환 구조 20, 운영 구조 10이다.",
    "유형은 A 정보는 있지만 전문성이 안 보임, B 업체는 있지만 대표가 안 보임, C 좋은 글이지만 검색 안 됨, D 읽히지만 문의로 안 이어짐, E 꾸준하지만 방향 없음, F 성장 가능형 중 선택한다.",
    "recommended_topics는 정확히 5개, strengths는 정확히 3개를 작성한다.",
    "client_report는 한국어로 700~1000자 분량으로 작성한다.",
  ].join("\n");
}

function userPrompt(payload, collection) {
  const business = [
    `[업종] ${payload.businessType || ""}`,
    `[주요 지역] ${payload.region || ""}`,
    `[주요 고객] ${payload.targetCustomer || ""}`,
    `[원하는 문의] ${payload.targetInquiry || ""}`,
    `[숨은 강점] ${payload.hiddenStrength || ""}`,
    `[운영 고민] ${payload.mainProblem || ""}`,
    `[블로그] ${payload.blogUrl || ""}`,
  ].join("\n");

  const validation = collection.posts.map((post, index) =>
    `${index + 1}. ${post.title} / 전문 ${post.charCount}자 / ${post.validation}`
  ).join("\n");

  return [
    "[사업 정보]",
    business,
    "",
    "[전문 수집 검증]",
    `수집 방식: ${collection.method}`,
    `전문 수집 글 수: ${collection.postCount}`,
    validation,
    "",
    "[브라우저로 수집한 게시글 전문]",
    collection.combinedText,
    "",
    "위 전문만 근거로 진단하라. 검색 성과나 매출·문의 성과는 추측하지 말라.",
  ].join("\n");
}
