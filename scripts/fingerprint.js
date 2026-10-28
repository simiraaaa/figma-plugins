// Local Bridge の /run に送る script (async 関数の本体)。ファイル全体のノードの指紋を返す。
// 書き換える前と後に 1 回ずつ取り、scripts/fingerprint.mts の diff で比べると、書き出した範囲の外で変わったノードが分かる。
// 使い方は .claude/skills/figma-safe-edit/SKILL.md。
//
//   curl -s -X POST '<URL>/run?file=<fileKey>&timeout=580' -H 'X-Run-Token: <合言葉>' --data-binary @<リポ>/scripts/fingerprint.js > <保存先>.json
//
// 返り値: { v: 1, file, fileKey, takenAt, ms, pages: { <ページ id>: <名前> }, nodes: ["<id>|<親の id>|<指紋>[|<メインコンポーネントの id>]", ...] }
// (4 つ目はインスタンスだけ)
// (ノードごとに 1 つの文字列にするのは、dev サーバーが応答を字下げつきの JSON にするので、配列だと 1 万ノードで 900 KB になるため。返り値の上限は 100 万文字)
// ページも 1 つのノードとして入る (親は空。指紋は名前と直下の子の並び)。ファイル全体も id "document" のノードとして入る (指紋はページの並び)。
// 指紋は、種類・名前・表示・ロック・位置・大きさ・回転・不透明度・塗り・線・効果・角丸・制約・レイアウト・文字 (範囲ごとの書式を含む)・
// スタイル・コンポーネントの property・メインコンポーネント・子の並びから作る。
// 値の一覧は網羅ではない (Plugin API の値は多く、見ていない値 (書き出し設定・プラグインデータなど) の変化は拾えない)。
const startedAt = Date.now();
await figma.loadAllPagesAsync();

function hash(text) {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) {
    x ^= text.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0).toString(16).padStart(8, "0");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return "?";
  }
}

const FIELDS = [
  "visible",
  "locked",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "blendMode",
  "fills",
  "strokes",
  "strokeWeight",
  "effects",
  "cornerRadius",
  "constraints",
  "layoutMode",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "clipsContent",
  "characters",
  "textAlignHorizontal",
  "textAlignVertical",
  "textAutoResize",
  "textTruncation",
  "maxLines",
  "fillStyleId",
  "strokeStyleId",
  "effectStyleId",
  "textStyleId",
  "componentProperties",
  "variantProperties",
];

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

/** 指紋と、インスタンスならメインコンポーネントの id (指紋の比較で、メインコンポーネントの変化が映ったインスタンスを見分けるため) */
async function signature(node) {
  const parts = [node.type, node.name];
  let mainId = "";
  for (const field of FIELDS) {
    if (field in node) parts.push(field + "=" + safeJson(node[field]));
  }
  if (node.type === "TEXT") {
    try {
      parts.push("segments=" + safeJson(node.getStyledTextSegments(TEXT_SEGMENT_FIELDS)));
    } catch (e) {
      parts.push("segments=?");
    }
  }
  // dynamic-page では mainComponent を同期で読めない (getMainComponentAsync を使う。2026-10-28 に実測)
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    mainId = main ? main.id : "";
    parts.push("main=" + mainId);
  }
  if ("children" in node) parts.push("children=" + node.children.map((c) => c.id).join(","));
  return { hash: hash(parts.join("\u0001")), mainId };
}

const pages = {};
// ページ自体の並べ替えも拾えるよう、ファイル全体も 1 つのノード (id は document) にする
const nodes = ["document||" + hash(figma.root.children.map((p) => p.id).join(","))];
for (const page of figma.root.children) {
  pages[page.id] = page.name;
  // ページの名前の変更と直下の並べ替えも拾えるよう、ページも 1 つのノードにする
  nodes.push(page.id + "||" + hash([page.name, page.children.map((c) => c.id).join(",")].join("\u0001")));
  const stack = page.children.map((child) => [child, page.id]);
  while (stack.length > 0) {
    const [node, parentId] = stack.pop();
    const { hash: fingerprint, mainId } = await signature(node);
    nodes.push(node.id + "|" + parentId + "|" + fingerprint + (mainId === "" ? "" : "|" + mainId));
    if ("children" in node) {
      for (const child of node.children) stack.push([child, node.id]);
    }
  }
}
// fileKey は manifest の enablePrivatePluginApi で取れる (取れなければ null)。同名の別ファイルの指紋を取り違えないため
return { v: 1, file: figma.root.name, fileKey: figma.fileKey ?? null, takenAt: new Date().toISOString(), ms: Date.now() - startedAt, pages, nodes };
