import test from "node:test";
import assert from "node:assert/strict";
import { validateFullPost } from "../src/extract.js";

test("충분한 브라우저 전문은 통과한다", () => {
  const post = { bodyText: "전문 본문입니다. ".repeat(100), rootSelector: ".se-main-container" };
  assert.equal(validateFullPost(post, 600).ok, true);
});

test("짧은 요약은 거부한다", () => {
  const post = { bodyText: "짧은 요약", rootSelector: ".se-main-container" };
  assert.equal(validateFullPost(post, 600).ok, false);
});
