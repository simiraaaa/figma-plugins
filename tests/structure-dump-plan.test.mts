/**
 * structure-dump 書き出し計画 (dump-v2) の検査
 *
 * 実行: npm test
 * Figma API 非依存の純関数なので、素のオブジェクトでページを組んで
 * 画面フレームの判定・ZIP 内パス・index.json の形を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as planDist from "../plugins/structure-dump/dist/plan.mjs";
import type { DumpPlan, FramePlan, SectionPlan } from "../plugins/structure-dump/src/plan.ts";

const {
  allFrames,
  allSections,
  buildFrameJson,
  buildIndex,
  buildSectionJson,
  dropDescendants,
  emptyMessage,
  longPaths,
  MAX_ZIP_PATH_CHARS,
  newExportOutput,
  planDump,
  recordAsset,
  recordScreenshot,
  safeName,
  SCREENSHOT_SCALE_BY_COMMAND,
  screenshotScaleFor,
} = planDist as unknown as typeof import("../plugins/structure-dump/src/plan.ts");

/** code.ts が渡すのと同じ並べ替えを、Figma 環境なしで読む (バンドルして ESM として import) */
async function loadSortInDocumentOrder() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const built = buildSync({
    entryPoints: [path.join(root, "shared/nodeOrder.ts")],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2020",
  });
  const mod = (await import(
    "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
  )) as typeof import("../shared/nodeOrder.ts");
  return mod.sortInDocumentOrder;
}

const sortInDocumentOrder = await loadSortInDocumentOrder();
const planOf = (roots: readonly TestNode[]) => planDump(roots, sortInDocumentOrder);

interface TestNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** plan は読まない。回転ノードで transform と食い違う値を置き、使っていないことを確かめる */
  absoluteBoundingBox?: { x: number; y: number };
  absoluteTransform: number[][];
  parent: TestNode | null;
  children: TestNode[];
}

interface Spec {
  w: number;
  h: number;
  x?: number;
  y?: number;
  hidden?: boolean;
  children?: TestNode[];
}

function node(type: string, id: string, name: string, spec: Spec): TestNode {
  const self: TestNode = {
    id,
    name,
    type,
    visible: !spec.hidden,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: spec.w,
    height: spec.h,
    absoluteTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    parent: null,
    children: spec.children ?? [],
  };
  for (const child of self.children) child.parent = self;
  return self;
}

const frame = (id: string, name: string, spec: Spec) => node("FRAME", id, name, spec);
const section = (id: string, name: string, spec: Spec) => node("SECTION", id, name, spec);

/** 親を辿って absoluteTransform の平行移動成分を埋める (回転なし) */
function page(children: TestNode[]): TestNode {
  const root = node("PAGE", "0:1", "Page 1", { w: 0, h: 0, children });
  const place = (n: TestNode, ox: number, oy: number): void => {
    const ax = ox + n.x;
    const ay = oy + n.y;
    n.absoluteTransform = [
      [1, 0, ax],
      [0, 1, ay],
    ];
    for (const c of n.children) place(c, ax, ay);
  };
  for (const c of children) place(c, 0, 0);
  return root;
}

const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);

function allPaths(plan: DumpPlan<TestNode>): string[] {
  const paths: string[] = [];
  for (const f of allFrames(plan)) paths.push(f.png, f.json);
  for (const s of allSections(plan)) {
    if (s.sectionJson !== undefined) paths.push(s.sectionJson);
  }
  return paths;
}

