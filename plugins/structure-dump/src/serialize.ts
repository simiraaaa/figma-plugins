/**
 * Figma ノードツリー → AI 可読の構造 JSON (ノード 1 つぶんの形。schema の版は plan.ts が持つ)
 *
 * Figma API 非依存の純関数 (figma グローバルを参照しない)。
 * mixed 番兵・Variables / スタイル / コンポーネント名の解決・image fill の収集・SVG の書き出しは
 * ctx で注入し、node --test で素のオブジェクトを使って検証できるようにする。
 *
 * 剪定方針: デフォルト値と非表示ノードは出力しない。ただしコンポーネントのプロパティで
 * 出し入れする子 (componentPropertyReferences.visible を持つ子) は、非表示でも visible: false を付けて残す。
 * AI がコード化に使う情報 (auto layout / テキスト / 色 / コンポーネント名と variant /
 * Variables の名前と値 / スタイル名 / プロパティの定義と結び付き) を残す。
 */

export interface ResolvedVariable {
  name: string;
  /** そのノードで効いているモードでの値 (Figma の Variable.resolveForConsumer)。解決できなければ無い */
  resolved?: { value: unknown; resolvedType: string };
}

export interface SerializeContext {
  /** figma.mixed と同一性比較するための番兵 */
  readonly mixed: unknown;
  /** consumer が undefined (スタイルの束縛) なら名前だけ返す */
  resolveVariable(id: string, consumer: unknown): Promise<ResolvedVariable>;
  /** スタイルの id → 名前。見つからなければ undefined */
  styleName(id: string): Promise<string | undefined>;
  /** explicitVariableModes の collection id と mode id → 名前。見つからなければ undefined */
  modeName(
    collectionId: string,
    modeId: string
  ): Promise<{ collection: string; mode: string } | undefined>;
  /** コンポーネントの id → 名前 (INSTANCE_SWAP の既定値)。見つからなければ undefined */
  componentName(id: string): Promise<string | undefined>;
  /** ノードを SVG で書き出し、ZIP 内のパスを返す。失敗したら warn して undefined */
  exportSvg(node: unknown): Promise<string | undefined>;
  /** image fill の imageRef を収集する (bytes の取得と書き出しは呼び出し側) */
  registerImage(hash: string): void;
  /** 中止せずに続行した失敗を、利用者に見える warning として残す */
  warn(message: string): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type DumpNode = { id: string; name: string; type: string } & Record<string, unknown>;

type AnyNode = Record<string, unknown> & { id: string; name: string; type: string };

export function r2(n: number): number {
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

/** "Label#123:456" 形式のプロパティキーから表示名部分を取り出す */
function propKeyName(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * 変数の値を JSON に出す形にする。COLOR は #rrggbb (不透明でなければ #rrggbbaa)、
 * FLOAT は小数 2 桁に丸め、STRING / BOOLEAN はそのまま
 */
export function formatVariableValue(value: unknown, resolvedType: string): unknown {
  if (resolvedType === "COLOR" && isRecord(value)) {
    const c = value as { r: number; g: number; b: number; a?: number };
    const alpha = typeof c.a === "number" && c.a !== 1 ? hex2(c.a) : "";
    return `${colorToHex(c)}${alpha}`;
  }
  if (resolvedType === "FLOAT" && typeof value === "number") return r2(value);
  return value;
}

/** consumer は値を解決するノード。スタイルの束縛のように consumer が無ければ名前だけ */
async function variableRef(
  id: string,
  consumer: AnyNode | undefined,
  ctx: SerializeContext
): Promise<Record<string, unknown>> {
  const variable = await ctx.resolveVariable(id, consumer);
  return prune({
    name: variable.name,
    value: variable.resolved
      ? formatVariableValue(variable.resolved.value, variable.resolved.resolvedType)
      : undefined,
  });
}

async function serializeBoundVariables(
  owner: Record<string, unknown>,
  consumer: AnyNode | undefined,
  ctx: SerializeContext
): Promise<unknown> {
  const bv = owner.boundVariables as
    | Record<string, { id: string } | { id: string }[]>
    | undefined;
  if (!bv) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(bv)) {
    if (Array.isArray(value)) {
      const refs: unknown[] = [];
      for (const alias of value) refs.push(await variableRef(alias.id, consumer, ctx));
      out[field] = refs;
    } else if (isRecord(value) && typeof value.id === "string") {
      out[field] = await variableRef(value.id, consumer, ctx);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ノードに明示したモード (explicitVariableModes) を collection 名 → mode 名で出す */
async function serializeVariableModes(
  node: AnyNode,
  ctx: SerializeContext
): Promise<unknown> {
  const modes = node.explicitVariableModes;
  if (!isRecord(modes)) return undefined;
  const out: Record<string, string> = {};
  for (const [collectionId, modeId] of Object.entries(modes)) {
    if (typeof modeId !== "string") continue;
    const named = await ctx.modeName(collectionId, modeId);
    if (named) out[named.collection] = named.mode;
    else out[`<unresolved:${collectionId}>`] = modeId;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// スタイル
// ---------------------------------------------------------------------------

const STYLE_FIELDS: readonly (readonly [string, string])[] = [
  ["fillStyleId", "fill"],
  ["strokeStyleId", "stroke"],
  ["textStyleId", "text"],
  ["effectStyleId", "effect"],
  ["gridStyleId", "grid"],
];

async function styleNameOf(id: string, ctx: SerializeContext): Promise<string> {
  return (await ctx.styleName(id)) ?? `<unresolved:${id}>`;
}

/** 名前付きスタイルの名前。部分ごとに違うテキストのスタイルは "mixed" (中身は textSegments) */
async function serializeStyles(node: AnyNode, ctx: SerializeContext): Promise<unknown> {
  const out: Record<string, string> = {};
  for (const [field, key] of STYLE_FIELDS) {
    const id = node[field];
    if (id === ctx.mixed) out[key] = "mixed";
    else if (typeof id === "string" && id !== "") out[key] = await styleNameOf(id, ctx);
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

export function serializePaints(value: unknown, ctx: SerializeContext): unknown {
  if (value === ctx.mixed) return "mixed";
  if (!Array.isArray(value)) return undefined;
  const paints = value
    .map((p: Record<string, unknown>) => serializePaint(p, ctx))
    .filter((p) => p !== undefined);
  return paints.length > 0 ? paints : undefined;
}

export function serializeEffects(value: unknown): unknown {
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

export function serializeLineHeight(value: unknown, mixed: unknown): string | undefined {
  if (value === mixed || !isRecord(value)) return undefined;
  if (value.unit === "PIXELS") return `${r2(value.value as number)}px`;
  if (value.unit === "PERCENT") return `${r2(value.value as number)}%`;
  return undefined; // AUTO はデフォルトなので省略
}

export function serializeLetterSpacing(value: unknown, mixed: unknown): string | undefined {
  if (value === mixed || !isRecord(value)) return undefined;
  const v = value.value as number;
  if (v === 0) return undefined;
  if (value.unit === "PIXELS") return `${r2(v)}px`;
  if (value.unit === "PERCENT") return `${r2(v)}%`;
  return undefined;
}

function serializeHyperlink(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return { type: value.type, value: value.value };
}

interface StyledSegment {
  characters: string;
  fontSize?: number;
  fontName?: { family: string; style: string };
  fontWeight?: number;
  fills?: unknown;
  textDecoration?: string;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  textStyleId?: string;
  fillStyleId?: string;
  hyperlink?: unknown;
}

/** 部分ごとに値が違いうる書式。どれかが mixed なら textSegments に展開する */
const SEGMENT_FIELDS = [
  "fontSize",
  "fontName",
  "fontWeight",
  "fills",
  "textDecoration",
  "lineHeight",
  "letterSpacing",
  "textStyleId",
  "fillStyleId",
  "hyperlink",
] as const;

async function serializeSegment(seg: StyledSegment, ctx: SerializeContext): Promise<unknown> {
  return prune({
    text: seg.characters,
    fontSize: seg.fontSize,
    fontFamily: seg.fontName ? seg.fontName.family : undefined,
    fontStyle: seg.fontName ? seg.fontName.style : undefined,
    fontWeight: seg.fontWeight,
    fills: serializePaints(seg.fills, ctx),
    textDecoration:
      seg.textDecoration && seg.textDecoration !== "NONE" ? seg.textDecoration : undefined,
    lineHeight: serializeLineHeight(seg.lineHeight, ctx.mixed),
    letterSpacing: serializeLetterSpacing(seg.letterSpacing, ctx.mixed),
    textStyle: seg.textStyleId ? await styleNameOf(seg.textStyleId, ctx) : undefined,
    fillStyle: seg.fillStyleId ? await styleNameOf(seg.fillStyleId, ctx) : undefined,
    hyperlink: serializeHyperlink(seg.hyperlink),
  });
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
  }
  if (
    SEGMENT_FIELDS.some((field) => node[field] === ctx.mixed) &&
    typeof node.getStyledTextSegments === "function"
  ) {
    const segments = (await (node.getStyledTextSegments as Function).call(node, [
      ...SEGMENT_FIELDS,
    ])) as StyledSegment[];
    const serialized: unknown[] = [];
    for (const seg of segments) serialized.push(await serializeSegment(seg, ctx));
    out.textSegments = serialized;
  }

  if (typeof node.textAlignHorizontal === "string" && node.textAlignHorizontal !== "LEFT") {
    out.textAlignHorizontal = node.textAlignHorizontal;
  }
  if (typeof node.textAlignVertical === "string" && node.textAlignVertical !== "TOP") {
    out.textAlignVertical = node.textAlignVertical;
  }
  const lineHeight = serializeLineHeight(node.lineHeight, ctx.mixed);
  if (lineHeight) out.lineHeight = lineHeight;
  const letterSpacing = serializeLetterSpacing(node.letterSpacing, ctx.mixed);
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
  if (typeof node.paragraphSpacing === "number" && node.paragraphSpacing !== 0) {
    out.paragraphSpacing = r2(node.paragraphSpacing);
  }
  if (typeof node.paragraphIndent === "number" && node.paragraphIndent !== 0) {
    out.paragraphIndent = r2(node.paragraphIndent);
  }
  if (node.textTruncation === "ENDING") {
    out.textTruncation = "ENDING";
    if (typeof node.maxLines === "number") out.maxLines = node.maxLines;
  }
  const hyperlink = serializeHyperlink(node.hyperlink);
  if (hyperlink !== undefined) out.hyperlink = hyperlink;
}

// ---------------------------------------------------------------------------
// コンポーネント
// ---------------------------------------------------------------------------

async function serializeComponentInfo(
  node: AnyNode,
  out: DumpNode,
  ctx: SerializeContext
): Promise<void> {
  const label = `${node.name} (${node.id})`;
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
        ctx.warn(`main component の取得に失敗: ${label}: ${errorMessage(e)}`);
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
      out.extractionError = errorMessage(e);
      ctx.warn(`componentProperties の読み取りに失敗: ${label}: ${out.extractionError}`);
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
        out.extractionError = errorMessage(e);
        ctx.warn(`variantProperties の読み取りに失敗: ${label}: ${out.extractionError}`);
      }
    }
  }

  if (
    (node.type === "COMPONENT" || node.type === "COMPONENT_SET") &&
    typeof node.description === "string" &&
    node.description !== ""
  ) {
    out.description = node.description;
  }
}

interface PropertyDefinition {
  type: string;
  defaultValue: unknown;
  variantOptions?: string[];
  preferredValues?: unknown[];
  description?: string;
}

/**
 * プロパティの定義を出すノード。セットの中のバリアント (COMPONENT) は定義を持たず、
 * セット側にある。バリアントを直接書き出したとき (isRoot) だけ、セットの定義を写す
 */
function definitionsOwner(node: AnyNode, isRoot: boolean): AnyNode | undefined {
  if (node.type === "COMPONENT_SET") return node;
  if (node.type !== "COMPONENT") return undefined;
  const parent = node.parent as AnyNode | null | undefined;
  if (!parent || parent.type !== "COMPONENT_SET") return node;
  return isRoot ? parent : undefined;
}

async function serializePropertyDefinitions(
  node: AnyNode,
  isRoot: boolean,
  out: DumpNode,
  ctx: SerializeContext
): Promise<void> {
  const owner = definitionsOwner(node, isRoot);
  if (owner === undefined) return;
  let defs: Record<string, PropertyDefinition> | undefined;
  try {
    defs = owner.componentPropertyDefinitions as Record<string, PropertyDefinition> | undefined;
  } catch (e) {
    out.extractionError = errorMessage(e);
    ctx.warn(
      `componentPropertyDefinitions の読み取りに失敗: ${owner.name} (${owner.id}): ${out.extractionError}`
    );
    return;
  }
  if (!defs) return;
  const definitions: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defs)) {
    let defaultValue: unknown = def.defaultValue;
    if (def.type === "INSTANCE_SWAP" && typeof def.defaultValue === "string") {
      defaultValue = prune({
        id: def.defaultValue,
        name: await ctx.componentName(def.defaultValue),
      });
    }
    definitions[propKeyName(key)] = prune({
      type: def.type,
      default: defaultValue,
      options: def.variantOptions,
      preferredValues:
        Array.isArray(def.preferredValues) && def.preferredValues.length > 0
          ? def.preferredValues
          : undefined,
      description: def.description ? def.description : undefined,
    });
  }
  if (Object.keys(definitions).length > 0) out.propertyDefinitions = definitions;
}

const PROPERTY_REF_FIELDS = ["visible", "characters", "mainComponent"] as const;

function propertyRefsOf(node: AnyNode): Record<string, string> | undefined {
  const refs = node.componentPropertyReferences;
  if (!isRecord(refs)) return undefined;
  const out: Record<string, string> = {};
  for (const field of PROPERTY_REF_FIELDS) {
    const key = refs[field];
    if (typeof key === "string") out[field] = propKeyName(key);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** プロパティで出し入れする子か。非表示でも捨てずに visible: false で残す */
function toggledByProperty(node: AnyNode): boolean {
  const refs = node.componentPropertyReferences;
  return isRecord(refs) && typeof refs.visible === "string";
}

// ---------------------------------------------------------------------------
// ベクターだけのノード (SVG で書き出す)
// ---------------------------------------------------------------------------

/** 単独でも描画する図形。子を持つ BOOLEAN_OPERATION も 1 つの図形として扱う */
const SHAPE_TYPES: ReadonlySet<string> = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "POLYGON",
  "LINE",
  "ELLIPSE",
  "RECTANGLE",
]);
/** 長方形と楕円だけの枠 (背景の箱など) は SVG にしない。線を描く図形を 1 つ以上含むものだけ */
const LINE_ART_TYPES: ReadonlySet<string> = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "POLYGON",
  "LINE",
]);
const VECTOR_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "FRAME",
  "GROUP",
  "INSTANCE",
  "COMPONENT",
]);

