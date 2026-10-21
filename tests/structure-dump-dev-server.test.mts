/**
 * structure-dump の開発ループ (dev サーバー) の検査
 *
 * 実行: npm test
 * AI (curl) とプラグインの UI の役を fetch で演じ、依頼 → long-poll → 結果の展開の往復を見る。
 * ポートの値がサーバー・manifest・ui.html でそろっていること、配る manifest から開発用の設定が外れることも見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDevServer,
  DEV_PORT,
  type DevServerOptions,
  type DevStatus,
  type DumpRequest,
  entryPath,
  parseExportBody,
  type PluginState,
  readStoredZip,
  type StatusReply,
} from "../scripts/dev-server-lib.mts";
import { releaseManifest } from "../scripts/release-lib.mts";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as zipDist from "../plugins/structure-dump/dist/zip.mjs";
const { buildZip, utf8Encode } =
  zipDist as unknown as typeof import("../plugins/structure-dump/src/zip.ts");

type Next = DumpRequest & { server: string };

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sampleZip(): Uint8Array {
  return buildZip([
    { name: "README.md", data: utf8Encode("# 読み方") },
    {
      name: "index.json",
      data: utf8Encode(JSON.stringify({ meta: { fileName: "Rabee UI", warnings: ["パスが長い"] } })),
    },
    { name: "画面.1-2/ボタン.3-4.json", data: utf8Encode("{}") },
  ]);
}

async function startServer(
  outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-")),
  options: Partial<DevServerOptions> = {}
): Promise<{ base: string; port: number; outDir: string; close: () => void }> {
  const server = http.createServer(createDevServer({ outDir, ...options }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    outDir,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** プラグインの UI の iframe と同じく Origin: null で送る */
const PLUGIN = { Origin: "null" };

function pluginNext(base: string, query = "", signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/next${query}`, { headers: PLUGIN, signal });
}

function pluginPost(
  base: string,
  route: "result" | "error",
  next: { seq: number; server: string },
  body: Uint8Array | string
): Promise<Response> {
  return fetch(`${base}/${route}?seq=${next.seq}&server=${next.server}`, {
    method: "POST",
    headers: PLUGIN,
    body,
  });
}

/** long-poll がまだ返っていないことを見る (ms 以内に返れば中身を、返らなければ "pending") */
async function settleWithin(promise: Promise<Response>, ms: number): Promise<Response | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

test("ZIP を読み戻せて、壊れたバイト列は CRC で落ちる", () => {
  const zip = sampleZip();
  const files = readStoredZip(zip);
  assert.deepEqual(
    files.map((f) => f.name),
    ["README.md", "index.json", "画面.1-2/ボタン.3-4.json"]
  );
  assert.equal(new TextDecoder().decode(files[0].data), "# 読み方");

  const broken = zip.slice();
  broken[40] ^= 0xff; // 最初のエントリ (README.md) の中身
  assert.throws(() => readStoredZip(broken), /CRC が合わない: README\.md/);
});

test("展開先の外を指すパスは断る", () => {
  const dir = path.join(tmpdir(), "out");
  assert.equal(entryPath(dir, "a/b.json"), path.join(dir, "a", "b.json"));
  assert.throws(() => entryPath(dir, "../x.json"), /展開先の外/);
  assert.throws(() => entryPath(dir, "a/../../x.json"), /展開先の外/);
  assert.throws(() => entryPath(dir, "/etc/x.json"), /展開先の外/);
});

test("依頼の本文: 空なら選択、nodeIds と scale を受け、形が違えば断る", () => {
  assert.deepEqual(parseExportBody(""), {});
  assert.deepEqual(parseExportBody('{"nodeIds":["1:2"],"scale":1}'), { nodeIds: ["1:2"], scale: 1 });
  assert.throws(() => parseExportBody('{"nodeIds":[]}'), /nodeIds/);
  assert.throws(() => parseExportBody('{"nodeIds":"1:2"}'), /nodeIds/);
  assert.throws(() => parseExportBody('{"scale":3}'), /scale/);
  assert.throws(() => parseExportBody('{"node":"1:2"}'), /知らないキー: node/);
  assert.throws(() => parseExportBody("[]"), /オブジェクト/);
});

test("依頼 → プラグインが取る → 結果を送ると、依頼した側に展開先が返る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    // プラグインの UI は起動直後 after 無しで聞き、最後の依頼を受け取る
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"] }),
    });
    const next = await json<Next>(polled);
    assert.equal(next.seq, 1);
    assert.deepEqual(next.nodeIds, ["1:2"]);
    assert.equal(typeof next.server, "string");

    const posted = await pluginPost(base, "result", next, sampleZip());
    assert.equal(posted.status, 200);

    const res = await exported;
    assert.equal(res.status, 200);
    const status = await json<DevStatus>(res);
    assert.equal(status.version, 1);
    assert.equal(status.seq, 1);
    assert.deepEqual(status.nodeIds, ["1:2"]);
    assert.equal(status.fileName, "Rabee UI");
    assert.equal(status.files, 3);
    assert.deepEqual(status.warnings, ["パスが長い"]);
    assert.equal(
      readFileSync(path.join(status.dir as string, "画面.1-2", "ボタン.3-4.json"), "utf8"),
      "{}"
    );
    assert.equal(realpathSync(path.join(outDir, "latest")), realpathSync(status.dir as string));
    assert.equal(JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8")).seq, 1);

    // 同じサーバーの続きを聞くと、新しい依頼が来るまで返らない
    const waiting = new AbortController();
    const pending = pluginNext(base, `?server=${next.server}&after=1`, waiting.signal);
    assert.equal(await settleWithin(pending, 200), "pending");
    waiting.abort();
    await pending.catch(() => {});

    // 走り直した (サーバーの id を知らない) プラグインには、最後の依頼をもう一度渡す
    assert.equal((await json<Next>(pluginNext(base))).seq, 1);
    assert.equal((await json<Next>(pluginNext(base, "?server=old-server&after=1"))).seq, 1);
  } finally {
    close();
  }
});

test("プラグインが失敗を送ると、依頼した側に 422 と理由が返る", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export`, { method: "POST", body: "" });
    const next = await json<Next>(polled);
    assert.equal(next.nodeIds, undefined);
    await pluginPost(base, "error", next, "ノードが見つからない: 9:9");
    const res = await exported;
    assert.equal(res.status, 422);
    assert.equal((await json<DevStatus>(res)).error, "ノードが見つからない: 9:9");
  } finally {
    close();
  }
});

