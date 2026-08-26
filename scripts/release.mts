/**
 * 配布 zip を組み立てて GitHub Release を作る。
 *
 * CI (GitHub Actions) は供給網リスクを避けるため使わない。実行は手元で、
 * gh CLI の認証で行う。zip はプラグイン自前の buildZip (無圧縮) で組み立て、
 * 梱包内容は manifest.json の参照から導出する (scripts/release-lib.mts)。
 *
 * 実行: npm run release            (tag 作成と Release 公開まで)
 *       npm run release -- --dry-run (zip 組み立てまで。公開しない)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip } from "../plugins/structure-dump/src/zip.ts";
import { assertPluginVersion, pluginZipEntries } from "./release-lib.mts";

const REPO = "simiraaaa/figma-plugins";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
for (const a of args) {
  if (a !== "--dry-run") {
    throw new Error(`不明な引数: ${a} (使えるのは --dry-run だけ)`);
  }
}
// `npm run release --dry-run` (-- なし) は npm が引数を吸って argv に残らないため、npm の config も見る
const dryRun = args.includes("--dry-run") || process.env.npm_config_dry_run === "true";

const run = (cmd: string, cmdArgs: string[]): void => {
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
};
const out = (cmd: string, cmdArgs: string[]): string =>
  execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();

const version = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
).version;
const tag = `v${version}`;

for (const p of [
  "plugins/structure-dump/src/code.ts",
  "plugins/component-spec/src/code.ts",
]) {
  assertPluginVersion(readFileSync(path.join(root, p), "utf8"), version, p);
}

let headSha = "";
if (!dryRun) {
  if (out("git", ["status", "--porcelain"]) !== "") {
    throw new Error("working tree が汚れている。コミットしてから実行する");
  }
  run("git", ["fetch", "origin", "main"]);
  headSha = out("git", ["rev-parse", "HEAD"]);
  if (headSha !== out("git", ["rev-parse", "origin/main"])) {
    throw new Error("HEAD が origin/main と一致しない。push してから実行する");
  }
  // 既存 tag (過去の失敗の残骸等) があると Release がそのコミットに付き、zip の中身とずれる
  let tagExists = true;
  try {
    out("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
  } catch {
    tagExists = false;
  }
  if (tagExists) {
    throw new Error(`tag ${tag} は origin に既に存在する。version を上げてから実行する`);
  }
}

run("npm", ["test"]);
run("npm", ["run", "build"]);

const releaseDir = path.join(root, "dist-release");
mkdirSync(releaseDir, { recursive: true });

const assets: string[] = [];
for (const name of ["structure-dump", "component-spec"]) {
  const zip = buildZip(pluginZipEntries(path.join(root, "plugins", name), name));
  const zipPath = path.join(releaseDir, `${name}-plugin.zip`);
  writeFileSync(zipPath, zip);
  assets.push(zipPath);
  console.log(`packaged: ${zipPath} (${zip.length} bytes)`);
}

if (dryRun) {
  console.log(`dry-run: ${tag} の Release は作成しない`);
} else {
  const notes = [
    "ビルド済み Figma プラグインの配布 zip です。",
    "",
    "展開して出てくるフォルダを消さない場所に置き、Figma デスクトップの",
    "Plugins → Development → Import plugin from manifest… で中の manifest.json を選択してください。",
    "",
    `詳しい手順 (非開発者向け): https://github.com/${REPO}/blob/main/plugins/component-spec/INSTALL.md`,
    "(structure-dump も同じ手順。フォルダ名を読み替えてください)",
  ].join("\n");
  // --target: ガードで検証した HEAD に tag を固定する (省くと gh はリモート先端に tag を作り、
  // test / build 中に main が進むと zip の中身と tag がずれる)
  run("gh", [
    "release",
    "create",
    tag,
    ...assets,
    "--repo",
    REPO,
    "--target",
    headSha,
    "--title",
    tag,
    "--notes",
    notes,
  ]);
  console.log(`released: ${tag}`);
}
