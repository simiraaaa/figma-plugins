/**
 * structure-dump の開発ループの script 実行 (プラグイン側) の検査
 *
 * 実行: npm test
 * figma の代わりに素のオブジェクトを渡し、合言葉の照合・実行・返り値の JSON 化を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as runDist from "../plugins/structure-dump/dist/run.mjs";
import type { RunResultBody } from "../plugins/structure-dump/src/run.ts";

const { MAX_RUN_RESULT_CHARS, runScript } =
  runDist as unknown as typeof import("../plugins/structure-dump/src/run.ts");

async function run(code: string, api: unknown = {}, token = "t1", options: { expectedToken?: string } = { expectedToken: "t1" }) {
  const body = await runScript({ code, token, expectedToken: options.expectedToken, api });
  assert.ok(body.length <= MAX_RUN_RESULT_CHARS, `本文が上限を超えた: ${body.length}`);
  return JSON.parse(body) as RunResultBody;
}

function errorOf(body: RunResultBody): string {
  assert.equal(body.ok, false, `失敗にならなかった: ${JSON.stringify(body)}`);
  return (body as { error: string }).error;
}

test("合言葉が合えば、figma を渡してコードを async 関数として実行し、返り値を JSON で返す", async () => {
  const api = { currentPage: { name: "Page 1" } };
  assert.deepEqual(await run("await null; return { name: figma.currentPage.name };", api), {
    ok: true,
    value: { name: "Page 1" },
  });
});

test("return しなければ value を持たない", async () => {
  assert.deepEqual(await run("figma.touched = true;", {}), { ok: true });
});

// 失敗の理由には、実行したかどうか (途中までの書き換えが残りうるか) を書く。依頼した側が送り直してよいかを決めるため
test("負例: 合言葉が違う・まだ無いときは、コードを実行せずに失敗を返す", async () => {
  const api = { ran: false };
  assert.match(errorOf(await run("figma.ran = true;", api, "wrong")), /合言葉が違う.*実行していない/);
  assert.match(errorOf(await run("figma.ran = true;", api, "t1", {})), /合言葉がまだ無い.*実行していない/);
  assert.equal(api.ran, false, "合言葉が合わないのに実行した");
});

test("負例: 例外と構文エラーは、理由つきの失敗にする", async () => {
  assert.match(errorOf(await run("throw new Error('boom');")), /途中で例外.*書き換えは残っている.*boom/);
  assert.match(errorOf(await run("return {")), /読めない.*実行していない.*SyntaxError/);
});

test("負例: JSON にできない返り値と、大きすぎる返り値は失敗にする", async () => {
  assert.match(errorOf(await run("return 1n;")), /最後まで実行した.*JSON にできない/);
  assert.match(errorOf(await run("const a = {}; a.self = a; return a;")), /JSON にできない/);
  const big = errorOf(await run(`return "x".repeat(${MAX_RUN_RESULT_CHARS});`));
  assert.match(big, /最後まで実行した.*大きすぎる/);
});
