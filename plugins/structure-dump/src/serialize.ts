/**
 * Figma ノードツリー → AI 可読の構造 JSON (schema: dump-v1)
 *
 * Figma API 非依存の純関数 (figma グローバルを参照しない)。
 * mixed 番兵・Variables 解決・image fill の収集は ctx で注入し、
 * node --test で素のオブジェクトを使って検証できるようにする。
 *
 * 剪定方針: デフォルト値と非表示ノードは出力しない。AI がコード化に使う
 * 情報 (auto layout / テキスト / 色 / コンポーネント名と variant / Variables 名) を残す。
 */

export interface SerializeContext {
  /** figma.mixed と同一性比較するための番兵 */
  readonly mixed: unknown;
  resolveVariableName(id: string): string;
  /** image fill の imageRef を収集する (bytes の取得と書き出しは呼び出し側) */
  registerImage(hash: string): void;
}

export type DumpNode = { id: string; name: string; type: string } & Record<string, unknown>;

type AnyNode = Record<string, unknown> & { id: string; name: string; type: string };

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hex2(component: number): string {
  const v = Math.max(0, Math.min(255, Math.round(component * 255)));
  return v.toString(16).padStart(2, "0");
}

function colorToHex(color: { r: number; g: number; b: number }): string {
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
}

/** undefined 値のキーを落としたオブジェクトを返す */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Paint / Effect
// ---------------------------------------------------------------------------

function serializePaint(paint: Record<string, unknown>, ctx: SerializeContext): unknown {
  if (paint.visible === false) return undefined;
  const type = paint.type;
  const opacity =
    typeof paint.opacity === "number" && paint.opacity !== 1 ? r2(paint.opacity) : undefined;

  if (type === "SOLID" && isRecord(paint.color)) {
    return prune({
      type,
      color: colorToHex(paint.color as { r: number; g: number; b: number }),
      opacity,
    });
  }
  if (typeof type === "string" && type.startsWith("GRADIENT_")) {
    const stops = Array.isArray(paint.gradientStops)
      ? paint.gradientStops.map((stop: Record<string, unknown>) => {
          const c = stop.color as { r: number; g: number; b: number; a?: number };
          return prune({
            position: r2(stop.position as number),
            color: colorToHex(c),
            alpha: typeof c.a === "number" && c.a !== 1 ? r2(c.a) : undefined,
          });
        })
      : undefined;
    return prune({ type, opacity, stops });
  }
  if (type === "IMAGE") {
    if (typeof paint.imageHash === "string") ctx.registerImage(paint.imageHash);
    return prune({
      type,
      scaleMode: paint.scaleMode,
      imageRef: typeof paint.imageHash === "string" ? paint.imageHash : undefined,
      opacity,
    });
  }
  return prune({ type, opacity });
}

function serializePaints(value: unknown, ctx: SerializeContext): unknown {
  if (value === ctx.mixed) return "mixed";
  if (!Array.isArray(value)) return undefined;
  const paints = value
    .map((p: Record<string, unknown>) => serializePaint(p, ctx))
    .filter((p) => p !== undefined);
  return paints.length > 0 ? paints : undefined;
}

function serializeEffects(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const effects = value
    .filter((e: Record<string, unknown>) => e.visible !== false)
    .map((e: Record<string, unknown>) => {
      const color = isRecord(e.color)
        ? e.color as { r: number; g: number; b: number; a?: number }
        : undefined;
      const offset = isRecord(e.offset)
        ? { x: r2(e.offset.x as number), y: r2(e.offset.y as number) }
        : undefined;
      return prune({
        type: e.type,
        color: color ? colorToHex(color) : undefined,
        alpha: color && typeof color.a === "number" && color.a !== 1 ? r2(color.a) : undefined,
        offset,
        radius: typeof e.radius === "number" ? r2(e.radius) : undefined,
        spread: typeof e.spread === "number" && e.spread !== 0 ? r2(e.spread) : undefined,
      });
    });
  return effects.length > 0 ? effects : undefined;
}

// ---------------------------------------------------------------------------
// テキスト
// ---------------------------------------------------------------------------

function serializeLineHeight(value: unknown, ctx: SerializeContext): string | undefined {
  if (value === ctx.mixed || !isRecord(value)) return undefined;
  if (value.unit === "PIXELS") return `${r2(value.value as number)}px`;
  if (value.unit === "PERCENT") return `${r2(value.value as number)}%`;
  return undefined; // AUTO はデフォルトなので省略
}

function serializeLetterSpacing(value: unknown, ctx: SerializeContext): string | undefined {
  if (value === ctx.mixed || !isRecord(value)) return undefined;
  const v = value.value as number;
  if (v === 0) return undefined;
  if (value.unit === "PIXELS") return `${r2(v)}px`;
  if (value.unit === "PERCENT") return `${r2(v)}%`;
  return undefined;
}

interface StyledSegment {
  characters: string;
  fontSize?: number;
  fontName?: { family: string; style: string };
  fontWeight?: number;
  fills?: unknown;
  textDecoration?: string;
}

