/**
 * 書き出し計画 (schema: dump-v2) の組み立て
 *
 * Figma API 非依存の純関数 (figma グローバルを参照しない)。
 * 選択 (またはページ直下) のノードから「どのノードを ZIP のどのパスへ出すか」を決め、
 * index.json・画面フレーム json・_section.json の形を組み立てる。
 * スクリーンショットと画像の取得結果を ZIP エントリと warning に振り分ける処理もここに置く。
 * node --test で素のオブジェクトを使って検証できるようにする。
 *
 * 並べ替え (shared/nodeOrder.ts の sortInDocumentOrder) は引数で受け取る。
 * このファイルが shared を import すると、テスト側の tsc (NodeNext) が拡張子なしの
 * 相対 import を拒むため。
 */

export const SCHEMA_VERSION = "dump-v2";

export const SECTION_JSON_NAME = "_section.json";

/** shared/nodeOrder.ts の OrderableNode と同じ形 */
export interface DocNode {
  readonly id: string;
  readonly parent: DocParent | null;
}

export interface DocParent extends DocNode {
  readonly children: readonly DocNode[];
}

export type DocumentOrderSort = <T extends DocNode>(nodes: readonly T[]) => T[];

export interface PlanNode extends DocNode {
  readonly name: string;
  readonly type: string;
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly absoluteTransform: readonly (readonly number[])[];
  readonly children?: readonly PlanNode[];
}

export interface Placement {
  x: number;
  y: number;
  absoluteX: number;
  absoluteY: number;
  width: number;
  height: number;
}

export interface SectionRef {
  id: string;
  name: string;
  dir: string;
}

export interface FramePlan<T extends PlanNode> extends Placement {
  node: T;
  id: string;
  name: string;
  section: SectionRef | null;
  png: string;
  json: string;
}

export interface SectionPlan<T extends PlanNode> extends Placement {
  node: T;
  id: string;
  name: string;
  dir: string;
  frames: FramePlan<T>[];
  sections: SectionPlan<T>[];
  /** 画面フレームでもセクションでもない子。空なら _section.json を作らない */
  others: T[];
  sectionJson?: string;
}

export interface DumpPlan<T extends PlanNode> {
  sections: SectionPlan<T>[];
  frames: FramePlan<T>[];
  /** 渡されたルートのうち非表示のため除いたもの (呼び出し側が warning に残す) */
  hiddenRoots: T[];
}

// ---------------------------------------------------------------------------
// ファイル名
// ---------------------------------------------------------------------------

