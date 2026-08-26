/**
 * component-spec の仕様 JSON 組み立て (component-spec-v1) の検査
 *
 * 実行: npm test
 * Figma API 非依存の純関数なので、素のオブジェクトで ComponentSet 相当を組んで
 * 「definitions を正とすること」「辿れないときに examples から集約すること」を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as specDist from "../plugins/component-spec/dist/spec.mjs";
const {
  SCHEMA_VERSION,
  buildComponentSpec,
  buildSpecDocument,
  propKeyName,
  safeId,
  safeName,
  screenshotPath,
  summarizeGroup,
} = specDist as unknown as typeof import("../plugins/component-spec/src/spec.ts");
import type {
  RawGroup,
  RawPropertyValue,
  SpecProperty,
} from "../plugins/component-spec/src/spec.ts";

const META = {
  fileName: "Design File",
  pluginVersion: "0.1.0",
  exportedAt: "2026-08-21T00:00:00.000Z",
};

/** インスタンスの componentProperties 相当 */
const variant = (value: unknown): RawPropertyValue => ({ type: "VARIANT", value });
const bool = (value: unknown): RawPropertyValue => ({ type: "BOOLEAN", value });
const text = (value: unknown): RawPropertyValue => ({ type: "TEXT", value });

function inputGroup(overrides: Partial<RawGroup> = {}): RawGroup {
  return {
    key: "10:0",
    name: "Input type=password",
    componentSetId: "10:0",
    definitions: {
      State: {
        type: "VARIANT",
        defaultValue: "Default",
        variantOptions: ["Default", "Hover", "Focus", "Error"],
      },
      Density: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Compact"] },
      "ShowToggle#1:2": { type: "BOOLEAN", defaultValue: true, description: "表示切替アイコン" },
      "Label#1:3": { type: "TEXT", defaultValue: "パスワード" },
    },
    examples: [
      {
        nodeId: "20:1",
        name: "State=Default",
        properties: { State: variant("Default"), "ShowToggle#1:2": bool(true) },
      },
      {
        nodeId: "20:2",
        name: "State=Error",
        properties: { State: variant("Error"), "Label#1:3": text("パスワード (再入力)") },
      },
    ],
    ...overrides,
  };
}

test("definitions を正として properties を組み、examples を証跡として添える", () => {
  const doc = buildSpecDocument({
    meta: META,
    groups: [inputGroup()],
    screenshots: { "20:1": "screenshots/Input-type-password/State-Default.20-1.png" },
  });

  assert.equal(doc.meta.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.meta.fileName, "Design File");
  assert.equal(doc.components.length, 1);

  const spec = doc.components[0];
  assert.equal(spec.name, "Input type=password");
  assert.equal(spec.componentSetId, "10:0");
  assert.equal(spec.source, "definitions");

  assert.deepEqual(spec.properties.State, {
    type: "VARIANT",
    defaultValue: "Default",
    values: ["Default", "Hover", "Focus", "Error"],
  });
  assert.deepEqual(
    spec.properties.ShowToggle,
    { type: "BOOLEAN", defaultValue: true, description: "表示切替アイコン" },
    "キーの #id サフィックスが落ちていない、または description が失われている"
  );
  assert.equal(spec.properties.Label.type, "TEXT");
  assert.equal(spec.properties.Label.values, undefined, "VARIANT 以外に values が付いている");

  assert.deepEqual(spec.examples[0], {
    nodeId: "20:1",
    name: "State=Default",
    props: { State: "Default", ShowToggle: true },
    screenshot: "screenshots/Input-type-password/State-Default.20-1.png",
  });
  assert.equal(spec.examples[1].screenshot, undefined, "スクショの無い example にパスが付いている");
  assert.deepEqual(doc.meta.warnings, []);
});

test("definitions を辿れないときは examples から集約し source=examples で区別する", () => {
  const doc = buildSpecDocument({
    meta: META,
    groups: [
      inputGroup({
        key: "name:Input type=password",
        componentSetId: undefined,
        definitions: null,
        definitionsError: "in get_componentPropertyDefinitions: not accessible",
      }),
    ],
  });

  const spec = doc.components[0];
  assert.equal(spec.source, "examples");
  assert.equal(spec.componentSetId, undefined);
  // VARIANT は観測値を出現順で重複なく集める
  assert.deepEqual(spec.properties.State, { type: "VARIANT", values: ["Default", "Error"] });
  assert.deepEqual(spec.properties.ShowToggle, { type: "BOOLEAN" });
  assert.deepEqual(spec.properties.Label, { type: "TEXT" }, "TEXT の実値が候補値として出ている");
  assert.equal(
    (spec.properties.State as SpecProperty).defaultValue,
    undefined,
    "examples 集約でデフォルト値を捏造している"
  );

  assert.match(doc.meta.warnings[0], /読み取りに失敗/);
  assert.match(doc.meta.warnings[1], /examples から集約/);
});

