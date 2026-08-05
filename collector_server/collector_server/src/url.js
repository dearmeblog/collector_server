import { AppError } from "./errors.js";

export function cleanUrlInput(value) {
  let result = String(value || "").trim();
  const embedded = result.match(/https?:\/\/[^\s<>"']+/i);
  if (embedded) result = embedded[0];
  result = result.replace(/[),.;]+$/, "");

  if (/^@?[A-Za-z0-9._-]{2,80}$/.test(result)) {
    return `https://blog.naver.com/${result.replace(/^@/, "")}`;
  }
  if (/^(?:m\.)?blog\.naver\.com\//i.test(result) ||
      /^rss\.blog\.naver\.com\//i.test(result) ||
      /^naver\.me\//i.test(result)) {
    return `https://${result}`;
  }
  return result;
}

export async function resolveNaverUrl(rawUrl) {
  const normalized = cleanUrlInput(rawUrl);
  if (!/^https?:\/\//i.test(normalized)) {
    throw new AppError("INVALID_BLOG_URL", "네이버 블로그 주소 형식이 올바르지 않습니다.", {
      status: 400,
      retryable: false,
    });
  }

  let resolved = normalized;
  if (/^https?:\/\/naver\.me\//i.test(normalized)) {
    try {
      const response = await fetch(normalized, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": desktopUserAgent() },
        signal: AbortSignal.timeout(12000),
      });
      resolved = response.url || normalized;
    } catch (error) {
      throw new AppError("SHORT_URL_RESOLVE_FAILED", "네이버 공유 주소를 원문 주소로 변환하지 못했습니다.", {
        status: 422,
        retryable: true,
        cause: error,
      });
    }
  }

  const blogId = extractBlogId(resolved);
  return {
    blogId,
    canonicalBlogUrl: `https://blog.naver.com/${encodeURIComponent(blogId)}`,
    resolvedUrl: resolved,
  };
}

export function extractBlogId(url) {
  const value = String(url || "").trim();
  const query = value.match(/[?&]blogId=([^&#]+)/i);
  if (query?.[1]) return decodeURIComponent(query[1]);

  const rss = value.match(/rss\.blog\.naver\.com\/([^/?#]+?)(?:\.xml)?(?:[/?#]|$)/i);
  if (rss?.[1]) return decodeURIComponent(rss[1]);

  const path = value.match(/(?:m\.)?blog\.naver\.com\/([^/?#]+)/i);
  if (path?.[1] && !/^Post(?:List|View)\.naver$/i.test(path[1])) {
    return decodeURIComponent(path[1]);
  }

  throw new AppError("BLOG_ID_NOT_FOUND", "블로그 주소에서 네이버 블로그 아이디를 찾지 못했습니다.", {
    status: 422,
    retryable: false,
  });
}

export function extractPostIdentity(url, fallbackBlogId = "") {
  const value = String(url || "");
  const queryBlog = value.match(/[?&]blogId=([^&#]+)/i)?.[1];
  const queryLog = value.match(/[?&]logNo=(\d+)/i)?.[1];
  if (queryLog) {
    return {
      blogId: queryBlog ? decodeURIComponent(queryBlog) : fallbackBlogId,
      logNo: queryLog,
    };
  }

  const path = value.match(/(?:m\.)?blog\.naver\.com\/([^/?#]+)\/(\d+)/i);
  if (path) return { blogId: decodeURIComponent(path[1]), logNo: path[2] };
  return null;
}

export function postCandidates(url, fallbackBlogId) {
  const identity = extractPostIdentity(url, fallbackBlogId);
  if (!identity?.blogId || !identity?.logNo) return [url];
  const blogId = encodeURIComponent(identity.blogId);
  const logNo = encodeURIComponent(identity.logNo);
  return [
    `https://m.blog.naver.com/${blogId}/${logNo}`,
    `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}&redirect=Dlog`,
  ];
}

export function normalizePostUrl(url, fallbackBlogId) {
  return postCandidates(url, fallbackBlogId)[0];
}

export function desktopUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
}

export function mobileUserAgent() {
  return "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
}