interface VectorStatus {
  /** 子孫が図形だけで、テキストも画像も無い */
  only: boolean;
  /** 線を描く図形を含む */
  lineArt: boolean;
}

function hasImageFill(node: AnyNode): boolean {
  return Array.isArray(node.fills) && node.fills.some((p: Record<string, unknown>) => p.type === "IMAGE");
}

function vectorStatus(node: AnyNode, children: readonly VectorStatus[]): VectorStatus {
  if (hasImageFill(node)) return { only: false, lineArt: false };
  if (SHAPE_TYPES.has(node.type)) return { only: true, lineArt: LINE_ART_TYPES.has(node.type) };
  if (!VECTOR_CONTAINER_TYPES.has(node.type) || children.length === 0) {
    return { only: false, lineArt: false };
  }
  return {
    only: children.every((c) => c.only),
    lineArt: children.some((c) => c.lineArt),
  };
}

function isSvgTarget(status: VectorStatus): boolean {
  return status.only && status.lineArt;
}

// ---------------------------------------------------------------------------
// ノード本体
// ---------------------------------------------------------------------------

/** 親の auto layout 有無。x/y を出すかの判断に使う */
export type ParentLayout = "AUTO" | "NONE";

const DEFAULT_BLEND_MODES: ReadonlySet<string> = new Set(["PASS_THROUGH", "NORMAL"]);

