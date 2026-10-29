/**
 * ファイル全体のノードのスナップショット (scripts/snapshot.js が返すもの) を 2 つ比べ、変わったノードを、書き出した範囲の中と外に分ける。
 * 書き換えの script が意図しない場所を変えていないかを確かめるために使う。手順は .claude/skills/figma-safe-edit/SKILL.md。
 */
import { readFileSync } from "node:fs";

/** snapshot.js の返り値 (POST /run の応答の value) */
export interface Snapshot {
  v: 2;
  file: string;
  /** figma.fileKey。取れないプラグインでは null */
  fileKey?: string | null;
  takenAt: string;
  pages: Record<string, string>;
  /**
   * "<ノードの id>|<親の id (ページ直下ならページの id。ページ自身なら空)>|<要約>[|<メインコンポーネントの id (インスタンスだけ)>]" (id に | は入らない)。
   * 要約は区分ごとのハッシュ (HASH_WIDTH 文字ずつ) をつないだもの (ASPECTS の順。ページは name と children の 2 つ、document は children だけ)
   */
  nodes: string[];
}

/** 要約の区分 (snapshot.js の ASPECT_FIELDS と同じ順)。変わったノードについて、どの区分が変わったかを出す */
export const ASPECTS = ["name", "geometry", "look", "text", "layout", "component", "children"] as const;
export type Aspect = (typeof ASPECTS)[number];
/** 区分ごとのハッシュの文字数 (snapshot.js の hash と同じ) */
export const HASH_WIDTH = 4;
const PAGE_ASPECTS: readonly Aspect[] = ["name", "children"];
const DOCUMENT_ASPECTS: readonly Aspect[] = ["children"];
const SUPPORTED_VERSION = 2;
/** ページの並びを持つ、ファイル全体のノードの id */
export const DOCUMENT_ID = "document";

export interface ChangedNode {
  id: string;
  /** ノードのあるページの名前 (after に無ければ before の) */
  page: string;
  /** moved は、要約は同じでも親が変わった (別の親やページへ移した) ノード */
  kind: "changed" | "added" | "removed" | "moved";
  /** changed のとき、変わった区分 (ASPECTS の順)。要約の形が区分に対応しないときは省く */
  aspects?: Aspect[];
}

export interface PropagatedNode extends ChangedNode {
  /** 範囲の中で変わった、元のノード (メインコンポーネントの中のノード) の id */
  from: string;
}

export interface SnapshotDiff {
  /** スナップショットを取ったファイルの名前 (before と after で違えば、別のファイルを比べている) */
  file: { before: string; after: string };
  nodes: { before: number; after: number };
  /** 書き出した範囲 (inside の id とその子孫) の中で変わったノード */
  inside: ChangedNode[];
  /**
   * 範囲の中のノードがメインコンポーネントの中にあり、その変化がインスタンスに映ったもの (インスタンスの中のノードの id は `I<インスタンス>;…;<元のノード>`)。
   * 範囲の外にあるが、範囲の中の書き換えの結果なので、意図の確認は「その元のノードを変えてよかったか」に帰着する
   */
  propagated: PropagatedNode[];
  /** 書き出した範囲の外で変わったノード (propagated を除く)。空でなければ、書き換えが意図しない場所に及んでいる */
  outside: ChangedNode[];
}

/** POST /run の応答 ({ seq, value }) か、value そのものを読む */
export function readSnapshot(file: string): Snapshot {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { value?: unknown } & Partial<Snapshot>;
  const candidate = (parsed.value ?? parsed) as Partial<Snapshot> & { v?: unknown };
  if (typeof candidate.v !== "number" || !Array.isArray(candidate.nodes) || typeof candidate.pages !== "object" || candidate.pages === null) {
    throw new Error(`スナップショットのファイルでない (snapshot.js の返り値を保存したものを渡す): ${file}`);
  }
  if (candidate.v !== SUPPORTED_VERSION) {
    throw new Error(`古い形のスナップショット (v${candidate.v}。今の snapshot.js は v${SUPPORTED_VERSION})。取り直す: ${file}`);
  }
  return candidate as Snapshot;
}

function chunks(summary: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < summary.length; i += HASH_WIDTH) out.push(summary.slice(i, i + HASH_WIDTH));
  return out;
}

