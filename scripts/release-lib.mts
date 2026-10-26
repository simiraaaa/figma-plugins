/**
 * release.mts の検査可能な純ロジック。
 *
 * 梱包リストは manifest.json の参照 (main / ui) から導出する。
 * 梱包側と manifest に同じパスを二重定義すると、片方だけ変えたとき
 * 「開ける zip だが Figma で動かない」配布物が通るため。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ZipEntry } from "../plugins/structure-dump/src/zip.ts";

export function assertPluginVersion(codeSource: string, version: string, label: string): void {
  const m = codeSource.match(/PLUGIN_VERSION = "([^"]+)"/);
  if (!m || m[1] !== version) {
    throw new Error(
      `${label} の PLUGIN_VERSION (${m ? m[1] : "未検出"}) が package.json の version (${version}) と一致しない`
    );
  }
}

/** 開発用のメニューのコマンドの接頭辞 */
const DEV_COMMAND_PREFIX = "dev-";

/**
 * 配る manifest から開発用の設定 (devAllowedDomains と "dev-" で始まるメニュー) を外す。
 * 配るプラグインは開発用の設定を持たない (Local Bridge は配らない plugins/local-bridge にある) が、紛れ込んでも配らない。
 * 配った zip もマニフェストから取り込む開発プラグインとして動くので、残すと devAllowedDomains が効く
 */
export function releaseManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  if (Array.isArray(manifest.menu)) {
    out.menu = manifest.menu.filter(
      (item: { command?: unknown }) =>
        !(typeof item.command === "string" && item.command.startsWith(DEV_COMMAND_PREFIX))
    );
  }
  const network = manifest.networkAccess;
  if (typeof network === "object" && network !== null) {
    const { devAllowedDomains: _dev, ...rest } = network as Record<string, unknown>;
    out.networkAccess = rest;
  }
  return out;
}

/** manifest.json とそれが参照する main / ui を zip エントリとして返す (参照先が無ければ throw) */
export function pluginZipEntries(pluginDir: string, name: string): ZipEntry[] {
  const manifest = JSON.parse(
    readFileSync(path.join(pluginDir, "manifest.json"), "utf8")
  ) as Record<string, unknown>;
  if (typeof manifest.main !== "string" || typeof manifest.ui !== "string") {
    throw new Error(`${name}/manifest.json に main / ui の参照が無い`);
  }
  const manifestEntry: ZipEntry = {
    name: `${name}/manifest.json`,
    data: new TextEncoder().encode(JSON.stringify(releaseManifest(manifest), null, 2) + "\n"),
  };
  return [manifestEntry, ...[manifest.main, manifest.ui].map((rel) => {
    let data: Uint8Array;
    try {
      data = new Uint8Array(readFileSync(path.join(pluginDir, rel)));
    } catch {
      throw new Error(`${name} の梱包対象が読めない: ${rel} (ビルド済みか確認する)`);
    }
    return { name: `${name}/${rel}`, data };
  })];
}
