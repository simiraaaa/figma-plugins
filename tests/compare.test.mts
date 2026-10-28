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
import { compareExports, type CompareOptions, defaultCompareDir, type CompareSummary } from "../scripts/compare-lib.mts";
import { BRIDGE_META_FILE } from "../scripts/bridge-meta.mts";

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
  /** そのほかに書くファイル (書き出しの中のパス → 中身) */
  files?: Record<string, string>;
  /** dev サーバーが添える行き先のファイルの印 (.local-bridge.json) の fileKey。undefined なら印を書かない */
  fileKey?: string;
  /** そのほかに書く 1×1 の白い PNG (書き出しの中のパス) */
  blankPngs?: string[];
  /** index.json の一番上の frames に載せる id (書き出した範囲の根)。既定は 1:2 */
  rootIds?: string[];
  /** index.json の meta.scope。ページを書き出したときは page:<ページ名> */
  scope?: string;
}

function writeExport(dir: string, spec: ExportSpec): string {
  mkdirSync(dir, { recursive: true });
  const name = spec.name ?? "node";
  if (spec.fileKey !== undefined) {
    writeFileSync(path.join(dir, BRIDGE_META_FILE), JSON.stringify({ fileKey: spec.fileKey, fileName: "f" }));
  }
  const frames = (spec.rootIds ?? ["1:2"]).map((id) => ({ id }));
  const meta = { fileName: "f", exportedAt: spec.exportedAt ?? "2026-10-26T00:00:00.000Z", scope: spec.scope ?? "nodes" };
  const index = { meta, sections: [], frames };
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
  for (const [rel, text] of Object.entries(spec.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  for (const rel of spec.blankPngs ?? []) {
    const png = new PNG({ width: 1, height: 1 });
    png.data.fill(255);
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), PNG.sync.write(png));
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

function compare(before: ExportSpec, after: ExportSpec, options: CompareOptions = {}): CompareSummary {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  return compareExports(
    writeExport(path.join(root, "before"), before),
    writeExport(path.join(root, "after"), after),
    path.join(root, "out"),
    options
  );
}

const PLAIN = { width: 4, height: 3, dots: [] as [number, number, number, number, number][] };

/**
 * ファイル全体のスナップショット (fingerprint.js の返り値) を POST /run の応答の形で書く。
 * ページ P1 (0:1) に Frame 1:2 > Title 1:3 と、別の Frame 2:1 > Text 2:2 (1:3 を元にするインスタンスの中のノード I2:1;1:3) がある
 */
interface FingerprintSpec {
  /** ノードごとのハッシュの上書き。無いノードは h<id> */
  hashes?: Record<string, string>;
  fileKey?: string | null;
  /** ノードの行を差し替える (ページの並びの行を足す・ノードを消す) */
  nodes?: (nodes: string[]) => string[];
}

function writeFingerprint(file: string, spec: FingerprintSpec = {}): string {
  const h = (id: string) => spec.hashes?.[id] ?? `h${id}`;
  const nodes = [`1:2|0:1|${h("1:2")}`, `1:3|1:2|${h("1:3")}`, `2:1|0:1|${h("2:1")}`, `I2:1;1:3|2:1|${h("I2:1;1:3")}`];
  const value = {
    v: 1,
    file: "f",
    fileKey: spec.fileKey === undefined ? "KEY" : spec.fileKey,
    takenAt: "2026-10-28T00:00:00.000Z",
    pages: { "0:1": "P1" },
    nodes: spec.nodes === undefined ? nodes : spec.nodes(nodes),
  };
  writeFileSync(file, JSON.stringify({ seq: 1, value }));
  return file;
}

function fingerprintPair(before: FingerprintSpec, after: FingerprintSpec): { before: string; after: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fingerprint-"));
  return {
    before: writeFingerprint(path.join(dir, "before.json"), before),
    after: writeFingerprint(path.join(dir, "after.json"), after),
  };
}

test("負例: 1 画素だけ色を変えると、その画素を数え、差分画像のその画素を赤くする", () => {
  const summary = compare({ png: PLAIN }, { png: { ...PLAIN, dots: [[2, 1, 250, 250, 250]] } });
  assert.equal(summary.same, false);
  assert.deepEqual(summary.changed, ["node.1-2.png"]);
  assert.deepEqual(summary.images, [
    {
      file: "node.1-2.png",
      changedPixels: 1,
      width: 4,
      height: 3,
      region: { x: 2, y: 1, width: 1, height: 1 },
      regions: [{ x: 2, y: 1, width: 1, height: 1 }],
    },
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

test("負例: 行き先のファイルの印があれば、report のノードと画像に Figma で開くリンク (figma://) を付ける", () => {
  const node = { id: "1:2", name: "Card", children: [{ id: "1:3", name: "Title", text: "a" }] };
  const after = { ...node, children: [{ id: "1:3", name: "Title", text: "b" }] };
  const summary = compare(
    { node, png: PLAIN, fileKey: "KEY" },
    { node: after, png: { ...PLAIN, dots: [[2, 1, 250, 250, 250]] }, fileKey: "KEY" }
  );
  assert.equal(summary.fileKey, "KEY");
  const report = readFileSync(summary.report, "utf8");
  // 構造の差分の区切りに出るノード (1:3) と、画像のノード (1-2) のどちらにも付く
  assert.match(report, /href="figma:\/\/file\/KEY\?node-id=1-3"/);
  assert.match(report, /href="figma:\/\/file\/KEY\?node-id=1-2"/);
});

test("負例: before と after の印の fileKey が違えば (別のファイルの書き出し)、どのノードにも Figma で開くリンクを付けない", () => {
  const summary = compare({ node: { id: "1:2", name: "a" }, fileKey: "KEY1" }, { node: { id: "1:2", name: "b" }, fileKey: "KEY2" });
  assert.equal(summary.fileKey, null);
  assert.doesNotMatch(readFileSync(summary.report, "utf8"), /figma:\/\//);
});

test("負例: after に無いノード (消えた画像・消えたノード) には Figma で開くリンクを付けない", () => {
  const before = { id: "1:2", name: "Card", children: [{ id: "1:3", name: "Gone", text: "x" }] };
  const after = { id: "1:2", name: "Card", children: [] };
  const summary = compare(
    { node: before, png: PLAIN, fileKey: "KEY", blankPngs: ["old.5-6.png"] },
    { node: after, png: { ...PLAIN, dots: [[0, 0, 250, 250, 250]] }, fileKey: "KEY" }
  );
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /href="figma:\/\/file\/KEY\?node-id=1-2"/);
  assert.doesNotMatch(report, /node-id=1-3"/);
  assert.doesNotMatch(report, /node-id=5-6"/);
});

test("負例: 全体スナップショットを渡すと、範囲の外 → 映った先の順で report の先頭に出し (範囲の中は載せない)、summary には 3 つとも入れる", () => {
  const node = { id: "1:2", name: "Card", children: [{ id: "1:3", name: "Title", text: "a" }] };
  const after = { ...node, children: [{ id: "1:3", name: "Title", text: "b" }] };
  // 範囲 (1:2) の中の 1:3 が変わり、それがインスタンス I2:1;1:3 に映り、範囲の外の 2:1 も変わった
  const summary = compare(
    { node, fileKey: "KEY" },
    { node: after, fileKey: "KEY" },
    { fingerprint: fingerprintPair({}, { hashes: { "1:3": "x", "I2:1;1:3": "x", "2:1": "x" } }) }
  );
  assert.ok(summary.fingerprint !== null);
  assert.deepEqual(summary.fingerprint.outside, [{ id: "2:1", page: "P1", kind: "changed" }]);
  assert.deepEqual(summary.fingerprint.propagated, [{ id: "I2:1;1:3", page: "P1", kind: "changed", from: "1:3" }]);
  assert.deepEqual(summary.fingerprint.inside, [{ id: "1:3", page: "P1", kind: "changed" }]);
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /<h1>書き出した範囲の外が変わっている<\/h1>/);
  const at = (text: string) => {
    const i = report.indexOf(text);
    assert.ok(i !== -1, `report に ${text} が無い`);
    return i;
  };
  assert.ok(at('id="outside"') < at('id="propagated"'), "範囲の外が映った先より先");
  assert.ok(at('id="propagated"') < at('id="text"'), "範囲の外の変化が構造の差分より先");
  // 範囲の中の変化は意図したもので、画像と構造の差分に出るので、先頭には載せない
  assert.doesNotMatch(report, /id="inside"/);
  // 範囲の外のノードにも Figma で開くリンクが付く (入れ子の id の ; は URL の符号化)
  assert.match(report, /href="figma:\/\/file\/KEY\?node-id=2-1"/);
  assert.match(report, /node-id=I2-1%3B1-3"/);
  assert.match(readFileSync(path.join(summary.outDir, "summary.json"), "utf8"), /"outside"/);
});

test("負例: 消えたノードとページの並び (document) には Figma で開くリンクを付けず、スナップショットを渡さなければ範囲の外は見ていないと出す", () => {
  // ページを並べ替え (document の行が変わる)、範囲の外の 2:1 を消した
  const fingerprint = fingerprintPair(
    { nodes: (nodes) => ["document||order-a", ...nodes] },
    { nodes: (nodes) => ["document||order-b", ...nodes.filter((line) => !line.startsWith("2:1|"))] }
  );
  const summary = compare({ node: { id: "1:2" }, fileKey: "KEY" }, { node: { id: "1:2" }, fileKey: "KEY" }, { fingerprint });
  assert.deepEqual(
    summary.fingerprint?.outside.map((n) => [n.id, n.kind]),
    [
      ["document", "changed"],
      ["2:1", "removed"],
    ]
  );
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /ページの並び/);
  assert.doesNotMatch(report, /node-id=2-1"/);
  assert.doesNotMatch(report, /node-id=document/);
  const without = compare({ node: { id: "1:2" } }, { node: { id: "1:2" } });
  assert.equal(without.fingerprint, null);
  assert.match(readFileSync(without.report, "utf8"), /範囲の外は見ていない/);
});

test("負例: 書き出しが同じでも、スナップショットの範囲の中に変化 (非表示の子など、書き出しに映らないもの) があれば「無い」と見出しに出さない", () => {
  const summary = compare(
    { node: { id: "1:2" }, fileKey: "KEY" },
    { node: { id: "1:2" }, fileKey: "KEY" },
    { fingerprint: fingerprintPair({}, { hashes: { "1:3": "hidden-child-changed" } }) }
  );
  assert.equal(summary.same, true);
  assert.deepEqual(summary.fingerprint?.inside.map((n) => n.id), ["1:3"]);
  assert.match(readFileSync(summary.report, "utf8"), /<h1>変わったところがある<\/h1>/);
});

test("負例: 書き出しの印と別のファイルのスナップショットを渡したら、取り違えなので断る (置き場所には何も書かない)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const out = path.join(root, "out");
  assert.throws(
    () =>
      compareExports(
        writeExport(path.join(root, "before"), { fileKey: "KEY" }),
        writeExport(path.join(root, "after"), { fileKey: "KEY" }),
        out,
        { fingerprint: fingerprintPair({ fileKey: "OTHER" }, { fileKey: "OTHER" }) }
      ),
    /別のファイルのスナップショット/
  );
  assert.equal(existsSync(out), false);
  // 前後の書き出しが別のファイル (印が KEY1 と KEY2) でも、それぞれの印と照らして断る
  assert.throws(
    () =>
      compare({ fileKey: "KEY1" }, { fileKey: "KEY2" }, { fingerprint: fingerprintPair({ fileKey: "KEY1" }, { fileKey: "KEY1" }) }),
    /別のファイルのスナップショット \(KEY1\)/
  );
});

test("負例: ページを書き出したときは、ページ自身を範囲の根にする (直下のノードを消しても outside に出さない)。同じ名前のページが 2 つなら --inside を求める", () => {
  // ページ P1 (0:1) を書き出した。after の根は残った直下のノード (1:2) だけで、消した 2:1 とページ自身は載らない
  const pageLine = (hash: string) => `0:1||${hash}`;
  const fingerprint = fingerprintPair(
    { nodes: (nodes) => [pageLine("children-a"), ...nodes] },
    { nodes: (nodes) => [pageLine("children-b"), ...nodes.filter((line) => !line.startsWith("2:1|") && !line.startsWith("I2:1;"))] }
  );
  const summary = compare(
    { fileKey: "KEY", scope: "page:P1", rootIds: ["1:2", "2:1"] },
    { fileKey: "KEY", scope: "page:P1", rootIds: ["1:2"] },
    { fingerprint }
  );
  assert.deepEqual(summary.fingerprint?.outside, []);
  assert.deepEqual(
    summary.fingerprint?.inside.map((n) => [n.id, n.kind]),
    [
      ["0:1", "changed"],
      ["2:1", "removed"],
      ["I2:1;1:3", "removed"],
    ]
  );
  // --inside を渡せば index.json を見ない
  const explicit = compare(
    { fileKey: "KEY", scope: "page:P1", rootIds: ["1:2", "2:1"] },
    { fileKey: "KEY", scope: "page:P1", rootIds: ["1:2"] },
    { fingerprint, inside: ["1:2"] }
  );
  assert.deepEqual(explicit.fingerprint?.inside, []);
  assert.equal(explicit.fingerprint?.outside.length, 3);
  const twoPages = fingerprintPair({}, { hashes: { "1:3": "x" } });
  for (const file of [twoPages.before, twoPages.after]) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { value: { pages: Record<string, string> } };
    parsed.value.pages["0:2"] = "P1";
    writeFileSync(file, JSON.stringify(parsed));
  }
  assert.throws(
    () => compare({ fileKey: "KEY", scope: "page:P1" }, { fileKey: "KEY", scope: "page:P1" }, { fingerprint: twoPages }),
    /同じ名前のページが 2 件/
  );
});

test("負例: 片方にだけ印があっても、同じファイルの書き出しと確かめられないので、Figma で開くリンクを付けない", () => {
  const summary = compare({ node: { id: "1:2", name: "a" }, fileKey: "KEY" }, { node: { id: "1:2", name: "b" } });
  assert.equal(summary.fileKey, null);
  assert.doesNotMatch(readFileSync(summary.report, "utf8"), /figma:\/\//);
});

test("負例: 変数やスタイルの id (ノードでないもの) の差分には、Figma で開くリンクを付けない", () => {
  const variables = (value: number) => JSON.stringify({ variables: [{ id: "VariableID:1:2", name: "color", value }] }, null, 2) + "\n";
  const summary = compare(
    { node: { id: "1:2", name: "a" }, fileKey: "KEY", files: { "variables.json": variables(1) } },
    { node: { id: "1:2", name: "a" }, fileKey: "KEY", files: { "variables.json": variables(2) } }
  );
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /VariableID:1:2/);
  assert.doesNotMatch(report, /figma:\/\//);
});

test("負例: 行き先のファイルの印が無い書き出し (Local Bridge 以外が置いたもの) には、Figma で開くリンクを付けない", () => {
  const summary = compare({ node: { id: "1:2", name: "a" } }, { node: { id: "1:2", name: "b" } });
  assert.equal(summary.fileKey, null);
  assert.doesNotMatch(readFileSync(summary.report, "utf8"), /figma:\/\//);
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
    {
      file: "node.1-2.png",
      changedPixels: 3,
      width: 5,
      height: 3,
      region: { x: 4, y: 0, width: 1, height: 3 },
      regions: [{ x: 4, y: 0, width: 1, height: 3 }],
    },
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
  // before の欄は空けておき、before と after の並びをそろえる
  assert.match(report, /class="missing"/);
});

test("負例: 大きい画面の一部だけが変わると、違う画素を囲む範囲を求め、その範囲を切り出した画像を作る", () => {
  const big = { width: 400, height: 300, dots: [] as [number, number, number, number, number][] };
  const summary = compare({ png: big }, { png: { ...big, dots: [[300, 200, 0, 0, 0], [310, 205, 0, 0, 0]] } });
  assert.deepEqual(summary.images[0].region, { x: 300, y: 200, width: 11, height: 6 });
  assert.deepEqual(summary.images[0].regions, [{ x: 300, y: 200, width: 11, height: 6 }]);
  for (const side of ["before", "after", "diff"]) {
    const crop = PNG.sync.read(readFileSync(path.join(summary.outDir, "crop", side, "node.1-2.1.png")));
    assert.ok(crop.width < big.width && crop.height < big.height, `${side} の切り出しが全体より小さくない`);
  }
  assert.match(readFileSync(summary.report, "utf8"), /src="crop\/diff\/node\.1-2\.1\.png"/);
});

test("負例: 1 枚の中で離れた所が変わると、変わった箇所ごとに範囲を分けて切り出し、全体図に番号つきの枠を出す", () => {
  const big = { width: 600, height: 400, dots: [] as [number, number, number, number, number][] };
  const summary = compare({ png: big }, { png: { ...big, dots: [[50, 40, 0, 0, 0], [52, 41, 0, 0, 0], [500, 350, 0, 0, 0]] } });
  assert.deepEqual(summary.images[0].regions, [
    { x: 50, y: 40, width: 3, height: 2 },
    { x: 500, y: 350, width: 1, height: 1 },
  ]);
  for (const n of [1, 2]) {
    assert.ok(existsSync(path.join(summary.outDir, "crop", "after", `node.1-2.${n}.png`)), `${n} 箇所目の切り出しが無い`);
  }
  const report = readFileSync(summary.report, "utf8");
  assert.equal(report.match(/class="box"/g)?.length, 2);
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

test("負例: 同じ中身の変化が何箇所にもあると、まとめて箇所の数とノードを出す", () => {
  const child = (id: string, name: string, color: string) => ({ id, name, rows: Array.from({ length: 8 }, (_, i) => i), fills: [{ color }] });
  const node = (color: string) => ({ node: { id: "1:2", name: "frame", children: [child("3:4", "A", color), child("5:6", "B", color)] } });
  const summary = compare({ node: node("#2563eb") }, { node: node("#ff8c1a") });
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /同じ変化が 2 箇所/);
  assert.match(report, /A <code>3:4<\/code>[\s\S]*B <code>5:6<\/code>/);
  // AI も長い差分を同じ変化ごとに分けられるよう、summary にも出す
  assert.deepEqual(
    summary.sameChanges.map((g) => [g.count, g.places.map((p) => `${p.name} ${p.nodeId}`)]),
    [[2, ["A 3:4", "B 5:6"]]]
  );
});

test("負例: 構造の差分のファイルが多いときは、最初は全部閉じておく", () => {
  const files = (v: string) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.${i + 10}-1.json`, `{"v": "${v}"}\n`]));
  const summary = compare({ files: files("a") }, { files: files("b") });
  const report = readFileSync(summary.report, "utf8");
  assert.doesNotMatch(detailsTagFor(report, "f0.10-1.json"), /\bopen\b/);
});

test("負例: 内容の行が -- や ++ で始まっても、ファイルの見出しと読み違えない", () => {
  const summary = compare({ files: { "notes.txt": "-- a\n" } }, { files: { "notes.txt": "-- b\n" } });
  const report = readFileSync(summary.report, "utf8");
  assert.match(report, /<span class="del">--- a<\/span>/);
  assert.match(report, /<span class="add">\+-- b<\/span>/);
});

test("負例: 隠しファイル (.DS_Store など) は比べない", () => {
  const summary = compare({ files: { ".DS_Store": "a" } }, { files: { ".DS_Store": "b" } });
  assert.equal(summary.same, true);
});

test("負例: 文字のファイルが足されただけでも、比べて差分に出す", () => {
  const summary = compare({}, { files: { "Note.9-9.json": '{"name": "note"}\n' } });
  assert.deepEqual(summary.added, ["Note.9-9.json"]);
  assert.ok(summary.changesDiff !== null);
  assert.match(readFileSync(summary.changesDiff, "utf8"), /^\+\{"name": "note"\}$/m);
});

test("負例: SVG のコードは、同じ変化のまとめにも出さない", () => {
  const svg = (fill: string) => `<svg><path d="M0 0" fill="${fill}"/></svg>\n`;
  const files = (fill: string) => ({ "assets/svg/a.svg": svg(fill), "assets/svg/b.svg": svg(fill) });
  const summary = compare({ files: files("white") }, { files: files("#FF8C1A") });
  assert.deepEqual(summary.sameChanges, []);
});

test("負例: 全体図の枠は、前後の大きい方にそろえた差分の画像に重ねる (after が小さくなってもずれない)", () => {
  const summary = compare({ png: { width: 400, height: 300, dots: [[390, 10, 0, 0, 0]] } }, { png: { width: 350, height: 300, dots: [] } });
  assert.match(readFileSync(summary.report, "utf8"), /class="map-inner"><img src="diff\/node\.1-2\.png"/);
});

test("負例: 差分が大きくても、同じ変化のまとめを出す", () => {
  const long = (c: string) => JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => `${c}${i}`.padEnd(60, c)) }, null, 2) + "\n";
  const summary = compare({ files: { "f.1-1.json": long("a"), "g.2-2.json": long("a") } }, { files: { "f.1-1.json": long("b"), "g.2-2.json": long("b") } });
  assert.ok(statSync(summary.changesDiff!).size > 2 * 1024 * 1024);
  assert.equal(summary.sameChanges[0]?.count, 2);
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

test("負例: 比べた結果と同じ名前だけでも、compare が書いた summary.json でなければ、消さずに断る", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  const out = path.join(root, "keep");
  mkdirSync(path.join(out, "before"), { recursive: true });
  writeFileSync(path.join(out, "before", "keep.txt"), "x");
  writeFileSync(path.join(out, "summary.json"), JSON.stringify({ same: true }));
  assert.throws(() => compareExports(before, after, out), /比べた結果の置き場所でない/);
  assert.ok(existsSync(path.join(out, "before", "keep.txt")));
  assert.equal(readFileSync(path.join(out, "summary.json"), "utf8"), JSON.stringify({ same: true }));
});

test("負例: --out が比べる書き出しの中を指すシンボリックリンクでも断る", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  mkdirSync(path.join(before, "inner"));
  symlinkSync(path.join(before, "inner"), path.join(root, "link"));
  assert.throws(() => compareExports(before, after, path.join(root, "link")), /--out が比べる書き出しの中にある/);
  assert.throws(() => compareExports(before, after, path.join(root, "link", "out")), /--out が比べる書き出しの中にある/);
  assert.ok(!existsSync(path.join(before, "inner", "summary.json")));
});

test("負例: --out が比べる書き出しの中にあれば断り、空のディレクトリなら使う", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  assert.throws(() => compareExports(before, after, path.join(before, "out")), /--out が比べる書き出しの中にある/);
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  assert.equal(compareExports(before, after, empty).same, true);
});

test("負例: 比べた結果の置き場所に隠しファイル (.DS_Store など) があっても、置き換えて比べ直す", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compare-"));
  const before = writeExport(path.join(root, "before"), {});
  const after = writeExport(path.join(root, "after"), {});
  const first = compareExports(before, after, path.join(root, "out"));
  writeFileSync(path.join(first.outDir, ".DS_Store"), "x");
  assert.equal(compareExports(before, after, first.outDir).same, true);
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
