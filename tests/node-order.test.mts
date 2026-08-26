/**
 * 負例: 走査対象の順序が入力順に依存する経路(レビューR08)
 *
 * 実行: npm test
 * figma.currentPage.selection の順序は Figma 公式で未規定なので、
 * 同じノード集合をどの順で渡しても document 位置で同じ順序になることを検査する。
 * 修正前の実装相当(入力順そのまま)ならこの検査が落ちることも、ここで示す。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 検証用documentのノード(OrderableNode を組み立てられるよう可変にした形) */
interface TestNode {
  id: string;
  children: TestNode[];
  parent: TestNode | null;
}

interface TestDocument {
  document: TestNode;
  byId: Map<string, TestNode>;
  get: (id: string) => TestNode;
}

/** src の純関数をFigma環境なしで読む(バンドルしてESMとしてimport) */
async function importSrc(relPath: string): Promise<unknown> {
  const built = buildSync({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2020",
  });
  const code = built.outputFiles[0].text;
  return import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );
}

const { sortInDocumentOrder } = (await importSrc(
  "shared/nodeOrder.ts"
)) as typeof import("../shared/nodeOrder.ts");

/** 修正前の実装相当: 与えられた順序をそのまま使う */
const asGiven = (nodes: readonly TestNode[]) => [...nodes];

function makeNode(id: string, children: TestNode[] = []): TestNode {
  const node: TestNode = { id, children, parent: null };
  for (const child of children) child.parent = node;
  return node;
}

/**
 * 検証用document。sibling index の昇順とid文字列の昇順が一致しないようidを付ける
 * (id順で並べても通ってしまう恒真検査にしないため)。
 */
function makeDocument(): TestDocument {
  const deep = makeNode("2:0");
  const frameA = makeNode("9:9", [makeNode("8:0"), deep]);
  const frameB = makeNode("1:1", [makeNode("7:0")]);
  const page1 = makeNode("50:0", [frameA, frameB]);
  const page2 = makeNode("40:0", [makeNode("3:0")]);
  const document = makeNode("0:0", [page1, page2]);

  const byId = new Map<string, TestNode>();
  const walk = (node: TestNode): void => {
    byId.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  walk(document);
  return { document, byId, get: (id) => byId.get(id)! };
}

const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

const DOCUMENT_ORDER = ["9:9", "8:0", "2:0", "1:1", "7:0", "3:0"];

function selectionOf(doc: TestDocument, order: readonly string[]): TestNode[] {
  return order.map((id) => doc.get(id));
}

test("document位置で並ぶ(sibling index優先。id文字列順ではない)", () => {
  const doc = makeDocument();
  const shuffled = selectionOf(doc, ["7:0", "2:0", "3:0", "9:9", "1:1", "8:0"]);
  assert.deepEqual(ids(sortInDocumentOrder(shuffled)), DOCUMENT_ORDER);
});

test("負例: 入力順そのまま(修正前相当)では逆順入力が並び替わらない", () => {
  const doc = makeDocument();
  const reversed = selectionOf(doc, [...DOCUMENT_ORDER].reverse());
  assert.notDeepEqual(
    ids(asGiven(reversed)),
    DOCUMENT_ORDER,
    "この検査は入力順そのままでも通ってしまう(恒真)"
  );
  assert.deepEqual(ids(sortInDocumentOrder(reversed)), DOCUMENT_ORDER);
});

test("同じ集合をどの順で渡しても出力順が同じ", () => {
  const doc = makeDocument();
  const subset = ["3:0", "2:0", "1:1", "8:0"];
  const expected = DOCUMENT_ORDER.filter((id) => subset.includes(id));
  for (const order of permutations(subset)) {
    assert.deepEqual(
      ids(sortInDocumentOrder(selectionOf(doc, order))),
      expected,
      `入力順 ${order.join(",")} で出力順が変わった`
    );
  }
});

test("祖先が子孫より先に来る", () => {
  const doc = makeDocument();
  assert.deepEqual(ids(sortInDocumentOrder(selectionOf(doc, ["2:0", "9:9"]))), [
    "9:9",
    "2:0",
  ]);
});

test("document順で渡された子リストは並び替わらない", () => {
  const doc = makeDocument();
  const page1 = doc.get("50:0");
  assert.deepEqual(ids(sortInDocumentOrder(page1.children)), ["9:9", "1:1"]);
});

test("入力配列を破壊しない", () => {
  const doc = makeDocument();
  const input = selectionOf(doc, ["3:0", "9:9"]);
  const sorted = sortInDocumentOrder(input);
  assert.deepEqual(ids(input), ["3:0", "9:9"]);
  assert.notEqual(sorted, input);
});

test("位置が辿れないノードはnode IDで並び、辿れたノードより後に来る", () => {
  const doc = makeDocument();
  const orphanParent = makeNode("99:0");
  // 親から辿り返せない = 親子関係が取れない状態
  const orphanA: TestNode = { id: "10:0", children: [], parent: orphanParent };
  const orphanB: TestNode = { id: "2:9", children: [], parent: orphanParent };
  const placed = doc.get("1:1");

  const sorted = sortInDocumentOrder([orphanA, placed, orphanB]);
  // id比較はlocaleでなくコードポイント順 ("10:0" < "2:9")
  assert.deepEqual(ids(sorted), ["1:1", "10:0", "2:9"]);
  assert.deepEqual(ids(sortInDocumentOrder([orphanB, orphanA, placed])), [
    "1:1",
    "10:0",
    "2:9",
  ]);
});

test("親子が循環していても停止し、決定的な順序を返す", () => {
  const a: TestNode = { id: "5:0", children: [], parent: null };
  const b: TestNode = { id: "4:0", children: [], parent: null };
  a.parent = b;
  b.parent = a;
  a.children = [b];
  b.children = [a];

  assert.deepEqual(ids(sortInDocumentOrder([a, b])), ["4:0", "5:0"]);
  assert.deepEqual(ids(sortInDocumentOrder([b, a])), ["4:0", "5:0"]);
});
