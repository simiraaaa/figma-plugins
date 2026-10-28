/**
 * ファイル全体の指紋の比較 (scripts/fingerprint-lib.mts) の検査
 *
 * 実行: npm test
 * 書き出した範囲の外で変わったノードを outside に出し、範囲の中の変化は inside に分けることを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diffFingerprints, type Fingerprint, readFingerprint } from "../scripts/fingerprint-lib.mts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** ページ P1 (id 0:1) に Frame 1:1 > Card 1:2 > Title 1:3 と、別の Frame 2:1 がある指紋 */
function base(overrides: Record<string, string> = {}): Fingerprint {
  const hash = (id: string) => overrides[id] ?? `h${id}`;
  return {
    v: 1,
    file: "f",
    takenAt: "2026-10-28T00:00:00.000Z",
    pages: { "0:1": "P1" },
    nodes: [`1:1|0:1|${hash("1:1")}`, `1:2|1:1|${hash("1:2")}`, `1:3|1:2|${hash("1:3")}`, `2:1|0:1|${hash("2:1")}`],
  };
}

test("負例: 書き出した範囲の外のノードが変わると outside に出し、範囲の中の変化は inside に分ける", () => {
  const after = base({ "1:3": "changed", "2:1": "changed" });
  const diff = diffFingerprints(base(), after, ["1:2"]);
  assert.deepEqual(diff.inside, [{ id: "1:3", page: "P1", kind: "changed" }]);
  assert.deepEqual(diff.outside, [{ id: "2:1", page: "P1", kind: "changed" }]);
});

test("負例: 範囲の外で足した・消したノードも outside に出す (消したノードのページは before から引く)", () => {
  const before = base();
  const after = base();
  after.nodes = after.nodes.filter((line) => !line.startsWith("2:1|"));
  after.nodes.push("3:1|0:1|new");
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.inside, []);
  assert.deepEqual(diff.outside, [
    { id: "3:1", page: "P1", kind: "added" },
    { id: "2:1", page: "P1", kind: "removed" },
  ]);
});

test("負例: 範囲の中のノードの変化がインスタンスに映ったものは、outside でなく propagated に出す (元のノードの id つき)", () => {
  const before = base();
  before.nodes.push("I2:1;1:3|2:1|hcopy", "I2:1;1:2|2:1|hcopy2");
  const after = base({ "1:3": "changed" });
  after.nodes.push("I2:1;1:3|2:1|copychanged", "I2:1;1:2|2:1|hcopy2");
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.inside, [{ id: "1:3", page: "P1", kind: "changed" }]);
  assert.deepEqual(diff.propagated, [{ id: "I2:1;1:3", page: "P1", kind: "changed", from: "1:3" }]);
  assert.deepEqual(diff.outside, []);
  // 元のノードが範囲の中で変わっていなければ、インスタンスの中の変化は outside
  const unrelated = base();
  unrelated.nodes.push("I2:1;1:3|2:1|hcopy", "I2:1;1:2|2:1|hcopy2");
  const unrelatedAfter = base();
  unrelatedAfter.nodes.push("I2:1;1:3|2:1|other", "I2:1;1:2|2:1|hcopy2");
  assert.deepEqual(diffFingerprints(unrelated, unrelatedAfter, ["1:2"]).outside, [{ id: "I2:1;1:3", page: "P1", kind: "changed" }]);
});

test("何も変わっていなければ inside も outside も空", () => {
  const diff = diffFingerprints(base(), base(), ["1:2"]);
  assert.deepEqual([diff.inside, diff.propagated, diff.outside], [[], [], []]);
  assert.deepEqual(diff.nodes, { before: 4, after: 4 });
});

test("負例: POST /run の応答のまま保存したファイルも読め、指紋でないファイルは断る", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fingerprint-"));
  const wrapped = path.join(dir, "before.json");
  writeFileSync(wrapped, JSON.stringify({ seq: 1, value: base() }));
  assert.equal(readFingerprint(wrapped).nodes.length, 4);
  const other = path.join(dir, "other.json");
  writeFileSync(other, JSON.stringify({ seq: 2, value: "ok" }));
  assert.throws(() => readFingerprint(other), /指紋のファイルでない/);
});

test("fingerprint.js は async 関数の本体として構文が通る (Local Bridge は本文をそのまま実行する)", () => {
  const source = readFileSync(path.join(root, "scripts", "fingerprint.js"), "utf8");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => unknown;
  assert.doesNotThrow(() => new AsyncFunction("figma", source));
});
