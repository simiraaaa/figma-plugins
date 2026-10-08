/**
 * 書き出し計画 (schema: dump-v2) の組み立て
 *
 * Figma API 非依存の純関数 (figma グローバルを参照しない)。
 * 選択 (またはページ直下) のノードから「どのノードを ZIP のどのパスへ出すか」を決め、
 * index.json・画面フレーム json・_section.json の形を組み立てる。
 * node --test で素のオブジェクトを使って検証できるようにする。
 *
 * 並べ替え (shared/nodeOrder.ts の sortInDocumentOrder) は引数で受け取る。
 * このファイルが shared を import すると、テスト側の tsc (NodeNext) が拡張子なしの
 * 相対 import を拒むため。
 */

export const SCHEMA_VERSION = "dump-v2";

/** セクション直下の子を画面フレームとみなす最小サイズ (両方以上で画面) */
export const SCREEN_FRAME_MIN_SIZE = { width: 380, height: 700 } as const;

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
  readonly absoluteBoundingBox?: { readonly x: number; readonly y: number } | null;
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
}

// ---------------------------------------------------------------------------
// ファイル名
// ---------------------------------------------------------------------------

/** ZIP 内・展開後のファイルシステム双方で安全な名前にする (Windows 含む) */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  const trimmed = cleaned.slice(0, 40);
  return trimmed.length > 0 ? trimmed : "node";
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

export function isScreenFrame(node: PlanNode): boolean {
  return (
    node.width >= SCREEN_FRAME_MIN_SIZE.width && node.height >= SCREEN_FRAME_MIN_SIZE.height
  );
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ページ全体での位置。absoluteBoundingBox が null のノードは absoluteTransform の平行移動成分を使う */
export function absolutePosition(node: PlanNode): { x: number; y: number } {
  const box = node.absoluteBoundingBox;
  if (box) return { x: r2(box.x), y: r2(box.y) };
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
 * SECTION は再帰し、それ以外はサイズに関係なく ZIP 直下の画面フレームにする。
 * sort には shared/nodeOrder.ts の sortInDocumentOrder を渡す
 */
export function planDump<T extends PlanNode>(
  roots: readonly T[],
  sort: DocumentOrderSort
): DumpPlan<T> {
  const plan: DumpPlan<T> = { sections: [], frames: [] };
  const targets = sort(dropDescendants(roots)).filter((n) => n.visible);
  for (const node of targets) {
    if (isSection(node)) plan.sections.push(planSection(node, "", sort));
    else plan.frames.push(planFrame(node, "", null));
  }
  return plan;
}

/** 画面フレームを document 順 (セクションの深さ優先) で列挙する */
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

/** writtenPngs は書き出しに成功した png のパス。失敗したフレームは png キー無しで載せる */
export function buildIndex<T extends PlanNode>(
  plan: DumpPlan<T>,
  meta: IndexMeta,
  writtenPngs: ReadonlySet<string>
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
  };
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
