/**
 * Local Bridge の dev サーバーの検査
 *
 * 実行: npm test
 * AI (curl) と Local Bridge の UI の役を fetch で演じ、依頼 → long-poll → 結果の展開の往復を見る。
 * ポートの値がサーバー・Local Bridge の manifest・ui.html でそろっていること、
 * 配るプラグインが通信の設定を持たず、紛れ込んでも配る manifest から外れることも見る。
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
  DEV_PORTS,
  DEV_SERVER_APP,
  DEV_SERVER_PROTOCOL,
  type DevServerHandler,
  type DevServerOptions,
  type DevStatus,
  type DumpRequest,
  entryPath,
  IMAGE_MODES,
  listenOnCandidatePorts,
  listenOnHosts,
  notStartedMessage,
  parseExportBody,
  type PluginState,
  readStoredZip,
  type RequestReply,
  type RunRequest,
  type StatusReply,
} from "../scripts/dev-server-lib.mts";
import { releaseManifest } from "../scripts/release-lib.mts";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as zipDist from "../plugins/structure-dump/dist/zip.mjs";
const { buildZip, utf8Encode } =
  zipDist as unknown as typeof import("../plugins/structure-dump/src/zip.ts");
import * as planDist from "../plugins/structure-dump/dist/plan.mjs";
const { IMAGES_MODES, parseImagesMode } =
  planDist as unknown as typeof import("../plugins/structure-dump/src/plan.ts");

/** /next の応答。launch はその依頼を渡した起動 id で、Local Bridge は結果を送るときに付ける */
type Next = DumpRequest & { server: string; launch: string };
type RunNext = RunRequest & { server: string; launch: string };
/** 結果を送る口のクエリに要るもの */
type Handed = { seq: number; server: string; launch?: string };

function resultQuery(next: Handed): string {
  const params = new URLSearchParams({ seq: String(next.seq), server: next.server });
  if (next.launch !== undefined) params.set("launch", next.launch);
  return params.toString();
}

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
): Promise<{ base: string; port: number; outDir: string; handler: DevServerHandler; close: () => void }> {
  const handler = createDevServer({ outDir, ...options });
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    outDir,
    handler,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** プラグインの UI の iframe と同じく Origin: null で送る */
const PLUGIN = { Origin: "null" };

/**
 * Local Bridge を開いている Figma のファイル。launch はその Local Bridge の起動 id (省けばファイルごとに 1 つの起動)、
 * session は開いている画面 (figma.currentUser.sessionId。省けばファイルごとに 1 つの画面)
 */
interface FigmaFile {
  key: string;
  name: string;
  launch?: string;
  session?: string;
}

const FILE_A: FigmaFile = { key: "fileKeyA", name: "Rabee UI" };
const FILE_B: FigmaFile = { key: "fileKeyB", name: "Rabee UI のコピー" };
const FILE = FILE_A.key;

/** query は `?server=...&after=...` の形。Local Bridge と同じく自分のファイルと起動 id を付けて聞く */
function pluginNext(base: string, query = "", signal?: AbortSignal, file: FigmaFile = FILE_A): Promise<Response> {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  params.set("file", file.key);
  params.set("name", file.name);
  params.set("launch", file.launch ?? `launch-${file.key}`);
  params.set("session", file.session ?? "38648");
  return fetch(`${base}/next?${params}`, { headers: PLUGIN, signal });
}

function pluginPost(
  base: string,
  route: "result" | "error",
  next: Handed,
  body: Uint8Array | string
): Promise<Response> {
  return fetch(`${base}/${route}?${resultQuery(next)}`, {
    method: "POST",
    headers: PLUGIN,
    body,
  });
}

/** 応答の plugin (つながっているファイルの一覧) から、そのファイルの Local Bridge の様子を引く */
function stateOf(plugin: PluginState[], file = FILE): PluginState | undefined {
  return plugin.find((p) => p.fileKey === file);
}

/** AI が script の実行を頼む。query は `?timeout=...` の形 */
function runRequest(base: string, code: string, query = "", token = "t1", file = FILE): Promise<Response> {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  params.set("file", file);
  return fetch(`${base}/run?${params}`, { method: "POST", headers: { "X-Run-Token": token }, body: code });
}

function pluginRunResult(base: string, next: Handed, body: unknown): Promise<Response> {
  return fetch(`${base}/run-result?${resultQuery(next)}`, {
    method: "POST",
    headers: PLUGIN,
    body: JSON.stringify(body),
  });
}

/** いま空いているポート */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** dev サーバーとして答えない別のアプリ */
async function otherApp(): Promise<{ port: number; close: () => void }> {
  const other = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html></html>");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  return { port: (other.address() as AddressInfo).port, close: () => other.close() };
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

test("依頼の本文: images は both・none・only を受け、省けば欄を作らず、ほかの値は断る", () => {
  for (const images of ["both", "none", "only"] as const) {
    assert.deepEqual(parseExportBody(JSON.stringify({ images })), { images });
  }
  assert.deepEqual(parseExportBody('{"nodeIds":["1:2"],"images":"none","scale":1}'), {
    nodeIds: ["1:2"],
    scale: 1,
    images: "none",
  });
  assert.equal("images" in parseExportBody('{"nodeIds":["1:2"]}'), false);
  for (const bad of ['"png"', '"None"', '""', "1", "null", "true", '["none"]']) {
    assert.throws(
      () => parseExportBody(`{"images":${bad}}`),
      /^Error: images は both・none・only のどれかにする \(省けば both\)$/,
      `images: ${bad} を受けた`
    );
  }
});

test("images の 3 値は、dev サーバーとプラグイン (Structure Dump の plan) で同じ集合で、同じ値を受けて同じ値を断る", () => {
  assert.deepEqual([...IMAGE_MODES].sort(), [...IMAGES_MODES].sort());
  const candidates = [...new Set([...IMAGE_MODES, ...IMAGES_MODES]), "png", "None", "", 1, null, true, ["none"]];
  for (const value of candidates) {
    const serverAccepts = (() => {
      try {
        parseExportBody(JSON.stringify({ images: value }));
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(serverAccepts, parseImagesMode(value) !== null, `images: ${JSON.stringify(value)} の扱いが食い違う`);
  }
});

test("images の付いた書き出しの依頼は、プラグインへそのまま渡り、処理中・結果・依頼の様子にモードが載る", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"], images: "only" }),
    });
    const next = await json<Next>(polled);
    assert.equal(next.images, "only");
    assert.deepEqual(next.nodeIds, ["1:2"]);

    const { plugin } = await json<StatusReply>(fetch(`${base}/status`));
    assert.equal(stateOf(plugin)?.processing?.images, "only");
    const processing = await json<RequestReply>(fetch(`${base}/status?seq=1&timeout=0.1`));
    assert.equal(processing.state, "processing");
    assert.equal(processing.images, "only");

    await pluginPost(base, "result", next, sampleZip());
    const status = await json<DevStatus>(exported);
    assert.equal(status.images, "only");
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=1`))).images, "only");

    // 省いた依頼は images を付けずに渡し (プラグインは無ければ both と読む)、モードも載せない
    const again = pluginNext(base, `?server=${next.server}&after=1`);
    const plain = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    const plainNext = await json<Next>(again);
    assert.equal("images" in plainNext, false);
    const plainProcessing = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing;
    assert.deepEqual([plainProcessing?.seq, plainProcessing?.kind], [2, "export"]);
    assert.equal("images" in (plainProcessing as object), false);
    await pluginPost(base, "result", plainNext, sampleZip());
    assert.equal("images" in (await json<DevStatus>(plain)), false);
  } finally {
    close();
  }
});

test("images が none の依頼は、プラグインへ none のまま渡り、結果の status.json と GET /status にモードが載る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"], images: "none" }),
    });
    const next = await json<Next>(polled);
    assert.equal(next.images, "none");
    await pluginPost(base, "result", next, sampleZip());
    assert.equal((await exported).status, 200);
    assert.equal(JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8")).images, "none");
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).images, "none");
  } finally {
    close();
  }
});

test("images に both を書いた依頼は、プラグインへ both のまま渡り、処理中・結果の status にはモードを載せない", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"], images: "both" }),
    });
    const next = await json<Next>(polled);
    assert.equal(next.images, "both");

    const processing = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing;
    assert.deepEqual([processing?.seq, processing?.kind], [1, "export"]);
    assert.equal("images" in (processing as object), false);
    const pendingReply = await json<RequestReply>(fetch(`${base}/status?seq=1&timeout=0.1`));
    assert.equal(pendingReply.state, "processing");
    assert.equal("images" in pendingReply, false);

    await pluginPost(base, "result", next, sampleZip());
    assert.equal("images" in (await json<DevStatus>(exported)), false);
    assert.equal("images" in JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8")), false);
    assert.equal("images" in (await json<StatusReply>(fetch(`${base}/status`))), false);
    assert.equal("images" in (await json<RequestReply>(fetch(`${base}/status?seq=1`))), false);
  } finally {
    close();
  }
});

test("images が only の依頼が失敗しても、status.json・GET /status・status?seq にモードが載る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["9:9"], images: "only" }),
    });
    await pluginPost(base, "error", await json<Next>(polled), "ノードが見つからない: 9:9");
    const res = await exported;
    assert.equal(res.status, 422);
    assert.equal((await json<DevStatus>(res)).images, "only");
    const stored = JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8"));
    assert.deepEqual([stored.error, stored.images], ["ノードが見つからない: 9:9", "only"]);
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).images, "only");
    const reply = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.deepEqual([reply.state, reply.images], ["failed", "only"]);
  } finally {
    close();
  }
});

test("負例: images が both・none・only でない書き出しの依頼は、積まずに 400 と理由を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    polled.catch(() => {});
    for (const bad of ['"png"', "null", "2"]) {
      const res = await fetch(`${base}/export?file=${FILE}&timeout=1`, { method: "POST", body: `{"images":${bad}}` });
      assert.equal(res.status, 400, `images: ${bad} を受けた`);
      assert.equal((await json<{ error: string }>(res)).error, "images は both・none・only のどれかにする (省けば both)");
    }
    assert.equal(await settleWithin(polled, 200), "pending", "断った依頼がプラグインに渡った");
  } finally {
    close();
  }
});

test("依頼 → プラグインが取る → 結果を送ると、依頼した側に展開先が返る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    // プラグインの UI は起動直後 after 無しで聞き、最後の依頼を受け取る
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: ["1:2"] }),
    });
    const next = await json<Next>(polled);
    assert.equal(next.seq, 1);
    assert.deepEqual(next.nodeIds, ["1:2"]);
    assert.equal(typeof next.server, "string");
    // Local Bridge は依頼の fileKey が自分のファイルかを確かめてから処理する
    assert.equal(next.fileKey, FILE);

    const posted = await pluginPost(base, "result", next, sampleZip());
    assert.equal(posted.status, 200);

    const res = await exported;
    assert.equal(res.status, 200);
    const status = await json<DevStatus>(res);
    assert.equal(status.version, 1);
    assert.equal(status.seq, 1);
    assert.equal(status.fileKey, FILE);
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
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}`, { method: "POST", body: "" });
    const next = await json<Next>(polled);
    assert.equal(next.nodeIds, undefined);
    await pluginPost(base, "error", next, "ノードが見つからない: 9:9");
    const res = await exported;
    assert.equal(res.status, 422);
    const body = await json<DevStatus>(res);
    assert.equal(body.error, "ノードが見つからない: 9:9");
    // 書き出せなかった結果も、どのファイルの結果かが分かる (ファイル名は Local Bridge が名乗った名前)
    assert.deepEqual([body.fileKey, body.fileName], [FILE_A.key, FILE_A.name]);
    const stored = JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8")) as DevStatus;
    assert.deepEqual([stored.fileKey, stored.fileName], [FILE_A.key, FILE_A.name]);
  } finally {
    close();
  }
});

