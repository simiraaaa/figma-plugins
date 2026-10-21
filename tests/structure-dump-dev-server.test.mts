/**
 * structure-dump の開発ループ (dev サーバー) の検査
 *
 * 実行: npm test
 * AI (curl) とプラグインの UI の役を fetch で演じ、依頼 → long-poll → 結果の展開の往復を見る。
 * ポートの値がサーバー・manifest・ui.html でそろっていること、配る manifest から開発用の設定が外れることも見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDevServer,
  DEV_PORT,
  type DevStatus,
  type DumpRequest,
  entryPath,
  parseExportBody,
  readStoredZip,
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
      data: utf8Encode(JSON.stringify({ meta: { warnings: ["パスが長い"] } })),
    },
    { name: "画面.1-2/ボタン.3-4.json", data: utf8Encode("{}") },
  ]);
}

async function startServer(): Promise<{ base: string; outDir: string; close: () => void }> {
  const outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-"));
  const server = http.createServer(createDevServer({ outDir }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    outDir,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
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
    const exported = fetch(`${base}/export`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"] }),
    });
    // プラグインの UI は起動直後 after 無しで聞き、最後の依頼を受け取る
    const next = await json<Next>(fetch(`${base}/next`));
    assert.equal(next.seq, 1);
    assert.deepEqual(next.nodeIds, ["1:2"]);
    assert.equal(typeof next.server, "string");

    const posted = await fetch(`${base}/result?seq=1`, { method: "POST", body: sampleZip() });
    assert.equal(posted.status, 200);

    const res = await exported;
    assert.equal(res.status, 200);
    const status = await json<DevStatus>(res);
    assert.equal(status.version, 1);
    assert.equal(status.seq, 1);
    assert.deepEqual(status.nodeIds, ["1:2"]);
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
    const pending = fetch(`${base}/next?server=${next.server}&after=1`, { signal: waiting.signal });
    assert.equal(await settleWithin(pending, 200), "pending");
    waiting.abort();
    await pending.catch(() => {});

    // 走り直した (サーバーの id を知らない) プラグインには、最後の依頼をもう一度渡す
    assert.equal((await json<Next>(fetch(`${base}/next`))).seq, 1);
    assert.equal(
      (await json<Next>(fetch(`${base}/next?server=old-server&after=1`))).seq,
      1
    );
  } finally {
    close();
  }
});

test("プラグインが失敗を送ると、依頼した側に 422 と理由が返る", async () => {
  const { base, close } = await startServer();
  try {
    const exported = fetch(`${base}/export`, { method: "POST", body: "" });
    const next = await json<Next>(fetch(`${base}/next`));
    assert.equal(next.nodeIds, undefined);
    await fetch(`${base}/error?seq=${next.seq}`, { method: "POST", body: "ノードが見つからない: 9:9" });
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
    const exported = fetch(`${base}/export`, { method: "POST", body: "" });
    await fetch(`${base}/next`);
    await fetch(`${base}/result?seq=1`, { method: "POST", body: sampleZip() });
    await exported;

    const waiting = fetch(`${base}/status?after=1`);
    assert.equal(await settleWithin(waiting, 200), "pending");
    await fetch(`${base}/result?seq=1`, { method: "POST", body: sampleZip() });
    const res = await waiting;
    assert.equal(res.status, 200);
    assert.equal((await json<DevStatus>(res)).version, 2);
  } finally {
    close();
  }
});

test("負例: ブラウザのサイトからの送信 (Origin が null 以外) は、依頼を受けずに断る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    // 断らずに受けてしまうと結果を待つので、待つ長さを 1 秒にして 504 で落ちるようにする
    const res = await fetch(`${base}/export?timeout=1`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: "",
    });
    assert.equal(res.status, 403);
    const result = await fetch(`${base}/result?seq=1`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: sampleZip(),
    });
    assert.equal(result.status, 403);
    assert.equal(existsSync(path.join(outDir, "latest")), false);
    // 依頼は積まれていないので、プラグインには何も渡らない
    const next = fetch(`${base}/next`);
    next.catch(() => {});
    assert.equal(await settleWithin(next, 200), "pending");
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
