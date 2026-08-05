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

const POST_READY_SELECTORS = [
  ".se-main-container",
  "#postViewArea",
  ".post_ct",
  ".se_component_wrap.__se_component_area",
  "#viewTypeSelector",
];

export async function collectFullBlog(rawBlogUrl) {
  const resolved = await resolveNaverUrl(rawBlogUrl);
  let links = await discoverFromRss(resolved.blogId).catch(() => []);

  // RSS는 URL 발견에만 사용합니다. description/content는 절대 읽지 않습니다.
  if (links.length < config.postCount) {
    const providers = preferredProviders();
    for (const provider of providers) {
      const discovered = await discoverWithBrowser(
        resolved.canonicalBlogUrl,
        resolved.blogId,
        provider,
      ).catch(() => []);
      links = dedupe([...links, ...discovered]);
      if (links.length >= config.postCount) break;
    }
  }

  links = links.slice(0, config.postCount);
  if (!links.length) {
    throw new AppError("POST_LINKS_NOT_FOUND", "최근 공개 게시글 주소를 찾지 못했습니다.", {
      status: 422,
      retryable: true,
    });
  }

  const providers = preferredProviders();
  let posts = [];
  let remaining = [...links];
  const allFailures = [];
  const methods = [];

  for (const provider of providers) {
    if (!remaining.length) break;

    const result = await collectWithProvider(provider, remaining, resolved.blogId);
    posts = mergePosts(posts, result.posts);
    allFailures.push(...result.failures.map((failure) => ({ ...failure, provider })));
    remaining = remaining.filter((url) =>
      !posts.some((post) => samePost(post.url, url, resolved.blogId))
    );
    methods.push(provider === "browserless" ? "Browserless Stealth" : "Render Playwright Chromium");
  }

  posts = orderPosts(posts, links, resolved.blogId).slice(0, config.postCount);

  if (posts.length < config.minFullPosts) {
    throw new AppError(
      "FULLTEXT_NOT_ENOUGH",
      `게시글 전문 수집에 성공한 글이 ${posts.length}개입니다.`,
      {
        status: 422,
        retryable: true,
        details: allFailures.slice(-20),
      },
    );
  }

  const combined = formatPosts(posts).slice(0, config.maxTotalChars);
  return {
    blogId: resolved.blogId,
    blogUrl: resolved.canonicalBlogUrl,
    method: methods.join(" → "),
    fulltextOnly: true,
    postCount: posts.length,
    posts,
    combinedText: combined,
    failedPosts: allFailures,
  };
}

function preferredProviders() {
  if (config.browserlessWs && config.browserlessPrimary) {
    return ["browserless", "local"];
  }
  return config.browserlessWs ? ["local", "browserless"] : ["local"];
}

async function discoverFromRss(blogId) {
  const response = await fetch(
    `https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`,
    {
      redirect: "follow",
      headers: {
        "User-Agent": desktopUserAgent(),
        "Accept": "application/rss+xml, application/xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const rawItems = parsed?.rss?.channel?.item || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return dedupe(
    items
      .map((item) => (typeof item?.link === "string" ? item.link : item?.link?.["#text"]))
      .filter(Boolean)
      .map((url) => normalizePostUrl(url, blogId)),
  );
}

async function discoverWithBrowser(_blogUrl, blogId, provider) {
  const session = await openBrowser(provider);
  try {
    const context = await getContext(session, provider, true);
    const page = await context.newPage();
    try {
      await configurePage(page, provider);
      await page.goto(`https://m.blog.naver.com/${encodeURIComponent(blogId)}`, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
      await page.waitForTimeout(2200);
      await autoScroll(page, 6);

      const links = await page.locator("a[href]").evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.href)
      );

      return dedupe(
        links
          .filter((href) =>
            new RegExp(
              `(?:m\\.)?blog\\.naver\\.com/${escapeRegExp(blogId)}/\\d+`,
              "i",
            ).test(href)
          )
          .map((href) => normalizePostUrl(href, blogId)),
      );
    } finally {
      await page.close().catch(() => {});
      if (provider === "local") await context.close().catch(() => {});
    }
  } finally {
    await session.browser.close().catch(() => {});
  }
}

async function collectWithProvider(provider, links, blogId) {
  let session;
  try {
    session = await openBrowser(provider);
    const limit = pLimit(config.concurrency);

    const results = await Promise.all(
      links.map((url) =>
        limit(async () => {
          try {
            const post = await collectOnePost({
              session,
              provider,
              url,
              blogId,
            });
            return { ok: true, post };
          } catch (error) {
            return {
              ok: false,
              failure: {
                url,
                message: error?.message || String(error),
              },
            };
          }
        }),
      ),
    );

    return {
      posts: results.filter((result) => result.ok).map((result) => result.post),
      failures: results.filter((result) => !result.ok).map((result) => result.failure),
    };
  } catch (error) {
    return {
      posts: [],
      failures: links.map((url) => ({
        url,
        message: `${provider} 브라우저 연결 실패: ${error?.message || error}`,
      })),
    };
  } finally {
    if (session?.browser) await session.browser.close().catch(() => {});
  }
}

async function openBrowser(provider) {
  if (provider === "browserless") {
    if (!config.browserlessWs) throw new Error("BROWSERLESS_WS가 설정되지 않았습니다.");
    const browser = await chromium.connectOverCDP(config.browserlessWs, {
      timeout: 30000,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Browserless 기본 컨텍스트가 없습니다.");
    return { browser, remoteContext: context };
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--lang=ko-KR",
    ],
  });
  return { browser, remoteContext: null };
}

async function getContext(session, provider, mobile) {
  if (provider === "browserless") return session.remoteContext;

  return session.browser.newContext({
    userAgent: mobile ? mobileUserAgent() : desktopUserAgent(),
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: mobile
      ? { width: 412, height: 1600 }
      : { width: 1365, height: 1800 },
    extraHTTPHeaders: {
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
    },
  });
}

async function collectOnePost({ session, provider, url, blogId }) {
  const candidates = postCandidates(url, blogId);
  const errors = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const mobile = candidate.includes("m.blog");
      let context = null;
      let page = null;

      try {
        context = await getContext(session, provider, mobile);
        page = await context.newPage();
        await configurePage(page, provider);
        page.setDefaultTimeout(config.navigationTimeoutMs);

        const response = await page.goto(candidate, {
          waitUntil: "domcontentloaded",
          timeout: config.navigationTimeoutMs,
        });
        if (response && response.status() >= 400) {
          throw new Error(`HTTP ${response.status()}`);
        }

        // 고정 지연만 사용하지 않고 실제 본문 DOM이 나타날 때까지 기다립니다.
        await waitForPostReady(page);
        await page.waitForTimeout(900 + attempt * 500);
        await autoScroll(page, 8);

        const extracted = await extractFromPageAndFrames(page);
        const validation = validateFullPost(extracted, config.minBodyChars);
        if (!validation.ok) {
          throw new Error(
            `${validation.reason} / title=${extracted.documentTitle || ""} / ` +
            `url=${extracted.renderedUrl || candidate} / preview=${String(extracted.bodyText || "").slice(0, 180)}`
          );
        }

        return {
          url: normalizePostUrl(candidate, blogId),
          title: extracted.title || extracted.documentTitle || "제목 확인 불가",
          bodyText: extracted.bodyText.slice(0, config.maxPostChars),
          charCount: extracted.bodyText.length,
          rootSelector: extracted.rootSelector,
          links: extracted.links.slice(0, 100),
          imageAlts: extracted.imageAlts,
          phoneNumbers: extracted.phoneNumbers,
          ctaSentences: extracted.ctaSentences,
          provider,
          validation: validation.reason,
        };
      } catch (error) {
        errors.push(`${candidate} #${attempt}: ${error?.message || error}`);
        await page?.waitForTimeout(600 * attempt).catch(() => {});
      } finally {
        if (page) await page.close().catch(() => {});
        if (provider === "local" && context) await context.close().catch(() => {});
      }
    }
  }

  throw new Error(errors.join(" | ").slice(0, 4500));
}

