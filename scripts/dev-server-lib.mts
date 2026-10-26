/**
 * Local Bridge の dev サーバー (dev:server) の本体。
 *
 * AI (curl) から書き出しと script の実行の依頼を受け、開いている開発用プラグイン Local Bridge (plugins/local-bridge) の UI が
 * それを long-poll で取り、書き出した ZIP や script の返り値をこのサーバーへ POST する。受けた ZIP は outDir の下へ展開する。
 * ホットリロードで走り直したプラグインは、まだ渡していない最後の依頼を受け取る (無ければ最後の書き出しの依頼をもう一度書き出す)。
 *
 * 候補のポートと dev サーバーの印は、Local Bridge の manifest の devAllowedDomains と ui.html が同じ値を持つ
 * (tests/dev-server.test.mts が一致を見る)。
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

/**
 * 待ち受けるポートの候補。前から順に、空いている最初のポートで起動する。
 * プラグインの UI は devAllowedDomains に書いたポートにしか届かず、乱数のポートは前もって書けないので並べておく
 */
export const DEV_PORTS: readonly number[] = [47717, 47718, 47719, 47720, 47721];
/** GET /hello が返す印。プラグインの UI は、候補のうちこれを返したポートを dev サーバーと見る */
export const DEV_SERVER_APP = "structure-dump-dev-server";

/** プラグインの UI が /next を待つ長さ。これを過ぎたら 204 を返し、UI は待ち直す */
const POLL_HOLD_MS = 25_000;
/**
 * 処理中の依頼も待っている /next も無いまま、最後にプラグインが来てからこれを過ぎたら、繋がっていないと見る。
 * /next の待ちが切れてから UI が聞き直すまでのすき間を含む長さにする
 */
const DEFAULT_PLUGIN_STALE_MS = POLL_HOLD_MS + 10_000;
/**
 * localhost 以外の名前で来た送信 (DNS rebinding でブラウザのサイトが自分の名前を 127.0.0.1 に向けたもの) は断る。
 * URL の hostname の形で比べる
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** プラグインの UI (Origin: null) が使う口。残りは AI (curl。Origin を付けない) が使う口 */
const PLUGIN_ROUTES: ReadonlySet<string> = new Set([
  "GET /hello",
  "GET /next",
  "POST /result",
  "POST /error",
  "POST /run-result",
]);
const DEFAULT_WAIT_SECONDS = 300;
/**
 * script は Claude Code の Bash ツールの既定 (120 秒) で curl が止められる前に、seq の入った 504 を返す。
 * seq を受け取れないと、依頼した側は送り直し、書き換えが二重にかかる
 */
const RUN_DEFAULT_WAIT_SECONDS = 90;
const KEEP_REQUESTS = 100;
const DEFAULT_KEEP_RESULTS = 20;
const SCREENSHOT_SCALES: ReadonlySet<number> = new Set([1, 2]);
export const IMAGE_MODES: ReadonlySet<unknown> = new Set<ImageMode>(["both", "none", "only"]);

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

interface RequestBase {
  seq: number;
  requestedAt: string;
}

/** 書き出す中身。none は構造だけ (画像を省く)、only は画像だけ */
export type ImageMode = "both" | "none" | "only";

export interface DumpRequest extends RequestBase {
  kind: "export";
  /** 無ければプラグインで開いているページの選択 (未選択ならページ直下) */
  nodeIds?: string[];
  scale?: number;
  /** 無ければ both。省いた依頼はこの欄を付けずにプラグインへ渡す */
  images?: ImageMode;
}

export interface RunRequest extends RequestBase {
  kind: "run";
  /** async 関数の本体。プラグインが figma を渡して実行する */
  code: string;
  /** X-Run-Token。照合はプラグインが行う (合言葉を知っているのはプラグインだけ) */
  token: string;
}

export type DevRequest = DumpRequest | RunRequest;

/** POST /export の本文を依頼の形にする。形が違えば throw */
export function parseExportBody(text: string): ExportFields {
  if (text.trim() === "") return {};
  const body = JSON.parse(text) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("本文は JSON のオブジェクトにする ({\"nodeIds\": [...], \"scale\": 2})");
  }
  const { nodeIds, scale, images, ...rest } = body as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`知らないキー: ${unknownKeys.join(", ")}`);
  const out: ExportFields = {};
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
  if (images !== undefined) {
    if (!IMAGE_MODES.has(images)) throw new Error("images は both・none・only のどれかにする (省けば both)");
    out.images = images as ImageMode;
  }
  return out;
}

