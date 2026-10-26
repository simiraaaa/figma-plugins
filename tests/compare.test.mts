/**
 * 書き出しの比較 (scripts/compare-lib.mts) の検査
 *
 * 実行: npm test
 * Local Bridge の書き出しと同じ形 (index.json・構造の json・画面の png) を作って比べ、
 * 変わった文字・画素を拾うこと、書き出しの時刻の違いだけでは変わったと見ないことを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { compareExports, type CompareSummary } from "../scripts/compare-lib.mts";

interface ExportSpec {
  exportedAt?: string;
  node?: Record<string, unknown>;
  /** [x, y, r, g, b] の点を白地に打つ。undefined なら png を書かない */
  png?: { width: number; height: number; dots: [number, number, number, number, number][] };
}

function writeExport(dir: string, spec: ExportSpec): string {
  mkdirSync(dir, { recursive: true });
  const index = { meta: { fileName: "f", exportedAt: spec.exportedAt ?? "2026-10-26T00:00:00.000Z" }, frames: [] };
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  writeFileSync(path.join(dir, "node.1-2.json"), JSON.stringify(spec.node ?? { name: "frame" }, null, 2) + "\n");
  if (spec.png) {
    const png = new PNG({ width: spec.png.width, height: spec.png.height });
    png.data.fill(255);
    for (const [x, y, r, g, b] of spec.png.dots) {
      const i = (y * spec.png.width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
    }
    writeFileSync(path.join(dir, "node.1-2.png"), PNG.sync.write(png));
  }
  return dir;
}

function compare(before: ExportSpec, after: ExportSpec): CompareSummary {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  return compareExports(
    writeExport(path.join(root, "before"), before),
    writeExport(path.join(root, "after"), after),
    path.join(root, "out")
  );
}

const PLAIN = { width: 4, height: 3, dots: [] as [number, number, number, number, number][] };

test("負例: 1 画素だけ色を変えると、その画素を数え、差分画像のその画素を赤くする", () => {
  const summary = compare({ png: PLAIN }, { png: { ...PLAIN, dots: [[2, 1, 250, 250, 250]] } });
  assert.equal(summary.same, false);
  assert.deepEqual(summary.changed, ["node.1-2.png"]);
  assert.deepEqual(summary.images, [{ file: "node.1-2.png", changedPixels: 1, width: 4, height: 3 }]);
  const diff = PNG.sync.read(readFileSync(path.join(summary.outDir, "diff", "node.1-2.png")));
  const i = (1 * 4 + 2) * 4;
  assert.deepEqual([...diff.data.subarray(i, i + 3)], [255, 0, 0]);
  assert.ok(existsSync(path.join(summary.outDir, "before", "node.1-2.png")));
  assert.ok(existsSync(path.join(summary.outDir, "after", "node.1-2.png")));
});

test("負例: 構造の json が変わると、変わったファイルに挙げ、changes.diff に差分を書く", () => {
  const summary = compare({ node: { name: "Instances" } }, { node: { name: "Instances (new)" } });
  assert.equal(summary.same, false);
  assert.deepEqual(summary.changed, ["node.1-2.json"]);
  assert.ok(summary.changesDiff !== null);
  const text = readFileSync(summary.changesDiff, "utf8");
  assert.match(text, /^-.*"name": "Instances",?$/m);
  assert.match(text, /^\+.*"name": "Instances \(new\)",?$/m);
  assert.match(readFileSync(summary.report, "utf8"), /Instances \(new\)/);
});

test("書き出しの時刻だけが違う書き出しは、変わったところが無いと見る", () => {
  const summary = compare(
    { exportedAt: "2026-10-26T07:46:02.598Z", png: PLAIN },
    { exportedAt: "2026-10-26T07:46:03.407Z", png: PLAIN }
  );
  assert.equal(summary.same, true);
  assert.deepEqual([summary.added, summary.removed, summary.changed, summary.images], [[], [], [], []]);
  assert.equal(summary.changesDiff, null);
});

test("画面の大きさが変わると、広げた側の画素も違う画素に数える", () => {
  const summary = compare({ png: PLAIN }, { png: { width: 5, height: 3, dots: [] } });
  assert.deepEqual(summary.images, [{ file: "node.1-2.png", changedPixels: 3, width: 5, height: 3 }]);
});

test("片方にしか無いファイルは、足された・消えたに挙げる", () => {
  const summary = compare({}, { png: PLAIN });
  assert.deepEqual(summary.added, ["node.1-2.png"]);
  assert.equal(summary.same, false);
  const back = compare({ png: PLAIN }, {});
  assert.deepEqual(back.removed, ["node.1-2.png"]);
});

test("比べた結果でないものが --out にあれば、消さずに断る", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  const out = path.join(root, "keep");
  mkdirSync(out);
  writeFileSync(path.join(out, "important.txt"), "x");
  assert.throws(() => compareExports(before, after, out), /比べた結果の置き場所でない/);
  assert.ok(existsSync(path.join(out, "important.txt")));
  // 前に比べた結果なら、置き換える
  const first = compareExports(before, after, path.join(root, "out"));
  assert.equal(compareExports(before, after, first.outDir).same, true);
});
