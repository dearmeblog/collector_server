import test from "node:test";
import assert from "node:assert/strict";
import { cleanUrlInput, extractBlogId, postCandidates } from "../src/url.js";

test("블로그 아이디만 입력해도 URL로 변환한다", () => {
  assert.equal(cleanUrlInput("royalcoffee_academ"), "https://blog.naver.com/royalcoffee_academ");
});

test("다양한 네이버 주소에서 블로그 아이디를 찾는다", () => {
  assert.equal(extractBlogId("https://blog.naver.com/royalcoffee_academ"), "royalcoffee_academ");
  assert.equal(extractBlogId("https://blog.naver.com/PostView.naver?blogId=royalcoffee_academ&logNo=123"), "royalcoffee_academ");
  assert.equal(extractBlogId("https://rss.blog.naver.com/royalcoffee_academ.xml"), "royalcoffee_academ");
});

test("게시글 주소를 모바일과 PC 후보로 만든다", () => {
  const candidates = postCandidates("https://blog.naver.com/royalcoffee_academ/12345", "royalcoffee_academ");
  assert.equal(candidates.length, 2);
  assert.match(candidates[0], /m\.blog\.naver\.com/);
  assert.match(candidates[1], /PostView\.naver/);
});
