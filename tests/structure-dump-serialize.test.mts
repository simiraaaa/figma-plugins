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
  ResolvedVariable,
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

const { serializeNode, formatVariableValue, buildVariablesJson, serializeStyle, variableClosure } =
  serializeDist as unknown as Omit<
    typeof import("../plugins/structure-dump/src/serialize.ts"),
    "serializeNode"
  > & {
    serializeNode: (
      input: unknown,
      ctx: SerializeContext,
      parentLayout?: ParentLayout
    ) => Promise<Dumped>;
  };

const MIXED = Symbol("mixed");

interface FakeCtx {
  ctx: SerializeContext;
  images: string[];
  warnings: string[];
  svgs: string[];
}

function makeCtx(): FakeCtx {
  const images: string[] = [];
  const warnings: string[] = [];
  const svgs: string[] = [];
  const known: Record<string, ResolvedVariable> = {
    "VariableID:1:2": {
      name: "color/primary",
      resolved: { value: { r: 1, g: 0.5, b: 0, a: 1 }, resolvedType: "COLOR" },
    },
    "VariableID:1:3": { name: "spacing/4", resolved: { value: 16, resolvedType: "FLOAT" } },
  };
  const styles: Record<string, string> = {
    "S:text": "text small/leading-none/medium",
    "S:fill": "function/primary",
    "S:bold": "text small/bold",
  };
  return {
    ctx: {
      mixed: MIXED,
      resolveVariable: async (id, consumer) => {
        const variable = known[id];
        if (variable === undefined) return { name: `<unresolved:${id}>` };
        return consumer === undefined ? { name: variable.name } : variable;
      },
      styleName: async (id) => styles[id],
      modeName: async (collectionId, modeId) =>
        collectionId === "VariableCollectionId:1" && modeId === "2:1"
          ? { collection: "Theme", mode: "Dark" }
          : undefined,
      componentName: async (id) => (id === "c:icon" ? "icon/chevron" : undefined),
      exportSvg: async (node) => {
        const id = (node as { id: string }).id;
        svgs.push(id);
        return `assets/svg/${id}.svg`;
      },
      registerImage: (hash) => {
        images.push(hash);
      },
      warn: (message) => {
        warnings.push(message);
      },
    },
    images,
    warnings,
    svgs,
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
      fills: [{ ...solid(1, 0.5, 0), boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } }],
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
  assert.deepEqual(out.variables, { fills: [{ name: "color/primary", value: "#ff8000" }] });
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

// ---------------------------------------------------------------------------
// dump-v3 で足した項目
// ---------------------------------------------------------------------------

test("variables は名前とそのノードで効いている値を持ち、解決できない変数は名前だけ", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "10:1", name: "Button", type: "FRAME",
      layoutMode: "HORIZONTAL", itemSpacing: 16,
      boundVariables: {
        itemSpacing: { id: "VariableID:1:3" },
        fills: [{ id: "VariableID:1:2" }],
        paddingLeft: { id: "VariableID:9:9" },
      },
      fills: [{ ...solid(1, 0.5, 0), boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } }],
    },
    ctx
  );
  assert.deepEqual(out.variables, {
    itemSpacing: { name: "spacing/4", value: 16 },
    fills: [{ name: "color/primary", value: "#ff8000" }],
    paddingLeft: { name: "<unresolved:VariableID:9:9>" },
  });
});

test("formatVariableValue: 色は #rrggbb (半透明は #rrggbbaa)、数は小数 2 桁、ほかはそのまま", () => {
  assert.equal(formatVariableValue({ r: 0, g: 0, b: 1, a: 1 }, "COLOR"), "#0000ff");
  assert.equal(formatVariableValue({ r: 0, g: 0, b: 1, a: 0.5 }, "COLOR"), "#0000ff80");
  assert.equal(formatVariableValue(1.23456, "FLOAT"), 1.23);
  assert.equal(formatVariableValue("Inter", "STRING"), "Inter");
  assert.equal(formatVariableValue(true, "BOOLEAN"), true);
});

