/**
 * Structure Dump の書き出しの本体。
 * Structure Dump のメニューと開発用プラグイン (plugins/local-bridge) の両方が build でこれを取り込むので、
 * どちらから書き出しても同じ出力になる。書き出しの中身はここだけに置く
 */

import { sortInDocumentOrder } from "../../../shared/nodeOrder";
import {
  buildVariablesJson,
  DumpNode,
  SerializeContext,
  serializeNode,
  serializeStyle,
  variableClosure,
} from "./serialize";
import {
  allFrames,
  allSections,
  buildFrameJson,
  buildIndex,
  buildSectionJson,
  DEFAULT_IMAGES_MODE,
  dumpContents,
  emptyMessage,
  errorDetail,
  FetchResult,
  FrameComponent,
  frameComponentOf,
  ImagesMode,
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
  STYLES_JSON_NAME,
  VARIABLES_JSON_NAME,
} from "./plan";
import zipReadme from "./zip-readme.md";
import { buildZip, utf8Encode, ZipEntry } from "./zip";

export const PLUGIN_VERSION = "0.4.1";

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
  /** SVG で書き出したノードの id → ZIP 内パス。失敗も undefined で覚え、書き出し直さない */
  readonly svgs = new Map<string, string | undefined>();
  private readonly warned = new Set<string>();

  constructor(private readonly warn: (message: string) => void) {}

  /** 同じ変数やスタイルを使うノードの数だけ、同じ warning を並べない */
  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  /** 一覧の取得に失敗しても書き出しは止めず、warning に残して空として続ける */
  async listOrWarn<T>(label: string, get: () => Promise<T[]>): Promise<T[]> {
    try {
      return await get();
    } catch (e) {
      this.warnOnce(`list:${label}`, `${label}の取得に失敗: ${errorDetail(e)}`);
      return [];
    }
  }
}

function jsonEntry(name: string, value: unknown): ZipEntry {
  return { name, data: utf8Encode(JSON.stringify(value, null, 2)) };
}

/**
 * ファイルの変数と、ノードやスタイルが使っていた変数を、alias の参照先まで辿ってコレクションごとにまとめる。
 * スタイルの束縛も辿るので、styles.json を組んだあとに呼ぶ
 */
async function variablesJson(resolver: Resolver): Promise<unknown> {
  const local = await resolver.listOrWarn("ファイルの変数の一覧", () =>
    figma.variables.getLocalVariablesAsync()
  );
  const collections = await resolver.listOrWarn("ファイルの変数のコレクションの一覧", () =>
    figma.variables.getLocalVariableCollectionsAsync()
  );
  const localById = new Map(local.map((v) => [v.id, v]));
  const closure = await variableClosure(
    [...localById.keys(), ...resolver.seenVariables],
    async (id) => localById.get(id) ?? resolver.variable(id)
  );
  for (const id of closure.missing) resolver.warnOnce(`variable:${id}`, `変数を引けない: ${id}`);
  const collectionIds = new Set(collections.map((c) => c.id));
  for (const variable of closure.variables) {
    const collectionId = variable.variableCollectionId;
    if (collectionIds.has(collectionId)) continue;
    const collection = await resolver.collection(collectionId);
    if (collection === null) {
      resolver.warnOnce(
        `collection:${collectionId}`,
        `変数のコレクションを引けない (この変数は variables.json に入らない): ${variable.name} (${collectionId})`
      );
      continue;
    }
    collections.push(collection);
    collectionIds.add(collectionId);
  }
  const names = new Map(closure.variables.map((v) => [v.id, v.name]));
  return buildVariablesJson(collections, closure.variables, (id) => names.get(id));
}

