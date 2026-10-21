/**
 * Structure Dump の開発用サーバー (dev:server) の本体。
 *
 * AI (curl) から書き出しの依頼を受け、開いている開発プラグインの UI がそれを long-poll で取り、
 * 書き出した ZIP をこのサーバーへ POST する。受けた ZIP は outDir の下へ展開する。
 * プラグインはメニューの「開発: dev サーバーとつなぐ」で起動したときだけつなぐ。
 * ホットリロードで走り直したプラグインは、最後の依頼をもう一度書き出す。
 *
 * ポートはプラグインの manifest の devAllowedDomains と ui.html が同じ値を持つ
 * (tests/structure-dump-dev-server.test.mts が一致を見る)。
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";

export const DEV_PORT = 47717;

/** プラグインの UI が /next を待つ長さ。これを過ぎたら 204 を返し、UI は待ち直す */
const POLL_HOLD_MS = 25_000;
/** 最後にプラグインが来てからこれを過ぎ、待っている /next も書き出し中の依頼も無ければ、繋がっていないと見る */
const DEFAULT_PLUGIN_STALE_MS = POLL_HOLD_MS + 10_000;
/** /next で渡してからこれを過ぎても結果が来ない依頼は、書き出し中と見ない (途中でプラグインを閉じた) */
const DEFAULT_HANDED_OUT_MS = 120_000;
/**
 * localhost 以外の名前で来た送信 (DNS rebinding でブラウザのサイトが自分の名前を 127.0.0.1 に向けたもの) は断る。
 * URL の hostname の形で比べる
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** プラグインの UI (Origin: null) が使う口。残りは AI (curl。Origin を付けない) が使う口 */
const PLUGIN_ROUTES: ReadonlySet<string> = new Set(["GET /next", "POST /result", "POST /error"]);
const DEFAULT_WAIT_SECONDS = 300;
const KEEP_REQUESTS = 100;
const DEFAULT_KEEP_RESULTS = 20;
const SCREENSHOT_SCALES: ReadonlySet<number> = new Set([1, 2]);

// ---------------------------------------------------------------------------
// ZIP の読み取り (プラグインの zip.ts が作る無圧縮 ZIP だけを読む)
// ---------------------------------------------------------------------------

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readStoredZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) {
    throw new Error("ZIP の終端 (EOCD) が見つからない");
  }
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: ZipFile[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error("ZIP の中央ディレクトリが壊れている");
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    if (method !== 0) throw new Error(`無圧縮でないエントリは読めない: ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + size);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`CRC が合わない: ${name}`);
    files.push({ name, data });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** ZIP 内のパスを dir の下の実パスにする。dir の外を指すパスは throw */
export function entryPath(dir: string, name: string): string {
  const resolved = path.resolve(dir, name);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`展開先の外を指すパス: ${name}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 依頼と結果
// ---------------------------------------------------------------------------

export interface DumpRequest {
  seq: number;
  /** 無ければプラグインで開いているページの選択 (未選択ならページ直下) */
  nodeIds?: string[];
  scale?: number;
  requestedAt: string;
}

/** POST /export の本文を依頼の形にする。形が違えば throw */
export function parseExportBody(text: string): Pick<DumpRequest, "nodeIds" | "scale"> {
  if (text.trim() === "") return {};
  const body = JSON.parse(text) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("本文は JSON のオブジェクトにする ({\"nodeIds\": [...], \"scale\": 2})");
  }
  const { nodeIds, scale, ...rest } = body as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`知らないキー: ${unknownKeys.join(", ")}`);
  const out: Pick<DumpRequest, "nodeIds" | "scale"> = {};
  if (nodeIds !== undefined) {
    if (
      !Array.isArray(nodeIds) ||
      nodeIds.length === 0 ||
      !nodeIds.every((id) => typeof id === "string" && id !== "")
    ) {
      throw new Error("nodeIds は空でない文字列の配列にする");
    }
    out.nodeIds = nodeIds as string[];
  }
  if (scale !== undefined) {
    if (typeof scale !== "number" || !SCREENSHOT_SCALES.has(scale)) {
      throw new Error("scale は 1 か 2 にする");
    }
    out.scale = scale;
  }
  return out;
}