test("名前付きスタイルの名前を styles に出し、部分ごとに違うテキストのスタイルは segment に展開する", async () => {
  const { ctx } = makeCtx();
  const uniform = await serializeNode(
    {
      id: "11:1", name: "label", type: "TEXT", characters: "ボタン",
      fontSize: 14, fontName: { family: "Inter", style: "Medium" }, fontWeight: 500,
      textStyleId: "S:text", fillStyleId: "S:fill", strokeStyleId: "", effectStyleId: "S:missing",
    },
    ctx
  );
  assert.deepEqual(uniform.styles, {
    fill: "function/primary",
    text: "text small/leading-none/medium",
    effect: "<unresolved:S:missing>",
  });
  assert.equal(uniform.textSegments, undefined, "書式がそろっているのに segment に展開した");

  const mixed = await serializeNode(
    {
      id: "11:2", name: "rich", type: "TEXT", characters: "通常太字",
      fontSize: 14, fontName: { family: "Inter", style: "Medium" }, fontWeight: 500,
      textStyleId: MIXED,
      getStyledTextSegments: (fields: string[]) => {
        assert.ok(fields.includes("textStyleId"));
        return [
          { characters: "通常", textStyleId: "S:text", lineHeight: { unit: "PIXELS", value: 20 } },
          { characters: "太字", textStyleId: "S:bold", hyperlink: { type: "URL", value: "https://example.com" } },
        ];
      },
    },
    ctx
  );
  assert.deepEqual((mixed.styles as Record<string, string>).text, "mixed");
  assert.deepEqual(mixed.textSegments, [
    { text: "通常", lineHeight: "20px", textStyle: "text small/leading-none/medium" },
    {
      text: "太字",
      textStyle: "text small/bold",
      hyperlink: { type: "URL", value: "https://example.com" },
    },
  ]);
});

test("プロパティで出し入れする子は非表示でも visible: false で残し、propertyRefs で結び付きを出す", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "12:1", name: "Button", type: "INSTANCE",
      layoutMode: "HORIZONTAL",
      children: [
        {
          id: "12:2", name: "Left Icon", type: "INSTANCE", visible: false,
          componentPropertyReferences: { visible: "Show left icon#1:0", mainComponent: "Left icon#1:1" },
          width: 16, height: 16,
        },
        {
          id: "12:3", name: "label", type: "TEXT", characters: "ボタン",
          componentPropertyReferences: { visible: "Show label#2:0", characters: "Label text#2:1" },
        },
        { id: "12:4", name: "just hidden", type: "RECTANGLE", visible: false, width: 1, height: 1 },
        {
          id: "12:5", name: "no ref", type: "RECTANGLE", visible: false,
          componentPropertyReferences: null, width: 1, height: 1,
        },
      ],
    },
    ctx
  );
  assert.deepEqual(
    out.children.map((c) => c.id),
    ["12:2", "12:3"],
    "プロパティの結び付きが無い非表示の子は捨てる"
  );
  assert.equal(out.children[0].visible, false);
  assert.deepEqual(out.children[0].propertyRefs, {
    visible: "Show left icon",
    mainComponent: "Left icon",
  });
  assert.equal(out.children[1].visible, undefined, "表示している子に visible を付けた");
  assert.deepEqual(out.children[1].propertyRefs, {
    visible: "Show label",
    characters: "Label text",
  });
});

const definitions = {
  "Show left icon#1:0": { type: "BOOLEAN", defaultValue: false },
  "Label text#2:1": { type: "TEXT", defaultValue: "ボタン", description: "" },
  "Left icon#1:1": {
    type: "INSTANCE_SWAP",
    defaultValue: "c:icon",
    preferredValues: [{ type: "COMPONENT", key: "abc" }],
  },
  Size: { type: "VARIANT", defaultValue: "M", variantOptions: ["S", "M", "L"] },
};

const expectedDefinitions = {
  "Show left icon": { type: "BOOLEAN", default: false },
  "Label text": { type: "TEXT", default: "ボタン" },
  "Left icon": { type: "INSTANCE_SWAP", default: { id: "c:icon", name: "icon/chevron" } },
  Size: { type: "VARIANT", default: "M", options: ["S", "M", "L"] },
};

