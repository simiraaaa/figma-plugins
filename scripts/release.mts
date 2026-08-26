/**
 * 配布 zip を組み立てて GitHub Release を作る。
 *
 * CI (GitHub Actions) は供給網リスクを避けるため使わない。実行は手元で、
 * gh CLI の認証で行う。zip はプラグイン自前の buildZip (無圧縮) で組み立てる。
 *
 * 実行: npm run release            (tag 作成と Release 公開まで)
 *       npm run release -- --dry-run (zip 組み立てまで。公開しない)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
};
const out = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

const version = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
).version;
const tag = `v${version}`;

// 配布物の版ずれ防止: 各プラグインの PLUGIN_VERSION と package.json version の一致
for (const p of [
  "plugins/structure-dump/src/code.ts",
  "plugins/component-spec/src/code.ts",
]) {
  const m = readFileSync(path.join(root, p), "utf8").match(/PLUGIN_VERSION = "([^"]+)"/);
  if (!m || m[1] !== version) {
    throw new Error(
      `${p} の PLUGIN_VERSION (${m ? m[1] : "未検出"}) が package.json の version (${version}) と一致しない`
    );
  }
}

if (!dryRun) {
  if (out("git", ["status", "--porcelain"]) !== "") {
    throw new Error("working tree が汚れている。コミットしてから実行する");
  }
  run("git", ["fetch", "origin", "main"]);
  if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"])) {
    throw new Error("HEAD が origin/main と一致しない。push してから実行する");
  }
}

// test は esbuild で dist/zip.mjs も作る (下の buildZip 読み込みが依存)
run("npm", ["test"]);
run("npm", ["run", "build"]);

const { buildZip } = (await import(
  path.join(root, "plugins/structure-dump/dist/zip.mjs")
)) as typeof import("../plugins/structure-dump/src/zip.ts");

const releaseDir = path.join(root, "dist-release");
mkdirSync(releaseDir, { recursive: true });

const assets: string[] = [];
for (const name of ["structure-dump", "component-spec"]) {
  const entry = (rel: string) => ({
    name: `${name}/${rel}`,
    data: new Uint8Array(readFileSync(path.join(root, "plugins", name, rel))),
  });
  // manifest が main: dist/code.js, ui: src/ui.html を相対参照するので 3 点セットで固定
  const zip = buildZip([entry("manifest.json"), entry("dist/code.js"), entry("src/ui.html")]);
  const zipPath = path.join(releaseDir, `${name}-plugin.zip`);
  writeFileSync(zipPath, zip);
  assets.push(zipPath);
  console.log(`packaged: ${zipPath} (${zip.length} bytes)`);
}

if (dryRun) {
  console.log(`dry-run: ${tag} の Release は作成しない`);
} else {
  run("gh", ["release", "create", tag, ...assets, "--title", tag, "--generate-notes"]);
  console.log(`released: ${tag}`);
}