type ExportFields = Pick<DumpRequest, "nodeIds" | "scale" | "images">;

export interface DevStatus {
  /** 結果か失敗を受けるたびに 1 増える。0 はまだ何も受けていない */
  version: number;
  seq?: number;
  nodeIds?: string[];
  /** 依頼の images。both (省いたときを含む) なら無い */
  images?: ImageMode;
  receivedAt?: string;
  /** 展開したディレクトリ (outDir/latest はここを指す) */
  dir?: string;
  /** 書き出した Figma のファイル名 (index.json の meta.fileName) */
  fileName?: string;
  files?: number;
  warnings?: string[];
  error?: string;
}

/** GET /status と、/export の 503・504 に添えるプラグインの様子 */
export interface PluginState {
  /** 最後にプラグインから何か届いた時刻。起動してからまだ何も届いていなければ無い */
  lastSeenAt?: string;
  /** プラグインへ渡して、まだ結果も失敗も返っていない依頼 */
  processing?: {
    seq: number;
    kind: DevRequest["kind"];
    nodeIds?: string[];
    /** 依頼の images。both (省いたときを含む) なら無い */
    images?: ImageMode;
    elapsedSeconds: number;
  };
}

/** POST /run の応答。script の結果は書き出しの結果ではないので、status.json と version は動かさない */
export interface RunReply {
  seq: number;
  /** script が return した値。return しなければ null */
  value?: unknown;
  error?: string;
}

export interface StatusReply extends DevStatus {
  /** 結果の置き場所。ほかのセッションが起動した dev サーバーに相乗りしたとき、どこに届くかを知るため */
  outDir: string;
  plugin: PluginState;
}

/**
 * GET /status?seq=<seq> が返す 1 件の依頼の様子。done と failed はその依頼の結果 (DevStatus か RunReply) を持つ。
 * skipped は、プラグインがあとの依頼を受け取ったので、もう処理されない依頼 (書き出しは、渡したのに結果が返らなかったものも含む)
 */
export type RequestState =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "skipped"
  /** script だけ: 渡したのに結果が返らないままプラグインが先へ進んだ (途中まで実行したかもしれない) */
  | "abandoned"
  /** script だけ: 渡す前に依頼した側が待つのをやめたので取り消した (実行していない) */
  | "cancelled";

export interface RequestReply extends Partial<DevStatus> {
  seq: number;
  kind: DevRequest["kind"];
  state: RequestState;
  value?: unknown;
  plugin: PluginState;
}

/** 依頼の決着。body は依頼した側へ返す本文 */
interface Outcome {
  ok: boolean;
  body: DevStatus | RunReply;
}

/** プラグインが送った script の結果 (run.ts の RunResultBody の JSON) を、依頼した側への応答にする。形が違えば undefined */
function runOutcomeOf(seq: number, text: string): Outcome | undefined {
  let body: { ok?: unknown; value?: unknown; error?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return undefined;
  }
  if (body?.ok === true) return { ok: true, body: { seq, value: body.value ?? null } };
  if (body?.ok === false && typeof body.error === "string") return { ok: false, body: { seq, error: body.error } };
  return undefined;
}

export interface DevServerOptions {
  outDir: string;
  keepResults?: number;
  pluginStaleMs?: number;
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
function secondsParam(url: URL, fallback = DEFAULT_WAIT_SECONDS): number | undefined {
  const raw = url.searchParams.get("timeout");
  if (raw === null) return fallback;
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

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    // JSON を返さない・2 秒以内に答えない
    return undefined;
  }
}

/** 使用中のポートの相手が dev サーバーとして GET /status に答えれば、その置き場所と、いまのプラグインがつながる版か */
async function runningDevServer(base: string): Promise<{ outDir?: string; current: boolean } | undefined> {
  const status = await getJson(`${base}/status`);
  if (typeof status?.version !== "number") return undefined;
  // GET /hello が無い版には、候補のポートを探す新しいプラグインがつながらない
  const hello = await getJson(`${base}/hello`);
  return {
    outDir: typeof status.outDir === "string" ? status.outDir : undefined,
    current: hello?.app === DEV_SERVER_APP,
  };
}

