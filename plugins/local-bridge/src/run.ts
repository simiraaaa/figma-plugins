/**
 * Local Bridge の script 実行 (dev サーバーの POST /run で AI が送ったコードを、プラグインの本体で実行する) と、
 * 依頼の行き先のファイルの照合 (書き出しの依頼にも使う)・ファイルごとの合言葉の読み書き
 *
 * figma と figma.clientStorage は引数で受け取る (node --test で素のオブジェクトを渡して検証できるようにする)。
 */

/** POST /run-result の本文の上限 (文字数)。AI が読み切れる大きさに抑える */
export const MAX_RUN_RESULT_CHARS = 1_000_000;

/** プラグインから dev サーバーの POST /run-result へ送る本文 (JSON) の形 */
export type RunResultBody = { ok: true; value?: unknown } | { ok: false; error: string };

/** figma.clientStorage のうち、合言葉の読み書きに使うもの (検査では素のオブジェクトで差し替える) */
export interface TokenStore {
  getAsync(key: string): Promise<unknown>;
  setAsync(key: string, value: unknown): Promise<void>;
  deleteAsync(key: string): Promise<void>;
  keysAsync(): Promise<string[]>;
}

/**
 * 合言葉はファイルごとに、このキーで 1 つずつ持つ。
 * 1 つのキーに全ファイル分をまとめると、複数のタブが同時に初めて作ったとき、読み直して書くあいだに片方が消える
 */
const RUN_TOKEN_PREFIX = "devRunToken:";
/** 前の版が全ファイル共通で使っていたキー。読まない (作り直すときに消す) */
const LEGACY_RUN_TOKEN_KEY = "devRunToken";

export function runTokenKey(fileKey: string): string {
  return `${RUN_TOKEN_PREFIX}${fileKey}`;
}

/**
 * このファイルの合言葉。無ければ candidate (UI が作った乱数) を合言葉にする。
 * 書いたあとに読み直して、保存された値を返す (2 つのタブが同時に初めて作ると、あとから書いたほうが残るので)
 */
export async function ensureRunToken(store: TokenStore, fileKey: string, candidate: string): Promise<string> {
  const key = runTokenKey(fileKey);
  const stored = await store.getAsync(key);
  if (typeof stored === "string" && stored !== "") return stored;
  await store.setAsync(key, candidate);
  const saved = await store.getAsync(key);
  return typeof saved === "string" && saved !== "" ? saved : candidate;
}

/**
 * 全ファイルの合言葉を消してから、このファイルの合言葉を candidate で作り直す。
 * 開いたままの別のタブは、次の script の照合でキーが無いので実行しない
 */
export async function renewRunTokens(store: TokenStore, fileKey: string, candidate: string): Promise<string> {
  for (const key of await store.keysAsync()) {
    if (key.startsWith(RUN_TOKEN_PREFIX) || key === LEGACY_RUN_TOKEN_KEY) await store.deleteAsync(key);
  }
  await store.setAsync(runTokenKey(fileKey), candidate);
  return candidate;
}

export interface RunInput {
  code: string;
  /** 依頼に付いてきた合言葉 (X-Run-Token) */
  token: string;
  /** 依頼の行き先のファイル */
  fileKey: unknown;
  /** この Local Bridge のファイル (figma.fileKey) */
  ownFileKey: string;
  /** 合言葉の保存場所。別のタブで作り直されたら、次の依頼からその値で照合するよう、依頼ごとに読む */
  store: TokenStore;
  /** コードに figma として渡すもの */
  api: unknown;
}

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;

function errorText(e: unknown): string {
  try {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } catch {
    return "(投げた値を文字列にできない)";
  }
}

function failure(error: string): string {
  return JSON.stringify({ ok: false, error } satisfies RunResultBody);
}

/**
 * 依頼の行き先 (fileKey) がこの Local Bridge のファイルでなければ、処理しない理由を返す。
 * dev サーバーの振り分けに不具合があっても、別のファイルを書き換えないための二重の守り
 */