test("status?after は新しい結果が届くまで待つ (build で走り直した結果を待つ使い方)", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export`, { method: "POST", body: "" });
    const next = await json<Next>(polled);
    await pluginPost(base, "result", next, sampleZip());
    await exported;

    const waiting = fetch(`${base}/status?after=1`);
    assert.equal(await settleWithin(waiting, 200), "pending");
    await pluginPost(base, "result", next, sampleZip());
    const res = await waiting;
    assert.equal(res.status, 200);
    assert.equal((await json<DevStatus>(res)).version, 2);
  } finally {
    close();
  }
});

test("起動し直しても版の番号は前回の続きから振り、新しい結果を消さない", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-"));
  for (let v = 31; v <= 50; v += 1) mkdirSync(path.join(outDir, "results", String(v)), { recursive: true });
  const { base, close } = await startServer(outDir);
  try {
    assert.equal((await json<DevStatus>(fetch(`${base}/status`))).version, 50);
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export`, { method: "POST", body: "" });
    await pluginPost(base, "result", await json<Next>(polled), sampleZip());
    const status = await json<DevStatus>(exported);
    assert.equal(status.version, 51);
    assert.equal(existsSync(path.join(outDir, "results", "51", "index.json")), true);
    assert.equal(realpathSync(path.join(outDir, "latest")), realpathSync(status.dir as string));
  } finally {
    close();
  }
});

test("起動し直した直後の status は、前回の最後の結果を返す", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-"));
  writeFileSync(
    path.join(outDir, "status.json"),
    JSON.stringify({ version: 7, seq: 3, dir: "/x/results/7", fileName: "Rabee UI", files: 4 })
  );
  const { base, close } = await startServer(outDir);
  try {
    const status = await json<DevStatus>(fetch(`${base}/status`));
    assert.equal(status.version, 7);
    assert.equal(status.fileName, "Rabee UI");
    assert.equal(status.dir, "/x/results/7");
  } finally {
    close();
  }
});

