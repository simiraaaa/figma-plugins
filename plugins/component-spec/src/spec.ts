/**
 * Figma のコンポーネント定義 → 仕様 JSON (schema: component-spec-v1)
 *
 * Figma API 非依存の純関数 (figma グローバルを参照しない)。
 * ノードから読んだ生データを Raw* 型で受け取るだけにして、
 * node --test で素のオブジェクトを使って検証できるようにする。
 *
 * 出力の正は componentPropertyDefinitions (取りうる全プロパティ・全 variant 値)。
 * 並んでいるインスタンスは examples (確認済みパターンの証跡) として添える。
 */

export const SCHEMA_VERSION = "component-spec-v1";

// ---------------------------------------------------------------------------
// 入力 (ノードから読んだ生データ)
// ---------------------------------------------------------------------------

/**
 * componentPropertyDefinitions の 1 エントリ。
 * type は Figma の値 ("VARIANT" | "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT") を
 * 翻訳せずそのまま通す (Figma 側に新しい型が増えても落とさない)
 */
export interface RawPropertyDefinition {
  readonly type?: unknown;
  readonly defaultValue?: unknown;
  readonly variantOptions?: unknown;
  readonly description?: unknown;
}

/** インスタンスの componentProperties / バリアントの variantProperties の 1 エントリ */
export interface RawPropertyValue {
  readonly type?: unknown;
  readonly value: unknown;
}

export interface RawExample {
  readonly nodeId: string;
  readonly name: string;
  /** キーは Figma の生キー ("Label#12:34")。読み取りに失敗したときは null */
  readonly properties: Readonly<Record<string, RawPropertyValue>> | null;
  readonly extractionError?: string;
}

export interface RawGroup {
  /** グループの同一性。ComponentSet id、set が無ければ Component id */
  readonly key: string;
  readonly name: string;
  readonly componentSetId?: string;
  /** 読み取れなかったときは null (examples からの集約にフォールバックする) */
  readonly definitions: Readonly<Record<string, RawPropertyDefinition>> | null;
  readonly definitionsError?: string;
  /** ドキュメント順 */
  readonly examples: readonly RawExample[];
}

export interface BuildInput {
  readonly meta: {
    readonly fileName: string;
    readonly pluginVersion: string;
    readonly exportedAt: string;
  };
  readonly groups: readonly RawGroup[];
  /** example の nodeId → ZIP 内のスクリーンショットパス。JSON 単体出力では空 */
  readonly screenshots?: Readonly<Record<string, string>>;
  /** Figma 側で起きた警告 (スクリーンショット失敗、main component 未解決など) */
  readonly warnings?: readonly string[];
}

// ---------------------------------------------------------------------------
// 出力 (schema: component-spec-v1)
// ---------------------------------------------------------------------------

export interface SpecProperty {
  type: string;
  defaultValue?: unknown;
  /** VARIANT の取りうる値。definitions では variantOptions、fallback では観測値 */
  values?: string[];
  description?: string;
}

export interface SpecExample {
  nodeId: string;
  name: string;
  props: Record<string, unknown>;
  screenshot?: string;
}

export type SpecSource = "definitions" | "examples";

export interface ComponentSpec {
  name: string;
  componentSetId?: string;
  source: SpecSource;
  properties: Record<string, SpecProperty>;
  examples: SpecExample[];
}

export interface SpecDocument {
  meta: {
    fileName: string;
    pluginVersion: string;
    schemaVersion: string;
    exportedAt: string;
    warnings: string[];
  };
  components: ComponentSpec[];
}

/** UI のチェックボックスリスト 1 行ぶん */
export interface GroupSummary {
  key: string;
  name: string;
  source: SpecSource;
  exampleCount: number;
  propertyCount: number;
  warningCount: number;
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** undefined 値のキーを落としたオブジェクトを返す */
function prune<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** "Label#123:456" 形式のプロパティキーから表示名部分を取り出す */
export function propKeyName(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

/** ZIP 内・展開後のファイルシステム双方で安全な名前にする (Windows 含む) */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  const trimmed = cleaned.slice(0, 40);
  return trimmed.length > 0 ? trimmed : "node";
}

/** ノード ID ("123:456") をファイル名に使える形へ */
export function safeId(id: string): string {
  return id.replace(/[^0-9a-zA-Z]+/g, "-");
}

/**
 * example のスクリーンショットの ZIP 内パス。
 * 同名バリアントが衝突しないよう、必ず node id を混ぜる
 */
export function screenshotPath(groupName: string, exampleName: string, nodeId: string): string {
  return `screenshots/${safeName(groupName)}/${safeName(exampleName)}.${safeId(nodeId)}.png`;
}

const VARIANT = "VARIANT";
const UNKNOWN_TYPE = "UNKNOWN";

/** type が読めなかった値から型を推定する (remote の古い API 応答向けの保険) */
function inferPropertyType(value: unknown): string {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "string") return "TEXT";
  return UNKNOWN_TYPE;
}

function typeOf(raw: RawPropertyValue): string {
  return typeof raw.type === "string" ? raw.type : inferPropertyType(raw.value);
}

// ---------------------------------------------------------------------------
// properties の組み立て
// ---------------------------------------------------------------------------

function hasDefinitions(group: RawGroup): boolean {
  return group.definitions !== null && Object.keys(group.definitions).length > 0;
}