export function wrongFileReason(requested: unknown, own: string): string | undefined {
  if (requested === own) return undefined;
  if (typeof requested !== "string" || requested === "") {
    return "依頼に行き先のファイル (fileKey) が無いので実行していない (dev サーバーが古い版なら、止めて起動し直す)";
  }
  return `別のファイル (${requested}) 宛ての依頼なので実行していない (この Local Bridge のファイルは ${own})`;
}

/**
 * この画面の sessionId (figma.currentUser.sessionId) を文字列で返す。取れなければ undefined。
 * dev サーバーは、同じファイルを別の画面 (分割表示・別のタブ) で開いた 2 つ目の Local Bridge を、これで見分けて断る。
 * manifest の permissions に currentuser が無い (取り込み直していない・ホットリロードでは効かない) と、currentUser を読むと例外を投げる
 */
export function sessionIdOf(api: unknown): string | undefined {
  let sessionId: unknown;
  try {
    sessionId = (api as { currentUser?: { sessionId?: unknown } | null }).currentUser?.sessionId;
  } catch {
    return undefined;
  }
  if (typeof sessionId === "number" && Number.isFinite(sessionId)) return String(sessionId);
  if (typeof sessionId === "string" && sessionId !== "") return sessionId;
  return undefined;
}

/** 書き出しの依頼の行き先がこのファイルでなければ、書き出さない理由を返す (script の wrongFileReason と同じ二重の守り) */
export function exportRefusal(request: { fileKey?: unknown }, own: string): string | undefined {
  const requested = request.fileKey;
  if (requested === own) return undefined;
  if (typeof requested !== "string" || requested === "") {
    return "依頼に行き先のファイル (fileKey) が無いので書き出していない (dev サーバーが古い版なら、止めて起動し直す)";
  }
  return `別のファイル (${requested}) 宛ての書き出しの依頼なので書き出していない (この Local Bridge のファイルは ${own})`;
}

/**
 * 行き先がこのファイルで、合言葉がこのファイルの最新の合言葉と合えば、code を async 関数の本体として figma を渡して実行し、
 * POST /run-result の本文を返す。
 * 失敗の理由には実行したかどうかを書く (途中で投げた script の書き換えは残るので、依頼した側が送り直してよいかを決められるように)
 */
export async function runScript(input: RunInput): Promise<string> {
  const wrongFile = wrongFileReason(input.fileKey, input.ownFileKey);
  if (wrongFile !== undefined) return failure(wrongFile);
  let expectedToken: unknown;
  try {
    expectedToken = await input.store.getAsync(runTokenKey(input.ownFileKey));
  } catch (e) {
    return failure(`合言葉を読めないので実行していない: ${errorText(e)}`);
  }
  if (typeof expectedToken !== "string" || expectedToken === "") {
    return failure(
      "このファイルの合言葉がまだ無いので実行していない (別のタブで作り直されたときを含む。Local Bridge の「AI に渡す文をコピー」で新しい合言葉の文を作って渡してもらう)"
    );
  }
  if (input.token !== expectedToken) {
    return failure(
      "合言葉が違うので実行していない (合言葉はファイルごと。このファイルの Local Bridge の「AI に渡す文」にある合言葉を X-Run-Token に付ける)"
    );
  }
  let fn: (figma: unknown) => Promise<unknown>;
  try {
    fn = new AsyncFunction("figma", input.code);
  } catch (e) {
    return failure(`script を読めないので実行していない: ${errorText(e)}`);
  }
  let value: unknown;
  try {
    value = await fn(input.api);
  } catch (e) {
    return failure(`script が途中で例外を投げた (それまでの書き換えは残っている): ${errorText(e)}`);
  }
  let body: string;
  try {
    body = JSON.stringify({ ok: true, value } satisfies RunResultBody);
  } catch (e) {
    return failure(`script は最後まで実行したが、返り値を JSON にできない: ${errorText(e)}`);
  }
  if (body.length > MAX_RUN_RESULT_CHARS) {
    return failure(
      `script は最後まで実行したが、返り値が大きすぎる (JSON で ${body.length} 文字。上限 ${MAX_RUN_RESULT_CHARS} 文字)`
    );
  }
  return body;
}
