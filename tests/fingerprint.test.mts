/**
 * ファイル全体のスナップショットの比較 (scripts/fingerprint-lib.mts) の検査
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

/** ページ P1 (id 0:1) に Frame 1:1 > Card 1:2 > Title 1:3 と、別の Frame 2:1 があるスナップショット */
function base(overrides: Record<string, string> = {}): Fingerprint {
  const hash = (id: string) => overrides[id] ?? `h${id}`;
  return {
    v: 2,
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

test("負例: メインコンポーネントに子を足すと変わるインスタンス本体は、メインコンポーネントが範囲の中で変わっていれば propagated", () => {
  // 1:2 がメインコンポーネント、2:1 がそのインスタンス (4 つ目の欄がメインコンポーネントの id)
  const before = base();
  before.nodes = before.nodes.map((line) => (line.startsWith("2:1|") ? `${line}|1:2` : line));
  const after = base({ "1:2": "child-added" });
  after.nodes = after.nodes.map((line) => (line.startsWith("2:1|") ? "2:1|0:1|body-changed|1:2" : line));
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.inside, [{ id: "1:2", page: "P1", kind: "changed" }]);
  assert.deepEqual(diff.propagated, [{ id: "2:1", page: "P1", kind: "changed", from: "1:2" }]);
  assert.deepEqual(diff.outside, []);
  // メインコンポーネントが変わっていなければ、インスタンス本体の変化は outside
  const unrelatedAfter = base();
  unrelatedAfter.nodes = unrelatedAfter.nodes.map((line) => (line.startsWith("2:1|") ? "2:1|0:1|body-changed|1:2" : line));
  assert.deepEqual(diffFingerprints(before, unrelatedAfter, ["1:2"]).outside, [{ id: "2:1", page: "P1", kind: "changed" }]);
});

test("負例: スナップショットが同じでも親が変わったノードは moved として出す (別のページへ移したものを含む)", () => {
  const before = base();
  before.pages["0:2"] = "P2";
  const after = base();
  after.pages["0:2"] = "P2";
  after.nodes = after.nodes.map((line) => (line.startsWith("2:1|") ? line.replace("2:1|0:1|", "2:1|0:2|") : line));
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.outside, [{ id: "2:1", page: "P2", kind: "moved" }]);
});

test("負例: ページ自体の並べ替えは、ファイル全体のノード (id は document) のスナップショットの差として出す", () => {
  const before = base();
  before.nodes.unshift("document||ORDA");
  const after = base();
  after.nodes.unshift("document||ORDB");
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.outside, [{ id: "document", page: "", kind: "changed", aspects: ["children"] }]);
});

test("負例: ページの名前や直下の並びの変化は、ページのノード (親が空) のスナップショットの差として出す", () => {
  const before = base();
  before.nodes.push("0:1||page-hash");
  const after = base();
  after.nodes.push("0:1||page-hash-renamed");
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.outside, [{ id: "0:1", page: "P1", kind: "changed" }]);
});

test("負例: fileKey が違うスナップショット (同名の別ファイル) は比べずに断る。片方に無ければ比べる", () => {
  const before = { ...base(), fileKey: "KEY1" };
  assert.throws(() => diffFingerprints(before, { ...base(), fileKey: "KEY2" }, []), /別のファイルのスナップショット/);
  assert.deepEqual(diffFingerprints(before, { ...base(), fileKey: null }, []).outside, []);
});

test("何も変わっていなければ inside も outside も空", () => {
  const diff = diffFingerprints(base(), base(), ["1:2"]);
  assert.deepEqual([diff.inside, diff.propagated, diff.outside], [[], [], []]);
  assert.deepEqual(diff.nodes, { before: 4, after: 4 });
});

test("負例: POST /run の応答のまま保存したファイルも読め、スナップショットでないファイルと古い形 (v1) は断る", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fingerprint-"));
  const wrapped = path.join(dir, "before.json");
  writeFileSync(wrapped, JSON.stringify({ seq: 1, value: base() }));
  assert.equal(readFingerprint(wrapped).nodes.length, 4);
  const other = path.join(dir, "other.json");
  writeFileSync(other, JSON.stringify({ seq: 2, value: "ok" }));
  assert.throws(() => readFingerprint(other), /スナップショットのファイルでない/);
  const old = path.join(dir, "old.json");
  writeFileSync(old, JSON.stringify({ seq: 3, value: { ...base(), v: 1 } }));
  assert.throws(() => readFingerprint(old), /古い形のスナップショット \(v1/);
});

test("負例: 要約が区分ごと (4 文字 × 7) のときは、変わった区分を aspects に出す。ページは name と children、document は children", () => {
  const summary = (overrides: Partial<Record<string, string>> = {}) =>
    ["name", "geometry", "look", "text", "layout", "component", "children"].map((a) => overrides[a] ?? a.slice(0, 4).toUpperCase()).join("");
  const before = base({ "1:3": summary(), "2:1": summary() });
  before.nodes.unshift("document||PAGA", "0:1||PNAMCHLA");
  const after = base({ "1:3": summary({ geometry: "MOVE", text: "EDIT" }), "2:1": summary({ look: "XXXX" }) });
  after.nodes.unshift("document||PAGB", "0:1||PNAMCHLB");
  const diff = diffFingerprints(before, after, ["1:2"]);
  assert.deepEqual(diff.inside, [{ id: "1:3", page: "P1", kind: "changed", aspects: ["geometry", "text"] }]);
  assert.deepEqual(diff.outside, [
    { id: "document", page: "", kind: "changed", aspects: ["children"] },
    { id: "0:1", page: "P1", kind: "changed", aspects: ["children"] },
    { id: "2:1", page: "P1", kind: "changed", aspects: ["look"] },
  ]);
  // 区分の数が合わない要約 (1 つだけなど) には aspects を付けない
  assert.deepEqual(diffFingerprints(base(), base({ "2:1": "x" }), ["1:2"]).outside, [{ id: "2:1", page: "P1", kind: "changed" }]);
});

test("fingerprint.js は async 関数の本体として構文が通る (Local Bridge は本文をそのまま実行する)", () => {
  const source = readFileSync(path.join(root, "scripts", "fingerprint.js"), "utf8");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => unknown;
  assert.doesNotThrow(() => new AsyncFunction("figma", source));
});