test("COMPONENT_SET はプロパティの定義 (種類・既定値・選択肢) を持ち、中のバリアントには写さない", async () => {
  const { ctx } = makeCtx();
  const set: Record<string, unknown> = {
    id: "13:0", name: "Button", type: "COMPONENT_SET",
    description: "押せるボタン",
    componentPropertyDefinitions: definitions,
  };
  const variant = {
    id: "13:1", name: "Size=M", type: "COMPONENT", parent: set,
    variantProperties: { Size: "M" },
  };
  set.children = [variant];
  const out = await serializeNode(set, ctx);
  assert.deepEqual(out.propertyDefinitions, expectedDefinitions);
  assert.equal(out.description, "押せるボタン");
  assert.equal(out.children[0].propertyDefinitions, undefined, "セットの中のバリアントに定義を写した");
});

test("バリアントを直接書き出したときは、セットの定義を写す。セットに属さない COMPONENT は自分の定義", async () => {
  const { ctx } = makeCtx();
  const set = { id: "14:0", name: "Button", type: "COMPONENT_SET", componentPropertyDefinitions: definitions };
  const variant = {
    id: "14:1", name: "Size=M", type: "COMPONENT", parent: set,
    variantProperties: { Size: "M" },
  };
  Object.defineProperty(variant, "componentPropertyDefinitions", {
    get() {
      throw new Error("Can only get definitions of a component set or non-variant component");
    },
  });
  const out = await serializeNode(variant, ctx);
  assert.deepEqual(out.propertyDefinitions, expectedDefinitions);

  const single = await serializeNode(
    {
      id: "14:2", name: "Badge", type: "COMPONENT", parent: { id: "0:1", name: "Page", type: "PAGE" },
      componentPropertyDefinitions: { "Count#3:0": { type: "TEXT", defaultValue: "1" } },
    },
    ctx
  );
  assert.deepEqual(single.propertyDefinitions, { Count: { type: "TEXT", default: "1" } });
});

test("componentPropertyDefinitions が例外でも中止せず、extractionError と warning に残す", async () => {
  const { ctx, warnings } = makeCtx();
  const set = { id: "15:0", name: "Broken", type: "COMPONENT_SET" };
  Object.defineProperty(set, "componentPropertyDefinitions", {
    get() {
      throw new Error("Component set for node has existing errors");
    },
  });
  const out = await serializeNode(set, ctx);
  assert.match(out.extractionError, /existing errors/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Broken \(15:0\).*existing errors/);
});

const vector = (id: string, type = "VECTOR") => ({ id, name: id, type, width: 16, height: 16 });

test("ベクターだけの部分木は、いちばん上のノードだけを SVG で書き出す", async () => {
  const { ctx, svgs } = makeCtx();
  const out = await serializeNode(
    {
      id: "16:1", name: "Button", type: "FRAME",
      layoutMode: "HORIZONTAL",
      children: [
        {
          id: "16:2", name: "Icon", type: "INSTANCE",
          children: [{ id: "16:3", name: "Group", type: "GROUP", children: [vector("16:4"), vector("16:5", "ELLIPSE")] }],
        },
        { id: "16:6", name: "label", type: "TEXT", characters: "ボタン" },
        { id: "16:7", name: "Box", type: "FRAME", children: [vector("16:8", "RECTANGLE")] },
        {
          id: "16:9", name: "Hidden icon", type: "INSTANCE", visible: false,
          componentPropertyReferences: { visible: "Show icon#1:0" },
          children: [vector("16:10")],
        },
        { id: "16:11", name: "Photo", type: "RECTANGLE", fills: [{ type: "IMAGE", imageHash: "h1" }] },
      ],
    },
    ctx
  );
  assert.deepEqual(svgs, ["16:2", "16:9"], "SVG にするノードが違う");
  assert.equal(out.svg, undefined, "テキストを含む親を SVG にした");
  assert.equal(out.children[0].svg, "assets/svg/16:2.svg");
  assert.equal(out.children[0].children[0].svg, undefined, "SVG にしたノードの子孫まで SVG にした");
  assert.equal(out.children[2].svg, undefined, "長方形だけの枠を SVG にした");
});

