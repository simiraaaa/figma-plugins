// Local Bridge の /run に送る script (async 関数の本体)。ファイル全体のノードの指紋を返す。
// 書き換える前と後に 1 回ずつ取り、scripts/fingerprint.mts の diff で比べると、書き出した範囲の外で変わったノードが分かる。
// 使い方は .claude/skills/figma-safe-edit/SKILL.md。
//
//   curl -s -X POST '<URL>/run?file=<fileKey>&timeout=580' -H 'X-Run-Token: <合言葉>' --data-binary @<リポ>/scripts/fingerprint.js > <保存先>.json
//
// 返り値: { v: 1, file, takenAt, ms, pages: { <ページ id>: <名前> }, nodes: ["<id>|<親の id>|<指紋>", ...] }
// (ノードごとに 1 つの文字列にするのは、dev サーバーが応答を字下げつきの JSON にするので、配列だと 1 万ノードで 900 KB になるため。返り値の上限は 100 万文字)
// 指紋は、種類・名前・表示・位置・大きさ・回転・不透明度・塗り・線・効果・角丸・レイアウト・文字・コンポーネントの property・子の並びから作る。
// 見ていない値 (制約・書き出し設定・プラグインデータなど) の変化は拾えない。
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
  "layoutMode",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "characters",
  "fontSize",
  "fontName",
  "componentProperties",
  "variantProperties",
];

async function signature(node) {
  const parts = [node.type, node.name];
  for (const field of FIELDS) {
    if (field in node) parts.push(field + "=" + safeJson(node[field]));
  }
  // dynamic-page では mainComponent を同期で読めない (getMainComponentAsync を使う。2026-10-28 に実測)
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    parts.push("main=" + (main ? main.id : ""));
  }
  if ("children" in node) parts.push("children=" + node.children.map((c) => c.id).join(","));
  return hash(parts.join("\u0001"));
}

const pages = {};
const nodes = [];
for (const page of figma.root.children) {
  pages[page.id] = page.name;
  const stack = page.children.map((child) => [child, page.id]);
  while (stack.length > 0) {
    const [node, parentId] = stack.pop();
    nodes.push(node.id + "|" + parentId + "|" + (await signature(node)));
    if ("children" in node) {
      for (const child of node.children) stack.push([child, node.id]);
    }
  }
}
return { v: 1, file: figma.root.name, takenAt: new Date().toISOString(), ms: Date.now() - startedAt, pages, nodes };