function fromDefinitions(
  defs: Readonly<Record<string, RawPropertyDefinition>>,
  warnings: string[],
  groupName: string
): Record<string, SpecProperty> {
  const out: Record<string, SpecProperty> = {};
  for (const [key, def] of Object.entries(defs)) {
    const name = propKeyName(key);
    if (out[name] !== undefined) {
      warnings.push(
        `プロパティ名が衝突するため後の定義で上書きされました: ${groupName}.${name} (${key})`
      );
    }
    const values = Array.isArray(def.variantOptions)
      ? def.variantOptions.map((v) => String(v))
      : undefined;
    out[name] = prune({
      type: typeof def.type === "string" ? def.type : UNKNOWN_TYPE,
      defaultValue: def.defaultValue,
      values,
      description:
        typeof def.description === "string" && def.description.length > 0
          ? def.description
          : undefined,
    });
  }
  return out;
}

/**
 * examples から仕様を逆算する (definitions を辿れない remote コンポーネント向け)。
 * デフォルト値は分からないので出さない。VARIANT の値は「観測できた分だけ」で、
 * 取りうる全値である保証はない
 */
function fromExamples(
  examples: readonly RawExample[],
  warnings: string[],
  groupName: string
): Record<string, SpecProperty> {
  const types = new Map<string, string>();
  const observed = new Map<string, string[]>();

  for (const example of examples) {
    if (!example.properties) continue;
    for (const [key, raw] of Object.entries(example.properties)) {
      const name = propKeyName(key);
      const type = typeOf(raw);
      const known = types.get(name);
      if (known === undefined) {
        types.set(name, type);
        observed.set(name, []);
      } else if (known !== type) {
        warnings.push(
          `プロパティの型が example 間で一致しません: ${groupName}.${name} (${known} と ${type})`
        );
      }
      if (typeof raw.value === "string") {
        const values = observed.get(name) as string[];
        if (values.indexOf(raw.value) === -1) values.push(raw.value);
      }
    }
  }

  const out: Record<string, SpecProperty> = {};
  for (const [name, type] of types) {
    const values = observed.get(name) as string[];
    out[name] = prune({
      type,
      // VARIANT 以外の観測値は「その example の中身」でしかないので候補値として出さない
      values: type === VARIANT && values.length > 0 ? values : undefined,
    });
  }
  return out;
}

function exampleProps(example: RawExample): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (!example.properties) return props;
  for (const [key, raw] of Object.entries(example.properties)) {
    props[propKeyName(key)] = raw.value;
  }
  return props;
}

// ---------------------------------------------------------------------------
// component 単位
// ---------------------------------------------------------------------------

export interface BuiltComponent {
  readonly spec: ComponentSpec;
  readonly warnings: readonly string[];
}

export function buildComponentSpec(
  group: RawGroup,
  screenshots: Readonly<Record<string, string>> = {}
): BuiltComponent {
  const warnings: string[] = [];

  if (group.definitionsError !== undefined) {
    warnings.push(
      `componentPropertyDefinitions の読み取りに失敗: ${group.name}: ${group.definitionsError}`
    );
  }
  for (const example of group.examples) {
    if (example.extractionError !== undefined) {
      warnings.push(
        `プロパティの読み取りに失敗: ${example.name} (${example.nodeId}): ${example.extractionError}`
      );
    }
  }

  const useDefinitions = hasDefinitions(group);
  const source: SpecSource = useDefinitions ? "definitions" : "examples";
  const properties = useDefinitions
    ? fromDefinitions(
        group.definitions as Readonly<Record<string, RawPropertyDefinition>>,
        warnings,
        group.name
      )
    : fromExamples(group.examples, warnings, group.name);

  if (!useDefinitions) {
    warnings.push(
      `definitions を辿れないため examples から集約しました (取りうる値は網羅でない可能性): ${group.name}`
    );
  } else {
    // definitions にあるはずのプロパティが例側にしか出ないのは、定義と実体のずれ
    const unknown: string[] = [];
    for (const example of group.examples) {
      if (!example.properties) continue;
      for (const key of Object.keys(example.properties)) {
        const name = propKeyName(key);
        if (properties[name] === undefined && unknown.indexOf(name) === -1) unknown.push(name);
      }
    }
    for (const name of unknown) {
      warnings.push(`definitions に無いプロパティを example で観測: ${group.name}.${name}`);
    }
  }

  const examples: SpecExample[] = group.examples.map((example) =>
    prune<SpecExample>({
      nodeId: example.nodeId,
      name: example.name,
      props: exampleProps(example),
      screenshot: screenshots[example.nodeId],
    })
  );

  return {
    spec: prune<ComponentSpec>({
      name: group.name,
      componentSetId: group.componentSetId,
      source,
      properties,
      examples,
    }),
    warnings,
  };
}

/** UI のリスト 1 行。仕様本体と同じ組み立てを通して source を一致させる */
export function summarizeGroup(group: RawGroup): GroupSummary {
  const built = buildComponentSpec(group);
  return {
    key: group.key,
    name: built.spec.name,
    source: built.spec.source,
    exampleCount: built.spec.examples.length,
    propertyCount: Object.keys(built.spec.properties).length,
    warningCount: built.warnings.length,
  };
}

// ---------------------------------------------------------------------------
// document 全体
// ---------------------------------------------------------------------------

export function buildSpecDocument(input: BuildInput): SpecDocument {
  const warnings: string[] = input.warnings ? input.warnings.slice() : [];
  const components: ComponentSpec[] = [];

  for (const group of input.groups) {
    const built = buildComponentSpec(group, input.screenshots ?? {});
    components.push(built.spec);
    for (const warning of built.warnings) warnings.push(warning);
  }

  return {
    meta: {
      fileName: input.meta.fileName,
      pluginVersion: input.meta.pluginVersion,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: input.meta.exportedAt,
      warnings,
    },
    components,
  };
}