function serializeGeometry(
  node: AnyNode,
  out: DumpNode,
  ctx: SerializeContext,
  parentLayout: ParentLayout | undefined
): boolean {
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
      if (node.counterAxisAlignContent === "SPACE_BETWEEN") {
        out.counterAxisAlignContent = "SPACE_BETWEEN";
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
    if (node.strokesIncludedInLayout === true) out.strokesIncludedInLayout = true;
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
    const constraints = node.constraints;
    if (
      isRecord(constraints) &&
      (constraints.horizontal !== "MIN" || constraints.vertical !== "MIN")
    ) {
      out.constraints = { horizontal: constraints.horizontal, vertical: constraints.vertical };
    }
  }
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const value = node[key];
    if (typeof value === "number") out[key] = r2(value);
  }
  if (typeof node.rotation === "number" && node.rotation !== 0) {
    out.rotation = r2(node.rotation);
  }
  if (typeof node.opacity === "number" && node.opacity !== 1) {
    out.opacity = r2(node.opacity);
  }
  if (typeof node.blendMode === "string" && !DEFAULT_BLEND_MODES.has(node.blendMode)) {
    out.blendMode = node.blendMode;
  }
  if (node.isMask === true) out.isMask = true;
  if (node.clipsContent === true) out.clipsContent = true;
  if (typeof node.overflowDirection === "string" && node.overflowDirection !== "NONE") {
    out.overflowDirection = node.overflowDirection;
  }
  if (node.type === "BOOLEAN_OPERATION" && typeof node.booleanOperation === "string") {
    out.booleanOperation = node.booleanOperation;
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
  return hasAutoLayout;
}

