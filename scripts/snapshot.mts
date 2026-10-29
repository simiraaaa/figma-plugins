/**
 * ファイル全体のノードのスナップショット (scripts/snapshot.js の返り値) を 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run snapshot -- diff <before.json> <after.json> --inside <id>[,<id>...]   # 書き出した範囲の外で変わったノードを出す
 *
 * 終了コードは、outside と propagated の両方が空のときだけ 0。
 * propagated (インスタンスに映った変化) は、script がそのインスタンスを直接書き換えた場合と区別できないので、AI が読んで人に伝えるまで「済み」にしない。
 */
import { parseArgs } from "node:util";
import { diffSnapshots, readSnapshot } from "./snapshot-lib.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { inside: { type: "string", default: "" } },
});
if (positionals.length !== 3 || positionals[0] !== "diff") {
  console.error("使い方: npm run snapshot -- diff <before.json> <after.json> --inside <id>[,<id>...]");
  process.exit(2);
}
const inside = values.inside
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const diff = diffSnapshots(readSnapshot(positionals[1]), readSnapshot(positionals[2]), inside);
console.log(JSON.stringify(diff, null, 2));
process.exit(diff.outside.length === 0 && diff.propagated.length === 0 ? 0 : 1);
