/**
 * リポジトリの新しい版の確かめ (scripts/update-check.mts) の検査
 *
 * 実行: npm test
 * 一時の bare リポジトリを origin にした clone を作り、origin にだけコミットを足したときに「新しい版がある」と分かることを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRepoUpdate, updateMessage } from "../scripts/update-check.mts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

/** origin (bare) と、それを clone した作業ツリーを作る。origin の main に 1 コミットある状態 */
function makeRepos(): { origin: string; clone: string; work: string } {
  const root = mkdtempSync(path.join(tmpdir(), "update-check-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  writeFileSync(path.join(work, "a.txt"), "1\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "first");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const clone = path.join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  return { origin, clone, work };
}

test("負例: origin にだけ新しいコミットがあると、その数を返して pull を促す", async () => {
  const { clone, work } = makeRepos();
  writeFileSync(path.join(work, "a.txt"), "2\n");
  git(work, "commit", "-q", "-am", "second");
  git(work, "push", "-q", "origin", "main");
  const update = await checkRepoUpdate(clone);
  assert.equal(update.kind, "behind");
  assert.equal((update as { behind: number }).behind, 1);
  assert.match(updateMessage(update) ?? "", /新しい版がある \(1 コミット\)/);
});

test("origin と同じなら current で、知らせる文は無い", async () => {
  const { clone } = makeRepos();
  const update = await checkRepoUpdate(clone);
  assert.equal(update.kind, "current");
  assert.equal(updateMessage(update), null);
});

test("負例: リポジトリでない場所や origin の無いリポジトリでは unknown で、理由を返す", async () => {
  const notRepo = mkdtempSync(path.join(tmpdir(), "update-check-none-"));
  const update = await checkRepoUpdate(notRepo);
  assert.equal(update.kind, "unknown");
  assert.ok((update as { reason: string }).reason.length > 0);
  assert.equal(updateMessage(update), null);
});
