/**
 * local-bridge (開発用プラグイン) の script 実行 (プラグイン側) の検査
 *
 * 実行: npm test
 * figma と figma.clientStorage の代わりに素のオブジェクトを渡し、行き先のファイルと合言葉の照合・実行・返り値の JSON 化を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as runDist from "../plugins/local-bridge/dist/run.mjs";
import type { RunResultBody, TokenStore } from "../plugins/local-bridge/src/run.ts";

const {
  MAX_RUN_RESULT_CHARS,
  ensureRunToken,
  exportRefusal,
  renewRunTokens,
  runScript,
  runTokenKey,
  sessionIdOf,
  wrongFileReason,
} =
  runDist as unknown as typeof import("../plugins/local-bridge/src/run.ts");

const OWN = "fileKeyA";

/** figma.clientStorage の代わり */
function memoryStore(entries: Record<string, unknown> = { [runTokenKey(OWN)]: "t1" }): TokenStore & {
  data: Map<string, unknown>;
} {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getAsync: async (key) => data.get(key),
    setAsync: async (key, value) => {
      data.set(key, value);
    },
    deleteAsync: async (key) => {
      data.delete(key);
    },
    keysAsync: async () => [...data.keys()],
  };
}

async function run(
  code: string,
  api: unknown = {},
  token = "t1",
  store: TokenStore = memoryStore(),
  fileKey: unknown = OWN
) {
  const body = await runScript({ code, token, fileKey, ownFileKey: OWN, store, api });
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
  assert.match(errorOf(await run("figma.ran = true;", api, "t1", memoryStore({}))), /合言葉がまだ無い.*実行していない/);
  assert.equal(api.ran, false, "合言葉が合わないのに実行した");
});

test("負例: 合言葉は依頼ごとに保存場所の最新の値と照合し、別のタブで作り直したあとの古い合言葉では実行しない", async () => {
  const store = memoryStore();
  assert.deepEqual(await run("return 1;", {}, "t1", store), { ok: true, value: 1 });
  // 同じファイルの合言葉が、別のタブで作り直された
  await store.setAsync(runTokenKey(OWN), "t2");
  const api = { ran: false };
  assert.match(errorOf(await run("figma.ran = true;", api, "t1", store)), /合言葉が違う.*実行していない/);
  assert.equal(api.ran, false, "作り直す前の合言葉で実行した");
  assert.deepEqual(await run("return 2;", {}, "t2", store), { ok: true, value: 2 });
});

test("負例: 合言葉はファイルごとで、別のファイルの合言葉や前の共通の合言葉では実行しない", async () => {
  assert.equal(runTokenKey(OWN), "devRunToken:fileKeyA");
  const api = { ran: false };
  const store = memoryStore({ [runTokenKey(OWN)]: "tA", [runTokenKey("fileKeyB")]: "tB" });
  assert.match(errorOf(await run("figma.ran = true;", api, "tB", store)), /合言葉が違う.*実行していない/);
  // 前の版が全ファイル共通で使っていたキーは読まない
  const legacy = memoryStore({ devRunToken: "t1" });
  assert.match(errorOf(await run("figma.ran = true;", api, "t1", legacy)), /合言葉がまだ無い.*実行していない/);
  assert.equal(api.ran, false, "このファイルのものでない合言葉で実行した");
});

test("合言葉は無ければ渡した候補で作り、あればそのまま使う", async () => {
  const store = memoryStore({});
  assert.equal(await ensureRunToken(store, OWN, "c1"), "c1");
  assert.equal(store.data.get(runTokenKey(OWN)), "c1");
  assert.equal(await ensureRunToken(store, OWN, "c2"), "c1", "作ってある合言葉を差し替えた");
  assert.equal(store.data.get(runTokenKey(OWN)), "c1");
});

test("負例: 作り直すと全ファイルの合言葉を消し、このファイルの分だけ作る。消えたファイルの古い合言葉では実行しない", async () => {
  const store = memoryStore({
    [runTokenKey(OWN)]: "tA",
    [runTokenKey("fileKeyB")]: "tB",
    devRunToken: "old",
    otherSetting: 1,
  });
  assert.equal(await renewRunTokens(store, OWN, "tA2"), "tA2");
  assert.deepEqual(Object.fromEntries(store.data), { [runTokenKey(OWN)]: "tA2", otherSetting: 1 });

  const api = { ran: false };
  assert.match(errorOf(await run("figma.ran = true;", api, "tA", store)), /合言葉が違う.*実行していない/);
  // B のタブはまだ開いたまま。キーが無いので、作り直す前の合言葉では実行しない
  const onB = await runScript({
    code: "figma.ran = true;",
    token: "tB",
    fileKey: "fileKeyB",
    ownFileKey: "fileKeyB",
    store,
    api,
  });
  assert.match(errorOf(JSON.parse(onB) as RunResultBody), /合言葉がまだ無い.*実行していない/);
  assert.equal(api.ran, false, "作り直したあと、前の合言葉で実行した");
});