test("渡した依頼の結果がまだなら、プラグインから何も来なくても次の依頼を断らずに待たせる", async () => {
  const { base, close } = await startServer(undefined, { pluginStaleMs: 50 });
  try {
    const polled = pluginNext(base);
    const first = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    first.catch(() => {});
    const taken = await json<Next>(polled);
    // 重い書き出しのあいだは Figma ごと固まり、UI からは何も届かない
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fetch(`${base}/export?timeout=5`, { method: "POST", body: '{"nodeIds":["5:6"]}' });
    second.catch(() => {});
    assert.equal(await settleWithin(second, 200), "pending", "処理中なのに断った");

    const { plugin } = await json<StatusReply>(fetch(`${base}/status`));
    assert.equal(plugin.processing?.seq, 1);
    assert.equal(typeof plugin.processing?.elapsedSeconds, "number");
    assert.equal(typeof plugin.lastSeenAt, "string");

    // 書き出しが終わると、待たせていた依頼を次に渡す
    await pluginPost(base, "result", taken, sampleZip());
    assert.equal((await first).status, 200);
    const queued = await json<Next>(pluginNext(base, `?server=${taken.server}&after=1`));
    assert.equal(queued.seq, 2);
    assert.deepEqual(queued.nodeIds, ["5:6"]);
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).plugin.processing?.seq, 2);
    await pluginPost(base, "result", queued, sampleZip());
    assert.equal((await second).status, 200);
  } finally {
    close();
  }
});

test("時間切れの 504 には、プラグインが処理中の依頼と最後に届いた時刻が載る", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const first = fetch(`${base}/export?timeout=5`, { method: "POST", body: '{"nodeIds":["1:2"]}' });
    first.catch(() => {});
    await json<Next>(polled);
    const res = await fetch(`${base}/export?timeout=0.2`, { method: "POST", body: "" });
    assert.equal(res.status, 504);
    const body = await json<{ seq: number; error: string; plugin: PluginState }>(res);
    assert.equal(body.seq, 2);
    assert.match(body.error, /#1 の結果がまだ来ていない/);
    assert.equal(body.plugin.processing?.seq, 1);
    assert.deepEqual(body.plugin.processing?.nodeIds, ["1:2"]);
    assert.equal(typeof body.plugin.lastSeenAt, "string");
  } finally {
    close();
  }
});

test("走り直したプラグインが飛ばした依頼の 504 では、処理中の seq が時間切れの依頼より大きい", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const first = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    first.catch(() => {});
    await json<Next>(polled);
    const skipped = fetch(`${base}/export?timeout=0.5`, { method: "POST", body: "" });
    const latest = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    latest.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 走り直したプラグインはサーバーの id を知らないので、最後の依頼だけを受け取る
    assert.equal((await json<Next>(pluginNext(base))).seq, 3);
    const res = await skipped;
    assert.equal(res.status, 504);
    const body = await json<{ seq: number; plugin: PluginState }>(res);
    assert.equal(body.seq, 2);
    assert.equal(body.plugin.processing?.seq, 3);
  } finally {
    close();
  }
});

test("status?after の 504 は、最後の結果が失敗でも時間切れの理由を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    await pluginPost(base, "error", await json<Next>(polled), "ノードが見つからない: 9:9");
    assert.equal((await exported).status, 422);
    const res = await fetch(`${base}/status?after=1&timeout=0.2`);
    assert.equal(res.status, 504);
    const body = await json<StatusReply>(res);
    assert.match(body.error as string, /新しい結果が来ない/);
    assert.equal(body.version, 1);
  } finally {
    close();
  }
});

test("結果を返したあと、しばらくプラグインから何も来なければ繋がっていないと見て 503", async () => {
  const { base, close } = await startServer(undefined, { pluginStaleMs: 50 });
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    await pluginPost(base, "result", await json<Next>(polled), sampleZip());
    assert.equal((await exported).status, 200);
    // 結果を返したあと /next を待ちに来ない (プラグインを閉じた)
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
    const body = await json<{ plugin: PluginState }>(res);
    assert.equal(body.plugin.processing, undefined);
    assert.equal(typeof body.plugin.lastSeenAt, "string");
  } finally {
    close();
  }
});

