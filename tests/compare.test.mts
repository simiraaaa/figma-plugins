/**
 * 書き出しの比較 (scripts/compare-lib.mts) の検査
 *
 * 実行: npm test
 * Local Bridge の書き出しと同じ形 (index.json・構造の json・画面の png) を作って比べ、
 * 変わった文字・画素を拾うこと、書き出しの時刻の違いだけでは変わったと見ないことを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { compareExports, defaultCompareDir, type CompareSummary } from "../scripts/compare-lib.mts";

interface ExportSpec {
  exportedAt?: string;
  /** 書き出しのファイル名の名前の部分 (<名前>.1-2.json)。既定は node */
  name?: string;
  node?: Record<string, unknown>;
  /** [x, y, r, g, b] の点を白地に打つ。undefined なら png を書かない */
  png?: { width: number; height: number; dots: [number, number, number, number, number][] };
  /** png の代わりにそのまま書くバイト列 (壊れた PNG を作る) */
  pngBytes?: Buffer;
  svg?: string;
}

function writeExport(dir: string, spec: ExportSpec): string {
  mkdirSync(dir, { recursive: true });
  const name = spec.name ?? "node";
  const index = { meta: { fileName: "f", exportedAt: spec.exportedAt ?? "2026-10-26T00:00:00.000Z" }, frames: [] };
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  writeFileSync(path.join(dir, `${name}.1-2.json`), JSON.stringify(spec.node ?? { name: "frame" }, null, 2) + "\n");
  if (spec.png) {
    const png = new PNG({ width: spec.png.width, height: spec.png.height });
    png.data.fill(255);
    for (const [x, y, r, g, b] of spec.png.dots) {
      const i = (y * spec.png.width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
    }
    writeFileSync(path.join(dir, `${name}.1-2.png`), PNG.sync.write(png));
  }
  if (spec.pngBytes) writeFileSync(path.join(dir, `${name}.1-2.png`), spec.pngBytes);
  if (spec.svg !== undefined) {
    mkdirSync(path.join(dir, "assets", "svg"), { recursive: true });
    writeFileSync(path.join(dir, "assets", "svg", "1-2.svg"), spec.svg);
  }
  return dir;
}

/** report の中の、そのファイルの差分の details の開きタグ */
function detailsTagFor(report: string, file: string): string {
  const at = report.indexOf(`<code>${file}</code>`);
  assert.ok(at !== -1, `report に ${file} が無い`);
  const open = report.lastIndexOf("<details", at);
  return report.slice(open, report.indexOf(">", open) + 1);
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
  assert.deepEqual(summary.images, [
    { file: "node.1-2.png", changedPixels: 1, width: 4, height: 3, region: { x: 2, y: 1, width: 1, height: 1 } },
  ]);
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
  assert.deepEqual(summary.images, [
    { file: "node.1-2.png", changedPixels: 3, width: 5, height: 3, region: { x: 4, y: 0, width: 1, height: 3 } },
  ]);
});

test("片方にしか無いファイルは、足された・消えたに挙げる", () => {
  const summary = compare({}, { png: PLAIN });
  assert.deepEqual(summary.added, ["node.1-2.png"]);
  assert.equal(summary.same, false);
  const back = compare({ png: PLAIN }, {});
  assert.deepEqual(back.removed, ["node.1-2.png"]);
});

test("負例: 足された画像は report に after だけを載せ、無い before の画像を指さない", () => {
  const summary = compare({}, { png: PLAIN });
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /src="after\/node\.1-2\.png"/);
  assert.doesNotMatch(report, /src="before\/node\.1-2\.png"/);
  assert.doesNotMatch(report, /src="diff\/node\.1-2\.png"/);
});

test("負例: 大きい画面の一部だけが変わると、違う画素を囲む範囲を求め、その範囲を切り出した画像を作る", () => {
  const big = { width: 400, height: 300, dots: [] as [number, number, number, number, number][] };
  const summary = compare({ png: big }, { png: { ...big, dots: [[300, 200, 0, 0, 0], [310, 205, 0, 0, 0]] } });
  assert.deepEqual(summary.images[0].region, { x: 300, y: 200, width: 11, height: 6 });
  for (const side of ["before", "after", "diff"]) {
    const crop = PNG.sync.read(readFileSync(path.join(summary.outDir, "crop", side, "node.1-2.png")));
    assert.ok(crop.width < big.width && crop.height < big.height, `${side} の切り出しが全体より小さくない`);
  }
  assert.match(readFileSync(summary.report, "utf8"), /src="crop\/diff\/node\.1-2\.png"/);
});

