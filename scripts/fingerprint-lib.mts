/**
 * ファイル全体のノードの指紋 (scripts/fingerprint.js が返すもの) を 2 つ比べ、変わったノードを、書き出した範囲の中と外に分ける。
 * 書き換えの script が意図しない場所を変えていないかを確かめるために使う。手順は .claude/skills/figma-safe-edit/SKILL.md。
 */
import { readFileSync } from "node:fs";

/** fingerprint.js の返り値 (POST /run の応答の value) */
export interface Fingerprint {
  v: 1;
  file: string;
  takenAt: string;
  pages: Record<string, string>;
  /** "<ノードの id>|<親の id (ページ直下ならページの id)>|<指紋>" (id に | は入らない) */
  nodes: string[];
}

export interface ChangedNode {
  id: string;
  /** ノードのあるページの名前 (after に無ければ before の) */
  page: string;
  kind: "changed" | "added" | "removed";
}

export interface PropagatedNode extends ChangedNode {
  /** 範囲の中で変わった、元のノード (メインコンポーネントの中のノード) の id */
  from: string;
}

export interface FingerprintDiff {
  /** 指紋を取ったファイルの名前 (before と after で違えば、別のファイルを比べている) */
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
export function readFingerprint(file: string): Fingerprint {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { value?: unknown } & Partial<Fingerprint>;
  const candidate = (parsed.value ?? parsed) as Partial<Fingerprint>;
  if (candidate.v !== 1 || !Array.isArray(candidate.nodes) || typeof candidate.pages !== "object" || candidate.pages === null) {
    throw new Error(`指紋のファイルでない (fingerprint.js の返り値を保存したものを渡す): ${file}`);
  }
  return candidate as Fingerprint;
}

interface Entry {
  parent: string;
  hash: string;
}

function index(fp: Fingerprint): Map<string, Entry> {
  return new Map(
    fp.nodes.map((line) => {
      const [id, parent, hash] = line.split("|");
      return [id, { parent, hash }];
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
 * 範囲の根の指紋には子の並びが入るので、子を足す・消すと根も changed に出る (範囲の中)
 */
export function diffFingerprints(before: Fingerprint, after: Fingerprint, insideIds: readonly string[]): FingerprintDiff {
  const b = index(before);
  const a = index(after);
  const inside = new Set(insideIds);
  const changes: ChangedNode[] = [];
  for (const [id, entry] of a) {
    const prev = b.get(id);
    if (prev === undefined) changes.push({ id, page: pageOf(id, a, after.pages), kind: "added" });
    else if (prev.hash !== entry.hash) changes.push({ id, page: pageOf(id, a, after.pages), kind: "changed" });
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
    const from = propagatedFrom(change.id, insideIdsChanged);
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

/** インスタンスの中のノードの id (`I<インスタンス>;…;<元のノード>`) の元のノードが、範囲の中で変わったノードなら、その id */
function propagatedFrom(id: string, insideIdsChanged: ReadonlySet<string>): string | null {
  if (!id.startsWith("I")) return null;
  const origin = id.slice(id.lastIndexOf(";") + 1);
  return insideIdsChanged.has(origin) ? origin : null;
}