function serializeAppearance(node: AnyNode, out: DumpNode, ctx: SerializeContext): void {
  const fills = serializePaints(node.fills, ctx);
  if (fills !== undefined) out.fills = fills;
  const strokes = serializePaints(node.strokes, ctx);
  if (strokes !== undefined) {
    out.strokes = strokes;
    if (typeof node.strokeWeight === "number") {
      out.strokeWeight = r2(node.strokeWeight);
    } else if (node.strokeWeight === ctx.mixed) {
      // 辺ごとに太さが違う枠線は [上, 右, 下, 左]
      out.strokeWeights = [
        node.strokeTopWeight,
        node.strokeRightWeight,
        node.strokeBottomWeight,
        node.strokeLeftWeight,
      ].map((v) => (typeof v === "number" ? r2(v) : 0));
    }
    if (typeof node.strokeAlign === "string") out.strokeAlign = node.strokeAlign;
    if (Array.isArray(node.dashPattern) && node.dashPattern.length > 0) {
      out.dashPattern = node.dashPattern;
    }
  }
  const effects = serializeEffects(node.effects);
  if (effects !== undefined) out.effects = effects;
}

function serializeAnnotations(node: AnyNode): unknown {
  if (!Array.isArray(node.annotations) || node.annotations.length === 0) return undefined;
  return node.annotations.map((a: Record<string, unknown>) =>
    prune({
      label: typeof a.labelMarkdown === "string" && a.labelMarkdown !== "" ? a.labelMarkdown : a.label,
      properties: Array.isArray(a.properties)
        ? a.properties.map((p: Record<string, unknown>) => p.type)
        : undefined,
    })
  );
}