/** ファイルのスタイルと、ノードが使っていたライブラリのスタイル */
async function stylesJson(resolver: Resolver, ctx: SerializeContext): Promise<unknown> {
  const local: BaseStyle[] = [
    ...(await resolver.listOrWarn("ファイルの色のスタイルの一覧", () => figma.getLocalPaintStylesAsync())),
    ...(await resolver.listOrWarn("ファイルのテキストスタイルの一覧", () => figma.getLocalTextStylesAsync())),
    ...(await resolver.listOrWarn("ファイルのエフェクトスタイルの一覧", () => figma.getLocalEffectStylesAsync())),
    ...(await resolver.listOrWarn("ファイルのグリッドスタイルの一覧", () => figma.getLocalGridStylesAsync())),
  ];
  const localIds = new Set(local.map((s) => s.id));
  const styles = [...local];
  for (const id of resolver.seenStyles) {
    if (localIds.has(id)) continue;
    const style = await resolver.style(id);
    if (style !== null) styles.push(style);
  }
  const out: unknown[] = [];
  for (const style of styles) {
    try {
      out.push(await serializeStyle(style, ctx));
    } catch (e) {
      ctx.warn(`スタイルの読み取りに失敗: ${style.name} (${style.id}): ${errorDetail(e)}`);
    }
  }
  return { styles: out };
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

export interface DumpTarget {
  roots: readonly SceneNode[];
  source: RootSource;
  /** index.json の meta.scope */
  scope: string;
}

export interface DumpPayload {
  zipName: string;
  zip: Uint8Array;
  indexText: string;
  meta: Record<string, unknown>;
}

export type DumpOutcome = { type: "result"; payload: DumpPayload } | { type: "empty"; message: string };

export function currentPageTarget(): DumpTarget {
  const selection = figma.currentPage.selection;
  return selection.length > 0
    ? { roots: selection, source: "selection", scope: "selection" }
    : {
        roots: figma.currentPage.children,
        source: "page",
        scope: `page:${figma.currentPage.name}`,
      };
}

/**
 * images が none なら png・SVG・画像を出さず、only なら png と画像だけを出す。
 * only でも構造は書き出しと同じように辿る (image fill の imageRef と画面フレームのコンポーネント名を集めるため)
 */
export async function dump(
  target: DumpTarget,
  screenshotScale: number,
  images: ImagesMode = DEFAULT_IMAGES_MODE
): Promise<DumpOutcome> {
  const plan = planDump(target.roots, sortInDocumentOrder);
  const empty = emptyMessage(plan, target.source);
  if (empty !== null) return { type: "empty", message: empty };
  const frames = allFrames(plan);
  const sections = allSections(plan);
  const contents = dumpContents(images);

  const out = newExportOutput(
    plan.hiddenRoots.map((node) => `非表示のため除外: ${node.name} (${node.id})`)
  );
  for (const long of longPaths(plan, MAX_ZIP_PATH_CHARS, contents)) {
    out.warnings.push(`パスが長い (${long.length} 文字): ${long.path}`);
  }
  const imageHashes = new Set<string>();
  const resolver = new Resolver((message) => out.warnings.push(message));
  const ctx: SerializeContext = {
    mixed: figma.mixed,
    resolveVariable: async (id, consumer) => {
      resolver.seenVariables.add(id);
      const variable = await resolver.variable(id);
      if (variable === null) {
        resolver.warnOnce(`variable:${id}`, `変数を引けない: ${id}`);
        return { name: `<unresolved:${id}>` };
      }
      if (consumer === undefined) return { name: variable.name };
      try {
        return { name: variable.name, resolved: variable.resolveForConsumer(consumer as SceneNode) };
      } catch (e) {
        resolver.warnOnce(`value:${id}`, `変数の値を解決できない: ${variable.name}: ${errorDetail(e)}`);
        return { name: variable.name };
      }
    },
    styleName: async (id) => {
      resolver.seenStyles.add(id);
      const style = await resolver.style(id);
      if (style === null) resolver.warnOnce(`style:${id}`, `スタイルを引けない: ${id}`);
      return style?.name;
    },
    modeName: async (collectionId, modeId) => {
      const collection = await resolver.collection(collectionId);
      const mode = collection?.modes.find((m) => m.modeId === modeId);
      if (collection === null || mode === undefined) {
        resolver.warnOnce(
          `mode:${collectionId}:${modeId}`,
          `変数のモードを引けない: コレクション ${collectionId} のモード ${modeId}`
        );
        return undefined;
      }
      return { collection: collection.name, mode: mode.name };
    },
    componentName: async (id) => {
      const node = await resolver.node(id);
      if (node === null) resolver.warnOnce(`component:${id}`, `コンポーネントを引けない: ${id}`);
      return node?.name;
    },
    registerImage: (hash) => {
      imageHashes.add(hash);
    },
    warn: (message) => {
      out.warnings.push(message);
    },
  };
  if (contents.svgs) {
    ctx.exportSvg = async (node, hidden) => {
      const scene = node as SceneNode;
      // 非表示のノードは exportAsync が「表示されているレイヤーが無い」で失敗するので、
      // 非表示の INSTANCE は元のコンポーネントを書き出す (インスタンスで上書きした色や大きさは入らない)
      const target =
        hidden && scene.type === "INSTANCE" ? await orNull(() => scene.getMainComponentAsync()) : scene;
      if (target === null) {
        ctx.warn(`SVG の元のコンポーネントを取れない: ${scene.name} (${scene.id})`);
        return undefined;
      }
      if (resolver.svgs.has(target.id)) {
        const cached = resolver.svgs.get(target.id);
        if (cached === undefined && target !== scene) {
          ctx.warn(`SVG の元のコンポーネントの書き出しに失敗済み: ${scene.name} (${scene.id})`);
        }
        return cached;
      }
      // 元のコンポーネントを書き出すときは、warning にどのインスタンスの SVG かも残す
      const label =
        target === scene
          ? target
          : { id: target.id, name: `${target.name} (${scene.name} ${scene.id} の元のコンポーネント)` };
      const path = recordSvg(out, label, await fetchBytes(() => target.exportAsync({ format: "SVG" })));
      resolver.svgs.set(target.id, path);
      return path;
    };
  }

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
    if (contents.structure) out.entries.push(jsonEntry(frame.json, buildFrameJson(frame, dumped)));
    const component = frameComponentOf(dumped);
    if (component !== undefined) frameComponents.set(frame.id, component);
    if (contents.screenshots) {
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
    }
    postProgress("frames", i + 1, frames.length, frame.name);
  }

  const sectionsWithJson = sections.filter((section) => section.sectionJson !== undefined);
  for (let i = 0; i < sectionsWithJson.length; i += 1) {
    const section = sectionsWithJson[i];
    const nodes: DumpNode[] = [];
    for (const node of section.others) {
      nodes.push(await serialize(node));
    }
    if (contents.structure) {
      out.entries.push(jsonEntry(section.sectionJson as string, buildSectionJson(section, nodes)));
    }
    postProgress("sections", i + 1, sectionsWithJson.length);
  }

  // styles.json の paint の image fill も assets に載せるため、画像を取る前に組む (only でも組んで、画像だけ使う)。
  // variables.json はスタイルが束縛した変数も入れるので、styles.json のあとに組む
  const styles = jsonEntry(STYLES_JSON_NAME, await stylesJson(resolver, ctx));
  const structureEntries = contents.structure
    ? [jsonEntry(VARIABLES_JSON_NAME, await variablesJson(resolver)), styles]
    : [];

  // image fill の元画像。index.json の assets で imageRef → ZIP 内パスを引けるようにする
  const hashes = contents.assets ? Array.from(imageHashes) : [];
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
      images,
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
    ...structureEntries,
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
        images,
        sectionCount: sections.length,
        assetCount: out.writtenAssets.size,
        zipBytes: zip.length,
        warnings: out.warnings,
      },
    },
  };
}

export function failureText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
