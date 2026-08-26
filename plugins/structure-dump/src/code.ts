/**
 * Structure Dump - plugin main
 *
 * 特定の UI ライブラリに依存しない汎用の構造書き出しプラグイン。
 * 選択ノード (未選択なら現在ページ) を走査して構造 JSON を作り、
 * トップレベル各ノードのスクリーンショット PNG と image fill の元画像を
 * 1 つの ZIP (無圧縮) に束ねて UI へ渡す。コード生成はしない (AI 側の仕事)。
 */

import { sortInDocumentOrder } from "../../../shared/nodeOrder";
import { DumpNode, SerializeContext, serializeNode } from "./serialize";
import { buildZip, utf8Encode, ZipEntry } from "./zip";

const PLUGIN_VERSION = "0.1.0";
const SCHEMA_VERSION = "dump-v1";
const SCREENSHOT_SCALE = 1;

// ---------------------------------------------------------------------------
// Variables 一括ロード (ノード毎の非同期解決を避ける)
// ---------------------------------------------------------------------------

let variableNameById = new Map<string, string>();

async function loadVariables(): Promise<void> {
  try {
    const vars = await figma.variables.getLocalVariablesAsync();
    variableNameById = new Map(vars.map((v) => [v.id, v.name]));
  } catch (e) {
    // Variables 未使用ファイル等では空のままでよい
    variableNameById = new Map();
  }
}

// ---------------------------------------------------------------------------
// ファイル名
// ---------------------------------------------------------------------------

/** ZIP 内・展開後のファイルシステム双方で安全な名前にする (Windows 含む) */
function safeName(name: string): string {
  const cleaned = name.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  const trimmed = cleaned.slice(0, 40);
  return trimmed.length > 0 ? trimmed : "node";
}

/** ノード ID ("123:456") や imageRef をファイル名に使える形へ */
function safeId(id: string): string {
  return id.replace(/[^0-9a-zA-Z]+/g, "-");
}

function imageExtension(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "webp";
  }
  return "bin";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface ScreenshotMeta {
  id: string;
  name: string;
  file: string;
}

async function run(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 600 });

  await loadVariables();

  const selection = figma.currentPage.selection;
  const targets = sortInDocumentOrder(
    selection.length > 0 ? selection : figma.currentPage.children
  ).filter((node) => node.visible);

  if (targets.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message: "対象がありません (何かを選択するか、空でないページで実行してください)",
    });
    return;
  }

  const warnings: string[] = [];
  const imageHashes = new Set<string>();
  const ctx: SerializeContext = {
    mixed: figma.mixed,
    resolveVariableName: (id) => variableNameById.get(id) ?? `<unresolved:${id}>`,
    registerImage: (hash) => {
      imageHashes.add(hash);
    },
  };

  const tree: DumpNode[] = [];
  for (const node of targets) {
    tree.push(await serializeNode(node, ctx));
  }

  // スクリーンショット: トップレベル各ノードを PNG で書き出し、id で JSON と対応付ける
  const entries: ZipEntry[] = [];
  const screenshots: ScreenshotMeta[] = [];
  for (const node of targets) {
    if (!("exportAsync" in node)) continue;
    const file = `screenshots/${safeName(node.name)}.${safeId(node.id)}.png`;
    try {
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: SCREENSHOT_SCALE },
      });
      entries.push({ name: file, data: bytes });
      screenshots.push({ id: node.id, name: node.name, file });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      warnings.push(`スクリーンショット失敗: ${node.name} (${node.id}): ${detail}`);
    }
  }

  // image fill の元画像。JSON 側の imageRef とファイル名 (hash) で対応付ける
  for (const hash of imageHashes) {
    try {
      const image = figma.getImageByHash(hash);
      if (!image) {
        warnings.push(`画像が見つかりません: imageRef ${hash}`);
        continue;
      }
      const bytes = await image.getBytesAsync();
      entries.push({ name: `assets/${safeId(hash)}.${imageExtension(bytes)}`, data: bytes });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      warnings.push(`画像の取得に失敗: imageRef ${hash}: ${detail}`);
    }
  }

  const scope =
    selection.length > 0 ? "selection" : `page:${figma.currentPage.name}`;
  const json = {
    meta: {
      fileName: figma.root.name,
      pluginVersion: PLUGIN_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      screenshots,
      warnings,
    },
    tree,
  };
  const jsonText = JSON.stringify(json, null, 2);
  entries.unshift({ name: "structure.json", data: utf8Encode(jsonText) });

  const zip = buildZip(entries);

  figma.ui.postMessage({
    type: "result",
    payload: {
      zipName: `${safeName(figma.root.name)}-dump.zip`,
      zip,
      jsonText,
      meta: {
        fileName: figma.root.name,
        scope,
        targetCount: targets.length,
        screenshotCount: screenshots.length,
        assetCount: imageHashes.size,
        zipBytes: zip.length,
        warnings,
      },
    },
  });
}

/**
 * 想定外の例外を UI へ届く診断へ畳む。裸の run() だと unhandled rejection になり
 * UI が「実行中」のまま無言で止まる
 */
run().catch((err: unknown) => {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  figma.ui.postMessage({
    type: "error",
    message: `${detail}\n書き出しを中止しました`,
  });
});