/** 前後の要約を区分ごとに比べ、変わった区分を返す。区分の数が合わない (形が違う) ときは undefined */
function changedAspects(id: string, before: string, after: string): Aspect[] | undefined {
  if (before.length !== after.length || before.length % HASH_WIDTH !== 0) return undefined;
  const a = chunks(before);
  const b = chunks(after);
  const names =
    id === DOCUMENT_ID
      ? DOCUMENT_ASPECTS
      : a.length === ASPECTS.length
        ? ASPECTS
        : a.length === PAGE_ASPECTS.length
          ? PAGE_ASPECTS
          : null;
  if (names === null || names.length !== a.length) return undefined;
  return names.filter((_, i) => a[i] !== b[i]);
}

interface Entry {
  parent: string;
  hash: string;
  /** インスタンスならメインコンポーネントの id。それ以外は空 */
  main: string;
}

function index(snapshot: Snapshot): Map<string, Entry> {
  return new Map(
    snapshot.nodes.map((line) => {
      const [id, parent, hash, main = ""] = line.split("|");
      return [id, { parent, hash, main }];
    })
  );
}

/** id から親をたどって、inside のどれかか、そのページに着くまで上がる。inside に当たれば範囲の中 */
function isInside(id: string, entries: Map<string, Entry>, inside: ReadonlySet<string>): boolean {
  let current: string | undefined = id;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (inside.has(current)) return true;
    seen.add(current);
    current = entries.get(current)?.parent;
  }
  return false;
}

function pageOf(id: string, entries: Map<string, Entry>, pages: Record<string, string>): string {
  let current: string | undefined = id;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (current in pages) return pages[current];
    seen.add(current);
    current = entries.get(current)?.parent;
  }
  return "";
}

/**
 * before と after を比べる。insideIds は書き出した範囲の根 (export の nodeIds)。
 * 範囲の根のスナップショットには子の並びが入るので、子を足す・消すと根も changed に出る (範囲の中)
 */
export function diffSnapshots(before: Snapshot, after: Snapshot, insideIds: readonly string[]): SnapshotDiff {
  if (before.fileKey != null && after.fileKey != null && before.fileKey !== after.fileKey) {
    throw new Error(`別のファイルのスナップショットを比べている (before: ${before.fileKey}, after: ${after.fileKey})`);
  }
  const b = index(before);
  const a = index(after);
  const inside = new Set(insideIds);
  const changes: ChangedNode[] = [];
  for (const [id, entry] of a) {
    const prev = b.get(id);
    if (prev === undefined) changes.push({ id, page: pageOf(id, a, after.pages), kind: "added" });
    else if (prev.hash !== entry.hash) {
      const aspects = changedAspects(id, prev.hash, entry.hash);
      changes.push({ id, page: pageOf(id, a, after.pages), kind: "changed", ...(aspects === undefined ? {} : { aspects }) });
    }
    else if (prev.parent !== entry.parent) changes.push({ id, page: pageOf(id, a, after.pages), kind: "moved" });
  }
  for (const id of b.keys()) {
    if (!a.has(id)) changes.push({ id, page: pageOf(id, b, before.pages), kind: "removed" });
  }
  const within = (c: ChangedNode) => isInside(c.id, c.kind === "removed" ? b : a, inside);
  const insideChanges = changes.filter(within);
  const insideIdsChanged = new Set(insideChanges.map((c) => c.id));
  const propagated: PropagatedNode[] = [];
  const outside: ChangedNode[] = [];
  for (const change of changes.filter((c) => !within(c))) {
    const entry = (change.kind === "removed" ? b : a).get(change.id);
    const from = propagatedFrom(change.id, entry?.main ?? "", insideIdsChanged);
    if (from === null) outside.push(change);
    else propagated.push({ ...change, from });
  }
  return {
    file: { before: before.file, after: after.file },
    nodes: { before: before.nodes.length, after: after.nodes.length },
    inside: insideChanges,
    propagated,
    outside,
  };
}

/**
 * 範囲の中で変わったノードが映った先なら、その元のノードの id。
 * インスタンスの中のノード (`I<インスタンス>;…;<元のノード>`) は元のノードで、インスタンス本体 (メインコンポーネントに子を足す・消すと本体の子の並びが変わる) はメインコンポーネントで見る
 */
function propagatedFrom(id: string, main: string, insideIdsChanged: ReadonlySet<string>): string | null {
  if (id.startsWith("I")) {
    const origin = id.slice(id.lastIndexOf(";") + 1);
    if (insideIdsChanged.has(origin)) return origin;
  }
  return main !== "" && insideIdsChanged.has(main) ? main : null;
}
