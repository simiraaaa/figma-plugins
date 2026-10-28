/**
 * dev サーバーが書き出しの展開先に添える、行き先のファイルの印 (.local-bridge.json)。
 * Structure Dump の ZIP には無いもので、隠しファイルにして比較 (compare-lib.mts) の対象から外す。
 * compare はこれを読んで、report のノードから Figma を開くリンク (figma://) を作る。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const BRIDGE_META_FILE = ".local-bridge.json";

export interface BridgeMeta {
  fileKey: string;
  fileName?: string;
}

/** 展開先に印が無い (Local Bridge 以外が置いた書き出し・古い版の dev サーバーの結果) なら null */
export function readBridgeMeta(dir: string): BridgeMeta | null {
  const file = path.join(dir, BRIDGE_META_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fileKey?: unknown; fileName?: unknown };
    if (typeof parsed.fileKey !== "string" || parsed.fileKey === "") return null;
    return { fileKey: parsed.fileKey, fileName: typeof parsed.fileName === "string" ? parsed.fileName : undefined };
  } catch {
    return null;
  }
}

/** Figma デスクトップでそのノードを開くリンク。node-id は Plugin API の id の `:` を `-` にした形 */
export function figmaNodeLink(fileKey: string, nodeId: string): string {
  return `figma://file/${encodeURIComponent(fileKey)}?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`;
}
