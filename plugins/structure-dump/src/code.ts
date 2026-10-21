/**
 * Structure Dump - plugin main
 *
 * 特定の UI ライブラリに依存しない汎用の構造書き出しプラグイン。
 * 選択ノード (未選択なら現在ページ直下) をセクション単位・画面フレーム単位に分け、
 * 画面フレームごとの構造 JSON とスクリーンショット PNG、image fill の元画像、
 * 読み方の README を 1 つの ZIP (無圧縮) に束ねて UI へ渡す。コード生成はしない (AI 側の仕事)。
 */

import { sortInDocumentOrder } from "../../../shared/nodeOrder";
import {
  buildVariablesJson,
  DumpNode,
  SerializeContext,
  serializeNode,
  serializeStyle,
} from "./serialize";
import {
  allFrames,
  allSections,
  buildFrameJson,
  buildIndex,
  buildSectionJson,
  DEFAULT_SCREENSHOT_SCALE,
  DEV_LOOP_COMMAND,
  emptyMessage,
  errorDetail,
  FetchResult,
  FrameComponent,
  frameComponentOf,
  longPaths,
  MAX_ZIP_PATH_CHARS,
  newExportOutput,
  overflowsBounds,
  planDump,
  recordAsset,
  recordScreenshot,
  recordSvg,
  RootSource,
  safeName,
  screenshotScaleFor,
  STYLES_JSON_NAME,
  VARIABLES_JSON_NAME,
} from "./plan";
import zipReadme from "./zip-readme.md";
import { buildZip, utf8Encode, ZipEntry } from "./zip";

const PLUGIN_VERSION = "0.4.0";

// ---------------------------------------------------------------------------
// Variables・スタイル・コンポーネント名の解決 (書き出し 1 回ぶんの cache を持つ)
// ---------------------------------------------------------------------------

/** 同じ id を何度も引くので、Promise ごと覚えて 1 回だけ取りに行く */
function memoize<T>(get: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (id) => {
    let hit = cache.get(id);
    if (hit === undefined) {
      hit = get(id);
      cache.set(id, hit);
    }
    return hit;
  };
}

async function orNull<T>(get: () => Promise<T | null>): Promise<T | null> {
  try {
    return await get();
  } catch {
    return null;
  }
}

class Resolver {
  readonly variable = memoize((id) => orNull(() => figma.variables.getVariableByIdAsync(id)));
  readonly collection = memoize((id) =>
    orNull(() => figma.variables.getVariableCollectionByIdAsync(id))
  );
  readonly style = memoize((id) => orNull(() => figma.getStyleByIdAsync(id)));
  readonly node = memoize((id) => orNull(() => figma.getNodeByIdAsync(id)));
  /** 書き出し中に出会った変数とスタイル。ライブラリ (remote) のものを一覧へ足すのに使う */
  readonly seenVariables = new Set<string>();
  readonly seenStyles = new Set<string>();
  /** 値を解決できなかった変数。同じ変数を束縛したノードごとに warning を並べない */
  readonly unresolvedValues = new Set<string>();
}

function jsonEntry(name: string, value: unknown): ZipEntry {
  return { name, data: utf8Encode(JSON.stringify(value, null, 2)) };
}

/** ファイルのコレクションと、ノードが使っていたライブラリの変数をコレクションごとにまとめる */
async function variablesJson(resolver: Resolver): Promise<unknown> {
  // Variables を使っていないファイルなどで失敗しても、ライブラリの分だけで続ける
  const local = (await orNull(() => figma.variables.getLocalVariablesAsync())) ?? [];
  const collections: VariableCollection[] =
    (await orNull(() => figma.variables.getLocalVariableCollectionsAsync())) ?? [];
  const variables: Variable[] = [...local];
  const localIds = new Set(local.map((v) => v.id));
  const collectionIds = new Set(collections.map((c) => c.id));
  for (const id of resolver.seenVariables) {
    if (localIds.has(id)) continue;
    const variable = await resolver.variable(id);
    if (variable === null) continue;
    variables.push(variable);
    if (!collectionIds.has(variable.variableCollectionId)) {
      const collection = await resolver.collection(variable.variableCollectionId);
      if (collection !== null) {
        collections.push(collection);
        collectionIds.add(collection.id);
      }
    }
  }
  const names = new Map(variables.map((v) => [v.id, v.name]));
  for (const v of variables) {
    for (const value of Object.values(v.valuesByMode)) {
      const isAlias =
        typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";
      if (isAlias && !names.has(value.id)) {
        const target = await resolver.variable(value.id);
        if (target !== null) names.set(target.id, target.name);
      }
    }
  }
  return buildVariablesJson(collections, variables, (id) => names.get(id));
}