test("セクション直下の判定は型だけで決まる: FRAME・INSTANCE・COMPONENT・GROUP は大きさを問わず画面、それ以外は _section.json 側", () => {
  const p = page([
    section("1:1", "Flow", {
      w: 5000,
      h: 1000,
      children: [
        frame("2:1", "Small frame", { w: 100, h: 100 }),
        node("VECTOR", "2:2", "Big vector", { w: 390, h: 844, x: 200 }),
        node("INSTANCE", "2:3", "Big instance", { w: 390, h: 844, x: 700 }),
        node("GROUP", "2:4", "Group", { w: 390, h: 844, x: 1200 }),
        node("TEXT", "2:5", "memo", { w: 200, h: 40, x: 1700 }),
        node("COMPONENT", "2:6", "Component", { w: 390, h: 844, x: 2000 }),
        node("LINE", "2:7", "arrow", { w: 300, h: 0, x: 2500 }),
        frame("2:8", "Screen", { w: 1440, h: 1024, x: 2600 }),
        node("INSTANCE", "2:9", "Small instance", { w: 24, h: 24, x: 4100 }),
        node("COMPONENT_SET", "2:10", "Variants", { w: 390, h: 844, x: 4200 }),
      ],
    }),
  ]);
  const plan = planOf(p.children);
  const s = plan.sections[0];
  assert.deepEqual(ids(s.frames), ["2:1", "2:3", "2:4", "2:6", "2:8", "2:9"]);
  assert.deepEqual(ids(s.others), ["2:2", "2:5", "2:7", "2:10"]);
  assert.equal(s.sectionJson, "Flow.1-1/_section.json");
});

test("_section.json は画面フレーム以外の子が無ければ作らない・非表示の子は数えない", () => {
  const p = page([
    section("1:1", "Only screens", {
      w: 2000,
      h: 1000,
      children: [
        frame("2:1", "Home", { w: 390, h: 844 }),
        frame("2:2", "hidden memo", { w: 100, h: 100, hidden: true }),
        frame("2:3", "hidden screen", { w: 390, h: 844, hidden: true }),
      ],
    }),
  ]);
  const s = planOf(p.children).sections[0];
  assert.deepEqual(ids(s.frames), ["2:1"]);
  assert.deepEqual(s.others, []);
  assert.equal(s.sectionJson, undefined);
});

test("ネストしたセクションでも INSTANCE・COMPONENT・GROUP は画面になり、index.json に png 付きで載る", () => {
  const p = page([
    section("20:1", "Flow", {
      w: 5000,
      h: 2000,
      children: [
        section("20:2", "Mixed", {
          w: 2000,
          h: 1000,
          children: [
            node("INSTANCE", "20:3", "Screen", { w: 390, h: 844 }),
            node("COMPONENT_SET", "20:4", "Variants", { w: 390, h: 844, x: 500 }),
            node("INSTANCE", "20:5", "hidden screen", { w: 390, h: 844, x: 1000, hidden: true }),
          ],
        }),
        section("20:6", "Only screens", {
          w: 2000,
          h: 1000,
          x: 2100,
          children: [
            node("GROUP", "20:7", "Grouped", { w: 390, h: 844 }),
            node("COMPONENT", "20:8", "Component", { w: 390, h: 844, x: 500 }),
          ],
        }),
      ],
    }),
  ]);
  const plan = planOf(p.children);
  const [mixed, onlyScreens] = plan.sections[0].sections;
  assert.deepEqual(ids(mixed.frames), ["20:3"]);
  assert.deepEqual(ids(mixed.others), ["20:4"]);
  assert.equal(mixed.sectionJson, "Flow.20-1/Mixed.20-2/_section.json");
  assert.deepEqual(ids(onlyScreens.frames), ["20:7", "20:8"]);
  assert.equal(onlyScreens.sectionJson, undefined);

  const index = buildIndex(
    plan,
    { fileName: "f", pluginVersion: "0", exportedAt: "t", scope: "s", screenshotScale: 2, warnings: [] },
    new Set(allFrames(plan).map((f) => f.png)),
    new Map(),
    new Map()
  );
  const nested = (index.sections as { sections: { frames: { id: string; png?: string }[]; sectionJson?: string }[] }[])[0]
    .sections;
  assert.deepEqual(
    nested.map((s) => [s.frames.map((f) => [f.id, f.png]), s.sectionJson]),
    [
      [[["20:3", "Flow.20-1/Mixed.20-2/Screen.20-3.png"]], "Flow.20-1/Mixed.20-2/_section.json"],
      [
        [
          ["20:7", "Flow.20-1/Only-screens.20-6/Grouped.20-7.png"],
          ["20:8", "Flow.20-1/Only-screens.20-6/Component.20-8.png"],
        ],
        undefined,
      ],
    ]
  );
});

