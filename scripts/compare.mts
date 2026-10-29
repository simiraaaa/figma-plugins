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
import { compareExports, parseCompareArgs } from "./compare-lib.mts";

const args = parseCompareArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}
console.log(JSON.stringify(compareExports(args.beforeDir, args.afterDir, args.outDir, args.options), null, 2));