interface Serialized {
  node: AnyNode;
  out: DumpNode;
  vector: VectorStatus;
}

async function serializeTree(
  node: AnyNode,
  ctx: SerializeContext,
  parentLayout: ParentLayout | undefined,
  isRoot: boolean
): Promise<Serialized> {
  const out: DumpNode = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) out.visible = false;

  await serializeComponentInfo(node, out, ctx);
  await serializePropertyDefinitions(node, isRoot, out, ctx);
  const propertyRefs = propertyRefsOf(node);
  if (propertyRefs !== undefined) out.propertyRefs = propertyRefs;

  const hasAutoLayout = serializeGeometry(node, out, ctx, parentLayout);
  serializeAppearance(node, out, ctx);

  if (node.type === "TEXT") {
    await serializeText(node, ctx, out);
  }

  const styles = await serializeStyles(node, ctx);
  if (styles !== undefined) out.styles = styles;
  const variables = await serializeBoundVariables(node, node, ctx);
  if (variables !== undefined) out.variables = variables;
  const variableModes = await serializeVariableModes(node, ctx);
  if (variableModes !== undefined) out.variableModes = variableModes;
  const annotations = serializeAnnotations(node);
  if (annotations !== undefined) out.annotations = annotations;

  // 子 (非表示は、プロパティで出し入れする子だけ残す。インスタンス内部も展開する)
  const children: Serialized[] = [];
  const shownStatuses: VectorStatus[] = [];
  if (Array.isArray(node.children)) {
    const childLayout: ParentLayout = hasAutoLayout ? "AUTO" : "NONE";
    for (const child of node.children as AnyNode[]) {
      if (child.visible === false && !toggledByProperty(child)) continue;
      const serialized = await serializeTree(child, ctx, childLayout, false);
      children.push(serialized);
      // 非表示の子は描画されないので、親を SVG にするかの判定には入れない
      if (child.visible !== false) shownStatuses.push(serialized.vector);
    }
    if (children.length > 0) out.children = children.map((c) => c.out);
  }

  const vector = vectorStatus(node, shownStatuses);
  // SVG は、ベクターだけの部分木のいちばん上のノードにだけ付ける
  if (!isSvgTarget(vector)) {
    for (const child of children) {
      if (isSvgTarget(child.vector)) await attachSvg(child.out, child.node, ctx);
    }
  }
  return { node, out, vector };
}

