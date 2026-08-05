import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import {
  desktopUserAgent,
  mobileUserAgent,
  normalizePostUrl,
  postCandidates,
  resolveNaverUrl,
} from "./url.js";
import { extractRenderedPost, validateFullPost } from "./extract.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  trimValues: true,
});

export async function collectFullBlog(rawBlogUrl) {
  const resolved = await resolveNaverUrl(rawBlogUrl);
  let links = await discoverFromRss(resolved.blogId).catch(() => []);

  if (links.length < config.postCount) {
    const discovered = await discoverWithBrowser(resolved.canonicalBlogUrl, resolved.blogId, "local").catch(() => []);
    links = dedupe([...links, ...discovered]);
  }

  if (links.length < config.postCount && config.browserlessWs) {
    const remoteDiscovered = await discoverWithBrowser(resolved.canonicalBlogUrl, resolved.blogId, "browserless").catch(() => []);
    links = dedupe([...links, ...remoteDiscovered]);
  }

  links = links.slice(0, config.postCount);
  if (!links.length) {
    throw new AppError("POST_LINKS_NOT_FOUND", "최근 공개 게시글 주소를 찾지 못했습니다.", {
      status: 422,
      retryable: true,
    });
  }

  const localResult = await collectWithProvider("local", links, resolved.blogId);
  let posts = localResult.posts;
  let failures = localResult.failures;
  const methods = ["Playwright Chromium"];

  if (failures.length && config.browserlessWs) {
    const remoteResult = await collectWithProvider(
      "browserless",
      failures.map((item) => item.url),
      resolved.blogId,
    );
    posts = mergePosts(posts, remoteResult.posts);
    failures = remoteResult.failures;
    methods.push("Browserless fallback");
  }

  posts = posts
    .sort((a, b) => links.indexOf(a.url) - links.indexOf(b.url))
    .slice(0, config.postCount);

  if (posts.length < config.minFullPosts) {
    throw new AppError("FULLTEXT_NOT_ENOUGH", `전문 수집에 성공한 글이 ${posts.length}개입니다.`, {
      status: 422,
      retryable: true,
      details: failures,
    });
  }

  const combined = formatPosts(posts).slice(0, config.maxTotalChars);
  return {
    blogId: resolved.blogId,
    blogUrl: resolved.canonicalBlogUrl,
    method: methods.join(" + "),
    fulltextOnly: true,
    postCount: posts.length,
    posts,
    combinedText: combined,
    failedPosts: failures,
  };
}