const UNSAFE_NAME_CHARS = /[\/\\:*?"<>|\s\u0000-\u001f\u007f]+/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Windows は拡張子付き (`CON.notes`・`CON.1-2.png`) でも予約名として扱うので、
 * 最初のドットより前 (末尾の空白・ドットを除く) で判定する
 */
function isWindowsReservedName(name: string): boolean {
  const stem = name.split(".")[0].replace(/[ .]+$/, "");
  return WINDOWS_RESERVED_NAME.test(stem);
}

/** ZIP 内・展開後のファイルシステム双方で安全な名前にする (Windows 含む) */
export function safeName(name: string): string {
  // 先頭の . は隠しファイル・隠しディレクトリになるので取る
  const cleaned = name.replace(UNSAFE_NAME_CHARS, "-").replace(/^[-.]+|-+$/g, "");
  // UTF-16 単位で切るとサロゲートペアが割れ、ZIP に不正な UTF-8 の名前が入る
  const trimmed = Array.from(cleaned).slice(0, 40).join("");
  if (trimmed.length === 0) return "node";
  return isWindowsReservedName(trimmed) ? `_${trimmed}` : trimmed;
}

/** ノード ID ("123:456") や imageRef をファイル名に使える形へ */
export function safeId(id: string): string {
  return id.replace(/[^0-9a-zA-Z]+/g, "-");
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// 判定・座標
// ---------------------------------------------------------------------------

export function isSection(node: PlanNode): boolean {
  return node.type === "SECTION";
}

/**
 * セクション直下の子の判定。Figma データとして FRAME なら大きさを問わず画面フレームにする
 * (ノイズは読む側が除く。プラグインはデータを落とさない)
 */
export function isScreenFrame(node: PlanNode): boolean {
  return node.type === "FRAME";
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * ノードの原点 (回転前の左上) のページ座標。x/y も同じ原点なので、回転していても
 * 「親の absoluteX + x = absoluteX」が成り立つ。absoluteBoundingBox (外接矩形) は使わない
 */
export function absolutePosition(node: PlanNode): { x: number; y: number } {
  const t = node.absoluteTransform;
  return { x: r2(t[0][2]), y: r2(t[1][2]) };
}

function placement(node: PlanNode): Placement {
  const abs = absolutePosition(node);
  return {
    x: r2(node.x),
    y: r2(node.y),
    absoluteX: abs.x,
    absoluteY: abs.y,
    width: r2(node.width),
    height: r2(node.height),
  };
}

// ---------------------------------------------------------------------------
// 計画
// ---------------------------------------------------------------------------

/** 祖先も同じ列に入っているノードを落とす (祖先側の出力に含まれるため) */
export function dropDescendants<T extends PlanNode>(nodes: readonly T[]): T[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.filter((node) => {
    const visited = new Set<string>([node.id]);
    let current = node.parent;
    while (current && !visited.has(current.id)) {
      if (ids.has(current.id)) return false;
      visited.add(current.id);
      current = current.parent;
    }
    return true;
  });
}

function planFrame<T extends PlanNode>(
  node: T,
  dir: string,
  section: SectionRef | null
): FramePlan<T> {
  const base = joinPath(dir, `${safeName(node.name)}.${safeId(node.id)}`);
  return {
    node,
    id: node.id,
    name: node.name,
    section,
    png: `${base}.png`,
    json: `${base}.json`,
    ...placement(node),
  };
}

function planSection<T extends PlanNode>(
  node: T,
  parentDir: string,
  sort: DocumentOrderSort
): SectionPlan<T> {
  const dir = joinPath(parentDir, `${safeName(node.name)}.${safeId(node.id)}`);
  const ref: SectionRef = { id: node.id, name: node.name, dir };
  const plan: SectionPlan<T> = {
    node,
    id: node.id,
    name: node.name,
    dir,
    ...placement(node),
    frames: [],
    sections: [],
    others: [],
  };
  const children = sort((node.children ?? []) as readonly T[]);
  for (const child of children) {
    if (!child.visible) continue;
    if (isSection(child)) plan.sections.push(planSection(child, dir, sort));
    else if (isScreenFrame(child)) plan.frames.push(planFrame(child, dir, ref));
    else plan.others.push(child);
  }
  if (plan.others.length > 0) plan.sectionJson = joinPath(dir, SECTION_JSON_NAME);
  return plan;
}

/**
 * roots は選択ノード、または未選択時のページ直下のノード。
 * SECTION は再帰し、それ以外は型とサイズを問わず ZIP 直下の画面フレームにする。
 * sort には shared/nodeOrder.ts の sortInDocumentOrder を渡す
 */
export function planDump<T extends PlanNode>(
  roots: readonly T[],
  sort: DocumentOrderSort
): DumpPlan<T> {
  const plan: DumpPlan<T> = { sections: [], frames: [], hiddenRoots: [] };
  for (const node of sort(dropDescendants(roots))) {
    if (!node.visible) plan.hiddenRoots.push(node);
    else if (isSection(node)) plan.sections.push(planSection(node, "", sort));
    else plan.frames.push(planFrame(node, "", null));
  }
  return plan;
}

/**
 * 画面フレームを列挙する。順序は、トップレベルのセクションごとに
 * 「そのセクション直下のフレーム → ネストしたセクションを同じ規則で再帰」、
 * 最後に ZIP 直下のフレーム
 */
export function allFrames<T extends PlanNode>(plan: DumpPlan<T>): FramePlan<T>[] {
  const out: FramePlan<T>[] = [];
  const walk = (section: SectionPlan<T>): void => {
    out.push(...section.frames);
    section.sections.forEach(walk);
  };
  plan.sections.forEach(walk);
  out.push(...plan.frames);
  return out;
}

export function allSections<T extends PlanNode>(plan: DumpPlan<T>): SectionPlan<T>[] {
  const out: SectionPlan<T>[] = [];
  const walk = (section: SectionPlan<T>): void => {
    out.push(section);
    section.sections.forEach(walk);
  };
  plan.sections.forEach(walk);
  return out;
}

// ---------------------------------------------------------------------------
// JSON の形
// ---------------------------------------------------------------------------

export interface IndexMeta {
  fileName: string;
  pluginVersion: string;
  exportedAt: string;
  scope: string;
  warnings: string[];
}

function frameEntry<T extends PlanNode>(
  frame: FramePlan<T>,
  writtenPngs: ReadonlySet<string>
): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: frame.id, name: frame.name };
  if (writtenPngs.has(frame.png)) entry.png = frame.png;
  entry.json = frame.json;
  return { ...entry, ...placementOf(frame) };
}

function placementOf(p: Placement): Placement {
  return {
    x: p.x,
    y: p.y,
    absoluteX: p.absoluteX,
    absoluteY: p.absoluteY,
    width: p.width,
    height: p.height,
  };
}

function sectionEntry<T extends PlanNode>(
  section: SectionPlan<T>,
  writtenPngs: ReadonlySet<string>
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: section.id,
    name: section.name,
    dir: section.dir,
    ...placementOf(section),
    frames: section.frames.map((f) => frameEntry(f, writtenPngs)),
    sections: section.sections.map((s) => sectionEntry(s, writtenPngs)),
  };
  if (section.sectionJson !== undefined) entry.sectionJson = section.sectionJson;
  return entry;
}

/**
 * writtenPngs は書き出しに成功した png のパス。失敗したフレームは png キー無しで載せる。
 * writtenAssets は書き出しに成功した imageRef → ZIP 内パス。失敗した imageRef はキーを作らない
 */
