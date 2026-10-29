// Local Bridge の /run に送る script (async 関数の本体)。ファイル全体のスナップショット (全ノードの要約) を返す。
// 書き換える前と後に 1 回ずつ取り、npm run compare (または scripts/snapshot.mts の diff) で比べると、書き出した範囲の外で変わったノードと、何が変わったかの区分が分かる。
// 使い方は .claude/skills/figma-safe-edit/SKILL.md。
//
//   curl -s -X POST '<URL>/run?file=<fileKey>&timeout=580' -H 'X-Run-Token: <合言葉>' --data-binary @<リポ>/scripts/snapshot.js > <保存先>.json
//
// 返り値: { v: 2, file, fileKey, takenAt, ms, pages: { <ページ id>: <名前> }, nodes: ["<id>|<親の id>|<要約>[|<メインコンポーネントの id>]", ...] }
// (4 つ目はインスタンスだけ)
// 要約は ASPECT_FIELDS の順に区分ごとのハッシュ (4 文字ずつ) をつないだもの。区分ごとに分けるのは、変わったノードについて「位置だけ変わった」のように何が変わったかを言うため。
// (ノードごとに 1 つの文字列にするのは、dev サーバーが応答を字下げつきの JSON にするので、配列だと 1 万ノードで 900 KB になるため。返り値の上限は 100 万文字)
// ページも 1 つのノードとして入る (親は空。要約は名前と直下の子の並び)。ファイル全体も id "document" のノードとして入る (要約はページの並び)。
// 値の一覧は網羅ではない (Plugin API の値は多く、見ていない値 (書き出し設定・プラグインデータなど) の変化は拾えない)。
const startedAt = Date.now();
await figma.loadAllPagesAsync();

// 区分ごとのハッシュは 24 ビットを base64url の 4 文字にする (scripts/snapshot-lib.mts の HASH_WIDTH と同じ)。
// 16 進 8 桁だと区分 7 つで 1 万ノードの返り値が 100 万文字に近づく
const HASH_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function hash(text) {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) {
    x ^= text.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  // 上位 24 ビットを 6 ビットずつ 4 文字に
  let out = "";
  for (let shift = 26; shift >= 8; shift -= 6) out += HASH_ALPHABET[(x >>> shift) & 63];
  return out;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return "?";
  }
}

// 要約の区分 (順番は scripts/snapshot-lib.mts の ASPECTS と同じにする)。
// name: 名前 / geometry: 位置・大きさ・回転・制約・親のレイアウトの中での伸び方 / look: 表示・塗り・線・効果・角丸・ベクターの形 /
// text: 文字と書式 / layout: 自動レイアウトの設定 / component: 種類・コンポーネントの property・メインコンポーネント / children: 子の並び
const ASPECT_FIELDS = {
  name: [],
  geometry: ["x", "y", "width", "height", "rotation", "constraints", "layoutAlign", "layoutGrow", "layoutPositioning"],
  look: [
    "visible",
    "locked",
    "opacity",
    "blendMode",
    "fills",
    "strokes",
    "strokeWeight",
    "effects",
    "cornerRadius",
    "vectorPaths",
    "vectorNetwork",
    "arcData",
    "pointCount",
    "innerRadius",
    "clipsContent",
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
  ],
  text: ["characters", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "maxLines", "textStyleId"],
  layout: ["layoutMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"],
  component: ["componentProperties", "variantProperties"],
  children: [],
};

// 文字の書式は範囲ごとに違いうる (ノード全体の fontSize などは figma.mixed になり、どの範囲を変えても同じ値のまま) ので、範囲ごとに取る
const TEXT_SEGMENT_FIELDS = [
  "fontSize",
  "fontName",
  "fontWeight",
  "textDecoration",
  "textCase",
  "lineHeight",
  "letterSpacing",
  "fills",
  "textStyleId",
  "fillStyleId",
  "hyperlink",
  "paragraphSpacing",
  "paragraphIndent",
  "listOptions",
  "indentation",
  "listSpacing",
  "textWrapStyle",
];

function fieldsOf(node, fields) {
  const parts = [];
  for (const field of fields) {
    if (field in node) parts.push(field + "=" + safeJson(node[field]));
  }
  return parts;
}

/** 区分ごとのハッシュと、インスタンスならメインコンポーネントの id (比較で、メインコンポーネントの変化が映ったインスタンスを見分けるため) */
async function signature(node) {
  const extra = { name: [node.name], component: [node.type], text: [], children: [] };
  let mainId = "";
  if (node.type === "TEXT") {
    try {
      extra.text.push("segments=" + safeJson(node.getStyledTextSegments(TEXT_SEGMENT_FIELDS)));
    } catch (e) {
      extra.text.push("segments=?");
    }
  }
  // dynamic-page では mainComponent を同期で読めない (getMainComponentAsync を使う。2026-10-28 に実測)
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    mainId = main ? main.id : "";
    extra.component.push("main=" + mainId);
  }
  if ("children" in node) extra.children.push(node.children.map((c) => c.id).join(","));
  const hashes = Object.keys(ASPECT_FIELDS).map((aspect) =>
    hash([...(extra[aspect] || []), ...fieldsOf(node, ASPECT_FIELDS[aspect])].join("\u0001"))
  );
  return { hash: hashes.join(""), mainId };
}

const pages = {};
// ページ自体の並べ替えも拾えるよう、ファイル全体も 1 つのノード (id は document) にする
const nodes = ["document||" + hash(figma.root.children.map((p) => p.id).join(","))];
for (const page of figma.root.children) {
  pages[page.id] = page.name;
  // ページの名前の変更と直下の並べ替えも拾えるよう、ページも 1 つのノードにする (name と children の 2 区分)
  nodes.push(page.id + "||" + hash(page.name) + hash(page.children.map((c) => c.id).join(",")));
  const stack = page.children.map((child) => [child, page.id]);
  while (stack.length > 0) {
    const [node, parentId] = stack.pop();
    const { hash: summary, mainId } = await signature(node);
    nodes.push(node.id + "|" + parentId + "|" + summary + (mainId === "" ? "" : "|" + mainId));
    if ("children" in node) {
      for (const child of node.children) stack.push([child, node.id]);
    }
  }
}
// fileKey は manifest の enablePrivatePluginApi で取れる (取れなければ null)。同名の別ファイルのスナップショットを取り違えないため
return { v: 2, file: figma.root.name, fileKey: figma.fileKey ?? null, takenAt: new Date().toISOString(), ms: Date.now() - startedAt, pages, nodes };