test("status?after は新しい結果が届くまで待つ (build で走り直した結果を待つ使い方)", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}`, { method: "POST", body: "" });
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
    const exported = fetch(`${base}/export?file=${FILE}`, { method: "POST", body: "" });
    await pluginPost(base, "result", await json<Next>(polled), sampleZip());
    const status = await json<DevStatus>(exported);
    assert.equal(status.version, 51);
    assert.equal(existsSync(path.join(outDir, "results", "51", "index.json")), true);
    assert.equal(realpathSync(path.join(outDir, "latest")), realpathSync(status.dir as string));
  } finally {
    close();
  }
});

test("候補のポートで dev サーバーが動いていれば、起動せずにそのポートと結果の置き場所を返し、そのまま使うよう案内する", async () => {
  const { port, outDir, close } = await startServer();
  try {
    const outcome = await listenOnCandidatePorts((_req, res) => res.end(), [port], ["127.0.0.1"]);
    assert.deepEqual(outcome, { kind: "running", port, outDir, current: true });
    const message = notStartedMessage(outcome as Exclude<typeof outcome, { kind: "listening" }>);
    assert.match(message, /dev サーバーはもう .*:\d+ で動いている/);
    assert.ok(message.includes(String(port)), "ポートが無い");
    assert.ok(message.includes(outDir), "結果の置き場所が無い");
  } finally {
    close();
  }
});

test("候補のポートで古い版の dev サーバー (GET /hello に印を返さない) が動いていれば、止めて起動し直すよう案内する", async () => {
  // 変更前の版は GET /status に答え、知らない経路には 404 の JSON を返す
  const old = http.createServer((req, res) => {
    res.writeHead(req.url === "/status" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(req.url === "/status" ? '{"version": 3}' : '{"error": "知らない経路"}');
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  const { port } = old.address() as AddressInfo;
  try {
    const outcome = await listenOnCandidatePorts((_req, res) => res.end(), [port], ["127.0.0.1"]);
    assert.deepEqual(outcome, { kind: "running", port, outDir: undefined, current: false });
    const message = notStartedMessage(outcome as Exclude<typeof outcome, { kind: "listening" }>);
    assert.match(message, /古い版/);
    assert.match(message, /起動し直す/);
    assert.doesNotMatch(message, /そのまま依頼する/);
  } finally {
    old.close();
  }
});

test("候補のポートで、依頼をファイルごとに振り分けない版の dev サーバーが動いていれば、古い版として止めて起動し直すよう案内する", async () => {
  // 振り分ける前の版は GET /hello に印と root だけを返す。いまの Local Bridge はその版の依頼 (行き先が無い) を実行しない
  const old = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/status" ? '{"version": 3, "outDir": "/x"}' : `{"app": "${DEV_SERVER_APP}", "root": "/x"}`);
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  const { port } = old.address() as AddressInfo;
  try {
    const outcome = await listenOnCandidatePorts((_req, res) => res.end(), [port], ["127.0.0.1"]);
    assert.deepEqual(outcome, { kind: "running", port, outDir: "/x", current: false });
  } finally {
    old.close();
  }
});

test("後ろの候補のポートで dev サーバーが動いていれば、前の候補が空いていても起動しない", async () => {
  const free = await freePort();
  const { port, outDir, close } = await startServer();
  try {
    const outcome = await listenOnCandidatePorts((_req, res) => res.end("ok"), [free, port], ["127.0.0.1"]);
    if (outcome.kind === "listening") outcome.servers.forEach((s) => s.close());
    assert.deepEqual(outcome, { kind: "running", port, outDir, current: true });
  } finally {
    close();
  }
});

test("候補のポートが別のアプリに使われていれば、次の候補で待ち受ける", async () => {
  const other = await otherApp();
  const free = await freePort();
  const outcome = await listenOnCandidatePorts((_req, res) => res.end("ok"), [other.port, free], ["127.0.0.1"]);
  try {
    assert.equal(outcome.kind, "listening");
    assert.equal((outcome as { port: number }).port, free);
    assert.equal(await (await fetch(`http://127.0.0.1:${free}/`)).text(), "ok");
  } finally {
    if (outcome.kind === "listening") outcome.servers.forEach((s) => s.close());
    other.close();
  }
});

test("候補のポートがどれも別のアプリに使われていれば、起動せずに空け方と候補の足し方を案内する", async () => {
  const first = await otherApp();
  const second = await otherApp();
  try {
    const outcome = await listenOnCandidatePorts((_req, res) => res.end(), [first.port, second.port], ["127.0.0.1"]);
    assert.deepEqual(outcome, { kind: "busy", ports: [first.port, second.port] });
    const message = notStartedMessage(outcome as Exclude<typeof outcome, { kind: "listening" }>);
    assert.match(message, /dev サーバーとして答えない/);
    assert.ok(message.includes(String(second.port)), "候補のポートが無い");
    assert.match(message, /devAllowedDomains/);
  } finally {
    first.close();
    second.close();
  }
});

