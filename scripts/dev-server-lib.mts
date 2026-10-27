/**
 * Local Bridge の dev サーバー (dev:server) の本体。
 *
 * AI (curl) から書き出しと script の実行の依頼を受け、開いている開発用プラグイン Local Bridge (plugins/local-bridge) の UI が
 * それを long-poll で取り、書き出した ZIP や script の返り値をこのサーバーへ POST する。受けた ZIP は outDir の下へ展開する。
 * 依頼は行き先の Figma のファイル (fileKey) を持ち、そのファイルで開いている Local Bridge にだけ渡す。
 * 待ち行列・処理中の依頼・繋がっているかの判定はファイルごとに持ち、seq は全体で 1 本の通し番号にする。
 * ホットリロードで走り直したプラグインは、自分のファイル宛てでまだ渡していない最後の依頼を受け取る
 * (無ければ自分のファイル宛ての最後の書き出しの依頼をもう一度書き出す)。
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
/**
 * GET /hello が返す、Local Bridge とのやり取りの版。依頼をファイルごとに振り分ける版から 2 (それより前の版は返さない)。
 * いまの Local Bridge は、振り分けない版の依頼 (行き先のファイルが無い) を実行しないので、npm run dev:server はこれが違う dev サーバーを古い版と見る
 */
export const DEV_SERVER_PROTOCOL = 2;

/** プラグインの UI が /next を待つ長さ。これを過ぎたら 204 を返し、UI は待ち直す */
const POLL_HOLD_MS = 25_000;
/**
 * あるファイルの処理中の依頼も待っている /next も無いまま、そのファイルのプラグインが最後に来てからこれを過ぎたら、繋がっていないと見る。
 * /next の待ちが切れてから UI が聞き直すまでのすき間を含む長さにする
 */
const DEFAULT_PLUGIN_STALE_MS = POLL_HOLD_MS + 10_000;
/**
 * 処理中の依頼があっても、渡してから (か、その画面から最後に何か届いてから) これを過ぎたら、その画面は生きていないと見る。
 * 処理中のまま画面を閉じると結果が来ないので、上限が無いと別の画面がいつまでも持ち主になれない。
 * 重い書き出しのあいだは Figma ごと固まって何も届かないので、短くしすぎない
 */
const DEFAULT_PROCESSING_STALE_MS = 10 * 60_000;
/** /next の session (figma.currentUser.sessionId) の形。数なので数字だけ・20 文字まで */
const SESSION_PATTERN = /^\d{1,20}$/;
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
/** 覚えておく依頼の数。決着していない依頼と、ファイルごとの最後の書き出しの依頼は、これを超えても落とさない */
const KEEP_REQUESTS = 100;
/** /next で名乗るファイル名の上限 (文字数)。応答や記録に載せるので、長すぎる名前は切る */
const MAX_FILE_NAME_CHARS = 200;
/** 止めた起動 id を覚えておく数。超えたら古いほうから忘れる */
const MAX_RETIRED_LAUNCHES = 1000;
/** 覚えておく依頼から落とした、渡したのに結果がまだの依頼の要約を覚えておく数。超えたら古いほうから忘れる */
const MAX_DEPARTED_REQUESTS = 1000;
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
  /** 行き先の Figma のファイル (figma.fileKey)。Local Bridge は自分のファイルと違えば処理しない */
  fileKey: string;
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
  /** 依頼の行き先のファイル */
  fileKey?: string;
  /** 書き出した Figma のファイル名 (index.json の meta.fileName。書き出せなかったときは Local Bridge が名乗った名前) */
  fileName?: string;
  files?: number;
  warnings?: string[];
  error?: string;
}

/**
 * GET /status と、/export・/run の 400・503・504 に添える、Local Bridge がつながっているファイル 1 つの様子。
 * 繋がっていないファイルは一覧に載せない
 */
