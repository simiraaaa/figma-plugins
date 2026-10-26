/**
 * Local Bridge の書き出しを 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run compare -- <before の書き出し> <after の書き出し>            # 結果は <書き出しの置き場所>/compare/ に置く
 *   npm run compare -- <before の書き出し> <after の書き出し> --out <ディレクトリ>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { compareExports, defaultCompareDir, isDirectory } from "./compare-lib.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
});
if (positionals.length !== 2 || !positionals.every(isDirectory)) {
  console.error("使い方: npm run compare -- <before の書き出しのディレクトリ> <after の書き出しのディレクトリ> [--out <ディレクトリ>]");
  process.exit(2);
}
const [beforeDir, afterDir] = positionals.map((p) => path.resolve(p));
const outDir = path.resolve(values.out ?? defaultCompareDir(beforeDir, afterDir));
console.log(JSON.stringify(compareExports(beforeDir, afterDir, outDir), null, 2));
