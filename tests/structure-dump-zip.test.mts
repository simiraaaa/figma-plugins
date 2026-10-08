/**
 * structure-dump の自前 ZIP 実装の検査
 *
 * 実行: npm test
 * 生成した ZIP を実物のリーダー (python3 zipfile) で開けること、
 * 壊れたバイト列が CRC 検査で落ちること (fail-open でないこと) を見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 実行するのは esbuild 産物、型は同じソースから取る(産物側は型を持たない)
import * as zipDist from "../plugins/structure-dump/dist/zip.mjs";
const { buildZip, crc32, utf8Encode } =
  zipDist as unknown as typeof import("../plugins/structure-dump/src/zip.ts");

/** ZIP を書き出して python3 zipfile で読む。CRC 不一致なら例外で落ちる */
function readViaPython(zipBytes: Uint8Array, entryName: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "structure-dump-zip-"));
  const zipPath = join(dir, "out.zip");
  writeFileSync(zipPath, zipBytes);
  return execFileSync("python3", [
    "-c",
    [
      "import sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "bad = z.testzip()",
      "assert bad is None, f'CRC mismatch: {bad}'",
      "sys.stdout.buffer.write(z.read(sys.argv[2]))",
    ].join("\n"),
    zipPath,
    entryName,
  ]);
}

test("crc32 が既知のテストベクタと一致する", () => {
  // CRC-32 (poly 0xEDB88320) の標準チェック値
  assert.equal(crc32(utf8Encode("123456789")), 0xcbf43926);
});

test("utf8Encode がマルチバイト文字を正しく符号化する", () => {
  assert.deepEqual([...utf8Encode("a")], [0x61]);
  assert.deepEqual([...utf8Encode("画")], [0xe7, 0x94, 0xbb]);
  assert.deepEqual([...utf8Encode("😀")], [0xf0, 0x9f, 0x98, 0x80]);
});

test("生成した ZIP を実物のリーダーで開けて内容が一致する", () => {
  const jsonText = '{"tree":[{"name":"画面A"}]}';
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const zip = buildZip([
    { name: "structure.json", data: utf8Encode(jsonText) },
    { name: "screenshots/画面A.1-23.png", data: binary },
  ]);

  assert.equal(readViaPython(zip, "structure.json").toString("utf8"), jsonText);
  assert.deepEqual([...readViaPython(zip, "screenshots/画面A.1-23.png")], [...binary]);
});

function hasUnzipCli(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "日本語のディレクトリ名を含む ZIP を unzip CLI で展開できる (UTF-8 名を CP437 扱いされない)",
  { skip: hasUnzipCli() ? false : "unzip CLI が無い" },
  () => {
    const name = "画面一覧.1-2/ログイン画面.3-4.json";
    const data = utf8Encode('{"a":"画面"}');
    const dir = mkdtempSync(join(tmpdir(), "structure-dump-unzip-"));
    const zipPath = join(dir, "out.zip");
    writeFileSync(zipPath, buildZip([{ name, data }]));
    const outDir = join(dir, "out");
    execFileSync("unzip", ["-q", zipPath, "-d", outDir], { stdio: "pipe" });
    assert.deepEqual([...readFileSync(join(outDir, name))], [...data]);
  }
);

test("中央ディレクトリの version made by が Unix (create_system=3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "structure-dump-zip-"));
  const zipPath = join(dir, "out.zip");
  writeFileSync(zipPath, buildZip([{ name: "a.txt", data: utf8Encode("a") }]));
  const out = execFileSync("python3", [
    "-c",
    "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).infolist()[0].create_system)",
    zipPath,
  ]);
  assert.equal(out.toString().trim(), "3");
});

test("負例: 内容が壊れた ZIP は CRC 検査で落ちる", () => {
  const zip = buildZip([{ name: "structure.json", data: utf8Encode('{"a":1}') }]);
  // local header (30 bytes) + name (14 bytes) の直後 = 格納データの先頭を破壊
  const corrupted = Uint8Array.from(zip);
  corrupted[30 + 14] ^= 0xff;
  assert.throws(
    () => readViaPython(corrupted, "structure.json"),
    /CRC|BadZip|Bad CRC/i,
    "壊れた内容の ZIP が CRC 検査を素通りしている"
  );
});