async function serializeText(
  node: AnyNode,
  ctx: SerializeContext,
  out: DumpNode
): Promise<void> {
  out.characters = node.characters;

  const fontMixed = [node.fontSize, node.fontName, node.fontWeight].some(
    (v) => v === ctx.mixed
  );
  if (!fontMixed) {
    if (typeof node.fontSize === "number") out.fontSize = node.fontSize;
    if (isRecord(node.fontName)) {
      out.fontFamily = node.fontName.family;
      out.fontStyle = node.fontName.style;
    }
    if (typeof node.fontWeight === "number") out.fontWeight = node.fontWeight;
  } else if (typeof node.getStyledTextSegments === "function") {
    // 部分的に書式が違うテキストは segment 単位で展開する
    const segments = (await (node.getStyledTextSegments as Function).call(node, [
      "fontSize",
      "fontName",
      "fontWeight",
      "fills",
      "textDecoration",
    ])) as StyledSegment[];
    out.textSegments = segments.map((seg) =>
      prune({
        text: seg.characters,
        fontSize: seg.fontSize,
        fontFamily: seg.fontName ? seg.fontName.family : undefined,
        fontStyle: seg.fontName ? seg.fontName.style : undefined,
        fontWeight: seg.fontWeight,
        fills: serializePaints(seg.fills, ctx),
        textDecoration:
          seg.textDecoration && seg.textDecoration !== "NONE" ? seg.textDecoration : undefined,
      })
    );
  }

  if (typeof node.textAlignHorizontal === "string" && node.textAlignHorizontal !== "LEFT") {
    out.textAlignHorizontal = node.textAlignHorizontal;
  }
  if (typeof node.textAlignVertical === "string" && node.textAlignVertical !== "TOP") {
    out.textAlignVertical = node.textAlignVertical;
  }
  const lineHeight = serializeLineHeight(node.lineHeight, ctx);
  if (lineHeight) out.lineHeight = lineHeight;
  const letterSpacing = serializeLetterSpacing(node.letterSpacing, ctx);
  if (letterSpacing) out.letterSpacing = letterSpacing;
  if (
    typeof node.textCase === "string" &&
    node.textCase !== "ORIGINAL" &&
    (node.textCase as unknown) !== ctx.mixed
  ) {
    out.textCase = node.textCase;
  }
  if (
    typeof node.textDecoration === "string" &&
    node.textDecoration !== "NONE" &&
    (node.textDecoration as unknown) !== ctx.mixed
  ) {
    out.textDecoration = node.textDecoration;
  }
  if (typeof node.textAutoResize === "string" && node.textAutoResize !== "NONE") {
    out.textAutoResize = node.textAutoResize;
  }
}

// ---------------------------------------------------------------------------
// コンポーネント / Variables
// ---------------------------------------------------------------------------