test("負例: 例外と構文エラーは、理由つきの失敗にする", async () => {
  assert.match(errorOf(await run("throw new Error('boom');")), /途中で例外.*書き換えは残っている.*boom/);
  assert.match(errorOf(await run("return {")), /読めない.*実行していない.*SyntaxError/);
  // 文字列にできない値 (toString を持たないオブジェクト) を投げても、結果を返す (返さないとプラグインの待ちが止まる)
  assert.match(errorOf(await run("throw Object.create(null);")), /途中で例外/);
});

test("負例: JSON にできない返り値と、大きすぎる返り値は失敗にする", async () => {
  assert.match(errorOf(await run("return 1n;")), /最後まで実行した.*JSON にできない/);
  assert.match(errorOf(await run("const a = {}; a.self = a; return a;")), /JSON にできない/);
  const big = errorOf(await run(`return "x".repeat(${MAX_RUN_RESULT_CHARS});`));
  assert.match(big, /最後まで実行した.*大きすぎる/);
});

test("負例: 依頼の行き先のファイルがこの Local Bridge のファイルでなければ、実行しない理由を返す", () => {
  assert.equal(wrongFileReason("fileKeyA", "fileKeyA"), undefined);
  assert.match(wrongFileReason("fileKeyB", "fileKeyA") ?? "", /別のファイル \(fileKeyB\).*実行していない.*fileKeyA/);
  // 行き先を持たない依頼 (古い版の dev サーバー) も実行しない
  for (const missing of [undefined, null, ""]) {
    assert.match(wrongFileReason(missing, "fileKeyA") ?? "", /行き先のファイル.*無い.*実行していない/);
  }
});

test("負例: 別のファイル宛ての script は、合言葉が合っていても実行しない", async () => {
  const api = { ran: false };
  assert.match(
    errorOf(await run("figma.ran = true;", api, "t1", memoryStore(), "fileKeyB")),
    /別のファイル \(fileKeyB\).*実行していない/
  );
  assert.match(errorOf(await run("figma.ran = true;", api, "t1", memoryStore(), null)), /行き先のファイル.*無い/);
  assert.equal(api.ran, false, "別のファイル宛ての script を実行した");
});

test("負例: 2 つのタブが同時に合言葉を初めて作っても、どちらも保存された合言葉を返す", async () => {
  const store = memoryStore({});
  const [first, second] = await Promise.all([ensureRunToken(store, OWN, "c1"), ensureRunToken(store, OWN, "c2")]);
  const stored = store.data.get(runTokenKey(OWN));
  assert.equal(first, stored, "画面に出す合言葉と保存された合言葉が食い違う");
  assert.equal(second, stored);
});

test("負例: 別のファイル宛て・行き先の無い書き出しの依頼は、書き出さない理由を返す", () => {
  assert.equal(exportRefusal({ fileKey: OWN }, OWN), undefined);
  assert.match(exportRefusal({ fileKey: "fileKeyB" }, OWN) ?? "", /別のファイル \(fileKeyB\) 宛ての書き出しの依頼なので書き出していない.*fileKeyA/);
  for (const fileKey of [undefined, null, ""]) {
    assert.match(exportRefusal({ fileKey }, OWN) ?? "", /行き先のファイル.*無いので書き出していない/);
  }
});

test("負例: 画面の sessionId は数か文字列のときだけ取り、権限が無い (例外)・currentUser が無いときは取れないとする", () => {
  assert.equal(sessionIdOf({ currentUser: { sessionId: 38648 } }), "38648");
  assert.equal(sessionIdOf({ currentUser: { sessionId: "38649" } }), "38649");
  const noPermission = {
    get currentUser(): unknown {
      throw new Error("Cannot access currentUser without the currentuser permission");
    },
  };
  assert.equal(sessionIdOf(noPermission), undefined);
  for (const api of [{ currentUser: null }, {}, { currentUser: { sessionId: "" } }, { currentUser: { sessionId: Number.NaN } }]) {
    assert.equal(sessionIdOf(api), undefined, JSON.stringify(api));
  }
});
