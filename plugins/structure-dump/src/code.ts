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
  emptyMessage,
  errorDetail,
  FetchResult,
  longPaths,
  MAX_ZIP_PATH_CHARS,
  newExportOutput,
  planDump,
  recordAsset,
  recordScreenshot,
  safeName,
} from "./plan";
import zipReadme from "./zip-readme.md";
import { buildZip, utf8Encode, ZipEntry } from "./zip";

const PLUGIN_VERSION = "0.2.0";
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

function jsonEntry(name: string, value: unknown): ZipEntry {
  return { name, data: utf8Encode(JSON.stringify(value, null, 2)) };
}

type ProgressPhase = "frames" | "sections" | "assets";

function postProgress(phase: ProgressPhase, done: number, total: number, name?: string): void {
  figma.ui.postMessage({ type: "progress", phase, done, total, name });
}

async function fetchBytes(get: () => Promise<Uint8Array>): Promise<FetchResult> {
  try {
    return { ok: true, bytes: await get() };
  } catch (error) {
    return { ok: false, error };
  }
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
  const empty = emptyMessage(plan, selection.length > 0);
  if (empty !== null) {
    figma.ui.postMessage({ type: "error", message: empty });
    return;
  }
  const frames = allFrames(plan);
  const sections = allSections(plan);

  const out = newExportOutput(
    plan.hiddenRoots.map((node) => `非表示のため除外: ${node.name} (${node.id})`)
  );
  for (const long of longPaths(plan, MAX_ZIP_PATH_CHARS)) {
    out.warnings.push(`パスが長い (${long.length} 文字): ${long.path}`);
  }
  const imageHashes = new Set<string>();
  const ctx: SerializeContext = {
    mixed: figma.mixed,
    resolveVariableName: (id) => variableNameById.get(id) ?? `<unresolved:${id}>`,
    registerImage: (hash) => {
      imageHashes.add(hash);
    },
    warn: (message) => {
      out.warnings.push(message);
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

  // 画面フレームは構造 JSON と PNG を拡張子違いの同じパスに置き、index.json から引けるようにする
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const dumped = await serialize(frame.node);
    out.entries.push(jsonEntry(frame.json, buildFrameJson(frame, dumped)));
    const shot = await fetchBytes(() =>
      frame.node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: SCREENSHOT_SCALE },
      })
    );
    recordScreenshot(out, frame, shot);
    postProgress("frames", i + 1, frames.length, frame.name);
  }

  const sectionsWithJson = sections.filter((section) => section.sectionJson !== undefined);
  for (let i = 0; i < sectionsWithJson.length; i += 1) {
    const section = sectionsWithJson[i];
    const nodes: DumpNode[] = [];
    for (const node of section.others) {
      nodes.push(await serialize(node));
    }
    out.entries.push(jsonEntry(section.sectionJson as string, buildSectionJson(section, nodes)));
    postProgress("sections", i + 1, sectionsWithJson.length);
  }

  // image fill の元画像。index.json の assets で imageRef → ZIP 内パスを引けるようにする
  const hashes = Array.from(imageHashes);
  for (let i = 0; i < hashes.length; i += 1) {
    const hash = hashes[i];
    let result: FetchResult | null;
    try {
      const image = figma.getImageByHash(hash);
      result = image ? { ok: true, bytes: await image.getBytesAsync() } : null;
    } catch (error) {
      result = { ok: false, error };
    }
    recordAsset(out, hash, result);
    postProgress("assets", i + 1, hashes.length);
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
      warnings: out.warnings,
    },
    out.writtenPngs,
    out.writtenAssets
  );
  const indexText = JSON.stringify(index, null, 2);
  const zip = buildZip([
    { name: "README.md", data: utf8Encode(zipReadme) },
    { name: "index.json", data: utf8Encode(indexText) },
    ...out.entries,
  ]);

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
        screenshotCount: out.writtenPngs.size,
        sectionCount: sections.length,
        assetCount: out.writtenAssets.size,
        zipBytes: zip.length,
        warnings: out.warnings,
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
