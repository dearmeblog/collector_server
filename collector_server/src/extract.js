const ROOT_SELECTORS = [
  "[data-a11y-title='본문']",
  ".se-viewer",
  ".se-module-text",
  ".se-main-container",
  "#postViewArea",
  ".post_ct",
  ".se_component_wrap.__se_component_area",
  "#viewTypeSelector",
  "article",
  "main",
];

const TITLE_SELECTORS = [
  ".se-documentTitle .se-text-paragraph",
  ".se-documentTitle",
  ".se-title-text",
  ".se_title .se_textView",
  ".pcol1",
  "h3.se_textarea",
  "h1",
  "meta[property='og:title']",
];

export async function extractRenderedPost(page) {
  return page.evaluate(({ rootSelectors, titleSelectors }) => {
    const normalize = (value) => String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const metaContent = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
    let title = "";
    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      const candidate = selector.startsWith("meta")
        ? metaContent(selector)
        : element?.innerText || element?.textContent || "";
      if (normalize(candidate).length > title.length) title = normalize(candidate);
    }

    const candidates = [];
    for (const selector of rootSelectors) {
      document.querySelectorAll(selector).forEach((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        if (text) candidates.push({ selector, element, text });
      });
    }

    if (!candidates.length) {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script,style,noscript,nav,header,footer,button,svg,iframe").forEach((node) => node.remove());
      candidates.push({ selector: "body-fallback", element: document.body, text: normalize(clone.innerText || clone.textContent || "") });
    }

    candidates.sort((a, b) => b.text.length - a.text.length);
    const selected = candidates[0];
    const root = selected.element;

    const links = [...root.querySelectorAll("a[href]")].map((anchor) => ({
      text: normalize(anchor.innerText || anchor.textContent || "").slice(0, 180),
      href: anchor.href,
    })).filter((item) => item.href && !item.href.startsWith("javascript:"));

    const imageAlts = [...root.querySelectorAll("img")]
      .map((image) => normalize(image.alt || image.getAttribute("data-alt") || ""))
      .filter(Boolean)
      .slice(0, 80);

    const text = selected.text;
    const phoneNumbers = [...new Set(text.match(/(?:0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}/g) || [])];
    const ctaKeywords = ["문의", "상담", "예약", "신청", "전화", "카카오", "톡톡", "오시는 길", "위치", "수강"];
    const ctaSentences = text.split(/\n+/)
      .map(normalize)
      .filter((line) => line.length >= 2 && ctaKeywords.some((keyword) => line.includes(keyword)))
      .slice(-20);

    return {
      title,
      bodyText: text,
      rootSelector: selected.selector,
      links,
      imageAlts,
      phoneNumbers,
      ctaSentences,
      renderedUrl: location.href,
      documentTitle: document.title,
    };
  }, { rootSelectors: ROOT_SELECTORS, titleSelectors: TITLE_SELECTORS });
}

export function validateFullPost(post, minChars) {
  const body = String(post?.bodyText || "").trim();
  const rejectionPatterns = [
    /비공개 (?:글|게시물)/,
    /로그인이 필요/,
    /존재하지 않는 (?:글|게시물|페이지)/,
    /접근 권한이 없/,
    /삭제되었거나 없는 게시물/,
    /서비스 이용이 제한/,
  ];

  if (body.length < minChars) {
    return { ok: false, reason: `본문 ${body.length}자: 최소 ${minChars}자 미달` };
  }
  if (rejectionPatterns.some((pattern) => pattern.test(body))) {
    return { ok: false, reason: "비공개·삭제·접근 제한 페이지로 판단됨" };
  }
  if (post.rootSelector === "body-fallback" && body.length < minChars * 2) {
    return { ok: false, reason: "게시글 본문 컨테이너를 찾지 못함" };
  }
  return { ok: true, reason: "브라우저 렌더링 전문 확인" };
}