export interface PluginState {
  fileKey: string;
  /** Local Bridge が /next で名乗ったファイル名 */
  fileName: string;
  /** 依頼を受けている画面 (figma.currentUser.sessionId) */
  session: string;
  /** 同じファイルを開いた別の画面の Local Bridge を最後に断った時刻。断っていなければ無い */
  otherScreenRefusedAt?: string;
  /** そのファイルの Local Bridge から最後に何か届いた時刻 */
  lastSeenAt: string;
  /** そのファイルの Local Bridge へ渡して、まだ結果も失敗も返っていない依頼 */
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
  plugin: PluginState[];
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
  fileKey: string;
  state: RequestState;
  value?: unknown;
  plugin: PluginState[];
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
  /** dev サーバーを起動したリポの場所 (絶対パス)。GET /hello で返し、Local Bridge は AI に渡す文の README などをこれで指す */
  root?: string;
  keepResults?: number;
  pluginStaleMs?: number;
  processingStaleMs?: number;
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
    current: hello?.app === DEV_SERVER_APP && hello.protocol === DEV_SERVER_PROTOCOL,
  };
}

export type CandidateOutcome =
  /** busy は、先に試して dev サーバーでない相手が使っていたポート */
  | { kind: "listening"; port: number; servers: http.Server[]; errors: string[]; busy: number[] }
  /**
   * 候補のポートで dev サーバーがもう動いている。outDir は古い版では無い。
   * current が false なら、いまのプラグインがつながらないか、依頼を実行しない古い版
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
        "いまのプラグインはこの版につながらないか、この版の依頼を実行しないので、止めてから npm run dev:server で起動し直す。" +
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

/** 409 の本文。reason で、止めた理由を Local Bridge の画面が言い分ける */
const SUPERSEDED = {
  reason: "superseded",
  error: "この画面で Local Bridge が走り直した (新しい起動がある) ので、こちらには依頼を渡さない (こちらは止まる)",
};
const OTHER_SCREEN = {
  reason: "other-screen",
  error:
    "このファイルは別の画面 (分割表示・別のタブ) で Local Bridge が開いているので、こちらには依頼を渡さない。" +
    "こちらを使うなら、もう片方の Local Bridge を閉じ、35 秒ほど待ってから、こちらを閉じて開き直す",
};

/** /next で名乗ったファイル名を、制御文字を除いて MAX_FILE_NAME_CHARS 文字までにする */
function fileNameOf(raw: string | null): string {
  return Array.from((raw ?? "").replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, MAX_FILE_NAME_CHARS)
    .join("");
}

/** 1 つのファイルで開いている Local Bridge の様子 */
interface Bridge {
  /**
   * 依頼を受けている画面 (figma.currentUser.sessionId)。同じファイルを分割表示や別のタブで開くと、画面ごとに違う。
   * この画面が生きている (connected) あいだは、別の画面の Local Bridge を断る
   */
  session: string;
  /** 別の画面の Local Bridge を最後に断った時刻 (ms)。断っていなければ 0 */
  otherScreenRefusedAt: number;
  /**
   * いま依頼を渡す Local Bridge の起動 id。同じ画面の新しい起動 (ホットリロード・開き直し) が来たら、その起動 id に替わる
   * (前の起動はもう止まっている。ホットリロードで前の起動の処理が止まることは 2026-10-27 に実測)
   */
  launch: string;
  /** /next で名乗ったファイル名 (ファイル名を変えたら、次の /next から新しい名前になる) */
  fileName: string;
  /** 最後にこのファイルの Local Bridge から何か届いた時刻 (ms) */
  lastSeen: number;
  pollers: Set<() => void>;
  /**
   * Local Bridge は 1 件ずつ処理し、終わってから /next を待ちに来るので、処理中の依頼はファイルごとに 1 つだけ持つ。
   * launch は渡した起動 id で、いつも今の launch と同じ (起動が替わると、新しい起動の最初の /next で差し替えるか解く)
   */
  processing?: { request: DevRequest; launch: string; handedAt: number };
}