async function discoverFromRss(blogId) {
  const response = await fetch(`https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`, {
    redirect: "follow",
    headers: { "User-Agent": desktopUserAgent(), Accept: "application/rss+xml, application/xml" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const rawItems = parsed?.rss?.channel?.item || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return dedupe(items
    .map((item) => typeof item?.link === "string" ? item.link : item?.link?.["#text"])
    .filter(Boolean)
    .map((url) => normalizePostUrl(url, blogId)));
}

async function discoverWithBrowser(blogUrl, blogId, provider) {
  const browser = provider === "browserless"
    ? await chromium.connectOverCDP(config.browserlessWs, { timeout: 20000 })
    : await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  let context = null;
  let ownsContext = false;
  try {
    if (provider === "browserless") {
      context = browser.contexts()[0];
      if (!context) throw new Error("Browserless 기본 컨텍스트가 없습니다.");
    } else {
      context = await browser.newContext({ userAgent: mobileUserAgent(), locale: "ko-KR" });
      ownsContext = true;
    }
    const page = await context.newPage();
    await page.goto(`https://m.blog.naver.com/${encodeURIComponent(blogId)}`, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    await page.waitForTimeout(1800);
    await autoScroll(page, 4);
    const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.href));
    await page.close();
    return dedupe(links
      .filter((href) => new RegExp(`m\\.blog\\.naver\\.com/${escapeRegExp(blogId)}/\\d+`, "i").test(href))
      .map((href) => normalizePostUrl(href, blogId)));
  } finally {
    if (ownsContext && context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function collectWithProvider(provider, links, blogId) {
  let browser;
  let remoteDefaultContext = null;

  try {
    if (provider === "browserless") {
      browser = await chromium.connectOverCDP(config.browserlessWs, { timeout: 20000 });
      remoteDefaultContext = browser.contexts()[0] || null;
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
      });
    }

    const limit = pLimit(3);
    const results = await Promise.all(links.map((url) => limit(async () => {
      try {
        const post = await collectOnePost({ browser, provider, remoteDefaultContext, url, blogId });
        return { ok: true, post };
      } catch (error) {
        return { ok: false, failure: { url, message: error?.message || String(error) } };
      }
    })));

    return {
      posts: results.filter((result) => result.ok).map((result) => result.post),
      failures: results.filter((result) => !result.ok).map((result) => result.failure),
    };
  } catch (error) {
    return {
      posts: [],
      failures: links.map((url) => ({ url, message: `${provider} 브라우저 연결 실패: ${error?.message || error}` })),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function collectOnePost({ browser, provider, remoteDefaultContext, url, blogId }) {
  const candidates = postCandidates(url, blogId);
  const errors = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let context = null;
      let page = null;
      try {
        if (provider === "browserless") {
          context = remoteDefaultContext || browser.contexts()[0];
          if (!context) throw new Error("Browserless 기본 컨텍스트가 없습니다.");
        } else {
          context = await browser.newContext({
            userAgent: candidate.includes("m.blog") ? mobileUserAgent() : desktopUserAgent(),
            locale: "ko-KR",
            timezoneId: "Asia/Seoul",
            viewport: { width: 1280, height: 1600 },
          });
        }

        page = await context.newPage();
        page.setDefaultTimeout(config.navigationTimeoutMs);
        await page.route("**/*", async (route) => {
          const type = route.request().resourceType();
          if (["media", "font"].includes(type)) return route.abort();
          return route.continue();
        });

        const response = await page.goto(candidate, {
          waitUntil: "domcontentloaded",
          timeout: config.navigationTimeoutMs,
        });
        if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);

        await page.waitForTimeout(1200 + attempt * 500);
        await autoScroll(page, 5);
        const extracted = await extractRenderedPost(page);
        const validation = validateFullPost(extracted, config.minBodyChars);
        if (!validation.ok) throw new Error(validation.reason);

        return {
          url: normalizePostUrl(candidate, blogId),
          title: extracted.title || extracted.documentTitle || "제목 확인 불가",
          bodyText: extracted.bodyText.slice(0, config.maxPostChars),
          charCount: extracted.bodyText.length,
          rootSelector: extracted.rootSelector,
          links: extracted.links.slice(0, 80),
          imageAlts: extracted.imageAlts,
          phoneNumbers: extracted.phoneNumbers,
          ctaSentences: extracted.ctaSentences,
          provider,
          validation: validation.reason,
        };
      } catch (error) {
        errors.push(`${candidate} #${attempt}: ${error?.message || error}`);
      } finally {
        if (page) await page.close().catch(() => {});
        if (provider !== "browserless" && context) await context.close().catch(() => {});
      }
    }
  }

  throw new Error(errors.join(" | ").slice(0, 1600));
}

async function autoScroll(page, steps) {
  for (let i = 0; i < steps; i += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(700, window.innerHeight * 0.85)));
    await page.waitForTimeout(220);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

function formatPosts(posts) {
  return posts.map((post, index) => [
    `[전문 게시글 ${index + 1}]`,
    `제목: ${post.title}`,
    `URL: ${post.url}`,
    `브라우저 전문 글자 수: ${post.charCount}`,
    `본문 컨테이너: ${post.rootSelector}`,
    "본문 전문:",
    post.bodyText,
    "본문 링크:",
    post.links.map((link) => `- ${link.text || "링크"}: ${link.href}`).join("\n") || "- 없음",
    "CTA 관련 문장:",
    post.ctaSentences.map((line) => `- ${line}`).join("\n") || "- 확인되지 않음",
  ].join("\n")).join("\n\n---\n\n");
}

function mergePosts(primary, fallback) {
  const map = new Map();
  for (const post of [...primary, ...fallback]) {
    const previous = map.get(post.url);
    if (!previous || post.charCount > previous.charCount) map.set(post.url, post);
  }
  return [...map.values()];
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