test("ネストしたセクションはディレクトリもネストし、パスは safeName.safeId", () => {
  const p = page([
    section("10:1", "Flow A", {
      w: 4000,
      h: 3000,
      children: [
        section("10:2", "Sub/B", {
          w: 2000,
          h: 1000,
          x: 100,
          y: 200,
          children: [
            frame("10:3", "Login: top", { w: 390, h: 844, x: 10, y: 20 }),
            node("TEXT", "10:4", "note", { w: 200, h: 100, x: 500, y: 20 }),
          ],
        }),
      ],
    }),
  ]);
  const plan = planOf(p.children);
  const outer = plan.sections[0];
  const inner = outer.sections[0];
  assert.equal(outer.dir, "Flow-A.10-1");
  assert.equal(inner.dir, "Flow-A.10-1/Sub-B.10-2");
  assert.equal(inner.frames[0].png, "Flow-A.10-1/Sub-B.10-2/Login-top.10-3.png");
  assert.equal(inner.frames[0].json, "Flow-A.10-1/Sub-B.10-2/Login-top.10-3.json");
  assert.deepEqual(inner.frames[0].section, {
    id: "10:2",
    name: "Sub/B",
    dir: "Flow-A.10-1/Sub-B.10-2",
  });
  assert.equal(inner.sectionJson, "Flow-A.10-1/Sub-B.10-2/_section.json");
  assert.equal(outer.sectionJson, undefined);
  // 相対座標は親基準、絶対座標はページ基準
  assert.deepEqual(
    [inner.frames[0].x, inner.frames[0].y, inner.frames[0].absoluteX, inner.frames[0].absoluteY],
    [10, 20, 110, 220]
  );
});

test("祖先と子孫を両方選んだら子孫を落として 1 回だけ出す", () => {
  const inner = frame("2:1", "Home", { w: 390, h: 844 });
  const deep = frame("3:1", "button", { w: 100, h: 40 });
  const outside = frame("4:1", "Detail", { w: 390, h: 844, x: 3000, children: [deep] });
  const sec = section("1:1", "Flow", { w: 2000, h: 1000, children: [inner] });
  page([sec, outside]);

  const plan = planOf([deep, inner, outside, sec]);
  assert.deepEqual(ids(plan.sections), ["1:1"]);
  assert.deepEqual(ids(plan.frames), ["4:1"]);
  assert.deepEqual(ids(allFrames(plan)), ["2:1", "4:1"]);
});

test("セクション外の選択は型とサイズを問わず ZIP 直下の画面フレーム・document 順・非表示は除いて返す", () => {
  const small = node("VECTOR", "5:1", "Icon", { w: 24, h: 24 });
  const big = frame("5:2", "Screen", { w: 390, h: 844, x: 100 });
  const hidden = frame("5:3", "Hidden", { w: 390, h: 844, x: 600, hidden: true });
  page([small, big, hidden]);

  const plan = planOf([big, hidden, small]);
  assert.deepEqual(ids(plan.frames), ["5:1", "5:2"]);
  assert.equal(plan.frames[0].png, "Icon.5-1.png");
  assert.equal(plan.frames[0].section, null);
  assert.deepEqual(ids(plan.hiddenRoots), ["5:3"]);
});

test("セクションの中のフレームだけを直接選ぶと ZIP 直下に section: null で置き、x/y は Figma 上の親基準のまま", () => {
  const inner = frame("9:2", "Inner", { w: 390, h: 844, x: 10, y: 20 });
  page([section("9:1", "Flow", { w: 2000, h: 1000, x: 50, y: 60, children: [inner] })]);

  const plan = planOf([inner]);
  assert.deepEqual(plan.sections, []);
  assert.deepEqual(ids(plan.frames), ["9:2"]);
  const f = plan.frames[0];
  assert.equal(f.section, null);
  assert.equal(f.png, "Inner.9-2.png");
  assert.equal(f.json, "Inner.9-2.json");
  assert.deepEqual([f.x, f.y, f.absoluteX, f.absoluteY], [10, 20, 60, 80]);
});