/** 結果を受けたときに引く、依頼の要約 (script のコードと合言葉は持たない) */
type RequestSummary = Pick<DevRequest, "seq" | "kind" | "fileKey"> & Pick<DumpRequest, "nodeIds" | "images">;

/** http.createServer に渡すハンドラ。fileCount は検査用で、覚えている Local Bridge のファイルの数を返す */
export type DevServerHandler = http.RequestListener & { fileCount: () => number };

/** 返すのは http.createServer に渡すハンドラ。listen は呼び出し側が行う */
export function createDevServer(options: DevServerOptions): DevServerHandler {
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
  const outcomeWaiters = new Map<number, Set<(outcome: Outcome) => void>>();
  const statusWaiters = new Set<() => void>();
  /** 依頼の state が変わるたびに呼ぶ (GET /status?seq の待ち) */
  const requestWaiters = new Set<() => void>();
  const pluginStaleMs = options.pluginStaleMs ?? DEFAULT_PLUGIN_STALE_MS;
  const processingStaleMs = options.processingStaleMs ?? DEFAULT_PROCESSING_STALE_MS;
  /** Local Bridge を開いているファイルごとの様子。キーは fileKey */
  const bridges = new Map<string, Bridge>();
  /**
   * 止めた起動 id と、その理由 (409 の本文)。この起動 id の /next には 409 を返す。
   * 同じ画面の新しい起動が来たなら SUPERSEDED、生きていない持ち主から別の画面に替わったなら OTHER_SCREEN
   */
  const retiredLaunches = new Map<string, typeof SUPERSEDED | typeof OTHER_SCREEN>();
  /** file・起動 id・画面のどれかを名乗らない古い版の Local Bridge が最後に /next に来た時刻 (ms)。503 の理由に添える */
  let oldPluginSeen = 0;
  /**
   * プラグインへ渡した (handed)・あとの依頼を渡したので飛ばした (skipped)・依頼した側が待つのをやめたので取り消した (cancelled) 依頼。
   * どれでもない依頼だけを、これから渡す
   */
  const fates = new Map<number, "handed" | "skipped" | "cancelled">();
  /**
   * 覚えておく依頼から落とした依頼のうち、渡したのに結果がまだのもの。
   * 起動が替わって捨てた依頼の結果が、止めた起動から遅れて届いても、どのファイルの結果か引けるように、結果を受けるまで残す
   */
  const departed = new Map<number, RequestSummary>();

  mkdirSync(resultsDir, { recursive: true });
  // results/ は起動をまたいで残る。前回の続きの番号から振らないと、保持件数の掃除が新しい結果を消す
  let status: DevStatus = previousStatus();
  /** ファイルごとの最後の結果 (GET /status?file)。status.json は全体で 1 つなので、起動したときは最後の結果のファイルの分だけ分かる */
  const fileStatuses = new Map<string, DevStatus>();
  if (status.fileKey !== undefined) fileStatuses.set(status.fileKey, status);
  // seq も前回の続きから振る。振り直すと、依頼側が前回の起動で受け取った seq が別の依頼を指す
  let nextSeq = Math.max(previousLastSeq(), status.seq ?? 0) + 1;
  /** この起動で最初に振る seq。これより前の seq は起動し直す前の依頼 */
  const firstSeq = nextSeq;

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
  function connected(bridge: Bridge | undefined): bridge is Bridge {
    if (bridge === undefined) return false;
    const now = Date.now();
    const processing =
      bridge.processing !== undefined && now - Math.max(bridge.processing.handedAt, bridge.lastSeen) < processingStaleMs;
    return processing || bridge.pollers.size > 0 || now - bridge.lastSeen < pluginStaleMs;
  }

  /**
   * /next で来たファイルの Local Bridge。初めて来たファイルなら作る。
   * 別の画面から来て、持ち主の画面が生きていれば undefined (断る。持ち主の画面には何もしない)。
   * 同じ画面の別の起動 id か、持ち主の画面が生きていないときの別の画面なら、前の起動を止め、
   * 待っていた前の起動の /next を起こして 409 を返させる
   */
  function bridgeFor(fileKey: string, fileName: string, launch: string, session: string): Bridge | undefined {
    forgetIdleBridges();
    const known = bridges.get(fileKey);
    if (known !== undefined && known.session !== session && connected(known)) {
      known.otherScreenRefusedAt = Date.now();
      return undefined;
    }
    const bridge = known ?? { session, otherScreenRefusedAt: 0, launch, fileName, lastSeen: 0, pollers: new Set() };
    const otherScreen = bridge.session !== session;
    bridge.session = session;
    if (bridge.launch !== launch) {
      retireLaunch(bridge.launch, otherScreen ? OTHER_SCREEN : SUPERSEDED);
      bridge.launch = launch;
      bridge.pollers.forEach((wake) => wake());
    }
    bridge.fileName = fileName;
    bridge.lastSeen = Date.now();
    bridges.set(fileKey, bridge);
    return bridge;
  }

  function retireLaunch(launch: string, reason: typeof SUPERSEDED | typeof OTHER_SCREEN): void {
    retiredLaunches.set(launch, reason);
    if (retiredLaunches.size > MAX_RETIRED_LAUNCHES) retiredLaunches.delete(retiredLaunches.keys().next().value as string);
  }

  /** 繋がっていないファイルのうち、そのファイル宛てでまだ渡していない依頼も無いものは忘れる (知らない fileKey の /next で増え続けないように) */
  function forgetIdleBridges(): void {
    for (const [fileKey, bridge] of bridges) {
      if (connected(bridge) || requests.some((r) => r.fileKey === fileKey && pending(r))) continue;
      bridges.delete(fileKey);
    }
  }

  /** seq の依頼を処理中にしているファイルの Local Bridge (覚えておく依頼から落ちていても引ける) */
  function processingBridgeOf(seq: number): Bridge | undefined {
    for (const bridge of bridges.values()) if (bridge.processing?.request.seq === seq) return bridge;
    return undefined;
  }

  /** 繋がっているファイルの一覧 (最後に届いたのが新しい順) */
  function pluginState(): PluginState[] {
    return [...bridges]
      .filter(([, bridge]) => connected(bridge))
      .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
      .map(([fileKey, bridge]) => {
        const processing = bridge.processing;
        return {
          fileKey,
          fileName: bridge.fileName,
          session: bridge.session,
          otherScreenRefusedAt:
            bridge.otherScreenRefusedAt === 0 ? undefined : new Date(bridge.otherScreenRefusedAt).toISOString(),
          lastSeenAt: new Date(bridge.lastSeen).toISOString(),
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
      });
  }

  function nodeIdsOf(request: RequestSummary | undefined): string[] | undefined {
    return request?.kind === "export" ? request.nodeIds : undefined;
  }

  function imagesOf(request: RequestSummary | undefined): ImageMode | undefined {
    return request?.kind === "export" && request.images !== "both" ? request.images : undefined;
  }

  /** fileKey を付ければ、そのファイルの最後の結果 (まだ無ければ version 0) */
  function lastStatus(fileKey: string | undefined): DevStatus {
    if (fileKey === undefined) return status;
    return fileStatuses.get(fileKey) ?? { version: 0 };
  }

  function statusReply(fileKey: string | undefined): StatusReply {
    return { ...lastStatus(fileKey), outDir, plugin: pluginState() };
  }

  function setProcessing(bridge: Bridge, next: Bridge["processing"]): void {
    bridge.processing = next;
    requestWaiters.forEach((wake) => wake());
  }

  function requestReply(seq: number): RequestReply | undefined {
    const request = requestOf(seq);
    if (request === undefined) return undefined;
    const outcome = outcomes.get(seq);
    const plugin = pluginState();
    const { kind, fileKey } = request;
    if (outcome !== undefined) {
      return { ...outcome.body, seq, kind, fileKey, state: outcome.ok ? "done" : "failed", plugin };
    }
    return {
      seq,
      kind,
      fileKey,
      nodeIds: nodeIdsOf(request),
      images: imagesOf(request),
      state: unsettledState(request),
      plugin,
    };
  }

  function unsettledState(request: DevRequest): RequestState {
    if (bridges.get(request.fileKey)?.processing?.request.seq === request.seq) return "processing";
    const fate = fates.get(request.seq);
    if (fate === undefined) return "queued";
    // 渡したのに結果が返らないままプラグインが先へ進んだ。書き出しは送り直せばよいが、script は途中まで実行したかもしれない
    if (fate === "handed") return request.kind === "run" ? "abandoned" : "skipped";
    return fate;
  }

  function pending(request: DevRequest): boolean {
    return !fates.has(request.seq);
  }

  /** fileKey のファイルの Local Bridge に次に渡す依頼。ほかのファイル宛ての依頼は見ない */
  function nextRequestFor(fileKey: string, after: number | undefined): DevRequest | undefined {
    const own = requests.filter((r) => r.fileKey === fileKey);
    if (after !== undefined) return own.find((r) => r.seq > after && pending(r));
    // 走り直したプラグイン (待ち位置を持たない) には、まだ渡していない最後の依頼を渡す (それより前の依頼は飛ばす)。
    // 無ければ最後の書き出しをやり直させる (build したプラグインの結果を status?after で待つ使い方)。
    // 渡し済みの script は渡し直さない (書き換えが二重にかかる)
    return own.findLast(pending) ?? own.findLast((r) => r.kind === "export");
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
    departed.delete(seq);
    // 落とした依頼の結果は、GET /status?seq では引かない (覚えておく依頼の中の依頼の結果だけを持つ)
    if (requestOf(seq) !== undefined) outcomes.set(seq, outcome);
    const waiters = outcomeWaiters.get(seq);
    if (waiters !== undefined) {
      outcomeWaiters.delete(seq);
      waiters.forEach((resolve) => resolve(outcome));
    }
    requestWaiters.forEach((wake) => wake());
  }

  function publish(next: DevStatus, ok: boolean): void {
    status = next;
    if (next.fileKey !== undefined) fileStatuses.set(next.fileKey, next);
    writeFileSync(path.join(outDir, "status.json"), JSON.stringify(status, null, 2) + "\n");
    statusWaiters.forEach((wake) => wake());
    if (next.seq !== undefined) settle(next.seq, { ok, body: next });
  }

  function requestOf(seq: number): DevRequest | undefined {
    return requests.find((r) => r.seq === seq);
  }

  /** 結果を受けるときに引く依頼。覚えておく依頼から落ちていても、渡したのに結果がまだなら引ける */
  function summaryOf(seq: number): RequestSummary | undefined {
    return requestOf(seq) ?? departed.get(seq);
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
    const meta = indexMeta(files);
    const file = fileOf(seq);
    // GET /status?file が返す各ファイルの最後の結果は、残す数を超えても消さない
    const lastOfFiles = new Set([...fileStatuses.values()].map((s) => s.version));
    if (file.fileKey !== undefined) lastOfFiles.delete(fileStatuses.get(file.fileKey)?.version ?? -1);
    lastOfFiles.add(version);
    for (const old of kept.slice(keepResults)) {
      if (lastOfFiles.has(old)) continue;
      rmSync(path.join(resultsDir, String(old)), { recursive: true, force: true });
    }
    publish(
      {
        version,
        seq,
        nodeIds: nodeIdsOf(summaryOf(seq)),
        images: imagesOf(summaryOf(seq)),
        receivedAt: new Date().toISOString(),
        dir,
        fileKey: file.fileKey,
        fileName: meta.fileName ?? file.fileName,
        warnings: meta.warnings,
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
        nodeIds: nodeIdsOf(summaryOf(seq)),
        images: imagesOf(summaryOf(seq)),
        receivedAt: new Date().toISOString(),
        ...fileOf(seq),
        error: message,
      },
      false
    );
    log(`#${seq} は失敗: ${message}`);
  }

  /** 依頼の行き先のファイルと、その Local Bridge が名乗ったファイル名 */
  function fileOf(seq: number): Pick<DevStatus, "fileKey" | "fileName"> {
    const fileKey = summaryOf(seq)?.fileKey;
    return { fileKey, fileName: fileKey === undefined ? undefined : bridges.get(fileKey)?.fileName };
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

  /**
   * 行き先のファイル (?file=<fileKey>)。無ければ 400 を返して undefined。
   * 行き先を AI が選ぶと取り違えるので、つながっているファイルの一覧を添えて人に聞かせる
   */
  function fileParam(url: URL, res: http.ServerResponse): string | undefined {
    const fileKey = url.searchParams.get("file");
    if (fileKey !== null && fileKey !== "") return fileKey;
    send(res, 400, {
      error:
        "行き先のファイルを ?file=<fileKey> で指定する (fileKey は Figma のファイルのリンク figma.com/design/<fileKey>/... の部分。Local Bridge の「AI に渡す文」にも書いてある)。" +
        "plugin は Local Bridge がつながっているファイルの一覧。どのファイルに送るかは、一覧を人に見せて聞く (自分で選ばない)",
      plugin: pluginState(),
    });
    return undefined;
  }

  /** 繋がっていないのに積むと、あとで開いたプラグインが誰も待っていない依頼を処理するので、積まずに 503 を返す */
  function refuseUnlessConnected(res: http.ServerResponse, fileKey: string): boolean {
    if (connected(bridges.get(fileKey))) return false;
    const plugin = pluginState();
    const oldSeconds = Math.floor((Date.now() - oldPluginSeen) / 1000);
    send(res, 503, {
      error:
        `ファイル ${fileKey} では Local Bridge が繋がっていない (Figma でそのファイルの Local Bridge を開いたままにする)。` +
        (plugin.length === 0
          ? "Local Bridge はどのファイルでも繋がっていない"
          : "plugin は Local Bridge がつながっているファイルの一覧。別のファイルに送るなら、一覧を人に見せてどれか聞く (自分で選ばない)") +
        (Date.now() - oldPluginSeen < pluginStaleMs
          ? `。file・起動 id・画面のどれかを名乗らない古い版の Local Bridge が ${oldSeconds} 秒前に来た。npm run build:local-bridge で build し直し、Local Bridge を開き直す`
          : ""),
      plugin,
    });
    return true;
  }

  function describe(request: DevRequest): string {
    const file = `${bridges.get(request.fileKey)?.fileName ?? ""} (${request.fileKey})`;
    if (request.kind === "run") return `${file} で script の実行 (${request.code.length} 文字)`;
    const target = request.nodeIds ? request.nodeIds.join(", ") : "プラグインで開いているページの選択";
    const images = imagesOf(request);
    return `${file} の ${images === undefined ? target : `${target} (images: ${images})`}`;
  }

  /**
   * 覚えておく依頼を KEEP_REQUESTS 件まで減らす (古いほうから)。
   * まだ渡していない依頼・処理中の依頼・ファイルごとの最後の書き出しの依頼は落とさない
   * (ほかのファイルの依頼が多くても、結果をどのファイルのものか引け、開き直した Local Bridge に書き出しをやり直させられるように)
   */
  function trimRequests(): void {
    const droppable = (r: DevRequest): boolean =>
      !pending(r) &&
      processingBridgeOf(r.seq) === undefined &&
      !(r.kind === "export" && requests.findLast((x) => x.fileKey === r.fileKey && x.kind === "export") === r);
    while (requests.length > KEEP_REQUESTS) {
      const index = requests.findIndex(droppable);
      if (index === -1) return;
      const [dropped] = requests.splice(index, 1);
      if (fates.get(dropped.seq) === "handed" && !outcomes.has(dropped.seq)) {
        departed.set(dropped.seq, {
          seq: dropped.seq,
          kind: dropped.kind,
          fileKey: dropped.fileKey,
          nodeIds: nodeIdsOf(dropped),
          images: dropped.kind === "export" ? dropped.images : undefined,
        });
        if (departed.size > MAX_DEPARTED_REQUESTS) departed.delete(departed.keys().next().value as number);
      }
      outcomes.delete(dropped.seq);
      fates.delete(dropped.seq);
    }
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
    trimRequests();
    log(`#${request.seq} を受けた: ${describe(request)}`);
    bridges.get(request.fileKey)?.pollers.forEach((wake) => wake());
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
        const processing = plugin.find((p) => p.fileKey === request.fileKey)?.processing;
        const hint =
          processing === undefined
            ? "Figma でそのファイルの Local Bridge を開いているか確かめる"
            : `プラグインへ渡した #${processing.seq} の結果がまだ来ていない`;
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
    if (route === "POST /export") {
      const seconds = secondsParam(url);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      const fileKey = fileParam(url, res);
      if (fileKey === undefined) return;
      let parsed: ExportFields;
      try {
        parsed = parseExportBody((await readBody(req)).toString("utf8"));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (refuseUnlessConnected(res, fileKey)) return;
      enqueueAndWait(res, { kind: "export", fileKey, ...parsed }, seconds);
      return;
    }

    if (route === "POST /run") {
      const seconds = secondsParam(url, RUN_DEFAULT_WAIT_SECONDS);
      if (seconds === undefined) {
        send(res, 400, { error: "timeout は正の秒数にする" });
        return;
      }
      const fileKey = fileParam(url, res);
      if (fileKey === undefined) return;
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
      if (refuseUnlessConnected(res, fileKey)) return;
      enqueueAndWait(res, { kind: "run", fileKey, code, token }, seconds);
      return;
    }

    if (route === "GET /hello") {
      const hello = { app: DEV_SERVER_APP, protocol: DEV_SERVER_PROTOCOL };
      send(res, 200, options.root === undefined ? hello : { ...hello, root: options.root });
      return;
    }

    if (route === "GET /next") {
      const fileKey = url.searchParams.get("file");
      const launch = url.searchParams.get("launch");
      const session = url.searchParams.get("session");
      if (!fileKey || !launch || !session) {
        // どのファイルの Local Bridge か分からないと別のファイル宛ての依頼を渡してしまう。
        // どの起動・どの画面か分からないと、同じファイルの 2 つの Local Bridge に依頼が並行に渡る
        oldPluginSeen = Date.now();
        send(res, 400, {
          error:
            "自分のファイル (file)・起動 id (launch)・画面 (session) のどれかを付けずに来たので、依頼を渡さない。古い版の Local Bridge なので、" +
            "リポジトリで npm run build:local-bridge を実行して build し直し、Local Bridge を開き直す",
        });
        return;
      }
      if (!SESSION_PATTERN.test(session)) {
        send(res, 400, { error: "session は数字だけ・20 文字までにする (figma.currentUser.sessionId)" });
        return;
      }
      const retired = retiredLaunches.get(launch);
      if (retired !== undefined) {
        send(res, 409, retired);
        return;
      }
      const bridge = bridgeFor(fileKey, fileNameOf(url.searchParams.get("name")), launch, session);
      if (bridge === undefined) {
        send(res, 409, OTHER_SCREEN);
        return;
      }
      const afterParam = url.searchParams.get("after");
      const sameServer = url.searchParams.get("server") === serverId;
      const after = afterParam !== null && sameServer ? Number(afterParam) : undefined;
      const reply = (request: DevRequest): void => {
        // プラグインは自分のファイル宛ての依頼を seq の小さい順に受け取るので、これより前でまだ渡していない依頼は、もう渡さない
        for (const r of requests) {
          if (r.fileKey === fileKey && r.seq < request.seq && pending(r)) fates.set(r.seq, "skipped");
        }
        fates.set(request.seq, "handed");
        setProcessing(bridge, { request, launch, handedAt: Date.now() });
        // 結果を送るときに launch を付けさせる (止めた起動からの結果で、後の起動の処理中を解かないように)
        send(res, 200, { server: serverId, launch, ...request });
      };
      // 渡す依頼があれば、処理中をそれに差し替える。先に解くと、走り直して同じ依頼を受け取り直すあいだに
      // GET /status?seq の待ちが起き、書き出し直す依頼を skipped と答える
      const ready = nextRequestFor(fileKey, after);
      if (ready !== undefined) {
        reply(ready);
        return;
      }
      // 書き出し中のプラグインは /next を待たないので、待ちに来たなら、このファイルの手元の依頼はもう無い
      setProcessing(bridge, undefined);
      waitFor(
        res,
        (wake) => {
          const poller = (): void => {
            if (bridge.launch !== launch) {
              wake();
              send(res, 409, retiredLaunches.get(launch) ?? SUPERSEDED);
              return;
            }
            const request = nextRequestFor(fileKey, after);
            if (request === undefined) return;
            wake();
            reply(request);
          };
          bridge.pollers.add(poller);
          return () => bridge.pollers.delete(poller);
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
      const launch = url.searchParams.get("launch");
      if (launch === null || launch === "") {
        send(res, 400, { error: "launch が無い (/next で受け取った launch を付けて送る)" });
        return;
      }
      // 止めた起動の Local Bridge からの結果も、seq で受ける (渡し済みの依頼の結果なので)
      const summary = summaryOf(seq);
      const bridge = summary === undefined ? undefined : bridges.get(summary.fileKey);
      if (bridge?.launch === launch) bridge.lastSeen = Date.now();
      // 版の古いプラグインの UI は script の依頼を書き出しとして扱い、書き出しの結果を返してくる
      const kind = summary?.kind;
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
      // ここでは待ちを起こさない。結果を保存する前に起こすと、結果の無い依頼として skipped と答える (保存の settle が起こす)。
      // 解くのは、受け取り終えた時点でこの seq をこの起動に渡した処理中だけ (受信中に起動が替わり、別の依頼か同じ依頼を後の起動へ渡していることがある)
      const owner = summary === undefined ? undefined : bridges.get(summary.fileKey);
      if (owner?.processing?.request.seq === seq && owner.processing.launch === launch) owner.processing = undefined;
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
        const forgotten = seq >= firstSeq && seq < nextSeq;
        send(res, 404, {
          error: forgotten
            ? `#${seq} はこの起動の dev サーバーが受けたが、覚えておく数を超えて忘れた依頼 (結果があったかは分からない)`
            : `この起動の dev サーバーは #${seq} を受けていない (起動し直す前の依頼か、まだ振っていない番号)`,
        });
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
      const fileKey = url.searchParams.get("file") ?? undefined;
      if (fileKey === "") {
        send(res, 400, { error: "file は空にしない (そのファイルの結果だけを見るときに fileKey を付ける)" });
        return;
      }
      const afterParam = url.searchParams.get("after");
      const after = afterParam === null ? undefined : Number(afterParam);
      if (after === undefined || lastStatus(fileKey).version > after) {
        send(res, 200, statusReply(fileKey));
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
            // 別のファイルの結果では返さない
            if (lastStatus(fileKey).version <= after) return;
            wake();
            send(res, 200, statusReply(fileKey));
          };
          statusWaiters.add(waiter);
          return () => statusWaiters.delete(waiter);
        },
        seconds * 1000,
        () => send(res, 504, { ...statusReply(fileKey), error: `${seconds} 秒待っても新しい結果が来ない` })
      );
      return;
    }

    send(res, 404, { error: `知らない経路: ${route}` });
  }

  const handler: http.RequestListener = (req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`内部エラー: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: String(e) });
    });
  };
  return Object.assign(handler, { fileCount: () => bridges.size });
}