test("片方のアドレスだけ使用中なら、待ち受けたもう片方も閉じて、使用中のアドレスを返す", async () => {
  const other = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const { port } = other.address() as AddressInfo;
  try {
    const outcome = await listenOnHosts((_req, res) => res.end(), port, ["127.0.0.1", "::1"]);
    assert.equal(outcome.inUse, "127.0.0.1");
    assert.deepEqual(outcome.servers, []);
    // ::1 で待ち受けたままにしていないので、依頼は届かない
    const reached = await fetch(`http://[::1]:${port}/status`, { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false
    );
    assert.equal(reached, false, "使用中で起動できないのに、もう片方で依頼を受けている");
  } finally {
    other.close();
  }
});

test("どのアドレスも空いていれば、全部で待ち受ける", async () => {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  const outcome = await listenOnHosts((_req, res) => res.end("ok"), port, ["127.0.0.1", "::1"]);
  try {
    assert.equal(outcome.inUse, undefined);
    assert.equal(outcome.servers.length, 2);
    assert.equal(await (await fetch(`http://[::1]:${port}/`)).text(), "ok");
  } finally {
    outcome.servers.forEach((s) => s.close());
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
    const first = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    first.catch(() => {});
    const taken = await json<Next>(polled);
    // 重い書き出しのあいだは Figma ごと固まり、UI からは何も届かない
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: '{"nodeIds":["5:6"]}' });
    second.catch(() => {});
    assert.equal(await settleWithin(second, 200), "pending", "処理中なのに断った");

    const plugin = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin);
    assert.equal(plugin?.processing?.seq, 1);
    assert.equal(typeof plugin?.processing?.elapsedSeconds, "number");
    assert.equal(typeof plugin?.lastSeenAt, "string");
    assert.equal(plugin?.fileName, FILE_A.name);

    // 書き出しが終わると、待たせていた依頼を次に渡す
    await pluginPost(base, "result", taken, sampleZip());
    assert.equal((await first).status, 200);
    const queued = await json<Next>(pluginNext(base, `?server=${taken.server}&after=1`));
    assert.equal(queued.seq, 2);
    assert.deepEqual(queued.nodeIds, ["5:6"]);
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing?.seq, 2);
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
    const first = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: '{"nodeIds":["1:2"]}' });
    first.catch(() => {});
    await json<Next>(polled);
    const res = await fetch(`${base}/export?file=${FILE}&timeout=0.2`, { method: "POST", body: "" });
    assert.equal(res.status, 504);
    const body = await json<{ seq: number; error: string; plugin: PluginState[] }>(res);
    assert.equal(body.seq, 2);
    assert.match(body.error, /#1 の結果がまだ来ていない/);
    assert.equal(stateOf(body.plugin)?.processing?.seq, 1);
    assert.deepEqual(stateOf(body.plugin)?.processing?.nodeIds, ["1:2"]);
    assert.equal(typeof stateOf(body.plugin)?.lastSeenAt, "string");
  } finally {
    close();
  }
});

test("status?seq は、その依頼の結果が出るまで待ち、done と展開先を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=0.2`, { method: "POST", body: '{"nodeIds":["1:2"]}' });
    const taken = await json<Next>(polled);
    assert.equal((await exported).status, 504);
    const waiting = fetch(`${base}/status?seq=1`);
    assert.equal(await settleWithin(waiting, 200), "pending");
    await pluginPost(base, "result", taken, sampleZip());
    const res = await waiting;
    assert.equal(res.status, 200);
    const body = await json<RequestReply>(res);
    assert.equal(body.state, "done");
    assert.equal(body.seq, 1);
    assert.deepEqual(body.nodeIds, ["1:2"]);
    assert.equal(body.version, 1);
    assert.equal(existsSync(path.join(body.dir as string, "index.json")), true);
  } finally {
    close();
  }
});

test("status?seq: 失敗は failed と理由、待つ長さを過ぎたら 504 といまの state を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const first = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    first.catch(() => {});
    const taken = await json<Next>(polled);
    const second = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    second.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const processing = await fetch(`${base}/status?seq=1&timeout=0.2`);
    assert.equal(processing.status, 504);
    assert.equal((await json<RequestReply>(processing)).state, "processing");
    const queued = await fetch(`${base}/status?seq=2&timeout=0.2`);
    assert.equal(queued.status, 504);
    assert.equal((await json<RequestReply>(queued)).state, "queued");

    await pluginPost(base, "error", taken, "ノードが見つからない: 9:9");
    const failed = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "ノードが見つからない: 9:9");
  } finally {
    close();
  }
});

test("status?seq: 走り直したプラグインが飛ばした依頼は、すぐ skipped を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const first = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    first.catch(() => {});
    await json<Next>(polled);
    const skipped = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    skipped.catch(() => {});
    const latest = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    latest.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = fetch(`${base}/status?seq=2`);
    assert.equal(await settleWithin(waiting, 100), "pending");
    // 走り直したプラグインはサーバーの id を知らないので、最後の依頼だけを受け取る
    assert.equal((await json<Next>(pluginNext(base))).seq, 3);
    const res = await settleWithin(waiting, 200);
    assert.notEqual(res, "pending", "飛ばされたのに待ち続けた");
    assert.equal((await json<RequestReply>(res as Response)).state, "skipped");
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=1`))).state, "skipped");
  } finally {
    close();
  }
});

test("status?seq: 走り直したプラグインが同じ依頼を書き出し直すあいだは、skipped と答えずに待つ", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    await json<Next>(polled);
    const waiting = fetch(`${base}/status?seq=1`);
    assert.equal(await settleWithin(waiting, 100), "pending");
    // 走り直したプラグインは最後の依頼 (書き出し中だった #1) をもう一度受け取る
    const again = await json<Next>(pluginNext(base));
    assert.equal(again.seq, 1);
    assert.equal(await settleWithin(waiting, 100), "pending", "書き出し直しているのに決着した");
    await pluginPost(base, "result", again, sampleZip());
    assert.equal((await json<RequestReply>(waiting)).state, "done");
  } finally {
    close();
  }
});

test("status?seq: この起動で受けていない依頼は 404、seq が数字でなければ 400", async () => {
  const { base, close } = await startServer();
  try {
    assert.equal((await fetch(`${base}/status?seq=1`)).status, 404);
    assert.equal((await fetch(`${base}/status?seq=abc`)).status, 400);
  } finally {
    close();
  }
});

test("新しい起動が来て abandoned になった script も、前の起動の結果があとから届けば done に変わる", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1" });
    const ran = runRequest(base, "return 1;", "?timeout=5");
    ran.catch(() => {});
    const taken = await json<RunNext>(polled);
    const fresh = pluginNext(base, "", undefined, { ...FILE_A, launch: "L2" });
    fresh.catch(() => {});
    await settleWithin(fresh, 100);
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=1`))).state, "abandoned");
    await pluginRunResult(base, taken, { ok: true, value: 1 });
    const reply = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.deepEqual([reply.state, reply.value], ["done", 1]);
  } finally {
    close();
  }
});

test("負例: status?seq は、この起動で振ったが覚えておく数を超えて忘れた依頼と、受けていない依頼を言い分ける", async () => {
  const { base, close } = await startServer();
  try {
    let query = "";
    for (let i = 0; i < 105; i += 1) {
      const polled = pluginNext(base, query);
      const ran = runRequest(base, "return 1;", "?timeout=5");
      const next = await json<RunNext>(polled);
      await pluginRunResult(base, next, { ok: true, value: 1 });
      assert.equal((await ran).status, 200);
      query = `?server=${next.server}&after=${next.seq}`;
    }
    const forgotten = await fetch(`${base}/status?seq=1`);
    assert.equal(forgotten.status, 404);
    assert.match((await json<{ error: string }>(forgotten)).error, /覚えておく数を超えて忘れた依頼.*結果があったかは分からない/);
    const unknown = await fetch(`${base}/status?seq=999`);
    assert.equal(unknown.status, 404);
    assert.match((await json<{ error: string }>(unknown)).error, /受けていない/);
  } finally {
    close();
  }
});

