/**
 * structure-dump serializer の検査
 *
 * 実行: npm test
 * Figma API 非依存の純関数なので、素のオブジェクトでツリーを組んで
 * 「残すべき情報が残り、デフォルト値と非表示ノードが落ちる」ことを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as serializeDist from "../plugins/structure-dump/dist/serialize.mjs";
import type {
  DumpNode,
  ParentLayout,
  SerializeContext,
} from "../plugins/structure-dump/src/serialize.ts";

/**
 * DumpNode の追加フィールドは Record<string, unknown>(serializer は形を固定しない)。
 * この検査が入れ子を辿るフィールドにだけ形を与える。
 * 省略可にしないのは、無ければ検査が落ちるべき前提だから。
 */
type Dumped = DumpNode & {
  children: Dumped[];
  textSegments: Record<string, unknown>[];
  extractionError: string;
};

const { serializeNode } = serializeDist as unknown as {
  serializeNode: (
    input: unknown,
    ctx: SerializeContext,
    parentLayout?: ParentLayout
  ) => Promise<Dumped>;
};

const MIXED = Symbol("mixed");

function makeCtx(): { ctx: SerializeContext; images: string[]; warnings: string[] } {
  const images: string[] = [];
  const warnings: string[] = [];
  const known: Record<string, string> = { "VariableID:1:2": "color/primary" };
  return {
    ctx: {
      mixed: MIXED,
      resolveVariableName: (id) => known[id] ?? `<unresolved:${id}>`,
      registerImage: (hash) => {
        images.push(hash);
      },
      warn: (message) => {
        warnings.push(message);
      },
    },
    images,
    warnings,
  };
}

const solid = (r: number, g: number, b: number) => ({
  type: "SOLID",
  color: { r, g, b },
});

test("auto layout・padding・色 hex 化・variables を残す", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "1:1",
      name: "Card",
      type: "FRAME",
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24,
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
      width: 320.004, height: 200,
      cornerRadius: 12,
      fills: [solid(1, 0.5, 0)],
      boundVariables: { fills: [{ id: "VariableID:1:2" }] },
    },
    ctx
  );

  assert.equal(out.layoutMode, "VERTICAL");
  assert.equal(out.itemSpacing, 8);
  assert.deepEqual(out.padding, [16, 24, 16, 24]);
  assert.equal(out.primaryAxisAlignItems, undefined, "デフォルト MIN が省かれていない");
  assert.equal(out.counterAxisAlignItems, "CENTER");
  assert.equal(out.layoutSizingHorizontal, "FIXED");
  assert.equal(out.width, 320);
  assert.equal(out.cornerRadius, 12);
  assert.deepEqual(out.fills, [{ type: "SOLID", color: "#ff8000" }]);
  assert.deepEqual(out.variables, { fills: ["color/primary"] });
  assert.equal(out.opacity, undefined, "デフォルト opacity=1 が省かれていない");
});

test("非表示の子は出力されず、auto layout の子は x/y を持たない", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "1:1", name: "Row", type: "FRAME",
      layoutMode: "HORIZONTAL",
      children: [
        { id: "1:2", name: "hidden", type: "RECTANGLE", visible: false, width: 10, height: 10 },
        { id: "1:3", name: "shown", type: "RECTANGLE", width: 10, height: 10, x: 5, y: 5 },
      ],
    },
    ctx
  );
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].id, "1:3");
  assert.equal(out.children[0].x, undefined, "auto layout の子に x が出ている");
});

test("auto layout なしの親の子と ABSOLUTE 配置の子は x/y を持つ", async () => {
  const { ctx } = makeCtx();
  const plain = await serializeNode(
    {
      id: "2:1", name: "Canvas", type: "FRAME",
      children: [{ id: "2:2", name: "box", type: "RECTANGLE", width: 10, height: 10, x: 12.345, y: 7 }],
    },
    ctx
  );
  assert.equal(plain.children[0].x, 12.35);
  assert.equal(plain.children[0].y, 7);

  const abs = await serializeNode(
    {
      id: "3:1", name: "Stack", type: "FRAME",
      layoutMode: "VERTICAL",
      children: [{
        id: "3:2", name: "badge", type: "FRAME",
        layoutPositioning: "ABSOLUTE", width: 10, height: 10, x: 300, y: 0,
      }],
    },
    ctx
  );
  assert.equal(abs.children[0].x, 300);
  assert.equal(abs.children[0].layoutPositioning, "ABSOLUTE");
});

test("インスタンスは componentName / variant props を持ち、プロパティキーの #id を落とす", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "4:1", name: "Button", type: "INSTANCE",
      getMainComponentAsync: async () => ({
        id: "c:1", name: "Variant=Primary", type: "COMPONENT",
        parent: { id: "cs:1", name: "Button", type: "COMPONENT_SET" },
      }),
      componentProperties: {
        Variant: { type: "VARIANT", value: "Primary" },
        "Label#12:34": { type: "TEXT", value: "送信" },
        "Disabled#56:78": { type: "BOOLEAN", value: false },
      },
    },
    ctx
  );
  assert.equal(out.componentName, "Variant=Primary");
  assert.equal(out.componentSetName, "Button");
  assert.deepEqual(out.props, { Variant: "Primary", Label: "送信", Disabled: false });
});