test("VARIANT の観測値は出現順で重複を畳む", () => {
  const { spec } = buildComponentSpec({
    key: "k",
    name: "Chip",
    definitions: null,
    examples: [
      { nodeId: "1", name: "a", properties: { Size: variant("Large") } },
      { nodeId: "2", name: "b", properties: { Size: variant("Small") } },
      { nodeId: "3", name: "c", properties: { Size: variant("Large") } },
    ],
  });
  assert.deepEqual(spec.properties.Size.values, ["Large", "Small"]);
});

test("definitions が空オブジェクトでも props を観測できれば examples 集約へ落ちる", () => {
  const { spec } = buildComponentSpec({
    key: "k",
    name: "Button",
    definitions: {},
    examples: [{ nodeId: "1", name: "a", properties: { Size: variant("Small") } }],
  });
  assert.equal(spec.source, "examples");
  assert.deepEqual(spec.properties.Size, { type: "VARIANT", values: ["Small"] });
});

test("definitions に無いプロパティを example で観測したら warning に記録する", () => {
  const { spec, warnings } = buildComponentSpec(
    inputGroup({
      examples: [
        {
          nodeId: "20:9",
          name: "Legacy",
          properties: { State: variant("Default"), Ghost: variant("On"), "Ghost#9:9": bool(true) },
        },
      ],
    })
  );
  assert.equal(spec.source, "definitions");
  const unknown = warnings.filter((w) => /definitions に無いプロパティ/.test(w));
  assert.equal(unknown.length, 1, "同じプロパティ名で warning が重複している");
  assert.match(unknown[0], /Input type=password\.Ghost/);
});

test("example のプロパティ読み取り失敗は中止せず warning にして続行する", () => {
  const { spec, warnings } = buildComponentSpec(
    inputGroup({
      examples: [
        {
          nodeId: "20:5",
          name: "broken",
          properties: null,
          extractionError: "Component set for node has existing errors",
        },
        { nodeId: "20:6", name: "ok", properties: { State: variant("Hover") } },
      ],
    })
  );
  assert.equal(spec.examples.length, 2);
  assert.deepEqual(spec.examples[0].props, {}, "読めなかった example の props が欠けている");
  assert.deepEqual(spec.examples[1].props, { State: "Hover" });
  assert.match(warnings[0], /existing errors/);
});

test("#id を落とした名前が衝突する定義は warning に記録する", () => {
  const { warnings } = buildComponentSpec({
    key: "k",
    name: "Field",
    definitions: {
      "Label#1:1": { type: "TEXT", defaultValue: "A" },
      "Label#2:2": { type: "TEXT", defaultValue: "B" },
    },
    examples: [],
  });
  assert.equal(warnings.filter((w) => /衝突/.test(w)).length, 1);
});

test("examples 集約でプロパティの型が食い違ったら warning に記録する", () => {
  const { warnings } = buildComponentSpec({
    key: "k",
    name: "Field",
    definitions: null,
    examples: [
      { nodeId: "1", name: "a", properties: { Dense: bool(true) } },
      { nodeId: "2", name: "b", properties: { Dense: variant("true") } },
    ],
  });
  assert.equal(warnings.filter((w) => /型が example 間で一致しません/.test(w)).length, 1);
});

test("type の無い値からは型を推定する (remote の応答差の保険)", () => {
  const { spec } = buildComponentSpec({
    key: "k",
    name: "Field",
    definitions: null,
    examples: [
      { nodeId: "1", name: "a", properties: { Dense: { value: true }, Label: { value: "x" } } },
    ],
  });
  assert.equal(spec.properties.Dense.type, "BOOLEAN");
  assert.equal(spec.properties.Label.type, "TEXT");
});

test("スクリーンショットのパスは名前を正規化し node id で衝突を避ける", () => {
  assert.equal(
    screenshotPath("Input type=password", "State=Default, Density=Compact", "20:1"),
    "screenshots/Input-type=password/State=Default,-Density=Compact.20-1.png"
  );
  assert.notEqual(
    screenshotPath("Set", "同名", "20:1"),
    screenshotPath("Set", "同名", "20:2"),
    "同名 example のパスが衝突している"
  );
  assert.equal(safeName("  /  "), "node");
  assert.equal(safeId("20:1"), "20-1");
  assert.equal(propKeyName("Label#1:2"), "Label");
  assert.equal(propKeyName("State"), "State");
});

test("UI 用サマリは仕様本体と同じ source / 件数を返す", () => {
  const summary = summarizeGroup(inputGroup());
  assert.deepEqual(summary, {
    key: "10:0",
    name: "Input type=password",
    source: "definitions",
    exampleCount: 2,
    propertyCount: 4,
    warningCount: 0,
  });
  assert.equal(summarizeGroup(inputGroup({ definitions: null })).source, "examples");
});

test("Figma 側の warning (スクショ失敗など) は meta.warnings の先頭に残る", () => {
  const doc = buildSpecDocument({
    meta: META,
    groups: [inputGroup({ definitions: null })],
    warnings: ["スクリーンショット失敗: State=Error (20:2): timeout"],
  });
  assert.match(doc.meta.warnings[0], /スクリーンショット失敗/);
  assert.ok(doc.meta.warnings.length > 1);
});
