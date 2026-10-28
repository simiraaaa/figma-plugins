/**
 * clone したリポジトリに新しい版 (origin/main の先のコミット) があるかを git で確かめる。
 * dev サーバーが起動時と一定の間隔で呼び、新しい版があれば端末と Local Bridge の画面で知らせる (人が git pull と build をし忘れないように)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 上流の枝。clone した人はこの枝を使う前提 (GUIDE の手順) */
export const UPSTREAM_REF = "origin/main";
/** git を待つ上限。ネットワークが無いときに起動を待たせないため */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** dev サーバーが動いているあいだに確かめ直す間隔 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type RepoUpdate =
  /** 上流に新しいコミットがある。behind はその数 */
  | { kind: "behind"; behind: number; checkedAt: string }
  | { kind: "current"; checkedAt: string }
  /** 確かめられなかった (git が無い・ネットワークが無い・リポジトリでない)。理由は人向けの 1 行 */
  | { kind: "unknown"; reason: string; checkedAt: string };

async function git(root: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: timeoutMs, encoding: "utf8" });
  return stdout.trim();
}

/** root のリポジトリで origin を取り込み、HEAD から見て上流に何コミット先があるかを返す */
export async function checkRepoUpdate(root: string, timeoutMs = UPDATE_CHECK_TIMEOUT_MS): Promise<RepoUpdate> {
  const checkedAt = new Date().toISOString();
  try {
    await git(root, ["fetch", "--quiet", "origin"], timeoutMs);
    const behind = Number(await git(root, ["rev-list", "--count", `HEAD..${UPSTREAM_REF}`], timeoutMs));
    if (!Number.isInteger(behind)) return { kind: "unknown", reason: "git rev-list の出力を読めない", checkedAt };
    return behind > 0 ? { kind: "behind", behind, checkedAt } : { kind: "current", checkedAt };
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { kind: "unknown", reason: detail, checkedAt };
  }
}

/** 端末と Local Bridge の画面に出す 1 行。新しい版が無ければ null */
export function updateMessage(update: RepoUpdate): string | null {
  if (update.kind !== "behind") return null;
  return `リポジトリに新しい版がある (${update.behind} コミット)。clone したディレクトリで git pull && npm install && npm run build を実行し、dev サーバーを起動し直す`;
}