test("渡した依頼の結果を返さずに /next を待ちに来たら、その依頼はもう処理中と見ない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    const taken = await json<Next>(polled);
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).plugin.processing?.seq, 1);
    const waiting = new AbortController();
    const again = pluginNext(base, `?server=${taken.server}&after=1`, waiting.signal);
    again.catch(() => {});
    assert.equal(await settleWithin(again, 100), "pending");
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).plugin.processing, undefined);
    waiting.abort();
  } finally {
    close();
  }
});

test("プラグインが繋がっていなければ、依頼を積まずにすぐ 503 を返す", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/export?timeout=5`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
    const body = await json<{ error: string; plugin: PluginState }>(res);
    assert.match(body.error, /開発: dev サーバーとつなぐ/);
    // 起動してからプラグインが一度も来ていない
    assert.deepEqual(body.plugin, {});
    // 積んでいないので、あとから繋いだプラグインには何も渡らない
    const next = pluginNext(base);
    next.catch(() => {});
    assert.equal(await settleWithin(next, 200), "pending");
  } finally {
    close();
  }
});

test("負例: 別の起動のサーバー宛ての結果と、数字でない timeout は断る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?timeout=2`, { method: "POST", body: "" });
    const next = await json<Next>(polled);
    const stale = await pluginPost(base, "result", { seq: next.seq, server: "old-server" }, sampleZip());
    assert.equal(stale.status, 409);
    assert.equal(existsSync(path.join(outDir, "latest")), false);
    assert.equal((await exported).status, 504);

    const bad = await fetch(`${base}/export?timeout=abc`, { method: "POST", body: "" });
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});

test("負例: ブラウザのサイトからの送信と、AI 側の口への Origin 付きの送信は、依頼を受けずに断る", async () => {
  const { base, port, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    polled.catch(() => {});
    // 断らずに受けてしまうと結果を待つので、待つ長さを 1 秒にして 504 で落ちるようにする
    for (const origin of ["https://example.com", "null"]) {
      const res = await fetch(`${base}/export?timeout=1`, {
        method: "POST",
        headers: { Origin: origin },
        body: "",
      });
      assert.equal(res.status, 403, `Origin ${origin} の /export を受けた`);
      const status = await fetch(`${base}/status`, { headers: { Origin: origin } });
      assert.equal(status.status, 403, `Origin ${origin} の /status を返した`);
    }
    const result = await fetch(`${base}/result?seq=1&server=x`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: sampleZip(),
    });
    assert.equal(result.status, 403);
    assert.equal(existsSync(path.join(outDir, "latest")), false);
    // DNS rebinding で別の名前から来た送信 (Host が localhost でない) も断る
    const rebound = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/status", headers: { Host: "evil.example:47717" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(rebound, 403);
    // 依頼は積まれていないので、プラグインには何も渡らない
    assert.equal(await settleWithin(polled, 200), "pending");
  } finally {
    close();
  }
});

test("ポートの値はサーバー・manifest の devAllowedDomains・ui.html でそろっている", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/structure-dump/manifest.json"), "utf8")
  ) as { networkAccess: { allowedDomains: string[]; devAllowedDomains?: string[] } };
  assert.deepEqual(manifest.networkAccess.allowedDomains, ["none"]);
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, [`http://localhost:${DEV_PORT}/`]);
  const ui = readFileSync(path.join(root, "plugins/structure-dump/src/ui.html"), "utf8");
  assert.ok(
    ui.includes(`const DEV_SERVER = "http://localhost:${DEV_PORT}";`),
    "ui.html の DEV_SERVER が DEV_PORT と違う"
  );
});

test("配る manifest からは devAllowedDomains と dev- のコマンドが外れ、ほかは残る", () => {
  const source = JSON.parse(
    readFileSync(path.join(root, "plugins/structure-dump/manifest.json"), "utf8")
  ) as Record<string, unknown>;
  const released = releaseManifest(source) as {
    menu: { command: string }[];
    networkAccess: Record<string, unknown>;
    main: string;
  };
  assert.deepEqual(released.networkAccess, { allowedDomains: ["none"] });
  assert.deepEqual(
    released.menu.map((m) => m.command),
    ["export-2x", "export-1x"]
  );
  assert.equal(released.main, "dist/code.js");
  // 元の manifest には開発用の設定がある (外す処理が素通りでも通る検査にしない)
  assert.ok(JSON.stringify(source).includes("devAllowedDomains"));
  assert.ok(JSON.stringify(source).includes('"dev-loop"'));
});