test("書き出したノード自身がベクターだけなら、そのノードを SVG にする", async () => {
  const { ctx, svgs } = makeCtx();
  const out = await serializeNode(
    { id: "17:1", name: "icon/chevron", type: "COMPONENT", children: [vector("17:2")] },
    ctx
  );
  assert.deepEqual(svgs, ["17:1"]);
  assert.equal(out.svg, "assets/svg/17:1.svg");
});

test("SVG の書き出しに失敗したノードには svg キーを作らない", async () => {
  const { ctx } = makeCtx();
  const failing: SerializeContext = { ...ctx, exportSvg: async () => undefined };
  const out = await serializeNode(vector("18:1"), failing);
  assert.equal("svg" in out, false);
});

test("MCP にあって dump-v2 に無かった見た目と配置の項目を出す", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "19:1", name: "Card", type: "FRAME",
      width: 300, height: 200, minHeight: 100, maxHeight: 400,
      clipsContent: true, overflowDirection: "VERTICAL", blendMode: "MULTIPLY",
      strokes: [solid(0, 0, 0)], strokeWeight: MIXED,
      strokeTopWeight: 1, strokeRightWeight: 0, strokeBottomWeight: 2, strokeLeftWeight: 0,
      explicitVariableModes: { "VariableCollectionId:1": "2:1" },
      annotations: [{ label: "タップで詳細へ", properties: [{ type: "fills" }] }],
      children: [
        {
          id: "19:2", name: "badge", type: "FRAME", width: 10, height: 10, x: 280, y: 0,
          constraints: { horizontal: "MAX", vertical: "MIN" }, isMask: true,
        },
        {
          id: "19:3", name: "body", type: "TEXT", characters: "長い本文",
          x: 0, y: 20, constraints: { horizontal: "MIN", vertical: "MIN" },
          paragraphSpacing: 8, textTruncation: "ENDING", maxLines: 2,
          hyperlink: { type: "NODE", value: "1:2" },
        },
      ],
    },
    ctx
  );
  assert.equal(out.minHeight, 100);
  assert.equal(out.maxHeight, 400);
  assert.equal(out.clipsContent, true);
  assert.equal(out.overflowDirection, "VERTICAL");
  assert.equal(out.blendMode, "MULTIPLY");
  assert.deepEqual(out.strokeWeights, [1, 0, 2, 0]);
  assert.equal(out.strokeWeight, undefined);
  assert.deepEqual(out.variableModes, { Theme: "Dark" });
  assert.deepEqual(out.annotations, [{ label: "タップで詳細へ", properties: ["fills"] }]);
  assert.deepEqual(out.children[0].constraints, { horizontal: "MAX", vertical: "MIN" });
  assert.equal(out.children[0].isMask, true);
  assert.equal(out.children[1].constraints, undefined, "既定の制約 (MIN, MIN) を出した");
  assert.equal(out.children[1].paragraphSpacing, 8);
  assert.equal(out.children[1].textTruncation, "ENDING");
  assert.equal(out.children[1].maxLines, 2);
  assert.deepEqual(out.children[1].hyperlink, { type: "NODE", value: "1:2" });
});