async function attachSvg(out: DumpNode, node: AnyNode, ctx: SerializeContext): Promise<void> {
  const path = await ctx.exportSvg(node);
  if (path !== undefined) out.svg = path;
}

export async function serializeNode(
  input: unknown,
  ctx: SerializeContext,
  parentLayout?: ParentLayout
): Promise<DumpNode> {
  const node = input as AnyNode;
  const root = await serializeTree(node, ctx, parentLayout, true);
  if (isSvgTarget(root.vector)) await attachSvg(root.out, node, ctx);
  return root.out;
}

// ---------------------------------------------------------------------------
// ファイル全体の Variables (variables.json) と名前付きスタイル (styles.json)
// ---------------------------------------------------------------------------

export interface VariableCollectionInput {
  id: string;
  name: string;
  remote: boolean;
  modes: readonly { modeId: string; name: string }[];
  defaultModeId: string;
}

export interface VariableInput {
  id: string;
  name: string;
  variableCollectionId: string;
  resolvedType: string;
  valuesByMode: Readonly<Record<string, unknown>>;
  description?: string;
  scopes?: readonly string[];
  codeSyntax?: Readonly<Record<string, string>>;
}

function isAlias(value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } {
  return isRecord(value) && value.type === "VARIABLE_ALIAS" && typeof value.id === "string";
}

/**
 * コレクションごとに、モード名 → 値で変数を並べる。別の変数を参照する値は { alias: 変数名 }。
 * variableName は alias の参照先の名前を引く (見つからなければ undefined)
 */