export interface DevStatus {
  /** 結果か失敗を受けるたびに 1 増える。0 はまだ何も受けていない */
  version: number;
  seq?: number;
  nodeIds?: string[];
  receivedAt?: string;
  /** 展開したディレクトリ (outDir/latest はここを指す) */
  dir?: string;
  /** 書き出した Figma のファイル名 (index.json の meta.fileName) */
  fileName?: string;
  files?: number;
  warnings?: string[];
  error?: string;
}

type Outcome = { ok: true; status: DevStatus } | { ok: false; status: DevStatus };

export interface DevServerOptions {
  outDir: string;
  keepResults?: number;
  pluginStaleMs?: number;
  handedOutMs?: number;
  log?: (line: string) => void;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(code);
    res.end();
    return;
  }
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2) + "\n");
}

function indexMeta(files: ZipFile[]): Pick<DevStatus, "fileName" | "warnings"> {
  const index = files.find((f) => f.name === "index.json");
  if (index === undefined) return {};
  const parsed = JSON.parse(new TextDecoder().decode(index.data)) as {
    meta?: { fileName?: unknown; warnings?: unknown };
  };
  const meta = parsed.meta ?? {};
  return {
    fileName: typeof meta.fileName === "string" ? meta.fileName : undefined,
    warnings: Array.isArray(meta.warnings) ? meta.warnings.map(String) : undefined,
  };
}

