/**
 * structure-dump 書き出し計画 (dump-v2) の検査
 *
 * 実行: npm test
 * Figma API 非依存の純関数なので、素のオブジェクトでページを組んで
 * 画面フレームの判定・ZIP 内パス・index.json の形を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
  planDump,
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
  absoluteBoundingBox: { x: number; y: number } | null;
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
  /** absoluteBoundingBox を null にして absoluteTransform からの取得を通す */
  noBoundingBox?: boolean;
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
    absoluteBoundingBox: spec.noBoundingBox ? null : { x: 0, y: 0 },
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

/** 親を辿って絶対座標を埋める (bounding box と transform の両方) */
function page(children: TestNode[]): TestNode {
  const root = node("PAGE", "0:1", "Page 1", { w: 0, h: 0, children });
  const place = (n: TestNode, ox: number, oy: number): void => {
    const ax = ox + n.x;
    const ay = oy + n.y;
    if (n.absoluteBoundingBox) n.absoluteBoundingBox = { x: ax, y: ay };
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

test("画面フレームのしきい値: 380x700 は画面、379x700 と 380x699 は _section.json 側", () => {
  const p = page([
    section("1:1", "Flow", {
      w: 2000,
      h: 1000,
      children: [
        frame("2:1", "Exact", { w: 380, h: 700 }),
        frame("2:2", "Narrow", { w: 379, h: 700, x: 400 }),
        frame("2:3", "Short", { w: 380, h: 699, x: 800 }),
        frame("2:4", "Big", { w: 1440, h: 1024, x: 1200 }),
      ],
    }),
  ]);
  const plan = planOf(p.children);
  const s = plan.sections[0];
  assert.deepEqual(ids(s.frames), ["2:1", "2:4"]);
  assert.deepEqual(ids(s.others), ["2:2", "2:3"]);
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
            frame("10:4", "note", { w: 200, h: 100, x: 500, y: 20 }),
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

test("セクション外の選択はサイズに関係なく ZIP 直下の画面フレーム・document 順・非表示は除く", () => {
  const small = frame("5:1", "Icon", { w: 24, h: 24 });
  const big = frame("5:2", "Screen", { w: 390, h: 844, x: 100 });
  const hidden = frame("5:3", "Hidden", { w: 390, h: 844, x: 600, hidden: true });
  page([small, big, hidden]);

  const plan = planOf([big, hidden, small]);
  assert.deepEqual(ids(plan.frames), ["5:1", "5:2"]);
  assert.equal(plan.frames[0].png, "Icon.5-1.png");
  assert.equal(plan.frames[0].section, null);
});

test("同名フレームは id で区別され、ZIP 内パスが衝突しない", () => {
  const p = page([
    section("1:1", "Flow", {
      w: 4000,
      h: 1000,
      children: [
        frame("2:1", "Home", { w: 390, h: 844 }),
        frame("2:2", "Home", { w: 390, h: 844, x: 400 }),
        frame("2:3", "Home", { w: 10, h: 10, x: 800 }),
        section("2:4", "Flow", { w: 1000, h: 1000, x: 900 }),
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
      "Flow.1-2/Home.3-1.png",
      "Home.1-3.png",
    ]
  );
  assert.deepEqual(
    allSections(plan).map((s) => s.dir),
    ["Flow.1-1", "Flow.1-1/Flow.2-4", "Flow.1-2"]
  );
});

test("absoluteBoundingBox が null なら absoluteTransform から絶対座標を取る", () => {
  const p = page([frame("6:1", "Rotated", { w: 390, h: 844, x: 12.345, y: 7, noBoundingBox: true })]);
  const f = planOf(p.children).frames[0];
  assert.deepEqual([f.absoluteX, f.absoluteY], [12.35, 7]);
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
        frame("2:3", "memo", { w: 200, h: 100, x: 10, y: 900 }),
        section("2:4", "Sub", {
          w: 500,
          h: 900,
          x: 1000,
          y: 0,
          children: [frame("3:1", "Modal", { w: 400, h: 700, x: 5, y: 5 })],
        }),
      ],
    }),
    frame("1:2", "Loose", { w: 100, h: 100, x: 3000, y: 0 }),
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
    warnings: ["スクリーンショット失敗: Broken (2:2): x"],
  };

  assert.deepEqual(buildIndex(plan, meta, written), {
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
