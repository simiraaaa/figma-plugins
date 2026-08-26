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

/** manifest.json とそれが参照する main / ui を zip エントリとして返す (参照先が無ければ throw) */
export function pluginZipEntries(pluginDir: string, name: string): ZipEntry[] {
  const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8")) as {
    main?: unknown;
    ui?: unknown;
  };
  if (typeof manifest.main !== "string" || typeof manifest.ui !== "string") {
    throw new Error(`${name}/manifest.json に main / ui の参照が無い`);
  }
  return ["manifest.json", manifest.main, manifest.ui].map((rel) => {
    let data: Uint8Array;
    try {
      data = new Uint8Array(readFileSync(path.join(pluginDir, rel)));
    } catch {
      throw new Error(`${name} の梱包対象が読めない: ${rel} (ビルド済みか確認する)`);
    }
    return { name: `${name}/${rel}`, data };
  });
}
