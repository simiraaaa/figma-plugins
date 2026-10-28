/**
 * Local Bridge の書き出しを 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run compare -- <before の書き出し> <after の書き出し>            # 結果は <書き出しの置き場所>/compare/ に置く
 *   npm run compare -- <before の書き出し> <after の書き出し> --out <ディレクトリ>
 *   npm run compare -- <before の書き出し> <after の書き出し> --fingerprint-before <前の json> --fingerprint-after <後の json>
 *       # ファイル全体のスナップショット (scripts/fingerprint.js の返り値) も比べ、書き出した範囲の外の変化を report の先頭に出す
 *
 * 終了コードは、変化の有無に関わらず 0 (判定は出力の JSON の欄で行う。fingerprint.mts とは違う)。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { compareExports, defaultCompareDir, isDirectory } from "./compare-lib.mts";

const USAGE =
  "使い方: npm run compare -- <before の書き出しのディレクトリ> <after の書き出しのディレクトリ> [--out <ディレクトリ>] [--fingerprint-before <前の json> --fingerprint-after <後の json>]";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, "fingerprint-before": { type: "string" }, "fingerprint-after": { type: "string" } },
});
const fpBefore = values["fingerprint-before"];
const fpAfter = values["fingerprint-after"];
// スナップショットは前後そろえて渡す。片方だけでは比べられない
const halfGiven = (fpBefore === undefined) !== (fpAfter === undefined);
if (positionals.length !== 2 || !positionals.every(isDirectory) || halfGiven) {
  console.error(USAGE);
  process.exit(2);
}
const [beforeDir, afterDir] = positionals.map((p) => path.resolve(p));
const outDir = path.resolve(values.out ?? defaultCompareDir(beforeDir, afterDir));
const fingerprint =
  fpBefore === undefined || fpAfter === undefined ? undefined : { before: path.resolve(fpBefore), after: path.resolve(fpAfter) };
console.log(JSON.stringify(compareExports(beforeDir, afterDir, outDir, { fingerprint }), null, 2));
