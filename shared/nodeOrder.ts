/**
 * ノード列の順序固定(Figma API 非依存の純関数)
 *
 * 抽出結果を「同じ入力から同じコード」にするため、走査対象のノード列を
 * document 上の位置(ルートからの sibling index 列)で並べ替える。
 * id / parent / children を持つ構造だけを見るので、テストでは素のオブジェクトで検証できる。
 */

export interface OrderableNode {
  readonly id: string;
  readonly parent: OrderableParent | null;
}

export interface OrderableParent extends OrderableNode {
  readonly children: readonly OrderableNode[];
}

interface DocumentKey {
  /** ルート直下から node までの sibling index 列 */
  readonly path: readonly number[];
  /** path をルートまで辿り切れたか。辿れなかった列は位置を主張しない */
  readonly resolved: boolean;
  readonly id: string;
}

/** parent.id → (child.id → sibling index)。同一 sort 呼び出し中だけ有効 */
type SiblingIndexCache = Map<string, Map<string, number>>;

const NO_INDEX = -1;

function siblingIndex(node: OrderableNode, cache: SiblingIndexCache): number {
  const parent = node.parent;
  if (!parent) return NO_INDEX;

  let indexById = cache.get(parent.id);
  if (!indexById) {
    indexById = new Map<string, number>();
    const children = parent.children;
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        indexById.set(children[i].id, i);
      }
    }
    cache.set(parent.id, indexById);
  }

  const index = indexById.get(node.id);
  return index === undefined ? NO_INDEX : index;
}

function documentKey(node: OrderableNode, cache: SiblingIndexCache): DocumentKey {
  const path: number[] = [];
  const visited = new Set<string>();
  let current: OrderableNode = node;

  while (current.parent) {
    if (visited.has(current.id)) return { path, resolved: false, id: node.id };
    visited.add(current.id);

    const index = siblingIndex(current, cache);
    if (index === NO_INDEX) return { path, resolved: false, id: node.id };

    path.unshift(index);
    current = current.parent;
  }

  return { path, resolved: true, id: node.id };
}

function compareIds(a: string, b: string): number {
  // 実行環境で結果が変わらないよう、locale ではなくコードポイントで比較する
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareKeys(a: DocumentKey, b: DocumentKey): number {
  if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;

  if (a.resolved) {
    const shared = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < shared; i += 1) {
      if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
    }
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  }

  return compareIds(a.id, b.id);
}

/**
 * document 上の位置で昇順に並べた新しい配列を返す。
 *
 * figma.currentPage.selection の順序は Figma 公式で未規定なので、
 * 走査対象は必ずこの関数を通して document 位置で固定する。
 * 位置を辿れないノード(親子関係が壊れている等)は末尾に寄せ、node ID で順序を決める。
 */
export function sortInDocumentOrder<T extends OrderableNode>(nodes: readonly T[]): T[] {
  const cache: SiblingIndexCache = new Map();
  const keyed = nodes.map((node) => ({ node, key: documentKey(node, cache) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map((entry) => entry.node);
}