export type CandidateOutcome =
  /** busy は、先に試して dev サーバーでない相手が使っていたポート */
  | { kind: "listening"; port: number; servers: http.Server[]; errors: string[]; busy: number[] }
  /**
   * 候補のポートで dev サーバーがもう動いている。outDir は古い版では無い。
   * current が false なら、いまのプラグインがつながらない古い版
   */
  | { kind: "running"; port: number; outDir?: string; current: boolean }
  /** 候補のポートがどれも、dev サーバーでない相手に使われている */
  | { kind: "busy"; ports: number[] };

/**
 * 候補のポートを前から順に試し、空いている最初のポートの hosts で待ち受ける。
 * どれかの候補で dev サーバーが動いていれば、新しく起動せずに相乗りする (プラグインは 1 つの dev サーバーにしかつながらない)
 */
export async function listenOnCandidatePorts(
  handler: http.RequestListener,
  ports: readonly number[],
  hosts: readonly string[]
): Promise<CandidateOutcome> {
  // 前の候補が空いていても、後ろの候補で動いている dev サーバーがある
  // (前の候補を使っていた別のアプリが、その dev サーバーの起動後にポートを手放した)
  for (const port of ports) {
    const running = await runningDevServer(`http://${urlHost(hosts[0])}:${port}`);
    if (running !== undefined) return { kind: "running", port, ...running };
  }
  const busy: number[] = [];
  for (const port of ports) {
    const outcome = await listenOnHosts(handler, port, hosts);
    if (outcome.inUse === undefined) {
      return { kind: "listening", port, servers: outcome.servers, errors: outcome.errors, busy };
    }
    // localhost に聞くと、もう片方のアドレスで別のものに届きうるので、使用中だったアドレスに聞く
    const running = await runningDevServer(`http://${outcome.inUse}:${port}`);
    if (running !== undefined) return { kind: "running", port, ...running };
    busy.push(port);
  }
  return { kind: "busy", ports: busy };
}

/** 候補のポートで起動しなかったとき、次にどうするかを返す */
export function notStartedMessage(outcome: Exclude<CandidateOutcome, { kind: "listening" }>): string {
  if (outcome.kind === "running") {
    const where = outcome.outDir === undefined ? "" : `結果の置き場所は ${outcome.outDir}。`;
    if (!outcome.current) {
      return (
        `古い版の dev サーバーが http://localhost:${outcome.port} で動いている。${where}` +
        "いまのプラグインはこの版につながらないので、止めてから npm run dev:server で起動し直す。" +
        "止めると、それを使っているほかのセッションの依頼も止まるので、止める前に人に確かめる"
      );
    }
    return (
      `dev サーバーはもう http://localhost:${outcome.port} で動いている。${where}新しく起動せず、動いているほうにそのまま依頼する。` +
      "止めると、それを使っているほかのセッションの依頼も止まる"
    );
  }
  return (
    `候補のポート ${outcome.ports.join("・")} がどれも、dev サーバーとして答えない相手 (別のアプリか、答えられなくなった dev サーバー) に使われている。` +
    "どれかを空けるか、候補を変える " +
    "(scripts/dev-server-lib.mts の DEV_PORTS・plugins/local-bridge/manifest.json の devAllowedDomains・plugins/local-bridge/src/ui.html の DEV_PORTS をそろえて変え、Local Bridge を起動し直す)"
  );
}

export interface ListenOutcome {
  /** 待ち受けているサーバー。使用中のアドレスがあったときは空 (待ち受けた分も閉じる) */
  servers: http.Server[];
  /** 使用中だったアドレス (URL に書く形。IPv6 は [] で囲む) */
  inUse?: string;
  /** 使用中以外の理由で待ち受けられなかったアドレスと理由 */
  errors: string[];
}

/** 待ち受けるアドレスを URL に書く形にする (IPv6 は [] で囲む) */
function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * hosts のそれぞれで port を待ち受ける。どれかが使用中なら、待ち受けた分も閉じる
 * (片方だけで依頼を受け始めると、起動できなかったプロセスが依頼を受けてしまう)
 */