test("テキストは書式を持ち、mixed 書式は segment に展開される", async () => {
  const { ctx } = makeCtx();
  const uniform = await serializeNode(
    {
      id: "5:1", name: "title", type: "TEXT",
      characters: "見出し",
      fontSize: 24,
      fontName: { family: "Noto Sans JP", style: "Bold" },
      fontWeight: 700,
      textAlignHorizontal: "CENTER",
      lineHeight: { unit: "PERCENT", value: 150 },
      letterSpacing: { unit: "PIXELS", value: 0 },
      fills: [solid(0, 0, 0)],
    },
    ctx
  );
  assert.equal(uniform.characters, "見出し");
  assert.equal(uniform.fontSize, 24);
  assert.equal(uniform.fontFamily, "Noto Sans JP");
  assert.equal(uniform.fontWeight, 700);
  assert.equal(uniform.textAlignHorizontal, "CENTER");
  assert.equal(uniform.lineHeight, "150%");
  assert.equal(uniform.letterSpacing, undefined, "letterSpacing 0 が省かれていない");

  const mixed = await serializeNode(
    {
      id: "5:2", name: "rich", type: "TEXT",
      characters: "通常太字",
      fontSize: MIXED,
      fontName: MIXED,
      fontWeight: MIXED,
      fills: MIXED,
      getStyledTextSegments: (fields: string[]) => {
        assert.ok(fields.includes("fontSize"));
        return [
          { characters: "通常", fontSize: 14, fontName: { family: "Noto Sans JP", style: "Regular" }, fontWeight: 400, fills: [solid(0, 0, 0)] },
          { characters: "太字", fontSize: 14, fontName: { family: "Noto Sans JP", style: "Bold" }, fontWeight: 700, fills: [solid(1, 0, 0)] },
        ];
      },
    },
    ctx
  );
  assert.equal(mixed.fills, "mixed");
  assert.equal(mixed.textSegments.length, 2);
  assert.equal(mixed.textSegments[1].fontWeight, 700);
  assert.deepEqual(mixed.textSegments[1].fills, [{ type: "SOLID", color: "#ff0000" }]);
});

test("image fill は imageRef を残して hash を収集し、非表示 paint は落ちる", async () => {
  const { ctx, images } = makeCtx();
  const out = await serializeNode(
    {
      id: "6:1", name: "hero", type: "RECTANGLE",
      width: 100, height: 100,
      fills: [
        { type: "IMAGE", scaleMode: "FILL", imageHash: "abc123" },
        { type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: false },
      ],
    },
    ctx
  );
  assert.deepEqual(out.fills, [{ type: "IMAGE", scaleMode: "FILL", imageRef: "abc123" }]);
  assert.deepEqual(images, ["abc123"]);
});

test("effects と mixed cornerRadius が正規化される", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "7:1", name: "elevated", type: "FRAME",
      cornerRadius: MIXED,
      topLeftRadius: 8, topRightRadius: 8, bottomRightRadius: 0, bottomLeftRadius: 0,
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 2 },
          radius: 4,
          spread: 0,
          visible: true,
        },
        { type: "LAYER_BLUR", radius: 10, visible: false },
      ],
    },
    ctx
  );
  assert.deepEqual(out.cornerRadius, [8, 8, 0, 0]);
  assert.deepEqual(out.effects, [
    { type: "DROP_SHADOW", color: "#000000", alpha: 0.25, offset: { x: 0, y: 2 }, radius: 4 },
  ]);
});

test("壊れたComponentSet(variantProperties が例外)でも中止せず extractionError を記録する", async () => {
  const { ctx, warnings } = makeCtx();
  const brokenComponent = {
    id: "8:1",
    name: "Density=Compact, State=Default",
    type: "COMPONENT",
    parent: { id: "8:0", name: "Input type=text", type: "COMPONENT_SET" },
  };
  Object.defineProperty(brokenComponent, "variantProperties", {
    get() {
      throw new Error("in get_variantProperties: Component set for node has existing errors");
    },
  });
  const out = await serializeNode(brokenComponent, ctx);
  assert.equal(out.componentSetName, "Input type=text");
  assert.match(out.extractionError, /existing errors/);
  assert.equal(out.props, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Density=Compact, State=Default \(8:1\).*existing errors/);
});

test("壊れたComponentSet参照のINSTANCE(componentProperties が例外)でも中止せず記録する", async () => {
  const { ctx, warnings } = makeCtx();
  const brokenInstance = {
    id: "8:2",
    name: "Input type=text",
    type: "INSTANCE",
  };
  Object.defineProperty(brokenInstance, "componentProperties", {
    get() {
      throw new Error("in get_componentProperties: Component set for node has existing errors");
    },
  });
  const out = await serializeNode(brokenInstance, ctx);
  assert.match(out.extractionError, /existing errors/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Input type=text \(8:2\).*existing errors/);
});

test("INSTANCE の main component 取得が失敗しても中止せず warning に残す", async () => {
  const { ctx, warnings } = makeCtx();
  const remoteInstance = {
    id: "8:3",
    name: "Remote button",
    type: "INSTANCE",
    getMainComponentAsync: async () => {
      throw new Error("library not available");
    },
  };
  const out = await serializeNode(remoteInstance, ctx);
  assert.equal(out.componentName, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Remote button \(8:3\).*library not available/);
});