test("起動し直しても依頼の seq は前回の続きから振り、前回の依頼と取り違えない", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-"));
  const first = await startServer(outDir);
  try {
    const polled = pluginNext(first.base);
    const exported = fetch(`${first.base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    await pluginPost(first.base, "result", await json<Next>(polled), sampleZip());
    await exported;
    // 結果を返さずに残った依頼
    const pending = fetch(`${first.base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    first.close();
  }
  const second = await startServer(outDir);
  try {
    // 前回の起動の結果は GET /status に残るが、前回の依頼の seq は引けない (忘れた依頼とは言わない)
    assert.equal((await json<StatusReply>(fetch(`${second.base}/status`))).seq, 1);
    const previous = await fetch(`${second.base}/status?seq=1`);
    assert.equal(previous.status, 404);
    assert.match((await json<{ error: string }>(previous)).error, /受けていない/);
    const polled = pluginNext(second.base);
    const exported = fetch(`${second.base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    assert.equal((await json<Next>(polled)).seq, 3);
  } finally {
    second.close();
  }
});

test("結果の本文を受け取っている途中で時間切れになった依頼の 504 には、処理中が載る", async () => {
  const { base, port, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=0.3`, { method: "POST", body: "" });
    const taken = await json<Next>(polled);
    const zip = sampleZip();
    const upload = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/result?${resultQuery(taken)}`,
      headers: { Origin: "null", "Content-Length": zip.length },
    });
    upload.on("error", () => {});
    upload.write(zip.subarray(0, 10));
    const res = await exported;
    assert.equal(res.status, 504);
    assert.equal(stateOf((await json<{ plugin: PluginState[] }>(res)).plugin)?.processing?.seq, 1);
    upload.end(zip.subarray(10));
  } finally {
    close();
  }
});

test("status?after の 504 は、最後の結果が失敗でも時間切れの理由を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
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
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    await pluginPost(base, "result", await json<Next>(polled), sampleZip());
    assert.equal((await exported).status, 200);
    // 結果を返したあと /next を待ちに来ない (プラグインを閉じた)
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
    // 繋がっていないファイルは一覧に載せない
    assert.deepEqual((await json<{ plugin: PluginState[] }>(res)).plugin, []);
  } finally {
    close();
  }
});

test("渡した依頼の結果を返さずに /next を待ちに来たら、その依頼はもう処理中と見ない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    const taken = await json<Next>(polled);
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing?.seq, 1);
    const waiting = new AbortController();
    const again = pluginNext(base, `?server=${taken.server}&after=1`, waiting.signal);
    again.catch(() => {});
    assert.equal(await settleWithin(again, 100), "pending");
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing, undefined);
    waiting.abort();
  } finally {
    close();
  }
});

test("プラグインが繋がっていなければ、依頼を積まずにすぐ 503 を返す", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
    const body = await json<{ error: string; plugin: PluginState[] }>(res);
    assert.match(body.error, /Local Bridge を開いたままにする/);
    // 起動してからプラグインが一度も来ていない
    assert.deepEqual(body.plugin, []);
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
    const exported = fetch(`${base}/export?file=${FILE}&timeout=2`, { method: "POST", body: "" });
    const next = await json<Next>(polled);
    const stale = await pluginPost(base, "result", { seq: next.seq, server: "old-server" }, sampleZip());
    assert.equal(stale.status, 409);
    assert.equal(existsSync(path.join(outDir, "latest")), false);
    assert.equal((await exported).status, 504);

    const bad = await fetch(`${base}/export?file=${FILE}&timeout=abc`, { method: "POST", body: "" });
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});

test("script の実行: 依頼 → プラグインが取る → 結果を送ると、依頼した側に返り値が返り、書き出しの結果は動かない", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const ran = runRequest(base, "return figma.currentPage.name;");
    const next = await json<RunNext>(polled);
    assert.equal(next.kind, "run");
    assert.equal(next.seq, 1);
    assert.equal(next.code, "return figma.currentPage.name;");
    assert.equal(next.token, "t1");

    assert.equal((await pluginRunResult(base, next, { ok: true, value: { name: "Page 1" } })).status, 200);
    const res = await ran;
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { seq: 1, value: { name: "Page 1" } });

    const status = await json<StatusReply>(fetch(`${base}/status`));
    assert.equal(status.version, 0);
    assert.equal(existsSync(path.join(outDir, "status.json")), false);
    const reply = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.equal(reply.kind, "run");
    assert.equal(reply.state, "done");
    assert.deepEqual(reply.value, { name: "Page 1" });
    assert.equal("code" in reply || "token" in reply, false, "依頼の様子にコードか合言葉が載った");

    // 返り値の無い script は value が null
    const again = pluginNext(base, `?server=${next.server}&after=1`);
    const empty = runRequest(base, "figma.notify('x');");
    await pluginRunResult(base, await json<RunNext>(again), { ok: true });
    assert.deepEqual(await json(empty), { seq: 2, value: null });
  } finally {
    close();
  }
});

test("script の実行: プラグインで失敗したら、依頼した側に 422 と理由が返る", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const ran = runRequest(base, "return 1;", "", "wrong");
    const next = await json<RunNext>(polled);
    await pluginRunResult(base, next, { ok: false, error: "合言葉が違う" });
    const res = await ran;
    assert.equal(res.status, 422);
    assert.deepEqual(await json(res), { seq: 1, error: "合言葉が違う" });
    const reply = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.equal(reply.state, "failed");
    assert.equal(reply.error, "合言葉が違う");
  } finally {
    close();
  }
});

test("負例: script の実行の依頼は、合言葉のヘッダかコードが無ければ積まずに 400 を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    polled.catch(() => {});
    const noToken = await fetch(`${base}/run?file=${FILE}&timeout=1`, { method: "POST", body: "return 1;" });
    assert.equal(noToken.status, 400);
    assert.match((await json<{ error: string }>(noToken)).error, /X-Run-Token/);
    const noCode = await runRequest(base, "  \n", "?timeout=1");
    assert.equal(noCode.status, 400);
    assert.equal(await settleWithin(polled, 200), "pending", "断った依頼がプラグインに渡った");
  } finally {
    close();
  }
});

test("走り直したプラグインには、渡し済みの script をもう一度渡さず、その依頼は abandoned と答える", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const ran = runRequest(base, "figma.currentPage.selection[0].remove();", "?timeout=5");
    ran.catch(() => {});
    await json<RunNext>(polled);
    const waiting = fetch(`${base}/status?seq=1`);
    assert.equal(await settleWithin(waiting, 100), "pending");

    // 走り直したプラグインはサーバーの id を知らない
    const fresh = pluginNext(base);
    fresh.catch(() => {});
    assert.equal(await settleWithin(fresh, 200), "pending", "渡し済みの script をもう一度渡した");
    const reply = await json<RequestReply>(waiting);
    assert.equal(reply.state, "abandoned");

    // そのあとに来た依頼は渡す
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    const next = await json<Next>(fresh);
    assert.equal(next.seq, 2);
    assert.equal(next.kind, "export");
  } finally {
    close();
  }
});

test("最後の依頼が渡し済みの script なら、走り直したプラグインには最後の書き出しをやり直させ、script は渡し直さない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: '{"nodeIds":["1:2"]}' });
    const first = await json<Next>(polled);
    await pluginPost(base, "result", first, sampleZip());
    await exported;
    const again = pluginNext(base, `?server=${first.server}&after=1`);
    const ran = runRequest(base, "return 1;", "?timeout=5");
    await pluginRunResult(base, await json<RunNext>(again), { ok: true, value: 1 });
    await ran;

    // build で走り直したプラグインは、書き出しをやり直して status?after の待ちに結果を届ける
    const fresh = await json<Next>(pluginNext(base));
    assert.equal(fresh.seq, 1);
    assert.equal(fresh.kind, "export");
    const after = pluginNext(base, `?server=${fresh.server}&after=1`);
    after.catch(() => {});
    assert.equal(await settleWithin(after, 200), "pending", "書き出しのあとに渡し済みの script を渡した");
  } finally {
    close();
  }
});

test("依頼した側が待つのをやめた script は、まだ渡していなければ取り消し、あとからも渡さない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    const busy = await json<Next>(polled);

    // 時間切れ (書き出しの後ろで待っているあいだに切れた)
    const timedOut = await runRequest(base, "return 1;", "?timeout=0.2");
    assert.equal(timedOut.status, 504);
    const body = await json<{ seq: number; error: string }>(timedOut);
    assert.equal(body.seq, 2);
    assert.match(body.error, /取り消した/);
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=2`))).state, "cancelled");

    // 接続が切れた (Bash の時間切れで curl が止められた)
    const aborted = new AbortController();
    runRequest(base, "return 2;", "?timeout=5").catch(() => {});
    const dropped = fetch(`${base}/run?file=${FILE}&timeout=5`, {
      method: "POST",
      headers: { "X-Run-Token": "t1" },
      body: "return 3;",
      signal: aborted.signal,
    });
    dropped.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    aborted.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=4`))).state, "cancelled");

    // 書き出しが終わったプラグインには、待っている #3 だけを渡す
    await pluginPost(base, "result", busy, sampleZip());
    const next = await json<RunNext>(pluginNext(base, `?server=${busy.server}&after=1`));
    assert.equal(next.seq, 3);
    const later = pluginNext(base, `?server=${busy.server}&after=3`);
    later.catch(() => {});
    assert.equal(await settleWithin(later, 200), "pending", "取り消した script を渡した");
  } finally {
    close();
  }
});

test("走り直したプラグインには、まだ渡していない script は渡す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported.catch(() => {});
    await json<Next>(polled);
    const ran = runRequest(base, "return 1;", "?timeout=5");
    ran.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await json<RunNext>(pluginNext(base));
    assert.equal(fresh.seq, 2);
    assert.equal(fresh.kind, "run");
    await pluginRunResult(base, fresh, { ok: true, value: 1 });
    assert.deepEqual(await json(ran), { seq: 2, value: 1 });
    // 渡したあと結果が返らなかった書き出しは、いままでどおり skipped
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=1`))).state, "skipped");
  } finally {
    close();
  }
});