export function listenOnHosts(
  handler: http.RequestListener,
  port: number,
  hosts: readonly string[]
): Promise<ListenOutcome> {
  return new Promise((resolve) => {
    const listening: http.Server[] = [];
    const errors: string[] = [];
    let inUse: string | undefined;
    let settled = 0;
    const settle = (): void => {
      settled += 1;
      if (settled < hosts.length) return;
      if (inUse === undefined) {
        resolve({ servers: listening, errors });
        return;
      }
      listening.forEach((server) => server.close());
      resolve({ servers: [], inUse, errors });
    };
    for (const host of hosts) {
      const server = http.createServer(handler);
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") inUse ??= urlHost(host);
        else errors.push(`${host}: ${e.message}`);
        settle();
      });
      server.listen(port, host, () => {
        listening.push(server);
        settle();
      });
    }
  });
}

/** 返すのは http.createServer に渡すハンドラ。listen は呼び出し側が行う */
export function createDevServer(options: DevServerOptions): http.RequestListener {
  const log = options.log ?? (() => {});
  const keepResults = options.keepResults ?? DEFAULT_KEEP_RESULTS;
  const outDir = path.resolve(options.outDir);
  const resultsDir = path.join(outDir, "results");
  /** 起動し直す前に渡した依頼はこの起動には無いので、プラグインはこれが変わったら待ち位置を捨てる */
  const serverId = randomUUID().slice(0, 8);
  const lastSeqFile = path.join(outDir, "last-seq");

  const requests: DevRequest[] = [];
  /** done と failed の依頼の結果。requests から落ちた依頼の分は消す */
  const outcomes = new Map<number, Outcome>();
  const pollers = new Set<() => void>();
  const outcomeWaiters = new Map<number, Set<(outcome: Outcome) => void>>();
  const statusWaiters = new Set<() => void>();
  /** 依頼の state が変わるたびに呼ぶ (GET /status?seq の待ち) */
  const requestWaiters = new Set<() => void>();
  const pluginStaleMs = options.pluginStaleMs ?? DEFAULT_PLUGIN_STALE_MS;
  let lastPluginSeen = 0;
  /** プラグインは 1 件ずつ処理し、終わってから /next を待ちに来るので、処理中の依頼は 1 つだけ持つ */
  let processing: { request: DevRequest; handedAt: number } | undefined;
  /**
   * プラグインへ渡した (handed)・あとの依頼を渡したので飛ばした (skipped)・依頼した側が待つのをやめたので取り消した (cancelled) 依頼。
   * どれでもない依頼だけを、これから渡す
   */
  const fates = new Map<number, "handed" | "skipped" | "cancelled">();

  mkdirSync(resultsDir, { recursive: true });
  // results/ は起動をまたいで残る。前回の続きの番号から振らないと、保持件数の掃除が新しい結果を消す
  let status: DevStatus = previousStatus();
  // seq も前回の続きから振る。振り直すと、依頼側が前回の起動で受け取った seq が別の依頼を指す
  let nextSeq = Math.max(previousLastSeq(), status.seq ?? 0) + 1;

  function previousLastSeq(): number {
    try {
      const seq = Number(readFileSync(lastSeqFile, "utf8").trim());
      return Number.isInteger(seq) && seq > 0 ? seq : 0;
    } catch {
      return 0;
    }
  }

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

  // 重い書き出しのあいだは Figma ごと固まり、UI から何も届かない。
  // だから処理中かどうかは、届いたかどうかでなく、渡した依頼の結果がまだかで見る
  function pluginConnected(): boolean {
    return processing !== undefined || pollers.size > 0 || Date.now() - lastPluginSeen < pluginStaleMs;
  }

  function pluginState(): PluginState {
    return {
      lastSeenAt: lastPluginSeen === 0 ? undefined : new Date(lastPluginSeen).toISOString(),
      processing:
        processing === undefined
          ? undefined
          : {
              seq: processing.request.seq,
              kind: processing.request.kind,
              nodeIds: nodeIdsOf(processing.request),
              images: imagesOf(processing.request),
              elapsedSeconds: Math.floor((Date.now() - processing.handedAt) / 1000),
            },
    };
  }

  function nodeIdsOf(request: DevRequest | undefined): string[] | undefined {
    return request?.kind === "export" ? request.nodeIds : undefined;
  }

  function imagesOf(request: DevRequest | undefined): ImageMode | undefined {
    return request?.kind === "export" && request.images !== "both" ? request.images : undefined;
  }

  function statusReply(): StatusReply {
    return { ...status, outDir, plugin: pluginState() };
  }

  function setProcessing(next: typeof processing): void {
    processing = next;
    requestWaiters.forEach((wake) => wake());
  }

  function requestReply(seq: number): RequestReply | undefined {
    const request = requestOf(seq);
    if (request === undefined) return undefined;
    const outcome = outcomes.get(seq);
    const plugin = pluginState();
    if (outcome !== undefined) {
      return { ...outcome.body, seq, kind: request.kind, state: outcome.ok ? "done" : "failed", plugin };
    }
    return {
      seq,
      kind: request.kind,
      nodeIds: nodeIdsOf(request),
      images: imagesOf(request),
      state: unsettledState(request),
      plugin,
    };
  }

  function unsettledState(request: DevRequest): RequestState {
    if (processing?.request.seq === request.seq) return "processing";
    const fate = fates.get(request.seq);
    if (fate === undefined) return "queued";
    // 渡したのに結果が返らないままプラグインが先へ進んだ。書き出しは送り直せばよいが、script は途中まで実行したかもしれない
    if (fate === "handed") return request.kind === "run" ? "abandoned" : "skipped";
    return fate;
  }

  function pending(request: DevRequest): boolean {
    return !fates.has(request.seq);
  }

  function nextRequestFor(after: number | undefined): DevRequest | undefined {
    if (after !== undefined) return requests.find((r) => r.seq > after && pending(r));
    // 走り直したプラグイン (待ち位置を持たない) には、まだ渡していない最後の依頼を渡す (それより前の依頼は飛ばす)。
    // 無ければ最後の書き出しをやり直させる (build したプラグインの結果を status?after で待つ使い方)。
    // 渡し済みの script は渡し直さない (書き換えが二重にかかる)
    return requests.findLast(pending) ?? requests.findLast((r) => r.kind === "export");
  }

  /** 依頼した側が待つのをやめた script は、まだ渡していなければ取り消す。あとで開いたプラグインや別のファイルで実行させない */
  function cancelIfPending(request: DevRequest): boolean {
    if (request.kind !== "run" || !pending(request)) return false;
    fates.set(request.seq, "cancelled");
    log(`#${request.seq} の script を取り消した (依頼した側が待つのをやめた。まだ渡していない)`);
    requestWaiters.forEach((wake) => wake());
    return true;
  }

  function settle(seq: number, outcome: Outcome): void {
    outcomes.set(seq, outcome);
    const waiters = outcomeWaiters.get(seq);
    if (waiters !== undefined) {
      outcomeWaiters.delete(seq);
      waiters.forEach((resolve) => resolve(outcome));
    }
    requestWaiters.forEach((wake) => wake());
  }

  function publish(next: DevStatus, ok: boolean): void {
    status = next;
    writeFileSync(path.join(outDir, "status.json"), JSON.stringify(status, null, 2) + "\n");
    statusWaiters.forEach((wake) => wake());
    if (next.seq !== undefined) settle(next.seq, { ok, body: next });
  }

  function requestOf(seq: number): DevRequest | undefined {
    return requests.find((r) => r.seq === seq);
  }

  function storeRunOutcome(seq: number, outcome: Outcome): void {
    settle(seq, outcome);
    log(outcome.ok ? `#${seq} の script の結果を受けた` : `#${seq} の script は失敗: ${(outcome.body as RunReply).error}`);
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
    publish(
      {
        version,
        seq,
        nodeIds: nodeIdsOf(requestOf(seq)),
        images: imagesOf(requestOf(seq)),
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
    publish(
      {
        version: status.version + 1,
        seq,
        nodeIds: nodeIdsOf(requestOf(seq)),
        images: imagesOf(requestOf(seq)),
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
    onTimeout: () => void,
    /** 返す前に相手が接続を切った */
    onClose?: () => void
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
      if (done) return;
      finish();
      onClose?.();
    });
  }

  /** 繋がっていないのに積むと、あとで開いたプラグインが誰も待っていない依頼を処理するので、積まずに 503 を返す */
  function refuseUnlessConnected(res: http.ServerResponse): boolean {
    if (pluginConnected()) return false;
    send(res, 503, {
      error: "プラグインが繋がっていない (Figma で Local Bridge を開いたままにする)",
      plugin: pluginState(),
    });
    return true;
  }

  function describe(request: DevRequest): string {
    if (request.kind === "run") return `script の実行 (${request.code.length} 文字)`;
    const target = request.nodeIds ? request.nodeIds.join(", ") : "プラグインで開いているページの選択";
    const images = imagesOf(request);
    return images === undefined ? target : `${target} (images: ${images})`;
  }

  /** 依頼を積み、プラグインから決着が届いたら res に返す。seconds 待っても届かなければ 504 */
  function enqueueAndWait(
    res: http.ServerResponse,
    fields: Omit<DumpRequest, "seq" | "requestedAt"> | Omit<RunRequest, "seq" | "requestedAt">,
    seconds: number
  ): void {
    const request = { ...fields, seq: nextSeq, requestedAt: new Date().toISOString() } as DevRequest;
    nextSeq += 1;
    writeFileSync(lastSeqFile, `${request.seq}\n`);
    requests.push(request);
    if (requests.length > KEEP_REQUESTS) {
      const dropped = (requests.shift() as DevRequest).seq;
      outcomes.delete(dropped);
      fates.delete(dropped);
    }
    log(`#${request.seq} を受けた: ${describe(request)}`);
    pollers.forEach((wake) => wake());
    let resolveOutcome: ((outcome: Outcome) => void) | undefined;
    waitFor(
      res,
      (wake) => {
        resolveOutcome = (outcome) => {
          wake();
          send(res, outcome.ok ? 200 : 422, outcome.body);
        };
        const set = outcomeWaiters.get(request.seq) ?? new Set();
        set.add(resolveOutcome);
        outcomeWaiters.set(request.seq, set);
        return () => outcomeWaiters.get(request.seq)?.delete(resolveOutcome as (o: Outcome) => void);
      },
      seconds * 1000,
      () => {
        const plugin = pluginState();
        if (cancelIfPending(request)) {
          send(res, 504, {
            error: `${seconds} 秒待ってもプラグインに渡せなかったので取り消した (実行していない。送り直してよい)`,
            seq: request.seq,
            plugin,
          });
          return;
        }
        // 処理の途中でプラグインを閉じても処理中は残るので、「処理中」とは断定しない
        const hint =
          plugin.processing === undefined
            ? "Figma で Local Bridge を開いているか確かめる"
            : `プラグインへ渡した #${plugin.processing.seq} の結果がまだ来ていない`;
        send(res, 504, {
          error: `${seconds} 秒待ってもプラグインから結果が来ない (${hint})`,
          seq: request.seq,
          plugin,
        });
      },
      () => cancelIfPending(request)
    );
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
    // /hello はポートを探すだけの送信 (curl からも来る) で、依頼を待つプラグインがいる印にならない
    if (fromPlugin && route !== "GET /hello") lastPluginSeen = Date.now();

    if (route === "POST /export") {
      const seconds = secondsParam(url);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      let parsed: ExportFields;
      try {
        parsed = parseExportBody((await readBody(req)).toString("utf8"));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (refuseUnlessConnected(res)) return;
      enqueueAndWait(res, { kind: "export", ...parsed }, seconds);
      return;
    }

    if (route === "POST /run") {
      const seconds = secondsParam(url, RUN_DEFAULT_WAIT_SECONDS);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      const token = req.headers["x-run-token"];
      if (typeof token !== "string" || token === "") {
        send(res, 400, { error: "X-Run-Token が無い (プラグインの画面に出ている合言葉をヘッダに付ける)" });
        return;
      }
      const code = (await readBody(req)).toString("utf8");
      if (code.trim() === "") {
        send(res, 400, { error: "本文に実行するコードを入れる" });
        return;
      }
      if (refuseUnlessConnected(res)) return;
      enqueueAndWait(res, { kind: "run", code, token }, seconds);
      return;
    }

    if (route === "GET /hello") {
      send(res, 200, { app: DEV_SERVER_APP });
      return;
    }

    if (route === "GET /next") {
      const afterParam = url.searchParams.get("after");
      const sameServer = url.searchParams.get("server") === serverId;
      const after = afterParam !== null && sameServer ? Number(afterParam) : undefined;
      const reply = (request: DevRequest): void => {
        // プラグインは seq の小さい順に受け取るので、これより前でまだ渡していない依頼は、もう渡さない
        for (const r of requests) if (r.seq < request.seq && pending(r)) fates.set(r.seq, "skipped");
        fates.set(request.seq, "handed");
        setProcessing({ request, handedAt: Date.now() });
        send(res, 200, { server: serverId, ...request });
      };
      // 渡す依頼があれば、処理中をそれに差し替える。先に解くと、走り直して同じ依頼を受け取り直すあいだに
      // GET /status?seq の待ちが起き、書き出し直す依頼を skipped と答える
      const ready = nextRequestFor(after);
      if (ready !== undefined) {
        reply(ready);
        return;
      }
      // 書き出し中のプラグインは /next を待たないので、待ちに来たなら手元の依頼はもう無い
      setProcessing(undefined);
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

    if (route === "POST /result" || route === "POST /error" || route === "POST /run-result") {
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
      // 版の古いプラグインの UI は script の依頼を書き出しとして扱い、書き出しの結果を返してくる
      const kind = requestOf(seq)?.kind;
      if (kind !== undefined && (kind === "run") !== (route === "POST /run-result")) {
        send(res, 409, { error: `#${seq} は ${kind === "run" ? "script の実行" : "書き出し"} の依頼なので、この口では受けない` });
        return;
      }
      // 応答を受け取れなかった UI が送り直してきても、先に届いた結果を残す (書き出しは build のたびに書き出し直すので上書きする)
      if (kind === "run" && outcomes.has(seq)) {
        send(res, 409, { error: `#${seq} の script の結果はもう受けている` });
        return;
      }
      const body = await readBody(req);
      // 本文を受け取り終えるまでは処理中のままにする (受信中に時間切れになった依頼側に、処理中と見せる)。
      // ここでは待ちを起こさない。結果を保存する前に起こすと、結果の無い依頼として skipped と答える (保存の settle が起こす)
      if (processing?.request.seq === seq) processing = undefined;
      if (route === "POST /run-result") {
        const text = body.toString("utf8");
        const read = runOutcomeOf(seq, text);
        const outcome = read ?? {
          ok: false,
          body: { seq, error: `プラグインから届いた script の結果を読めない: ${text.slice(0, 200)}` },
        };
        storeRunOutcome(seq, outcome);
        send(res, read === undefined ? 400 : 200, outcome.body);
        return;
      }
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

    if (route === "GET /status" && url.searchParams.has("seq")) {
      const seq = Number(url.searchParams.get("seq"));
      const seconds = secondsParam(url);
      if (!Number.isInteger(seq) || seq < 1 || seconds === undefined) {
        send(res, 400, { error: "seq は正の整数、timeout は正の秒数にする" });
        return;
      }
      const settled = (reply: RequestReply): boolean => reply.state !== "queued" && reply.state !== "processing";
      const now = requestReply(seq);
      if (now === undefined) {
        send(res, 404, { error: `この起動の dev サーバーは #${seq} を受けていない (起動し直す前の依頼か、古い依頼)` });
        return;
      }
      if (settled(now)) {
        send(res, 200, now);
        return;
      }
      waitFor(
        res,
        (wake) => {
          const waiter = (): void => {
            const reply = requestReply(seq);
            if (reply === undefined || !settled(reply)) return;
            wake();
            send(res, 200, reply);
          };
          requestWaiters.add(waiter);
          return () => requestWaiters.delete(waiter);
        },
        seconds * 1000,
        () => send(res, 504, { ...requestReply(seq), error: `${seconds} 秒待っても #${seq} の結果が来ない` })
      );
      return;
    }

    if (route === "GET /status") {
      const afterParam = url.searchParams.get("after");
      const after = afterParam === null ? undefined : Number(afterParam);
      if (after === undefined || status.version > after) {
        send(res, 200, statusReply());
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
            send(res, 200, statusReply());
          };
          statusWaiters.add(waiter);
          return () => statusWaiters.delete(waiter);
        },
        seconds * 1000,
        () => send(res, 504, { ...statusReply(), error: `${seconds} 秒待っても新しい結果が来ない` })
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