test("負例: ノードの名前を変えても、ノード ID で前後を組にして、変わったファイルとして比べる", () => {
  const summary = compare(
    { name: "old", node: { name: "old" }, png: PLAIN },
    { name: "new", node: { name: "new" }, png: { ...PLAIN, dots: [[0, 0, 0, 0, 0]] } }
  );
  assert.deepEqual([summary.added, summary.removed], [[], []]);
  assert.deepEqual(summary.renamed, [
    { before: "old.1-2.json", after: "new.1-2.json" },
    { before: "old.1-2.png", after: "new.1-2.png" },
  ]);
  assert.deepEqual(summary.changed, ["new.1-2.json", "new.1-2.png"]);
  assert.equal(summary.images[0].file, "new.1-2.png");
  assert.ok(summary.changesDiff !== null);
  assert.match(readFileSync(summary.changesDiff, "utf8"), /^-\s*"name": "old"\n\+\s*"name": "new"$/m);
});

test("負例: report では SVG の差分を閉じておき、構造の json の差分は開いておく", () => {
  const summary = compare(
    { node: { name: "a" }, svg: '<svg><path d="M0 0" fill="white"/></svg>\n' },
    { node: { name: "b" }, svg: '<svg><path d="M0 0" fill="#FF8C1A"/></svg>\n' }
  );
  const report = readFileSync(summary.report, "utf8");
  assert.doesNotMatch(detailsTagFor(report, "assets/svg/1-2.svg"), /\bopen\b/);
  assert.match(detailsTagFor(report, "node.1-2.json"), /\bopen\b/);
});

test("負例: 構造の差分の区切りに、変わった箇所を含むノードの名前と ID を出す", () => {
  const node = (color: string) => ({
    node: {
      id: "1:2",
      name: "frame",
      children: [{ id: "3:4", name: "Checked icon", type: "VECTOR", padding: [1, 2, 3, 4, 5, 6, 7, 8], fills: [{ color }] }],
    },
  });
  const summary = compare({ node: node("#2563eb") }, { node: node("#ff8c1a") });
  assert.ok(summary.changesDiff !== null);
  assert.match(readFileSync(summary.changesDiff, "utf8"), /^@@ .* @@ .*"id": "3:4"/m);
  assert.match(readFileSync(summary.report, "utf8"), /class="node">Checked icon <code>3:4<\/code>/);
});

test("文字の差分が 1 MiB を超えても、changes.diff に書き切る", () => {
  const long = (c: string) => ({ rows: Array.from({ length: 20000 }, (_, i) => `${c}${i}`.padEnd(60, c)) });
  const summary = compare({ node: long("a") }, { node: long("b") });
  assert.ok(summary.changesDiff !== null);
  assert.ok(statSync(summary.changesDiff).size > 1024 * 1024);
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

test("負例: 比べた結果の置き場所でも、比べた結果が作らないファイルがあれば、消さずに断る", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  const first = compareExports(before, after, path.join(root, "out"));
  writeFileSync(path.join(first.outDir, "notes.txt"), "x");
  assert.throws(() => compareExports(before, after, first.outDir), /比べた結果の置き場所でない/);
  assert.ok(existsSync(path.join(first.outDir, "notes.txt")));
});

test("負例: 壊れた PNG はそのファイルを挙げて断り、直せば同じ --out で比べ直せる", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), { pngBytes: Buffer.from("not a png") });
  const after = writeExport(path.join(root, "after"), { png: PLAIN });
  const out = path.join(root, "out");
  assert.throws(() => compareExports(before, after, out), /PNG を読めない: before\/node\.1-2\.png/);
  writeExport(before, { png: PLAIN });
  assert.equal(compareExports(before, after, out).same, true);
});

test("負例: 壊れた index.json はそのファイルを挙げて断る", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  writeFileSync(path.join(before, "index.json"), "{");
  assert.throws(() => compareExports(before, after, path.join(root, "out")), /index\.json を読めない: .*before/);
});

test("負例: 既定の置き場所は、latest のようなリンクをたどった先の書き出しの名前で決める", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "compare-")));
  const results = path.join(root, "results");
  writeExport(path.join(results, "1"), {});
  writeExport(path.join(results, "2"), {});
  symlinkSync("2", path.join(results, "latest"));
  assert.equal(defaultCompareDir(path.join(results, "1"), path.join(results, "latest")), path.join(root, "compare", "1-2"));
});