test("負例: 書き出しの依頼に script の結果を、script の依頼に書き出しの結果を送ると断る", async () => {
  const { base, outDir, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=1`, { method: "POST", body: "" });
    exported.catch(() => {});
    const exportNext = await json<Next>(polled);
    assert.equal((await pluginRunResult(base, exportNext, { ok: true, value: 1 })).status, 409);

    const again = pluginNext(base, `?server=${exportNext.server}&after=1`);
    const ran = runRequest(base, "return 1;", "?timeout=1");
    ran.catch(() => {});
    const runNext = await json<RunNext>(again);
    assert.equal((await pluginPost(base, "result", runNext, sampleZip())).status, 409);
    assert.equal((await pluginPost(base, "error", runNext, "x")).status, 409);
    assert.equal(existsSync(path.join(outDir, "latest")), false);
    const still = await fetch(`${base}/status?seq=2&timeout=0.2`);
    assert.equal(still.status, 504);
    assert.equal((await json<RequestReply>(still)).state, "processing");
  } finally {
    close();
  }
});

test("負例: 行き先のファイル (file) の無い依頼は、積まずに 400 と、つながっているファイルの一覧を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    polled.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exported = await fetch(`${base}/export?timeout=1`, { method: "POST", body: "" });
    const ran = await fetch(`${base}/run?timeout=1`, {
      method: "POST",
      headers: { "X-Run-Token": "t1" },
      body: "return 1;",
    });
    for (const res of [exported, ran]) {
      assert.equal(res.status, 400);
      const body = await json<{ error: string; plugin: PluginState[] }>(res);
      assert.match(body.error, /file=/);
      assert.deepEqual(
        body.plugin.map((p) => [p.fileKey, p.fileName, typeof p.lastSeenAt]),
        [[FILE_A.key, FILE_A.name, "string"]]
      );
    }
    assert.equal(await settleWithin(polled, 200), "pending", "file の無い依頼がプラグインに渡った");
  } finally {
    close();
  }
});

test("負例: Local Bridge がつながっていないファイル宛ての依頼は、積まずに 503 と、つながっているファイルの一覧を返す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    polled.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exported = await fetch(`${base}/export?file=${FILE_B.key}&timeout=1`, { method: "POST", body: "" });
    const ran = await runRequest(base, "return 1;", "?timeout=1", "t1", FILE_B.key);
    for (const res of [exported, ran]) {
      assert.equal(res.status, 503);
      const body = await json<{ error: string; plugin: PluginState[] }>(res);
      assert.ok(body.error.includes(FILE_B.key), "断った行き先が理由に無い");
      assert.deepEqual(
        body.plugin.map((p) => [p.fileKey, p.fileName]),
        [[FILE_A.key, FILE_A.name]]
      );
    }
    assert.equal(await settleWithin(polled, 200), "pending", "別のファイル宛ての依頼がプラグインに渡った");
  } finally {
    close();
  }
});

test("2 つのファイルの Local Bridge が待っていると、それぞれ自分のファイル宛ての依頼だけを受け取る", async () => {
  const { base, close } = await startServer();
  try {
    const pollA = pluginNext(base, "", undefined, FILE_A);
    const pollB = pluginNext(base, "", undefined, FILE_B);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exportedB = fetch(`${base}/export?file=${FILE_B.key}&timeout=5`, {
      method: "POST",
      body: '{"nodeIds":["2:2"]}',
    });
    const ranA = runRequest(base, "return figma.root.name;", "?timeout=5", "t1", FILE_A.key);
    const nextB = await json<Next>(pollB);
    const nextA = await json<RunNext>(pollA);
    assert.deepEqual([nextB.seq, nextB.kind, nextB.fileKey], [1, "export", FILE_B.key]);
    assert.deepEqual([nextA.seq, nextA.kind, nextA.fileKey], [2, "run", FILE_A.key]);

    await pluginRunResult(base, nextA, { ok: true, value: FILE_A.name });
    assert.deepEqual(await json(ranA), { seq: 2, value: FILE_A.name });
    // A の続きを待っているあいだに、B 宛て (#3。B は書き出し中) と A 宛て (#4) の依頼が順に来る
    const againA = pluginNext(base, `?server=${nextA.server}&after=2`, undefined, FILE_A);
    const ranB = runRequest(base, "return 3;", "?timeout=5", "t1", FILE_B.key);
    ranB.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ranA2 = runRequest(base, "return 4;", "?timeout=5", "t1", FILE_A.key);
    ranA2.catch(() => {});
    const nextA2 = await json<RunNext>(againA);
    assert.deepEqual([nextA2.seq, nextA2.fileKey], [4, FILE_A.key], "A に B 宛ての依頼を渡した");

    await pluginPost(base, "result", nextB, sampleZip());
    const status = await json<DevStatus>(exportedB);
    assert.equal(status.fileKey, FILE_B.key);
    const nextB2 = await json<RunNext>(pluginNext(base, `?server=${nextB.server}&after=1`, undefined, FILE_B));
    assert.deepEqual([nextB2.seq, nextB2.fileKey], [3, FILE_B.key]);

    const listed = (await json<StatusReply>(fetch(`${base}/status`))).plugin.map((p) => p.fileKey).sort();
    assert.deepEqual(listed, [FILE_A.key, FILE_B.key]);
  } finally {
    close();
  }
});

test("開き直した Local Bridge は、別のファイル宛ての最後の書き出しをやり直さない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base, "", undefined, FILE_A);
    const exported = fetch(`${base}/export?file=${FILE_A.key}&timeout=5`, { method: "POST", body: "" });
    await pluginPost(base, "result", await json<Next>(polled), sampleZip());
    assert.equal((await exported).status, 200);

    const freshB = pluginNext(base, "", undefined, FILE_B);
    freshB.catch(() => {});
    assert.equal(await settleWithin(freshB, 200), "pending", "別のファイル宛ての書き出しを渡した");
    // 同じファイルで開き直した Local Bridge には、いままでどおり最後の書き出しを渡す
    const freshA = await json<Next>(pluginNext(base, "", undefined, FILE_A));
    assert.deepEqual([freshA.seq, freshA.fileKey], [1, FILE_A.key]);
  } finally {
    close();
  }
});

test("ファイル A の依頼を処理しているあいだも、ファイル B の依頼は待たせずに B の Local Bridge へ渡す", async () => {
  const { base, close } = await startServer();
  try {
    const pollA = pluginNext(base, "", undefined, FILE_A);
    const pollB = pluginNext(base, "", undefined, FILE_B);
    pollB.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exportedA = fetch(`${base}/export?file=${FILE_A.key}&timeout=5`, { method: "POST", body: "" });
    exportedA.catch(() => {});
    const takenA = await json<Next>(pollA);
    assert.equal(takenA.fileKey, FILE_A.key);

    const ranB = runRequest(base, "return 1;", "?timeout=5", "t1", FILE_B.key);
    const takenB = await settleWithin(pollB, 500);
    assert.notEqual(takenB, "pending", "A の処理中に B の依頼を待たせた");
    const nextB = await json<RunNext>(takenB as Response);
    assert.deepEqual([nextB.seq, nextB.fileKey], [2, FILE_B.key]);
    await pluginRunResult(base, nextB, { ok: true, value: 1 });
    assert.equal((await ranB).status, 200);
    // B が終わっても、A の依頼は処理中のまま
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin, FILE_A.key)?.processing?.seq, 1);
  } finally {
    close();
  }
});

test("負例: 片方のファイルの Local Bridge が /next を待ちに来ても、もう片方の処理中の script を abandoned にしない", async () => {
  const { base, close } = await startServer();
  try {
    const pollA = pluginNext(base, "", undefined, FILE_A);
    const ran = runRequest(base, "figma.currentPage.selection[0].remove();", "?timeout=5", "t1", FILE_A.key);
    ran.catch(() => {});
    const takenA = await json<RunNext>(pollA);
    assert.equal(takenA.fileKey, FILE_A.key);

    // B のタブで Local Bridge を開いた (待ち位置を持たない)
    const freshB = pluginNext(base, "", undefined, FILE_B);
    freshB.catch(() => {});
    assert.equal(await settleWithin(freshB, 100), "pending");
    const still = await fetch(`${base}/status?seq=1&timeout=0.2`);
    assert.equal(still.status, 504);
    assert.equal((await json<RequestReply>(still)).state, "processing");
  } finally {
    close();
  }
});

test("負例: 自分のファイルを付けずに /next に来た古い版の Local Bridge には、依頼を渡さず build し直すよう 400 で返す", async () => {
  const { base, close } = await startServer();
  try {
    const old = await fetch(`${base}/next`, { headers: PLUGIN });
    assert.equal(old.status, 400);
    assert.match((await json<{ error: string }>(old)).error, /build/);
    // 古い版が来ただけでは、どのファイルもつながっているとは見ない
    assert.deepEqual((await json<StatusReply>(fetch(`${base}/status`))).plugin, []);
  } finally {
    close();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("同じ画面で走り直した (後から来た起動の) Local Bridge だけが依頼を受け取り、前の起動の Local Bridge には 409 で止まるよう返す", async () => {
  const { base, close } = await startServer();
  try {
    const first = { ...FILE_A, launch: "L1" };
    const second = { ...FILE_A, launch: "L2" };
    const oldPoll = pluginNext(base, "", undefined, first);
    oldPoll.catch(() => {});
    await sleep(50);
    const newPoll = pluginNext(base, "", undefined, second);
    // 前の起動が待っていた /next は、後の起動が来た時点で 409 で返る
    const stopped = await settleWithin(oldPoll, 300);
    assert.notEqual(stopped, "pending", "前の起動の Local Bridge が待ち続けた");
    assert.equal((stopped as Response).status, 409);
    const stoppedBody = await json<{ error: string; reason: string }>(stopped as Response);
    assert.equal(stoppedBody.reason, "superseded");
    assert.match(stoppedBody.error, /走り直した/);

    // 交互に渡らず、続けて来た依頼はどれも後の起動が受け取る
    let poll = newPoll;
    for (const nodeIds of [["1:1"], ["2:2"]]) {
      const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: JSON.stringify({ nodeIds }) });
      const next = await json<Next>(poll);
      assert.deepEqual(next.nodeIds, nodeIds);
      await pluginPost(base, "result", next, sampleZip());
      assert.equal((await exported).status, 200);
      // 前の起動がまた聞きに来ても、依頼を渡さずに 409
      const again = await settleWithin(pluginNext(base, "", undefined, first), 300);
      assert.notEqual(again, "pending", "前の起動の Local Bridge が待ち続けた");
      assert.equal((again as Response).status, 409);
      poll = pluginNext(base, `?server=${next.server}&after=${next.seq}`, undefined, second);
    }
    poll.catch(() => {});
  } finally {
    close();
  }
});

test("負例: 前の起動の Local Bridge が /next に来ても、後の起動が処理中の script を abandoned にしない", async () => {
  const { base, close } = await startServer();
  try {
    const first = { ...FILE_A, launch: "L1" };
    const second = { ...FILE_A, launch: "L2" };
    const aborted = new AbortController();
    pluginNext(base, "", aborted.signal, first).catch(() => {});
    await sleep(50);
    aborted.abort();
    const newPoll = pluginNext(base, "", undefined, second);
    const ran = runRequest(base, "figma.currentPage.selection[0].remove();", "?timeout=5");
    ran.catch(() => {});
    assert.equal((await json<RunNext>(newPoll)).seq, 1);

    const late = new AbortController();
    const oldAgain = pluginNext(base, "", late.signal, first);
    oldAgain.catch(() => {});
    await settleWithin(oldAgain, 200);
    late.abort();
    const still = await fetch(`${base}/status?seq=1&timeout=0.2`);
    assert.equal(still.status, 504);
    assert.equal((await json<RequestReply>(still)).state, "processing");
  } finally {
    close();
  }
});

test("負例: 起動 id (launch) を付けずに /next に来た Local Bridge には、依頼を渡さず build し直すよう 400 で返す", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/next?file=${FILE}&name=x`, { headers: PLUGIN, signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 400);
    assert.match((await json<{ error: string }>(res)).error, /build/);
  } finally {
    close();
  }
});