/** 秒数のクエリ。無ければ既定、正の数でなければ undefined */
function secondsParam(url: URL): number | undefined {
  const raw = url.searchParams.get("timeout");
  if (raw === null) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function hostnameOf(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

/** 返すのは http.createServer に渡すハンドラ。listen は呼び出し側が行う */
export function createDevServer(options: DevServerOptions): http.RequestListener {
  const log = options.log ?? (() => {});
  const keepResults = options.keepResults ?? DEFAULT_KEEP_RESULTS;
  const outDir = path.resolve(options.outDir);
  const resultsDir = path.join(outDir, "results");
  /** サーバーを起動し直すと seq が 1 に戻るので、プラグインはこれが変わったら待ち位置を捨てる */
  const serverId = randomUUID().slice(0, 8);

  let nextSeq = 1;
  const requests: DumpRequest[] = [];
  const pollers = new Set<() => void>();
  const outcomeWaiters = new Map<number, Set<(outcome: Outcome) => void>>();
  const statusWaiters = new Set<() => void>();
  const pluginStaleMs = options.pluginStaleMs ?? DEFAULT_PLUGIN_STALE_MS;
  const handedOutMs = options.handedOutMs ?? DEFAULT_HANDED_OUT_MS;
  /** /next で渡して、まだ結果も失敗も来ていない依頼 → 渡した時刻 */
  const handedOut = new Map<number, number>();
  let lastPluginSeen = 0;

  mkdirSync(resultsDir, { recursive: true });
  // results/ は起動をまたいで残る。前回の続きの番号から振らないと、保持件数の掃除が新しい結果を消す
  let status: DevStatus = previousStatus();

  function previousStatus(): DevStatus {
    const versions = readdirSync(resultsDir).map(Number).filter((n) => Number.isInteger(n));
    let previous: DevStatus | undefined;
    try {
      const parsed = JSON.parse(readFileSync(path.join(outDir, "status.json"), "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as DevStatus).version === "number") {
        previous = parsed as DevStatus;
        versions.push(previous.version);
      }
    } catch {
      // 初回の起動では status.json が無い
    }
    return { ...previous, version: Math.max(0, ...versions) };
  }

  function pluginConnected(): boolean {
    const now = Date.now();
    return (
      pollers.size > 0 ||
      now - lastPluginSeen < pluginStaleMs ||
      Array.from(handedOut.values()).some((at) => now - at < handedOutMs)
    );
  }

  function nextRequestFor(after: number | undefined): DumpRequest | undefined {
    if (after === undefined) return requests[requests.length - 1];
    return requests.find((r) => r.seq > after);
  }

  function publish(next: DevStatus, outcome: Outcome["ok"]): void {
    status = next;
    writeFileSync(path.join(outDir, "status.json"), JSON.stringify(status, null, 2) + "\n");
    const waiters = next.seq === undefined ? undefined : outcomeWaiters.get(next.seq);
    if (waiters !== undefined) {
      outcomeWaiters.delete(next.seq as number);
      waiters.forEach((resolve) => resolve({ ok: outcome, status } as Outcome));
    }
    statusWaiters.forEach((wake) => wake());
  }

  function requestOf(seq: number): DumpRequest | undefined {
    return requests.find((r) => r.seq === seq);
  }

  function storeResult(seq: number, files: ZipFile[]): void {
    const version = status.version + 1;
    const dir = path.join(resultsDir, String(version));
    rmSync(dir, { recursive: true, force: true });
    for (const file of files) {
      const target = entryPath(dir, file.name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.data);
    }
    // latest の差し替えは rename で行い、読んでいる途中で消えた状態を作らない
    const tmpLink = path.join(outDir, `.latest-${version}`);
    rmSync(tmpLink, { force: true });
    symlinkSync(path.relative(outDir, dir), tmpLink);
    renameSync(tmpLink, path.join(outDir, "latest"));
    const kept = readdirSync(resultsDir)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => b - a);
    for (const old of kept.slice(keepResults)) {
      rmSync(path.join(resultsDir, String(old)), { recursive: true, force: true });
    }
    const request = requestOf(seq);
    publish(
      {
        version,
        seq,
        nodeIds: request?.nodeIds,
        receivedAt: new Date().toISOString(),
        dir,
        ...indexMeta(files),
        files: files.length,
      },
      true
    );
    log(`#${seq} の結果を受けた: ${files.length} ファイル → ${dir}`);
  }

  function storeError(seq: number, message: string): void {
    const request = requestOf(seq);
    publish(
      {
        version: status.version + 1,
        seq,
        nodeIds: request?.nodeIds,
        receivedAt: new Date().toISOString(),
        error: message,
      },
      false
    );
    log(`#${seq} は失敗: ${message}`);
  }

  function waitFor(
    res: http.ServerResponse,
    register: (wake: () => void) => () => void,
    ms: number,
    onTimeout: () => void
  ): void {
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      unregister();
    };
    const unregister = register(() => {
      if (!done) finish();
    });
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      onTimeout();
    }, ms);
    res.on("close", () => {
      if (!done) finish();
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // プラグインの UI は Content-Type を付けない単純なリクエストだけを送るので、preflight は来ない
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const hostname = hostnameOf(req.headers.host);
    if (hostname === undefined || !LOOPBACK_HOSTNAMES.has(hostname)) {
      send(res, 403, { error: `localhost 以外の名前で来た送信は受けない: ${req.headers.host}` });
      return;
    }
    // プラグインの iframe は Origin: null、curl は Origin 無しで来る。ブラウザで開いたサイトは
    // 自分の Origin か (sandbox の iframe なら) null を付けるので、AI 側の口は Origin 付きを全部断る
    const origin = req.headers.origin;
    const fromPlugin = PLUGIN_ROUTES.has(route);
    if (origin !== undefined && !(fromPlugin && origin === "null")) {
      send(res, 403, { error: `この Origin からは受けない: ${origin}` });
      return;
    }
    if (fromPlugin) lastPluginSeen = Date.now();

    if (route === "POST /export") {
      const seconds = secondsParam(url);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      let parsed: Pick<DumpRequest, "nodeIds" | "scale">;
      try {
        parsed = parseExportBody((await readBody(req)).toString("utf8"));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      // 繋がっていないのに積むと、あとで開いたプラグインが誰も待っていない依頼を書き出す
      if (!pluginConnected()) {
        send(res, 503, {
          error: "プラグインが繋がっていない (Figma で「開発: dev サーバーとつなぐ」を開いたままにする)",
        });
        return;
      }
      const request: DumpRequest = { seq: nextSeq, ...parsed, requestedAt: new Date().toISOString() };
      nextSeq += 1;
      requests.push(request);
      if (requests.length > KEEP_REQUESTS) requests.shift();
      log(`#${request.seq} を受けた: ${request.nodeIds ? request.nodeIds.join(", ") : "プラグインで開いているページの選択"}`);
      pollers.forEach((wake) => wake());
      let resolveOutcome: ((outcome: Outcome) => void) | undefined;
      waitFor(
        res,
        (wake) => {
          resolveOutcome = (outcome) => {
            wake();
            send(res, outcome.ok ? 200 : 422, outcome.status);
          };
          const set = outcomeWaiters.get(request.seq) ?? new Set();
          set.add(resolveOutcome);
          outcomeWaiters.set(request.seq, set);
          return () => outcomeWaiters.get(request.seq)?.delete(resolveOutcome as (o: Outcome) => void);
        },
        seconds * 1000,
        () =>
          send(res, 504, {
            error: `${seconds} 秒待ってもプラグインから結果が来ない (Figma で「開発: dev サーバーとつなぐ」を開いているか確かめる)`,
            seq: request.seq,
          })
      );
      return;
    }

    if (route === "GET /next") {
      const afterParam = url.searchParams.get("after");
      const sameServer = url.searchParams.get("server") === serverId;
      const after = afterParam !== null && sameServer ? Number(afterParam) : undefined;
      const reply = (request: DumpRequest): void => {
        handedOut.set(request.seq, Date.now());
        send(res, 200, { server: serverId, ...request });
      };
      const ready = nextRequestFor(after);
      if (ready !== undefined) {
        reply(ready);
        return;
      }
      waitFor(
        res,
        (wake) => {
          const poller = (): void => {
            const request = nextRequestFor(after);
            if (request === undefined) return;
            wake();
            reply(request);
          };
          pollers.add(poller);
          return () => pollers.delete(poller);
        },
        POLL_HOLD_MS,
        () => send(res, 204)
      );
      return;
    }

    if (route === "POST /result" || route === "POST /error") {
      const seq = Number(url.searchParams.get("seq"));
      if (!Number.isInteger(seq) || seq < 1) {
        send(res, 400, { error: "seq が無い" });
        return;
      }
      // 起動し直す前のサーバーの依頼の結果は、同じ seq の新しい依頼のものと取り違えるので受けない
      if (url.searchParams.get("server") !== serverId) {
        send(res, 409, { error: "別の起動のサーバーの依頼の結果は受けない" });
        return;
      }
      handedOut.delete(seq);
      const body = await readBody(req);
      if (route === "POST /error") {
        storeError(seq, body.toString("utf8"));
        send(res, 200, status);
        return;
      }
      try {
        storeResult(seq, readStoredZip(new Uint8Array(body)));
      } catch (e) {
        storeError(seq, `受けた ZIP を展開できない: ${e instanceof Error ? e.message : String(e)}`);
        send(res, 400, status);
        return;
      }
      send(res, 200, status);
      return;
    }

    if (route === "GET /status") {
      const afterParam = url.searchParams.get("after");
      const after = afterParam === null ? undefined : Number(afterParam);
      if (after === undefined || status.version > after) {
        send(res, 200, status);
        return;
      }
      const seconds = secondsParam(url);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      waitFor(
        res,
        (wake) => {
          const waiter = (): void => {
            wake();
            send(res, 200, status);
          };
          statusWaiters.add(waiter);
          return () => statusWaiters.delete(waiter);
        },
        seconds * 1000,
        () => send(res, 504, { error: `${seconds} 秒待っても新しい結果が来ない`, ...status })
      );
      return;
    }

    send(res, 404, { error: `知らない経路: ${route}` });
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`内部エラー: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: String(e) });
    });
  };
}