test("負例: 非表示の祖先と表示中の子孫を両方選ぶと、どちらも出ず非表示の祖先が除外として返る", () => {
  const child = frame("7:2", "Visible child", { w: 390, h: 844 });
  const hiddenParent = frame("7:1", "Hidden parent", { w: 800, h: 900, hidden: true, children: [child] });
  page([hiddenParent]);

  const plan = planOf([child, hiddenParent]);
  assert.deepEqual(plan.frames, []);
  assert.deepEqual(plan.sections, []);
  assert.deepEqual(ids(plan.hiddenRoots), ["7:1"]);
});

test("負例: 39 字の ASCII + 絵文字の名前でもサロゲートペアを割らない", () => {
  const name = "a".repeat(39) + "😀";
  assert.equal(safeName(name), name);
  assert.equal(safeName(name + "b"), name);
  const p = page([frame("8:1", name, { w: 390, h: 844 })]);
  const f = planOf(p.children).frames[0];
  assert.equal(f.png, `${name}.8-1.png`);
  assert.doesNotMatch(f.png, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("同名フレームは id で区別され、ZIP 内パスが衝突しない", () => {
  const p = page([
    section("1:1", "Flow", {
      w: 4000,
      h: 1000,
      children: [
        frame("2:1", "Home", { w: 390, h: 844 }),
        frame("2:2", "Home", { w: 390, h: 844, x: 400 }),
        node("TEXT", "2:3", "Home", { w: 10, h: 10, x: 800 }),
        section("2:4", "Flow", { w: 1000, h: 1000, x: 900 }),
        frame("2:5", "Home", { w: 10, h: 10, x: 2000 }),
      ],
    }),
    section("1:2", "Flow", {
      w: 1000,
      h: 1000,
      y: 2000,
      children: [frame("3:1", "Home", { w: 390, h: 844 })],
    }),
    frame("1:3", "Home", { w: 390, h: 844, y: 4000 }),
  ]);
  const plan = planOf(p.children);
  const paths = allPaths(plan);
  assert.equal(new Set(paths).size, paths.length, paths.join("\n"));
  assert.deepEqual(
    allFrames(plan).map((f) => f.png),
    [
      "Flow.1-1/Home.2-1.png",
      "Flow.1-1/Home.2-2.png",
      "Flow.1-1/Home.2-5.png",
      "Flow.1-2/Home.3-1.png",
      "Home.1-3.png",
    ]
  );
  assert.deepEqual(
    allSections(plan).map((s) => s.dir),
    ["Flow.1-1", "Flow.1-1/Flow.2-4", "Flow.1-2"]
  );
});

test("absoluteX/Y は absoluteTransform の平行移動成分 (回転ノードでも親の absoluteX + x と一致し、bbox は使わない)", () => {
  const rotated = frame("6:2", "Rotated", { w: 390, h: 844, x: 10.004, y: 20 });
  const sec = section("6:1", "Flow", { w: 2000, h: 1000, x: 50, y: 60, children: [rotated] });
  page([sec]);
  // 90 度回転。外接矩形の左上は原点から左へ height ぶんずれる
  rotated.absoluteTransform = [
    [0, -1, 60.004],
    [1, 0, 80],
  ];
  rotated.absoluteBoundingBox = { x: 60.004 - 844, y: 80 };

  const s = planOf([sec]).sections[0];
  const f = s.frames[0];
  assert.deepEqual([f.absoluteX, f.absoluteY], [60, 80]);
  assert.deepEqual([s.absoluteX + f.x, s.absoluteY + f.y], [f.absoluteX, f.absoluteY]);
});

test("index.json・画面フレーム json・_section.json の形", () => {
  const p = page([
    section("1:1", "Flow", {
      w: 2000,
      h: 1000,
      x: 50,
      y: 60,
      children: [
        frame("2:1", "Home", { w: 390, h: 844, x: 10, y: 20 }),
        frame("2:2", "Broken", { w: 390, h: 844, x: 500, y: 20 }),
        node("TEXT", "2:3", "memo", { w: 200, h: 100, x: 10, y: 900 }),
        section("2:4", "Sub", {
          w: 500,
          h: 900,
          x: 1000,
          y: 0,
          children: [frame("3:1", "Modal", { w: 400, h: 700, x: 5, y: 5 })],
        }),
      ],
    }),
    node("INSTANCE", "1:2", "Loose", { w: 100, h: 100, x: 3000, y: 0 }),
  ]);
  const plan = planOf(p.children);
  const written = new Set(
    allFrames(plan)
      .map((f) => f.png)
      .filter((png) => png !== "Flow.1-1/Broken.2-2.png")
  );
  const meta = {
    fileName: "Design",
    pluginVersion: "0.1.0",
    exportedAt: "2026-10-08T00:00:00.000Z",
    scope: "page:Page 1",
    screenshotScale: 2,
    warnings: ["スクリーンショット失敗: Broken (2:2): x"],
  };

  const assets = new Map([["abc123", "assets/abc123.png"]]);
  const components = new Map([
    ["1:2", { componentName: "Property 1=Default", componentSetName: "Card" }],
  ]);

  assert.deepEqual(buildIndex(plan, meta, written, assets, components), {
    meta: { ...meta, schemaVersion: "dump-v2" },
    sections: [
      {
        id: "1:1",
        name: "Flow",
        dir: "Flow.1-1",
        x: 50,
        y: 60,
        absoluteX: 50,
        absoluteY: 60,
        width: 2000,
        height: 1000,
        frames: [
          {
            id: "2:1",
            name: "Home",
            type: "FRAME",
            png: "Flow.1-1/Home.2-1.png",
            json: "Flow.1-1/Home.2-1.json",
            x: 10,
            y: 20,
            absoluteX: 60,
            absoluteY: 80,
            width: 390,
            height: 844,
          },
          {
            id: "2:2",
            name: "Broken",
            type: "FRAME",
            json: "Flow.1-1/Broken.2-2.json",
            x: 500,
            y: 20,
            absoluteX: 550,
            absoluteY: 80,
            width: 390,
            height: 844,
          },
        ],
        sections: [
          {
            id: "2:4",
            name: "Sub",
            dir: "Flow.1-1/Sub.2-4",
            x: 1000,
            y: 0,
            absoluteX: 1050,
            absoluteY: 60,
            width: 500,
            height: 900,
            frames: [
              {
                id: "3:1",
                name: "Modal",
                type: "FRAME",
                png: "Flow.1-1/Sub.2-4/Modal.3-1.png",
                json: "Flow.1-1/Sub.2-4/Modal.3-1.json",
                x: 5,
                y: 5,
                absoluteX: 1055,
                absoluteY: 65,
                width: 400,
                height: 700,
              },
            ],
            sections: [],
          },
        ],
        sectionJson: "Flow.1-1/_section.json",
      },
    ],
    frames: [
      {
        id: "1:2",
        name: "Loose",
        type: "INSTANCE",
        componentName: "Property 1=Default",
        componentSetName: "Card",
        png: "Loose.1-2.png",
        json: "Loose.1-2.json",
        x: 3000,
        y: 0,
        absoluteX: 3000,
        absoluteY: 0,
        width: 100,
        height: 100,
      },
    ],
    assets: { abc123: "assets/abc123.png" },
  });

  const home: FramePlan<TestNode> = plan.sections[0].frames[0];
  const dumped = { id: "2:1", name: "Home", type: "FRAME" };
  assert.deepEqual(buildFrameJson(home, dumped), {
    schemaVersion: "dump-v2",
    section: { id: "1:1", name: "Flow", dir: "Flow.1-1" },
    absoluteX: 60,
    absoluteY: 80,
    node: dumped,
  });
  assert.deepEqual(buildFrameJson(plan.frames[0], dumped).section, null);

  const flow: SectionPlan<TestNode> = plan.sections[0];
  assert.deepEqual(ids(flow.others), ["2:3"]);
  const memo = { id: "2:3", name: "memo", type: "FRAME" };
  assert.deepEqual(buildSectionJson(flow, [memo]), {
    schemaVersion: "dump-v2",
    section: {
      id: "1:1",
      name: "Flow",
      dir: "Flow.1-1",
      x: 50,
      y: 60,
      absoluteX: 50,
      absoluteY: 60,
      width: 2000,
      height: 1000,
    },
    nodes: [memo],
  });
});

test("safeName: 制御文字は - に置き換える", () => {
  assert.equal(safeName("a\u0001b\u001fc\u007fd"), "a-b-c-d");
  assert.equal(safeName("tab\tand\u0000nul"), "tab-and-nul");
});

test("safeName: 先頭の . を取り、隠しファイル・隠しディレクトリにしない", () => {
  assert.equal(safeName(".hidden"), "hidden");
  assert.equal(safeName("...dots"), "dots");
  assert.equal(safeName(". leading space"), "leading-space");
});

test("safeName: Windows の予約名は先頭に _ を付ける (大文字小文字を問わない)", () => {
  for (const reserved of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
    assert.equal(safeName(reserved), `_${reserved}`, reserved);
  }
  for (const ordinary of ["COM10", "CONSOLE", "LPT0", "NULL", "AUX-1", "notes.CON"]) {
    assert.equal(safeName(ordinary), ordinary, ordinary);
  }
});

test("safeName: 最初のドットより前が予約名なら、拡張子が付いていても _ を付ける", () => {
  assert.equal(safeName("CON.notes"), "_CON.notes");
  assert.equal(safeName("nul.backup"), "_nul.backup");
  assert.equal(safeName("Com1.a.b"), "_Com1.a.b");
  assert.equal(safeName("CONSOLE.notes"), "CONSOLE.notes");
});

test("safeName: 空の名前と記号だけの名前は node になる", () => {
  for (const name of ["", "   ", "///", '*?:"<>|', "...", ".-.-"]) {
    assert.equal(safeName(name), "node", JSON.stringify(name));
  }
});

test("dropDescendants: 祖先の parent が循環していても停止し、ノードを残す", () => {
  const p = node("FRAME", "c:1", "p", { w: 1, h: 1 });
  const q = node("FRAME", "c:2", "q", { w: 1, h: 1 });
  const x = frame("c:3", "x", { w: 390, h: 844 });
  x.parent = p;
  p.parent = q;
  q.parent = p;
  assert.deepEqual(ids(dropDescendants([x])), ["c:3"]);
});

test("非表示のセクションの中の表示中の子は、ネストしていてもどこにも出ない", () => {
  const visibleChild = frame("d:3", "Visible", { w: 390, h: 844 });
  const hiddenInner = section("d:2", "Hidden inner", {
    w: 1000,
    h: 1000,
    hidden: true,
    children: [visibleChild],
  });
  const outer = section("d:1", "Outer", { w: 3000, h: 3000, children: [hiddenInner] });
  const hiddenTop = section("d:4", "Hidden top", {
    w: 1000,
    h: 1000,
    y: 4000,
    hidden: true,
    children: [frame("d:5", "Visible too", { w: 390, h: 844 })],
  });
  const p = page([outer, hiddenTop]);

  const plan = planOf(p.children);
  assert.deepEqual(ids(allSections(plan)), ["d:1"]);
  assert.deepEqual(allFrames(plan), []);
  assert.deepEqual(plan.sections[0].others, []);
  assert.deepEqual(ids(plan.hiddenRoots), ["d:4"]);
});

test("emptyMessage: 出すものがあれば null、無ければ非表示の有無と選択の有無で出し分ける", () => {
  const shown = frame("e:1", "Shown", { w: 390, h: 844 });
  const hidden = frame("e:2", "Hidden", { w: 390, h: 844, hidden: true });
  page([shown, hidden]);

  assert.equal(emptyMessage(planOf([shown, hidden]), true), null);
  assert.equal(emptyMessage(planOf([hidden]), true), "選択したノードはすべて非表示です");
  assert.equal(emptyMessage(planOf([hidden]), false), "ページ直下のノードはすべて非表示です");
  assert.equal(
    emptyMessage(planOf([]), false),
    "対象がありません (何かを選択するか、空でないページで実行してください)"
  );
  const emptySection = section("e:3", "Empty", { w: 100, h: 100 });
  page([emptySection]);
  assert.equal(emptyMessage(planOf([emptySection]), true), null);
});

test("longPaths: 上限を超えるセクション・画面フレーム・_section.json のパスを文字数付きで返す", () => {
  const longName = "あ".repeat(40);
  const deep = section("f:3", longName, {
    w: 1000,
    h: 1000,
    children: [
      frame("f:4", longName, { w: 390, h: 844 }),
      node("TEXT", "f:5", "memo", { w: 10, h: 10 }),
    ],
  });
  const mid = section("f:2", longName, { w: 2000, h: 2000, children: [deep] });
  const top = section("f:1", longName, { w: 3000, h: 3000, children: [mid] });
  const short = frame("f:6", "Short", { w: 390, h: 844, y: 5000 });
  const p = page([top, short]);
  const plan = planOf(p.children);

  const dirOf = (depth: number) =>
    Array.from({ length: depth }, (_, i) => `${longName}.f-${i + 1}`).join("/");
  const sectionDir = dirOf(3);
  const framePng = `${sectionDir}/${longName}.f-4.png`;
  const frameJson = `${sectionDir}/${longName}.f-4.json`;
  const sectionJson = `${sectionDir}/_section.json`;
  const entry = (path: string) => ({ path, length: Array.from(path).length });

  assert.equal(Array.from(dirOf(2)).length <= 130, true);
  assert.deepEqual(longPaths(plan, 130), [
    entry(sectionDir),
    entry(framePng),
    entry(frameJson),
    entry(sectionJson),
  ]);
  assert.deepEqual(longPaths(plan, 1000), []);
  assert.equal(MAX_ZIP_PATH_CHARS, 200);
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test("recordScreenshot: 成功は entry と writtenPngs、失敗と空の PNG は warning だけ", () => {
  const out = newExportOutput(["既存"]);
  const ok = { id: "1:1", name: "Home", png: "Home.1-1.png" };
  const failed = { id: "1:2", name: "Broken", png: "Broken.1-2.png" };
  const empty = { id: "1:3", name: "Empty", png: "Empty.1-3.png" };

  recordScreenshot(out, ok, { ok: true, bytes: PNG_BYTES });
  recordScreenshot(out, failed, { ok: false, error: new Error("render failed") });
  recordScreenshot(out, empty, { ok: true, bytes: new Uint8Array(0) });

  assert.deepEqual(out.entries.map((e) => e.name), ["Home.1-1.png"]);
  assert.deepEqual([...out.writtenPngs], ["Home.1-1.png"]);
  assert.deepEqual(out.warnings, [
    "既存",
    "スクリーンショット失敗: Broken (1:2): render failed",
    "スクリーンショット失敗: Empty (1:3): 空の PNG",
  ]);
});

test("recordAsset: 成功は assets 対応表に入り、失敗と画像なしはキーが無く warning に残る", () => {
  const out = newExportOutput();
  recordAsset(out, "aa11", { ok: true, bytes: PNG_BYTES });
  recordAsset(out, "bb22", { ok: false, error: "network" });
  recordAsset(out, "cc33", null);
  recordAsset(out, "dd44", { ok: true, bytes: new Uint8Array(0) });

  assert.deepEqual(out.entries.map((e) => e.name), ["assets/aa11.png"]);
  assert.deepEqual(Object.fromEntries(out.writtenAssets), { aa11: "assets/aa11.png" });
  assert.deepEqual(out.warnings, [
    "画像の取得に失敗: imageRef bb22: network",
    "画像が見つかりません: imageRef cc33",
    "画像の取得に失敗: imageRef dd44: 空のデータ",
  ]);

  const shown = frame("g:1", "Shown", { w: 390, h: 844 });
  page([shown]);
  const index = buildIndex(
    planOf([shown]),
    { fileName: "f", pluginVersion: "0", exportedAt: "t", scope: "s", screenshotScale: 2, warnings: out.warnings },
    out.writtenPngs,
    out.writtenAssets,
    new Map()
  );
  assert.deepEqual(index.assets, { aa11: "assets/aa11.png" });
});

test("スクリーンショットの倍率はメニューのコマンドで決まり、既定は 2x", () => {
  assert.equal(screenshotScaleFor("export-1x"), 1);
  assert.equal(screenshotScaleFor("export-2x"), 2);
  assert.equal(screenshotScaleFor(""), 2);
});

test("manifest のメニューのコマンドは、倍率の対応表と同じ集合", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/structure-dump/manifest.json"), "utf8")
  ) as { menu?: { command: string }[] };
  assert.deepEqual(
    (manifest.menu ?? []).map((m) => m.command).sort(),
    Object.keys(SCREENSHOT_SCALE_BY_COMMAND).sort()
  );
});