test("GET /status?file はそのファイルの最後の結果を返し、status?after に file を付けるとそのファイルの新しい結果だけを待つ", async () => {
  const { base, close } = await startServer();
  try {
    // ファイルごとの待ち位置 (Local Bridge が覚える server と after)
    const positions = new Map<string, string>();
    const exportOn = async (file: FigmaFile): Promise<DevStatus> => {
      const polled = pluginNext(base, positions.get(file.key) ?? "", undefined, file);
      const exported = fetch(`${base}/export?file=${file.key}&timeout=5`, { method: "POST", body: "" });
      const next = await json<Next>(polled);
      positions.set(file.key, `?server=${next.server}&after=${next.seq}`);
      await pluginPost(base, "result", next, sampleZip());
      return json<DevStatus>(exported);
    };
    const firstA = await exportOn(FILE_A);
    const firstB = await exportOn(FILE_B);
    assert.deepEqual([firstA.version, firstB.version], [1, 2]);

    const ofA = await json<StatusReply>(fetch(`${base}/status?file=${FILE_A.key}`));
    assert.deepEqual([ofA.version, ofA.fileKey, ofA.dir], [1, FILE_A.key, firstA.dir]);
    assert.equal((await json<StatusReply>(fetch(`${base}/status`))).fileKey, FILE_B.key);
    // そのファイルの結果がまだ無ければ version は 0
    const none = await json<StatusReply>(fetch(`${base}/status?file=unknownKey`));
    assert.deepEqual([none.version, none.dir], [0, undefined]);

    const waiting = fetch(`${base}/status?file=${FILE_A.key}&after=1&timeout=5`);
    await exportOn(FILE_B);
    assert.equal(await settleWithin(waiting, 200), "pending", "別のファイルの結果で返った");
    const secondA = await exportOn(FILE_A);
    const res = await waiting;
    assert.equal(res.status, 200);
    assert.deepEqual(
      [(await json<StatusReply>(res)).version, secondA.fileKey],
      [secondA.version, FILE_A.key]
    );
  } finally {
    close();
  }
});

test("起動し直した直後の status?file は、前回の最後の結果がそのファイルのものならそれを返す", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "structure-dump-dev-"));
  writeFileSync(path.join(outDir, "status.json"), JSON.stringify({ version: 7, seq: 3, fileKey: FILE_A.key, dir: "/x/7" }));
  const { base, close } = await startServer(outDir);
  try {
    assert.equal((await json<StatusReply>(fetch(`${base}/status?file=${FILE_A.key}`))).version, 7);
    assert.equal((await json<StatusReply>(fetch(`${base}/status?file=${FILE_B.key}`))).version, 0);
  } finally {
    close();
  }
});

test("負例: ほかのファイルの依頼が保持の上限を超えても、処理中の依頼とそのファイルの最後の書き出しは落とさない", async () => {
  const { base, close } = await startServer();
  try {
    const pollB = pluginNext(base, "", undefined, FILE_B);
    const exportedB = fetch(`${base}/export?file=${FILE_B.key}&timeout=30`, { method: "POST", body: "" });
    const takenB = await json<Next>(pollB);
    let query = "";
    for (let i = 0; i < 110; i += 1) {
      const polled = pluginNext(base, query, undefined, FILE_A);
      const ran = runRequest(base, "return 1;", "?timeout=5");
      const next = await json<RunNext>(polled);
      await pluginRunResult(base, next, { ok: true, value: 1 });
      assert.equal((await ran).status, 200);
      query = `?server=${next.server}&after=${next.seq}`;
    }
    // B の処理中の依頼は落ちていないので、結果を受け、どのファイルの結果かも分かる
    await pluginPost(base, "result", takenB, sampleZip());
    const status = await json<DevStatus>(exportedB);
    assert.equal(status.fileKey, FILE_B.key);
    assert.equal((await json<RequestReply>(fetch(`${base}/status?seq=${takenB.seq}`))).state, "done");
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin, FILE_B.key)?.processing, undefined);
    // B を開き直すと、B の最後の書き出しをやり直す
    const fresh = await json<Next>(pluginNext(base, "", undefined, { ...FILE_B, launch: "B2" }));
    assert.deepEqual([fresh.seq, fresh.fileKey], [takenB.seq, FILE_B.key]);
  } finally {
    close();
  }
});

test("負例: 知らない fileKey の /next を大量に送っても、繋がっていないファイルは忘れ、処理中のファイルは覚えている", async () => {
  const { base, handler, close } = await startServer(undefined, { pluginStaleMs: 50 });
  try {
    const pollB = pluginNext(base, "", undefined, FILE_B);
    const exportedB = fetch(`${base}/export?file=${FILE_B.key}&timeout=5`, { method: "POST", body: "" });
    exportedB.catch(() => {});
    await json<Next>(pollB);
    for (let i = 0; i < 30; i += 1) {
      const aborted = new AbortController();
      pluginNext(base, "", aborted.signal, { key: `junk${i}`, name: "x" }).catch(() => {});
      await sleep(5);
      aborted.abort();
    }
    await sleep(100);
    const aborted = new AbortController();
    pluginNext(base, "", aborted.signal, FILE_A).catch(() => {});
    await sleep(20);
    assert.equal(handler.fileCount(), 2, "繋がっていないファイルを覚え続けた");
    aborted.abort();
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin, FILE_B.key)?.processing?.seq, 1);
  } finally {
    close();
  }
});

test("負例: /next で名乗ったファイル名は、制御文字を除き 200 文字までにして載せる", async () => {
  const { base, close } = await startServer();
  try {
    const aborted = new AbortController();
    pluginNext(base, "", aborted.signal, { key: FILE, name: `a\u0000b\nc\u007f${"あ".repeat(300)}` }).catch(() => {});
    await sleep(50);
    const name = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.fileName ?? "";
    aborted.abort();
    assert.doesNotMatch(name, /[\u0000-\u001f\u007f]/);
    assert.equal(Array.from(name).length, 200);
    assert.ok(name.startsWith("abc"), name.slice(0, 10));
  } finally {
    close();
  }
});

