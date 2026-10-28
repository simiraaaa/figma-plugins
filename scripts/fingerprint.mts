/**
 * ファイル全体のノードの指紋 (scripts/fingerprint.js の返り値) を 2 つ比べる。手順は .claude/skills/figma-safe-edit/SKILL.md。
 *
 *   npm run fingerprint -- diff <before.json> <after.json> --inside <id>[,<id>...]   # 書き出した範囲の外で変わったノードを出す (outside が空なら終了コード 0)
 */
import { parseArgs } from "node:util";
import { diffFingerprints, readFingerprint } from "./fingerprint-lib.mts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { inside: { type: "string", default: "" } },
});
if (positionals.length !== 3 || positionals[0] !== "diff") {
  console.error("使い方: npm run fingerprint -- diff <before.json> <after.json> --inside <id>[,<id>...]");
  process.exit(2);
}
const inside = values.inside
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const diff = diffFingerprints(readFingerprint(positionals[1]), readFingerprint(positionals[2]), inside);
console.log(JSON.stringify(diff, null, 2));
process.exit(diff.outside.length === 0 ? 0 : 1);
