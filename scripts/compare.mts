/**
 * Local Bridge の書き出しを 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run compare -- <before の書き出し> <after の書き出し>            # 結果は <書き出しの置き場所>/compare/ に置く
 *   npm run compare -- <before の書き出し> <after の書き出し> --out <ディレクトリ>
 *   npm run compare -- <before の書き出し> <after の書き出し> --snapshot-before <前の json> --snapshot-after <後の json>
 *       # ファイル全体のスナップショット (scripts/snapshot.js の返り値) も比べ、書き出した範囲の外の変化を report の先頭に出す
 *       # 書き出した範囲は after の index.json から決める。--inside <id>[,<id>...] で指定もできる
 *   npm run compare -- <before の書き出し> <after の書き出し> ... --note <見立てのファイル>
 *       # AI が書いた見立て (範囲の外の変化が何で、原因は何か) を report の先頭に出す。書き直すたびに compare をやり直す
 *
 * 終了コードは、変化の有無に関わらず 0 (判定は出力の JSON の欄で行う。snapshot.mts とは違う)。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { compareExports, defaultCompareDir, isDirectory } from "./compare-lib.mts";

const USAGE =
  "使い方: npm run compare -- <before の書き出しのディレクトリ> <after の書き出しのディレクトリ> [--out <ディレクトリ>] [--snapshot-before <前の json> --snapshot-after <後の json> [--inside <id>[,<id>...]]] [--note <見立てのファイル>]";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "snapshot-before": { type: "string" },
    "snapshot-after": { type: "string" },
    inside: { type: "string" },
    note: { type: "string" },
  },
});
const snapshotBefore = values["snapshot-before"];
const snapshotAfter = values["snapshot-after"];
// スナップショットは前後そろえて渡す。片方だけでは比べられない
const halfGiven = (snapshotBefore === undefined) !== (snapshotAfter === undefined);
if (positionals.length !== 2 || !positionals.every(isDirectory) || halfGiven) {
  console.error(USAGE);
  process.exit(2);
}
const [beforeDir, afterDir] = positionals.map((p) => path.resolve(p));
const outDir = path.resolve(values.out ?? defaultCompareDir(beforeDir, afterDir));
const snapshot =
  snapshotBefore === undefined || snapshotAfter === undefined ? undefined : { before: path.resolve(snapshotBefore), after: path.resolve(snapshotAfter) };
const inside = values.inside
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const note = values.note === undefined ? undefined : path.resolve(values.note);
console.log(JSON.stringify(compareExports(beforeDir, afterDir, outDir, { snapshot, inside, note }), null, 2));