test("負例: file を名乗らない古い版の Local Bridge が来たばかりなら、503 の理由にそれを添える", async () => {
  const { base, close } = await startServer(undefined, { pluginStaleMs: 100 });
  try {
    assert.equal((await fetch(`${base}/next`, { headers: PLUGIN })).status, 400);
    const res = await fetch(`${base}/export?file=${FILE}&timeout=1`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
    assert.match((await json<{ error: string }>(res)).error, /名乗らない古い版の Local Bridge が \d+ 秒前に来た.*build し直/);
    await sleep(150);
    const later = await fetch(`${base}/export?file=${FILE}&timeout=1`, { method: "POST", body: "" });
    assert.doesNotMatch((await json<{ error: string }>(later)).error, /古い版の Local Bridge/);
  } finally {
    close();
  }
});

/** 結果の本文を途中まで送った POST /result。end で残りを送る */
function slowUpload(port: number, next: Handed, zip: Uint8Array): { end: () => Promise<number> } {
  let status: Promise<number> = Promise.resolve(0);
  const upload = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: `/result?${resultQuery(next)}`,
    headers: { Origin: "null", "Content-Length": zip.length },
  });
  status = new Promise((resolve, reject) => {
    upload.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    upload.on("error", reject);
  });
  upload.write(zip.subarray(0, 10));
  return {
    end: () => {
      upload.end(zip.subarray(10));
      return status;
    },
  };
}

test("負例: 結果の本文を受け取っているあいだに後の起動へ渡した別の依頼の処理中を、その結果で消さない", async () => {
  const { base, port, close } = await startServer();
  try {
    const first = { ...FILE_A, launch: "L1" };
    const polled = pluginNext(base, "", undefined, first);
    const exported1 = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    exported1.catch(() => {});
    const taken1 = await json<Next>(polled);
    const exported2 = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: '{"nodeIds":["2:2"]}' });
    exported2.catch(() => {});
    await sleep(50);
    // 前の起動が #1 の結果を送り始めたところで、後の起動が開いて #2 を受け取る
    const upload = slowUpload(port, taken1, sampleZip());
    await sleep(50);
    const taken2 = await json<Next>(pluginNext(base, "", undefined, { ...FILE_A, launch: "L2" }));
    assert.equal(taken2.seq, 2);
    assert.equal(await upload.end(), 200);
    assert.equal((await exported1).status, 200);
    const still = await fetch(`${base}/status?seq=2&timeout=0.2`);
    assert.equal(still.status, 504);
    assert.equal((await json<RequestReply>(still)).state, "processing", "#1 の結果で #2 の処理中が消えた");
  } finally {
    close();
  }
});

test("負例: 止めた起動から遅れて届いた結果は受けるが、後の起動が同じ依頼を書き出し直している処理中は消さない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1" });
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    const taken1 = await json<Next>(polled);
    // 後の起動は、最後の書き出しの #1 をやり直す
    const taken2 = await json<Next>(pluginNext(base, "", undefined, { ...FILE_A, launch: "L2" }));
    assert.deepEqual([taken2.seq, taken2.launch], [1, "L2"]);
    assert.equal((await pluginPost(base, "result", taken1, sampleZip())).status, 200);
    assert.equal((await exported).status, 200);
    const plugin = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin);
    assert.equal(plugin?.processing?.seq, 1, "後の起動の処理中が、止めた起動の結果で消えた");
    // 後の起動の結果も受ける (書き出しは上書きする)
    assert.equal((await pluginPost(base, "result", taken2, sampleZip())).status, 200);
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing, undefined);
  } finally {
    close();
  }
});

test("負例: 引き継いだときに捨てた前の起動の依頼が保持の上限で落ちても、遅れて届いた結果がどのファイルのものか引ける", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1" });
    const exported1 = fetch(`${base}/export?file=${FILE}&timeout=30`, { method: "POST", body: '{"nodeIds":["1:1"]}' });
    exported1.catch(() => {});
    const taken1 = await json<Next>(polled);
    const exported2 = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    await sleep(50);
    const second = { ...FILE_A, launch: "L2" };
    const taken2 = await json<Next>(pluginNext(base, "", undefined, second));
    assert.equal(taken2.seq, 2);
    await pluginPost(base, "result", taken2, sampleZip());
    assert.equal((await exported2).status, 200);
    let query = `?server=${taken2.server}&after=2`;
    for (let i = 0; i < 110; i += 1) {
      const next = pluginNext(base, query, undefined, second);
      const ran = runRequest(base, "return 1;", "?timeout=5");
      const taken = await json<RunNext>(next);
      await pluginRunResult(base, taken, { ok: true, value: 1 });
      assert.equal((await ran).status, 200);
      query = `?server=${taken.server}&after=${taken.seq}`;
    }
    assert.equal((await pluginPost(base, "result", taken1, sampleZip())).status, 200);
    const status = await json<DevStatus>(exported1);
    assert.deepEqual([status.fileKey, status.nodeIds], [FILE_A.key, ["1:1"]]);
  } finally {
    close();
  }
});

test("負例: 起動 id (launch) を付けずに送られた結果は受けず、処理中も消さない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const exported = fetch(`${base}/export?file=${FILE}&timeout=2`, { method: "POST", body: "" });
    exported.catch(() => {});
    const taken = await json<Next>(polled);
    const res = await pluginPost(base, "result", { seq: taken.seq, server: taken.server }, sampleZip());
    assert.equal(res.status, 400);
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.processing?.seq, 1);
  } finally {
    close();
  }
});

test("負例: 結果を残す数を超えても、各ファイルの最後の結果は消さない (GET /status?file が消えた dir を返さない)", async () => {
  const { base, close } = await startServer(undefined, { keepResults: 2 });
  try {
    const positions = new Map<string, string>();
    const exportOn = async (file: FigmaFile): Promise<DevStatus> => {
      const polled = pluginNext(base, positions.get(file.key) ?? "", undefined, file);
      const exported = fetch(`${base}/export?file=${file.key}&timeout=5`, { method: "POST", body: "" });
      const next = await json<Next>(polled);
      positions.set(file.key, `?server=${next.server}&after=${next.seq}`);
      await pluginPost(base, "result", next, sampleZip());
      return json<DevStatus>(exported);
    };
    const ofA = await exportOn(FILE_A);
    const olderB = await exportOn(FILE_B);
    for (let i = 0; i < 3; i += 1) await exportOn(FILE_B);
    const reply = await json<StatusReply>(fetch(`${base}/status?file=${FILE_A.key}`));
    assert.equal(reply.dir, ofA.dir);
    assert.equal(existsSync(path.join(ofA.dir as string, "index.json")), true, "A の最後の結果を消した");
    // 残す数は守る (各ファイルの最後でない古い結果は消える)
    assert.equal(existsSync(olderB.dir as string), false);
  } finally {
    close();
  }
});