export function buildIndex<T extends PlanNode>(
  plan: DumpPlan<T>,
  meta: IndexMeta,
  writtenPngs: ReadonlySet<string>,
  writtenAssets: ReadonlyMap<string, string>
): Record<string, unknown> {
  return {
    meta: {
      fileName: meta.fileName,
      pluginVersion: meta.pluginVersion,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: meta.exportedAt,
      scope: meta.scope,
      warnings: meta.warnings,
    },
    sections: plan.sections.map((s) => sectionEntry(s, writtenPngs)),
    frames: plan.frames.map((f) => frameEntry(f, writtenPngs)),
    assets: assetsObject(writtenAssets),
  };
}

function assetsObject(writtenAssets: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  writtenAssets.forEach((path, imageRef) => {
    out[imageRef] = path;
  });
  return out;
}

export function buildFrameJson<T extends PlanNode, N>(
  frame: FramePlan<T>,
  node: N
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    section: frame.section,
    absoluteX: frame.absoluteX,
    absoluteY: frame.absoluteY,
    node,
  };
}

export function buildSectionJson<T extends PlanNode, N>(
  section: SectionPlan<T>,
  nodes: readonly N[]
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    section: {
      id: section.id,
      name: section.name,
      dir: section.dir,
      ...placementOf(section),
    },
    nodes,
  };
}

// ---------------------------------------------------------------------------
// 書き出し前後の判定と記録 (Figma API の呼び出しは code.ts に残す)
// ---------------------------------------------------------------------------

/** 出すものが無いときの UI 向けメッセージ。出すものがあれば null */
export function emptyMessage<T extends PlanNode>(
  plan: DumpPlan<T>,
  hasSelection: boolean
): string | null {
  if (plan.frames.length > 0 || plan.sections.length > 0) return null;
  if (plan.hiddenRoots.length === 0) {
    return "対象がありません (何かを選択するか、空でないページで実行してください)";
  }
  return hasSelection
    ? "選択したノードはすべて非表示です"
    : "ページ直下のノードはすべて非表示です";
}

/** これを超える ZIP 内パスは、展開先によってはパス長の上限に当たるので warning に残す */
export const MAX_ZIP_PATH_CHARS = 200;

export interface LongPath {
  path: string;
  /** コードポイント数 */
  length: number;
}

/** セクションのディレクトリ・画面フレームの png/json・_section.json のうち limit 文字を超えるもの */
export function longPaths<T extends PlanNode>(plan: DumpPlan<T>, limit: number): LongPath[] {
  const paths: string[] = [];
  for (const section of allSections(plan)) {
    paths.push(section.dir);
    for (const frame of section.frames) paths.push(frame.png, frame.json);
    if (section.sectionJson !== undefined) paths.push(section.sectionJson);
  }
  for (const frame of plan.frames) paths.push(frame.png, frame.json);
  return paths
    .map((path) => ({ path, length: Array.from(path).length }))
    .filter((p) => p.length > limit);
}

export function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** zip.ts の ZipEntry と同じ形 */
export interface OutputEntry {
  name: string;
  data: Uint8Array;
}

export interface ExportOutput {
  entries: OutputEntry[];
  warnings: string[];
  writtenPngs: Set<string>;
  /** imageRef → ZIP 内パス */
  writtenAssets: Map<string, string>;
}

export function newExportOutput(warnings: string[] = []): ExportOutput {
  return { entries: [], warnings, writtenPngs: new Set(), writtenAssets: new Map() };
}

export type FetchResult = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown };

export function recordScreenshot(
  out: ExportOutput,
  frame: { id: string; name: string; png: string },
  result: FetchResult
): void {
  const label = `${frame.name} (${frame.id})`;
  if (!result.ok) {
    out.warnings.push(`スクリーンショット失敗: ${label}: ${errorDetail(result.error)}`);
  } else if (result.bytes.length === 0) {
    out.warnings.push(`スクリーンショット失敗: ${label}: 空の PNG`);
  } else {
    out.entries.push({ name: frame.png, data: result.bytes });
    out.writtenPngs.add(frame.png);
  }
}

export function imageExtension(bytes: Uint8Array): string {
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

/** result が null なのは getImageByHash が画像を返さなかったとき */
export function recordAsset(
  out: ExportOutput,
  imageRef: string,
  result: FetchResult | null
): void {
  if (result === null) {
    out.warnings.push(`画像が見つかりません: imageRef ${imageRef}`);
  } else if (!result.ok) {
    out.warnings.push(`画像の取得に失敗: imageRef ${imageRef}: ${errorDetail(result.error)}`);
  } else if (result.bytes.length === 0) {
    out.warnings.push(`画像の取得に失敗: imageRef ${imageRef}: 空のデータ`);
  } else {
    const path = `assets/${safeId(imageRef)}.${imageExtension(result.bytes)}`;
    out.entries.push({ name: path, data: result.bytes });
    out.writtenAssets.set(imageRef, path);
  }
}