test("variables.json: コレクションごとにモード名 → 値で並べ、参照は alias の名前にする", () => {
  const json = buildVariablesJson(
    [
      {
        id: "C:1", name: "Theme", remote: false,
        modes: [{ modeId: "m:1", name: "Light" }, { modeId: "m:2", name: "Dark" }],
        defaultModeId: "m:1",
      },
      { id: "C:2", name: "Library", remote: true, modes: [{ modeId: "m:3", name: "Default" }], defaultModeId: "m:3" },
    ],
    [
      {
        id: "V:1", name: "function/primary", variableCollectionId: "C:1", resolvedType: "COLOR",
        valuesByMode: { "m:1": { r: 0, g: 0, b: 1, a: 1 }, "m:2": { type: "VARIABLE_ALIAS", id: "V:9" } },
        description: "主要な色", scopes: ["ALL_FILLS"], codeSyntax: { WEB: "--primary" },
      },
      {
        id: "V:2", name: "spacing/4", variableCollectionId: "C:2", resolvedType: "FLOAT",
        valuesByMode: { "m:3": 16 }, description: "", scopes: [], codeSyntax: {},
      },
    ],
    (id) => (id === "V:9" ? "blue/400" : undefined)
  );
  assert.deepEqual(json, {
    collections: [
      {
        id: "C:1", name: "Theme", modes: ["Light", "Dark"], defaultMode: "Light",
        variables: [
          {
            id: "V:1", name: "function/primary", type: "COLOR",
            values: { Light: "#0000ff", Dark: { alias: "blue/400" } },
            description: "主要な色", scopes: ["ALL_FILLS"], codeSyntax: { WEB: "--primary" },
          },
        ],
      },
      {
        id: "C:2", name: "Library", remote: true, modes: ["Default"], defaultMode: "Default",
        variables: [{ id: "V:2", name: "spacing/4", type: "FLOAT", values: { Default: 16 } }],
      },
    ],
  });
});

test("styles.json の 1 件: テキストスタイルは書式と束縛した変数の名前 (値は持たない) を出す", async () => {
  const { ctx } = makeCtx();
  const text = await serializeStyle(
    {
      id: "S:text", name: "text small/leading-none/medium", type: "TEXT", remote: true,
      description: "",
      fontName: { family: "Inter", style: "Medium" }, fontSize: 14,
      lineHeight: { unit: "PERCENT", value: 100 }, letterSpacing: { unit: "PIXELS", value: 0 },
      textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 0, paragraphIndent: 0,
      boundVariables: { fontSize: { id: "VariableID:1:3" } },
    },
    ctx
  );
  assert.deepEqual(text, {
    id: "S:text", name: "text small/leading-none/medium", type: "TEXT", remote: true,
    fontFamily: "Inter", fontStyle: "Medium", fontSize: 14, lineHeight: "100%",
    variables: { fontSize: { name: "spacing/4" } },
  });

  const paint = await serializeStyle(
    { id: "S:fill", name: "function/primary", type: "PAINT", description: "主要", paints: [solid(0, 0, 1)] },
    ctx
  );
  assert.deepEqual(paint, {
    id: "S:fill", name: "function/primary", type: "PAINT", description: "主要",
    paints: [{ type: "SOLID", color: "#0000ff" }],
  });
});

// ---------------------------------------------------------------------------
// レビュー 1 巡目への対応
// ---------------------------------------------------------------------------

test("fills / strokes の変数は出力の paint と同じ並びで、非表示の paint を飛ばし、束縛の無い paint は null", async () => {
  const { ctx } = makeCtx();
  const bound = (id: string) => ({ color: { type: "VARIABLE_ALIAS", id } });
  const out = await serializeNode(
    {
      id: "20:1", name: "Box", type: "FRAME",
      fills: [
        { ...solid(1, 0, 0), visible: false, boundVariables: bound("VariableID:1:3") },
        { ...solid(1, 0.5, 0), boundVariables: bound("VariableID:1:2") },
        solid(0, 0, 0),
      ],
      strokes: [solid(0, 0, 0)],
      // node 側の配列は paint の並びと揃っていない (非表示の paint の束縛も入っている)
      boundVariables: { fills: [{ id: "VariableID:1:3" }, { id: "VariableID:1:2" }] },
    },
    ctx
  );
  assert.equal((out.fills as unknown[]).length, 2);
  assert.deepEqual(out.variables, {
    fills: [{ name: "color/primary", value: "#ff8000" }, null],
  });
});

test("コンポーネントのプロパティに束縛した変数を、プロパティの表示名ごとに出す", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "21:1", name: "Button", type: "INSTANCE",
      boundVariables: { componentProperties: { "Label#1:2": { type: "VARIABLE_ALIAS", id: "VariableID:1:3" } } },
    },
    ctx
  );
  assert.deepEqual(out.variables, { componentProperties: { Label: { name: "spacing/4", value: 16 } } });
});