/** "Label#123:456" 形式のプロパティキーから表示名部分を取り出す */
function propKeyName(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

async function serializeComponentInfo(node: AnyNode, out: DumpNode): Promise<void> {
  if (node.type === "INSTANCE") {
    if (typeof node.getMainComponentAsync === "function") {
      try {
        const main = (await (node.getMainComponentAsync as Function).call(node)) as
          | (AnyNode & { parent?: AnyNode | null })
          | null;
        if (main) {
          out.componentName = main.name;
          if (main.parent && main.parent.type === "COMPONENT_SET") {
            out.componentSetName = main.parent.name;
          }
        }
      } catch (e) {
        // remote component 等で失敗しても構造出力は続行
      }
    }
    try {
      const defs = node.componentProperties as
        | Record<string, { value: unknown }>
        | undefined;
      if (defs) {
        const props: Record<string, unknown> = {};
        for (const [key, def] of Object.entries(defs)) {
          props[propKeyName(key)] = def.value;
        }
        if (Object.keys(props).length > 0) out.props = props;
      }
    } catch (e) {
      // componentProperties が無い、または参照先ComponentSetが壊れている。中止せず記録
      out.extractionError = e instanceof Error ? e.message : String(e);
    }
  }

  // コンポーネント定義側を選択したときも variant を照合できるようにする
  if (node.type === "COMPONENT") {
    const parent = node.parent as AnyNode | null | undefined;
    if (parent && parent.type === "COMPONENT_SET") {
      out.componentSetName = parent.name;
      try {
        const vp = node.variantProperties as Record<string, string> | null | undefined;
        if (vp && Object.keys(vp).length > 0) out.props = vp;
      } catch (e) {
        // ComponentSetが壊れている(バリアント重複等)と読み取りが例外になる。中止せず記録
        out.extractionError = e instanceof Error ? e.message : String(e);
      }
    }
  }
}

function serializeBoundVariables(node: AnyNode, ctx: SerializeContext): unknown {
  const bv = node.boundVariables as
    | Record<string, { id: string } | { id: string }[]>
    | undefined;
  if (!bv) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [field, value] of Object.entries(bv)) {
    if (Array.isArray(value)) {
      out[field] = value.map((alias) => ctx.resolveVariableName(alias.id));
    } else if (isRecord(value) && typeof value.id === "string") {
      out[field] = ctx.resolveVariableName(value.id);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// ノード本体
// ---------------------------------------------------------------------------

/** 親の auto layout 有無。x/y を出すかの判断に使う */
export type ParentLayout = "AUTO" | "NONE";

export async function serializeNode(
  input: unknown,
  ctx: SerializeContext,
  parentLayout?: ParentLayout
): Promise<DumpNode> {
  const node = input as AnyNode;
  const out: DumpNode = { id: node.id, name: node.name, type: node.type };

  await serializeComponentInfo(node, out);

  // Auto Layout
  const hasAutoLayout = typeof node.layoutMode === "string" && node.layoutMode !== "NONE";
  if (hasAutoLayout) {
    out.layoutMode = node.layoutMode;
    if (typeof node.itemSpacing === "number" && node.itemSpacing !== 0) {
      out.itemSpacing = r2(node.itemSpacing);
    }
    if (node.layoutWrap === "WRAP") {
      out.layoutWrap = "WRAP";
      if (typeof node.counterAxisSpacing === "number" && node.counterAxisSpacing !== 0) {
        out.counterAxisSpacing = r2(node.counterAxisSpacing);
      }
    }
    const padding = [
      node.paddingTop,
      node.paddingRight,
      node.paddingBottom,
      node.paddingLeft,
    ].map((v) => (typeof v === "number" ? r2(v) : 0));
    if (padding.some((v) => v !== 0)) out.padding = padding;
    if (
      typeof node.primaryAxisAlignItems === "string" &&
      node.primaryAxisAlignItems !== "MIN"
    ) {
      out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    }
    if (
      typeof node.counterAxisAlignItems === "string" &&
      node.counterAxisAlignItems !== "MIN"
    ) {
      out.counterAxisAlignItems = node.counterAxisAlignItems;
    }
  }
  if (typeof node.layoutSizingHorizontal === "string") {
    out.layoutSizingHorizontal = node.layoutSizingHorizontal;
    out.layoutSizingVertical = node.layoutSizingVertical;
  }

  // 位置とサイズ。auto layout の子は座標をレイアウトが決めるので x/y を省く
  if (typeof node.width === "number") {
    out.width = r2(node.width);
    out.height = r2(node.height as number);
  }
  const absolute = node.layoutPositioning === "ABSOLUTE";
  if ((parentLayout === "NONE" || absolute) && typeof node.x === "number") {
    out.x = r2(node.x);
    out.y = r2(node.y as number);
    if (absolute) out.layoutPositioning = "ABSOLUTE";
  }
  if (typeof node.minWidth === "number") out.minWidth = r2(node.minWidth);
  if (typeof node.maxWidth === "number") out.maxWidth = r2(node.maxWidth);
  if (typeof node.rotation === "number" && node.rotation !== 0) {
    out.rotation = r2(node.rotation);
  }
  if (typeof node.opacity === "number" && node.opacity !== 1) {
    out.opacity = r2(node.opacity);
  }

  // 角丸: 単一値、または四隅が異なる場合は [tl, tr, br, bl]
  if (typeof node.cornerRadius === "number" && node.cornerRadius !== 0) {
    out.cornerRadius = r2(node.cornerRadius);
  } else if (node.cornerRadius === ctx.mixed) {
    const corners = [
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius,
    ].map((v) => (typeof v === "number" ? r2(v) : 0));
    if (corners.some((v) => v !== 0)) out.cornerRadius = corners;
  }

  // スタイル
  const fills = serializePaints(node.fills, ctx);
  if (fills !== undefined) out.fills = fills;
  const strokes = serializePaints(node.strokes, ctx);
  if (strokes !== undefined) {
    out.strokes = strokes;
    if (typeof node.strokeWeight === "number") out.strokeWeight = r2(node.strokeWeight);
    if (typeof node.strokeAlign === "string") out.strokeAlign = node.strokeAlign;
    if (Array.isArray(node.dashPattern) && node.dashPattern.length > 0) {
      out.dashPattern = node.dashPattern;
    }
  }
  const effects = serializeEffects(node.effects);
  if (effects !== undefined) out.effects = effects;

  if (node.type === "TEXT") {
    await serializeText(node, ctx, out);
  }

  const variables = serializeBoundVariables(node, ctx);
  if (variables !== undefined) out.variables = variables;

  // 子 (非表示はスキップ。インスタンス内部も展開する)
  if (Array.isArray(node.children)) {
    const childLayout: ParentLayout = hasAutoLayout ? "AUTO" : "NONE";
    const children: DumpNode[] = [];
    for (const child of node.children as AnyNode[]) {
      if (child.visible === false) continue;
      children.push(await serializeNode(child, ctx, childLayout));
    }
    if (children.length > 0) out.children = children;
  }

  return out;
}
