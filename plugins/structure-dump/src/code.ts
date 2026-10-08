/**
 * Structure Dump - plugin main
 *
 * 特定の UI ライブラリに依存しない汎用の構造書き出しプラグイン。
 * 選択ノード (未選択なら現在ページ直下) をセクション単位・画面フレーム単位に分け、
 * 画面フレームごとの構造 JSON とスクリーンショット PNG、image fill の元画像、
 * 読み方の README を 1 つの ZIP (無圧縮) に束ねて UI へ渡す。コード生成はしない (AI 側の仕事)。
 */

import { sortInDocumentOrder } from "../../../shared/nodeOrder";
import { DumpNode, SerializeContext, serializeNode } from "./serialize";
import {
  allFrames,
  allSections,
  buildFrameJson,
  buildIndex,
  buildSectionJson,
  planDump,
  safeId,
  safeName,
} from "./plan";
import zipReadme from "./zip-readme.md";
import { buildZip, utf8Encode, ZipEntry } from "./zip";

const PLUGIN_VERSION = "0.1.0";
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

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jsonEntry(name: string, value: unknown): ZipEntry {
  return { name, data: utf8Encode(JSON.stringify(value, null, 2)) };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 600 });

  await loadVariables();

  const selection = figma.currentPage.selection;
  const plan = planDump(
    selection.length > 0 ? selection : figma.currentPage.children,
    sortInDocumentOrder
  );
  const frames = allFrames(plan);
  const sections = allSections(plan);

  if (frames.length === 0 && sections.length === 0) {
    let message = "対象がありません (何かを選択するか、空でないページで実行してください)";
    if (plan.hiddenRoots.length > 0) {
      message =
        selection.length > 0
          ? "選択したノードはすべて非表示です"
          : "ページ直下のノードはすべて非表示です";
    }
    figma.ui.postMessage({ type: "error", message });
    return;
  }

  const warnings: string[] = plan.hiddenRoots.map(
    (node) => `非表示のため除外: ${node.name} (${node.id})`
  );
  const imageHashes = new Set<string>();
  const ctx: SerializeContext = {
    mixed: figma.mixed,
    resolveVariableName: (id) => variableNameById.get(id) ?? `<unresolved:${id}>`,
    registerImage: (hash) => {
      imageHashes.add(hash);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };

  // 失敗したノードを黙って省くと出力が欠けたことに気づけないので、中止してノードを示す
  const serialize = async (node: SceneNode): Promise<DumpNode> => {
    try {
      return await serializeNode(node, ctx, "NONE");
    } catch (e) {
      throw new Error(`構造の書き出しに失敗: ${node.name} (${node.id}): ${errorDetail(e)}`);
    }
  };

  const entries: ZipEntry[] = [];
  const writtenPngs = new Set<string>();

  // 画面フレームは構造 JSON と PNG を拡張子違いの同じパスに置き、index.json から引けるようにする
  for (const frame of frames) {
    const dumped = await serialize(frame.node);
    entries.push(jsonEntry(frame.json, buildFrameJson(frame, dumped)));
    try {
      const bytes = await frame.node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: SCREENSHOT_SCALE },
      });
      entries.push({ name: frame.png, data: bytes });
      writtenPngs.add(frame.png);
    } catch (e) {
      warnings.push(`スクリーンショット失敗: ${frame.name} (${frame.id}): ${errorDetail(e)}`);
    }
  }

  for (const section of sections) {
    if (section.sectionJson === undefined) continue;
    const nodes: DumpNode[] = [];
    for (const node of section.others) {
      nodes.push(await serialize(node));
    }
    entries.push(jsonEntry(section.sectionJson, buildSectionJson(section, nodes)));
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
      warnings.push(`画像の取得に失敗: imageRef ${hash}: ${errorDetail(e)}`);
    }
  }

  const scope =
    selection.length > 0 ? "selection" : `page:${figma.currentPage.name}`;
  const index = buildIndex(
    plan,
    {
      fileName: figma.root.name,
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      warnings,
    },
    writtenPngs
  );
  const indexText = JSON.stringify(index, null, 2);
  entries.unshift(
    { name: "README.md", data: utf8Encode(zipReadme) },
    { name: "index.json", data: utf8Encode(indexText) }
  );

  const zip = buildZip(entries);

  figma.ui.postMessage({
    type: "result",
    payload: {
      zipName: `${safeName(figma.root.name)}-dump.zip`,
      zip,
      indexText,
      meta: {
        fileName: figma.root.name,
        scope,
        frameCount: frames.length,
        screenshotCount: writtenPngs.size,
        sectionCount: sections.length,
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