test("負例: 画面 (session) を名乗らずに /next に来た Local Bridge には、依頼を渡さず build し直すよう 400 で返す", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/next?file=${FILE}&name=x&launch=L1`, { headers: PLUGIN, signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 400);
    assert.match((await json<{ error: string }>(res)).error, /build/);
  } finally {
    close();
  }
});

test("負例: 同じファイルを別の画面で開いた Local Bridge は、先の画面が生きているあいだ 409 で断り、先の画面に依頼を渡し続ける", async () => {
  const { base, close } = await startServer();
  try {
    const owner = { ...FILE_A, launch: "L1", session: "38648" };
    const other = { ...FILE_A, launch: "L2", session: "38649" };
    const ownerPoll = pluginNext(base, "", undefined, owner);
    await sleep(50);
    const refused = await settleWithin(pluginNext(base, "", undefined, other), 300);
    assert.notEqual(refused, "pending", "別の画面の Local Bridge が待ちに入った");
    assert.equal((refused as Response).status, 409);
    const body = await json<{ error: string; reason: string }>(refused as Response);
    assert.equal(body.reason, "other-screen");
    assert.match(body.error, /別の画面/);
    // 先の画面は止めない
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    const next = await settleWithin(ownerPoll, 300);
    assert.notEqual(next, "pending", "先の画面の Local Bridge に依頼が渡らない");
    const taken = await json<Next>(next as Response);
    assert.equal(taken.launch, "L1");
    await pluginPost(base, "result", taken, sampleZip());
    assert.equal((await exported).status, 200);
    const plugin = stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin);
    assert.equal(plugin?.session, "38648");
    assert.equal(typeof plugin?.otherScreenRefusedAt, "string");
  } finally {
    close();
  }
});

test("負例: 先の画面が処理中なら、別の画面の Local Bridge が来てもその script を abandoned にしない", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1", session: "38648" });
    const ran = runRequest(base, "figma.currentPage.selection[0].remove();", "?timeout=5");
    ran.catch(() => {});
    await json<RunNext>(polled);
    const refused = await settleWithin(pluginNext(base, "", undefined, { ...FILE_A, launch: "L2", session: "38649" }), 300);
    assert.notEqual(refused, "pending");
    assert.equal((refused as Response).status, 409);
    const still = await fetch(`${base}/status?seq=1&timeout=0.2`);
    assert.equal(still.status, 504);
    assert.equal((await json<RequestReply>(still)).state, "processing");
  } finally {
    close();
  }
});

test("先の画面が生きていなければ (待ち手も処理中も無く、最後に届いてから時間が過ぎた)、別の画面が新しい持ち主になり、残っていた依頼を受け取る", async () => {
  const { base, close } = await startServer(undefined, { pluginStaleMs: 300 });
  try {
    const polled = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1", session: "38648" });
    const first = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    const taken1 = await json<Next>(polled);
    // 書き出し中に次の依頼が積まれ、先の画面は結果を返したあと閉じられた (/next に来ない)
    const second = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: '{"nodeIds":["2:2"]}' });
    await sleep(50);
    await pluginPost(base, "result", taken1, sampleZip());
    assert.equal((await first).status, 200);
    await sleep(350);
    const taken2 = await json<Next>(pluginNext(base, "", undefined, { ...FILE_A, launch: "L2", session: "38649" }));
    assert.deepEqual([taken2.seq, taken2.launch], [2, "L2"]);
    await pluginPost(base, "result", taken2, sampleZip());
    assert.equal((await second).status, 200);
    assert.equal(stateOf((await json<StatusReply>(fetch(`${base}/status`))).plugin)?.session, "38649");
  } finally {
    close();
  }
});

test("負例: 2 つの画面が同時にホットリロードで走り直し、持ち主でない画面の新しい起動が先に来ても断り、持ち主の画面の新しい起動が引き継ぐ", async () => {
  const { base, close } = await startServer();
  try {
    // 走り直す前: 持ち主の画面 38648 の起動 L1 が待っていた
    const before = new AbortController();
    pluginNext(base, "", before.signal, { ...FILE_A, launch: "L1", session: "38648" }).catch(() => {});
    await sleep(20);
    before.abort();
    // 走り直した: 持ち主でない画面の新しい起動が先に来る
    const otherFirst = await settleWithin(pluginNext(base, "", undefined, { ...FILE_A, launch: "L2b", session: "38649" }), 300);
    assert.notEqual(otherFirst, "pending", "持ち主でない画面が持ち主になった");
    assert.equal((otherFirst as Response).status, 409);
    // 持ち主の画面の新しい起動は引き継ぐ
    const ownerPoll = pluginNext(base, "", undefined, { ...FILE_A, launch: "L1b", session: "38648" });
    const exported = fetch(`${base}/export?file=${FILE}&timeout=5`, { method: "POST", body: "" });
    const taken = await json<Next>(ownerPoll);
    assert.equal(taken.launch, "L1b");
    await pluginPost(base, "result", taken, sampleZip());
    assert.equal((await exported).status, 200);
    // 持ち主の画面の前の起動は止めた
    assert.equal((await pluginNext(base, "", undefined, { ...FILE_A, launch: "L1", session: "38648" })).status, 409);
  } finally {
    close();
  }
});

test("GET /hello はプラグインの口で、dev サーバーの印を返す", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(`${base}/hello`, { headers: PLUGIN });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { app: DEV_SERVER_APP, protocol: DEV_SERVER_PROTOCOL });
    assert.equal((await fetch(`${base}/hello`, { headers: { Origin: "https://example.com" } })).status, 403);
  } finally {
    close();
  }
});

test("GET /hello は、起動したリポの場所を渡されていれば root で返す (Local Bridge が AI に渡す文を絶対パスで書くため)", async () => {
  const { base, close } = await startServer(undefined, { root: "/work/figma-plugins" });
  try {
    const res = await fetch(`${base}/hello`, { headers: PLUGIN });
    assert.deepEqual(await json(res), { app: DEV_SERVER_APP, protocol: DEV_SERVER_PROTOCOL, root: "/work/figma-plugins" });
  } finally {
    close();
  }
});

test("負例: GET /hello を聞いただけでは、プラグインが繋がっているとは見ない", async () => {
  const { base, close } = await startServer();
  try {
    // ポートを探す curl も、プラグインの UI の探索も /hello を聞く。どちらも依頼を待つ相手ではない
    assert.equal((await fetch(`${base}/hello`)).status, 200);
    assert.equal((await fetch(`${base}/hello`, { headers: PLUGIN })).status, 200);
    const res = await fetch(`${base}/export?file=${FILE}&timeout=1`, { method: "POST", body: "" });
    assert.equal(res.status, 503);
  } finally {
    close();
  }
});

test("負例: 決着した script の依頼に、あとから届いた結果は受けず、最初の結果を残す", async () => {
  const { base, close } = await startServer();
  try {
    const polled = pluginNext(base);
    const ran = runRequest(base, "return 1;");
    const next = await json<RunNext>(polled);
    assert.equal((await pluginRunResult(base, next, { ok: true, value: 1 })).status, 200);
    assert.deepEqual(await json(ran), { seq: 1, value: 1 });
    // 1 回目の応答を受け取れなかった UI が、送信の失敗として送り直した
    const again = await pluginRunResult(base, next, { ok: false, error: "script は実行したが、結果の送信に失敗" });
    assert.equal(again.status, 409);
    const reply = await json<RequestReply>(fetch(`${base}/status?seq=1`));
    assert.equal(reply.state, "done");
    assert.equal(reply.value, 1);
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
      const res = await fetch(`${base}/export?file=${FILE}&timeout=1`, {
        method: "POST",
        headers: { Origin: origin },
        body: "",
      });
      assert.equal(res.status, 403, `Origin ${origin} の /export を受けた`);
      const run = await fetch(`${base}/run?file=${FILE}&timeout=1`, {
        method: "POST",
        headers: { Origin: origin, "X-Run-Token": "t1" },
        body: "return 1;",
      });
      assert.equal(run.status, 403, `Origin ${origin} の /run を受けた`);
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

test("候補のポートと dev サーバーの印と版は、サーバー・Local Bridge の devAllowedDomains・ui.html でそろっている", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/local-bridge/manifest.json"), "utf8")
  ) as { networkAccess: { allowedDomains: string[]; devAllowedDomains?: string[] } };
  assert.deepEqual(manifest.networkAccess.allowedDomains, ["none"]);
  assert.deepEqual(
    manifest.networkAccess.devAllowedDomains,
    DEV_PORTS.map((port) => `http://localhost:${port}/`)
  );
  const ui = readFileSync(path.join(root, "plugins/local-bridge/src/ui.html"), "utf8");
  assert.ok(
    ui.includes(`const DEV_PORTS = [${DEV_PORTS.join(", ")}];`),
    "ui.html の DEV_PORTS がサーバーの DEV_PORTS と違う"
  );
  assert.ok(ui.includes(`const DEV_SERVER_APP = "${DEV_SERVER_APP}";`), "ui.html の DEV_SERVER_APP が違う");
  assert.ok(ui.includes(`const DEV_SERVER_PROTOCOL = ${DEV_SERVER_PROTOCOL};`), "ui.html の DEV_SERVER_PROTOCOL が違う");
});

test("Local Bridge の manifest は、書き出しに効く実行条件が Structure Dump と同じ", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(root, `plugins/${name}/manifest.json`), "utf8")) as Record<string, unknown>;
  const dump = read("structure-dump");
  const localBridge = read("local-bridge");
  for (const key of ["api", "editorType", "documentAccess", "enableProposedApi"]) {
    assert.deepEqual(localBridge[key], dump[key], `manifest の ${key} が違う`);
  }
  // Local Bridge だけが currentuser を持つ (画面ごとの sessionId で、同じファイルの別の画面の 2 つ目を断るため。書き出しには効かない)
  const others = (permissions: unknown): unknown[] =>
    Array.isArray(permissions) ? permissions.filter((p) => p !== "currentuser") : [];
  assert.deepEqual(others(localBridge.permissions), others(dump.permissions), "manifest の permissions が違う");
  assert.ok((localBridge.permissions as unknown[]).includes("currentuser"), "Local Bridge の manifest に currentuser が無い");
});

test("Structure Dump の build は Local Bridge も作り直す (Local Bridge は書き出しを build で取り込む)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["build:dump"], /npm run build:local-bridge/);
});

test("配るプラグインの manifest は通信の設定と開発用のコマンドを持たない", () => {
  for (const name of ["structure-dump", "component-spec"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, `plugins/${name}/manifest.json`), "utf8")
    ) as { menu?: { command: string }[]; networkAccess: Record<string, unknown> };
    assert.deepEqual(manifest.networkAccess, { allowedDomains: ["none"] }, `${name} の networkAccess`);
    assert.ok(
      (manifest.menu ?? []).every((m) => !m.command.startsWith("dev-")),
      `${name} のメニューに開発用のコマンドがある`
    );
  }
});

test("配る manifest に開発用の設定が紛れ込んでも、devAllowedDomains と dev- のコマンドは外れ、ほかは残る", () => {
  const source = {
    name: "Example",
    main: "dist/code.js",
    menu: [
      { name: "書き出し", command: "export-2x" },
      { name: "開発", command: "dev-example" },
    ],
    networkAccess: { allowedDomains: ["none"], devAllowedDomains: ["http://localhost:47717/"] },
  };
  const released = releaseManifest(source) as {
    menu: { command: string }[];
    networkAccess: Record<string, unknown>;
    main: string;
  };
  assert.deepEqual(released.networkAccess, { allowedDomains: ["none"] });
  assert.deepEqual(
    released.menu.map((m) => m.command),
    ["export-2x"]
  );
  assert.equal(released.main, "dist/code.js");
});
