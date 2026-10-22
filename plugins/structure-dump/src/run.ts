/**
 * 開発ループの script 実行 (dev サーバーの POST /run で AI が送ったコードを、プラグインの本体で実行する)
 *
 * figma は引数で受け取る (node --test で素のオブジェクトを渡して検証できるようにする)。
 */

/** POST /run-result の本文の上限 (文字数)。AI が読み切れる大きさに抑える */
export const MAX_RUN_RESULT_CHARS = 1_000_000;

/** プラグインから dev サーバーの POST /run-result へ送る本文 (JSON) の形 */
export type RunResultBody = { ok: true; value?: unknown } | { ok: false; error: string };

export interface RunInput {
  code: string;
  /** 依頼に付いてきた合言葉 (X-Run-Token) */
  token: string;
  /** プラグインの画面に出している合言葉 */
  expectedToken: string | undefined;
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
 * 合言葉が合えば、code を async 関数の本体として figma を渡して実行し、POST /run-result の本文を返す。
 * 失敗の理由には実行したかどうかを書く (途中で投げた script の書き換えは残るので、依頼した側が送り直してよいかを決められるように)
 */
export async function runScript(input: RunInput): Promise<string> {
  if (input.expectedToken === undefined) return failure("合言葉がまだ無いので実行していない (プラグインを開き直す)");
  if (input.token !== input.expectedToken) {
    return failure("合言葉が違うので実行していない (プラグインの画面に出ている合言葉を X-Run-Token に付ける)");
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
