/**
 * release の梱包導出と版一致ガードの検査
 *
 * 実行: npm test
 * 梱包リストは manifest.json の参照から導出される (二重定義しない)。
 * 合成した plugin ディレクトリで、導出結果とエラー経路 (参照先欠落・版不一致) を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertPluginVersion, pluginZipEntries } from "../scripts/release-lib.mts";

function makePlugin(manifest: Record<string, unknown>, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "release-pkg-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const rel of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), `content of ${rel}`);
  }
  return dir;
}

test("manifest の main / ui 参照から梱包リストを導出する", () => {
  const dir = makePlugin({ name: "X", main: "dist/code.js", ui: "src/ui.html" }, [
    "dist/code.js",
    "src/ui.html",
  ]);
  const entries = pluginZipEntries(dir, "my-plugin");
  assert.deepEqual(
    entries.map((e) => e.name),
    ["my-plugin/manifest.json", "my-plugin/dist/code.js", "my-plugin/src/ui.html"]
  );
  for (const e of entries) assert.ok(e.data.length > 0, `${e.name} が空`);
});

test("負例: manifest が参照するファイルが無ければ梱包が落ちる", () => {
  // ui.html を作らない = ビルド漏れ・参照先の変え忘れの再現
  const dir = makePlugin({ name: "X", main: "dist/code.js", ui: "src/ui.html" }, [
    "dist/code.js",
  ]);
  assert.throws(() => pluginZipEntries(dir, "my-plugin"), /梱包対象が読めない: src\/ui\.html/);
});

test("負例: manifest に main / ui の参照が無ければ落ちる", () => {
  const dir = makePlugin({ name: "X", main: "dist/code.js" }, ["dist/code.js"]);
  assert.throws(() => pluginZipEntries(dir, "my-plugin"), /main \/ ui の参照が無い/);
});

test("版一致ガード: 一致すれば通り、不一致・未検出は落ちる", () => {
  assert.doesNotThrow(() =>
    assertPluginVersion('const PLUGIN_VERSION = "0.1.0";', "0.1.0", "code.ts")
  );
  assert.throws(
    () => assertPluginVersion('const PLUGIN_VERSION = "0.1.0";', "0.2.0", "code.ts"),
    /PLUGIN_VERSION \(0\.1\.0\) が package\.json の version \(0\.2\.0\) と一致しない/
  );
  assert.throws(
    () => assertPluginVersion("const OTHER = 1;", "0.1.0", "code.ts"),
    /未検出/
  );
});
