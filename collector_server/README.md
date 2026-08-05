# 디어미 전문 수집 서버 v4

이 서버는 네이버 RSS나 검색 API에서 **게시글 링크만 발견**합니다. AI 분석 자료에는 RSS 설명문이나 검색 요약문을 넣지 않습니다.

각 게시글을 Chromium 브라우저로 직접 열어 다음 항목을 수집합니다.

- 게시글 제목
- 렌더링된 본문 전문
- 본문 링크와 링크 문구
- 전화번호
- 문의·상담·예약 등 CTA 문장
- 이미지 대체문구

본문 전문 검증에 통과한 글이 1개 이상 있어야 AI 진단을 실행합니다.

## 기본 수집 경로

1. Docker 안의 Playwright Chromium
2. 실패한 글만 Browserless로 재시도—선택 설정
3. Google Sheets에서 최대 5차례 시간차 자동 재시도

## 로컬 실행

```bash
cp .env.example .env
npm install
npm start
```

상태 확인:

```text
http://localhost:10000/health
```

## 필수 환경변수

- `SHARED_SECRET`: Apps Script와 수집 서버가 같이 사용하는 긴 임의 문자열
- `OPENAI_API_KEY`: OpenAI Platform에서 발급한 API 키
- `OPENAI_MODEL`: 기본값 `gpt-5-mini`

## Browserless 보조 경로

기본 Playwright 수집만으로 먼저 운영할 수 있습니다. 차단이나 지역별 접속 문제까지 보완하려면 다음 환경변수를 추가합니다.

```text
BROWSERLESS_WS=wss://production-sfo.browserless.io/chromium/stealth?token=발급토큰
```

RSS 요약은 Browserless 설정 여부와 관계없이 분석 자료로 사용하지 않습니다.
