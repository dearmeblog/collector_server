# 디어미 전문 수집 서버 v4.1 안정화 버전

RSS는 게시글 URL을 찾는 용도로만 사용합니다. AI에는 실제 브라우저가 렌더링한 본문 전문만 전달합니다.

## v4.1 안정화 내용

- Browserless가 설정된 경우 Browserless Stealth를 우선 사용
- 게시글을 동시에 3개 열던 방식을 1개씩 순차 수집으로 변경
- Browserless CDP 세션에서 `page.route()`를 사용하지 않도록 수정
- 고정 대기 대신 네이버 본문 DOM이 나타날 때까지 대기
- 모바일 페이지와 PC 페이지를 각각 최대 3회 재시도
- 메인 페이지뿐 아니라 iframe 안의 본문도 검사
- 수집 실패 로그에 페이지 제목, 최종 URL, 본문 앞부분을 포함
- 전문 수집 실패 시 RSS 요약으로 대체하지 않음

## 권장 Browserless 환경변수

기본 안정화:

```text
BROWSERLESS_WS=wss://production-sfo.browserless.io/stealth?token=발급토큰&blockAds=true
```

Browserless 유료 프록시를 사용할 수 있을 때:

```text
BROWSERLESS_WS=wss://production-sfo.browserless.io/stealth?token=발급토큰&blockAds=true&proxy=residential&proxyCountry=kr&proxySticky=true&proxyLocaleMatch=true
```

CAPTCHA 자동 해결을 지원하는 요금제에서는 마지막에 다음 값을 추가할 수 있습니다.

```text
&solveCaptchas=true
```

토큰은 GitHub 코드에 넣지 말고 Render의 Environment에만 저장하세요.