export function buildVariablesJson(
  collections: readonly VariableCollectionInput[],
  variables: readonly VariableInput[],
  variableName: (id: string) => string | undefined
): Record<string, unknown> {
  return {
    collections: collections.map((collection) => {
      const modeName = new Map(collection.modes.map((m) => [m.modeId, m.name]));
      return prune({
        id: collection.id,
        name: collection.name,
        remote: collection.remote ? true : undefined,
        modes: collection.modes.map((m) => m.name),
        defaultMode: modeName.get(collection.defaultModeId),
        variables: variables
          .filter((v) => v.variableCollectionId === collection.id)
          .map((v) => {
            const values: Record<string, unknown> = {};
            for (const [modeId, value] of Object.entries(v.valuesByMode)) {
              values[modeName.get(modeId) ?? modeId] = isAlias(value)
                ? { alias: variableName(value.id) ?? `<unresolved:${value.id}>` }
                : formatVariableValue(value, v.resolvedType);
            }
            return prune({
              id: v.id,
              name: v.name,
              type: v.resolvedType,
              values,
              description: v.description ? v.description : undefined,
              scopes: v.scopes && v.scopes.length > 0 ? v.scopes : undefined,
              codeSyntax:
                v.codeSyntax && Object.keys(v.codeSyntax).length > 0 ? v.codeSyntax : undefined,
            });
          }),
      });
    }),
  };
}

function serializeLayoutGrids(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const grids = value
    .filter((g: Record<string, unknown>) => g.visible !== false)
    .map((g: Record<string, unknown>) =>
      prune({
        pattern: g.pattern,
        alignment: g.alignment,
        count: g.count,
        sectionSize: g.sectionSize,
        gutterSize: g.gutterSize,
        offset: g.offset,
      })
    );
  return grids.length > 0 ? grids : undefined;
}

/** 名前付きスタイル 1 つ (PAINT / TEXT / EFFECT / GRID) を、ノードと同じ書き方で出す */
export async function serializeStyle(
  input: unknown,
  ctx: SerializeContext
): Promise<Record<string, unknown>> {
  const style = input as Record<string, unknown> & { id: string; name: string; type: string };
  const out: Record<string, unknown> = { id: style.id, name: style.name, type: style.type };
  if (style.remote === true) out.remote = true;
  if (typeof style.description === "string" && style.description !== "") {
    out.description = style.description;
  }
  if (style.type === "PAINT") {
    const paints = serializePaints(style.paints, ctx);
    if (paints !== undefined) out.paints = paints;
  } else if (style.type === "TEXT") {
    if (isRecord(style.fontName)) {
      out.fontFamily = style.fontName.family;
      out.fontStyle = style.fontName.style;
    }
    if (typeof style.fontSize === "number") out.fontSize = r2(style.fontSize);
    const lineHeight = serializeLineHeight(style.lineHeight, ctx.mixed);
    if (lineHeight) out.lineHeight = lineHeight;
    const letterSpacing = serializeLetterSpacing(style.letterSpacing, ctx.mixed);
    if (letterSpacing) out.letterSpacing = letterSpacing;
    if (typeof style.textCase === "string" && style.textCase !== "ORIGINAL") {
      out.textCase = style.textCase;
    }
    if (typeof style.textDecoration === "string" && style.textDecoration !== "NONE") {
      out.textDecoration = style.textDecoration;
    }
    if (typeof style.paragraphSpacing === "number" && style.paragraphSpacing !== 0) {
      out.paragraphSpacing = r2(style.paragraphSpacing);
    }
    if (typeof style.paragraphIndent === "number" && style.paragraphIndent !== 0) {
      out.paragraphIndent = r2(style.paragraphIndent);
    }
  } else if (style.type === "EFFECT") {
    const effects = serializeEffects(style.effects);
    if (effects !== undefined) out.effects = effects;
  } else if (style.type === "GRID") {
    const grids = serializeLayoutGrids(style.layoutGrids);
    if (grids !== undefined) out.layoutGrids = grids;
  }
  const variables = await serializeBoundVariables(style, undefined, ctx);
  if (variables !== undefined) out.variables = variables;
  return out;
}