test("文字の範囲ごとに違う変数を束縛したテキストは、textSegments に範囲ごとの variables を出す", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "22:1", name: "rich", type: "TEXT", characters: "大小",
      fontSize: 14, fontName: { family: "Inter", style: "Medium" }, fontWeight: 500,
      boundVariables: { fontSize: [{ id: "VariableID:1:3" }, { id: "VariableID:9:9" }] },
      getStyledTextSegments: (fields: string[]) => {
        assert.ok(fields.includes("boundVariables"));
        return [
          { characters: "大", boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "VariableID:1:3" } } },
          { characters: "小" },
        ];
      },
    },
    ctx
  );
  assert.deepEqual(out.textSegments, [
    { text: "大", variables: { fontSize: { name: "spacing/4", value: 16 } } },
    { text: "小" },
  ]);
});

test("書き出したノードで効いているモードを、コレクション名 → モード名で出す (ルートだけ)", async () => {
  const { ctx } = makeCtx();
  const out = await serializeNode(
    {
      id: "23:1", name: "Screen", type: "FRAME",
      resolvedVariableModes: { "VariableCollectionId:1": "2:1" },
      children: [
        { id: "23:2", name: "child", type: "FRAME", resolvedVariableModes: { "VariableCollectionId:1": "2:1" } },
      ],
    },
    ctx
  );
  assert.deepEqual(out.resolvedVariableModes, { Theme: "Dark" });
  assert.equal(out.children[0].resolvedVariableModes, undefined);
});

test("塗りや枠線を持つ箱 (アイコンボタン) は SVG にせず、中のアイコンを SVG にする", async () => {
  const { ctx, svgs } = makeCtx();
  await serializeNode(
    {
      id: "24:1", name: "IconButton", type: "FRAME", fills: [solid(0, 0, 1)],
      children: [{ id: "24:2", name: "Icon", type: "INSTANCE", children: [vector("24:3")] }],
    },
    ctx
  );
  assert.deepEqual(svgs, ["24:2"]);
});

test("非表示の祖先の中のアイコンは、非表示として書き出しを頼む。INSTANCE 以外の非表示の図形は頼まずに警告する", async () => {
  const { ctx, warnings } = makeCtx();
  const requested: { id: string; hidden: boolean }[] = [];
  const recording: SerializeContext = {
    ...ctx,
    exportSvg: async (node, hidden) => {
      requested.push({ id: (node as { id: string }).id, hidden });
      return `assets/svg/${(node as { id: string }).id}.svg`;
    },
  };
  const out = await serializeNode(
    {
      id: "25:1", name: "Card", type: "FRAME", layoutMode: "HORIZONTAL",
      children: [
        { id: "25:2", name: "label", type: "TEXT", characters: "x" },
        {
          id: "25:3", name: "Slot", type: "FRAME", visible: false,
          componentPropertyReferences: { visible: "Show slot#1:0" },
          children: [
            { id: "25:4", name: "Icon", type: "INSTANCE", children: [vector("25:5")] },
            { ...vector("25:6"), name: "Line" },
          ],
        },
      ],
    },
    recording
  );
  assert.deepEqual(requested, [{ id: "25:4", hidden: true }]);
  assert.equal(out.children[1].children[0].svg, "assets/svg/25:4.svg");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /非表示のため SVG を書き出せない: Line \(25:6\)/);
});

test("variableClosure: alias の参照先を辿って全部集め、引けなかった id を返す", async () => {
  const table: Record<string, { id: string; valuesByMode: Record<string, unknown> }> = {
    A: { id: "A", valuesByMode: { m: { type: "VARIABLE_ALIAS", id: "B" } } },
    B: { id: "B", valuesByMode: { m: { type: "VARIABLE_ALIAS", id: "C" }, n: { type: "VARIABLE_ALIAS", id: "X" } } },
    C: { id: "C", valuesByMode: { m: 1 } },
  };
  const closure = await variableClosure(["A", "C"], async (id) => table[id] ?? null);
  assert.deepEqual(closure.variables.map((v) => v.id), ["A", "C", "B"]);
  assert.deepEqual(closure.missing, ["X"]);
});
