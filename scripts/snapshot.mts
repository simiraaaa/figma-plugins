/**
 * ファイル全体のノードのスナップショット (scripts/snapshot.js の返り値) を 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run snapshot -- diff <before.json> <after.json> --inside <id>[,<id>...]   # 書き出した範囲の外で変わったノードを出す
 *
 * 終了コードは、outside と propagated の両方が空のときだけ 0。
 * propagated (インスタンスに映った変化) は、script がそのインスタンスを直接書き換えた場合と区別できないので、AI が読んで人に伝えるまで「済み」にしない。
 */
import { diffSnapshots, parseSnapshotArgs, readSnapshot } from "./snapshot-lib.mts";

const args = parseSnapshotArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}
const diff = diffSnapshots(readSnapshot(args.before), readSnapshot(args.after), args.inside);
console.log(JSON.stringify(diff, null, 2));
process.exit(diff.outside.length === 0 && diff.propagated.length === 0 ? 0 : 1);