/** ファイルのスタイルと、ノードが使っていたライブラリのスタイル */
async function stylesJson(resolver: Resolver, ctx: SerializeContext): Promise<unknown> {
  const local: BaseStyle[] = [
    ...(await figma.getLocalPaintStylesAsync()),
    ...(await figma.getLocalTextStylesAsync()),
    ...(await figma.getLocalEffectStylesAsync()),
    ...(await figma.getLocalGridStylesAsync()),
  ];
  const localIds = new Set(local.map((s) => s.id));
  const styles = [...local];
  for (const id of resolver.seenStyles) {
    if (localIds.has(id)) continue;
    const style = await resolver.style(id);
    if (style !== null) styles.push(style);
  }
  const out: unknown[] = [];
  for (const style of styles) out.push(await serializeStyle(style, ctx));
  return { styles: out };
}

/**
 * SVG で書き出すノード。非表示のノードは exportAsync が「表示されているレイヤーが無い」で失敗するので、
 * 非表示の INSTANCE は元のコンポーネントを書き出す (インスタンスで上書きした色などは入らない)。
 * それ以外の非表示のノードは書き出さない
 */
async function svgSource(node: SceneNode): Promise<SceneNode | null> {
  if (node.visible) return node;
  if (node.type !== "INSTANCE") return null;
  return orNull(() => node.getMainComponentAsync());
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
// 書き出し
// ---------------------------------------------------------------------------

interface DumpTarget {
  roots: readonly SceneNode[];
  source: RootSource;
  /** index.json の meta.scope */
  scope: string;
}

interface DumpPayload {
  zipName: string;
  zip: Uint8Array;
  indexText: string;
  meta: Record<string, unknown>;
}

type DumpOutcome = { type: "result"; payload: DumpPayload } | { type: "empty"; message: string };

function currentPageTarget(): DumpTarget {
  const selection = figma.currentPage.selection;
  return selection.length > 0
    ? { roots: selection, source: "selection", scope: "selection" }
    : {
        roots: figma.currentPage.children,
        source: "page",
        scope: `page:${figma.currentPage.name}`,
      };
}

async function dump(target: DumpTarget, screenshotScale: number): Promise<DumpOutcome> {
  const plan = planDump(target.roots, sortInDocumentOrder);
  const empty = emptyMessage(plan, target.source);
  if (empty !== null) return { type: "empty", message: empty };
  const frames = allFrames(plan);
  const sections = allSections(plan);

  const out = newExportOutput(
    plan.hiddenRoots.map((node) => `非表示のため除外: ${node.name} (${node.id})`)
  );
  for (const long of longPaths(plan, MAX_ZIP_PATH_CHARS)) {
    out.warnings.push(`パスが長い (${long.length} 文字): ${long.path}`);
  }
  const imageHashes = new Set<string>();
  const resolver = new Resolver();
  const ctx: SerializeContext = {
    mixed: figma.mixed,
    resolveVariable: async (id, consumer) => {
      resolver.seenVariables.add(id);
      const variable = await resolver.variable(id);
      if (variable === null) return { name: `<unresolved:${id}>` };
      if (consumer === undefined) return { name: variable.name };
      try {
        return { name: variable.name, resolved: variable.resolveForConsumer(consumer as SceneNode) };
      } catch (e) {
        if (!resolver.unresolvedValues.has(id)) {
          resolver.unresolvedValues.add(id);
          out.warnings.push(`変数の値を解決できない: ${variable.name}: ${errorDetail(e)}`);
        }
        return { name: variable.name };
      }
    },
    styleName: async (id) => {
      resolver.seenStyles.add(id);
      return (await resolver.style(id))?.name;
    },
    modeName: async (collectionId, modeId) => {
      const collection = await resolver.collection(collectionId);
      const mode = collection?.modes.find((m) => m.modeId === modeId);
      return collection && mode ? { collection: collection.name, mode: mode.name } : undefined;
    },
    componentName: async (id) => (await resolver.node(id))?.name,
    exportSvg: async (node) => {
      const target = await svgSource(node as SceneNode);
      if (target === null) return undefined;
      const written = out.writtenSvgs.get(target.id);
      if (written !== undefined) return written;
      return recordSvg(out, target, await fetchBytes(() => target.exportAsync({ format: "SVG" })));
    },
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

  const frameComponents = new Map<string, FrameComponent>();

  // 画面フレームは構造 JSON と PNG を拡張子違いの同じパスに置き、index.json から引けるようにする
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const dumped = await serialize(frame.node);
    out.entries.push(jsonEntry(frame.json, buildFrameJson(frame, dumped)));
    const component = frameComponentOf(dumped);
    if (component !== undefined) frameComponents.set(frame.id, component);
    const node = frame.node;
    const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
    const render = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
    if (overflowsBounds(box, render)) {
      out.warnings.push(`枠の外に描画があり、png は枠で切った: ${frame.name} (${frame.id})`);
    }
    // 枠 (width × height) の範囲で書き出し、png の左上を枠の左上に合わせる (座標で png を指せるようにする)
    const shot = await fetchBytes(() =>
      node.exportAsync({
        format: "PNG",
        useAbsoluteBounds: true,
        constraint: { type: "SCALE", value: screenshotScale },
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

  // styles.json の paint の image fill も assets に載せるため、画像を取る前に組む
  const variables = jsonEntry(VARIABLES_JSON_NAME, await variablesJson(resolver));
  const styles = jsonEntry(STYLES_JSON_NAME, await stylesJson(resolver, ctx));

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

  const scope = target.scope;
  const index = buildIndex(
    plan,
    {
      fileName: figma.root.name,
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      screenshotScale,
      warnings: out.warnings,
    },
    out.writtenPngs,
    out.writtenAssets,
    frameComponents
  );
  const indexText = JSON.stringify(index, null, 2);
  const zip = buildZip([
    { name: "README.md", data: utf8Encode(zipReadme) },
    { name: "index.json", data: utf8Encode(indexText) },
    variables,
    styles,
    ...out.entries,
  ]);

  return {
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
        screenshotScale,
        sectionCount: sections.length,
        assetCount: out.writtenAssets.size,
        zipBytes: zip.length,
        warnings: out.warnings,
      },
    },
  };
}

function failureText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ---------------------------------------------------------------------------
// 開発ループ (メニューの dev-loop で起動したときだけ)
// ---------------------------------------------------------------------------

interface DevRequest {
  seq: number;
  nodeIds?: string[];
  scale?: number;
}

/** 依頼の id を書き出し対象にする。PAGE の id を 1 つだけ渡したら、そのページ直下を書き出す */
async function devTarget(nodeIds: readonly string[] | undefined): Promise<DumpTarget> {
  if (nodeIds === undefined) return currentPageTarget();
  const nodes: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node === null) throw new Error(`ノードが見つからない: ${id}`);
    if (node.type === "PAGE") {
      if (nodeIds.length !== 1) throw new Error(`ページの id は単独で指定する: ${id}`);
      await node.loadAsync();
      return { roots: node.children, source: "page", scope: `page:${node.name}` };
    }
    if (node.type === "DOCUMENT") throw new Error(`ドキュメントは指定できない: ${id}`);
    nodes.push(node);
  }
  return { roots: nodes, source: "nodes", scope: "nodes" };
}

/**
 * UI が dev サーバーから依頼を long-poll で取り、ここへ 1 件ずつ渡す。
 * 結果は UI がサーバーへ POST する (ネットワークに出られるのは UI の iframe だけ)
 */
function runDevLoop(): void {
  figma.showUI(__html__, { width: 480, height: 600 });
  figma.ui.onmessage = async (msg: { type?: string; request?: DevRequest }) => {
    if (msg.type !== "dev-request" || msg.request === undefined) return;
    const request = msg.request;
    try {
      const outcome = await dump(
        await devTarget(request.nodeIds),
        request.scale ?? DEFAULT_SCREENSHOT_SCALE
      );
      if (outcome.type === "empty") {
        figma.ui.postMessage({ type: "dev-error", seq: request.seq, message: outcome.message });
      } else {
        figma.ui.postMessage({ type: "dev-result", seq: request.seq, payload: outcome.payload });
      }
    } catch (err) {
      figma.ui.postMessage({ type: "dev-error", seq: request.seq, message: failureText(err) });
    }
  };
  figma.ui.postMessage({ type: "dev-start" });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  figma.showUI(__html__, { width: 480, height: 600 });
  const outcome = await dump(currentPageTarget(), screenshotScaleFor(figma.command));
  if (outcome.type === "empty") {
    figma.ui.postMessage({ type: "error", message: outcome.message });
  } else {
    figma.ui.postMessage(outcome);
  }
}

if (figma.command === DEV_LOOP_COMMAND) {
  runDevLoop();
} else {
  /**
   * 想定外の例外を UI へ届く診断へ畳む。裸の run() だと unhandled rejection になり
   * UI が「実行中」のまま無言で止まる
   */
  run().catch((err: unknown) => {
    figma.ui.postMessage({
      type: "error",
      message: `${failureText(err)}\n書き出しを中止しました`,
    });
  });
}