async function configurePage(page, provider) {
  // Browserless의 CDP 연결에서는 page.route()가 불안정할 수 있으므로 사용하지 않습니다.
  if (provider !== "local") return;

  await page.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (["media", "font"].includes(type)) return route.abort();
    return route.continue();
  });
}

async function waitForPostReady(page) {
  const selector = POST_READY_SELECTORS.join(",");
  try {
    await page.waitForSelector(selector, {
      state: "attached",
      timeout: config.postReadyTimeoutMs,
    });
  } catch (_) {
    // PC 블로그 페이지의 iframe이 늦게 생기는 경우도 있어 프레임까지 검사합니다.
    const deadline = Date.now() + Math.min(config.postReadyTimeoutMs, 12000);
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          if (await frame.locator(selector).count()) return;
        } catch (_) {}
      }
      await page.waitForTimeout(500);
    }
  }
}

async function extractFromPageAndFrames(page) {
  const candidates = [];

  for (const frame of page.frames()) {
    try {
      const result = await extractRenderedPost(frame);
      if (result?.bodyText) candidates.push(result);
    } catch (_) {}
  }

  if (!candidates.length) {
    return {
      title: "",
      bodyText: "",
      rootSelector: "none",
      links: [],
      imageAlts: [],
      phoneNumbers: [],
      ctaSentences: [],
      renderedUrl: page.url(),
      documentTitle: await page.title().catch(() => ""),
    };
  }

  candidates.sort((a, b) => {
    const aScore = extractionScore(a);
    const bScore = extractionScore(b);
    return bScore - aScore;
  });
  return candidates[0];
}

function extractionScore(post) {
  const textLength = String(post?.bodyText || "").length;
  const selectorBonus = post?.rootSelector === "body-fallback" ? 0 : 5000;
  const ctaBonus = (post?.ctaSentences?.length || 0) * 20;
  return textLength + selectorBonus + ctaBonus;
}

async function autoScroll(page, steps) {
  for (let i = 0; i < steps; i += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(650, window.innerHeight * 0.78));
    }).catch(() => {});
    await page.waitForTimeout(280);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

function formatPosts(posts) {
  return posts
    .map((post, index) =>
      [
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
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function orderPosts(posts, links, blogId) {
  return [...posts].sort((a, b) => {
    const ai = links.findIndex((url) => samePost(a.url, url, blogId));
    const bi = links.findIndex((url) => samePost(b.url, url, blogId));
    return ai - bi;
  });
}

function samePost(a, b, blogId) {
  return normalizePostUrl(a, blogId) === normalizePostUrl(b, blogId);
}

function mergePosts(primary, fallback) {
  const map = new Map();
  for (const post of [...primary, ...fallback]) {
    const key = post.url;
    const previous = map.get(key);
    if (!previous || post.charCount > previous.charCount) map.set(key, post);
  }
  return [...map.values()];
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
