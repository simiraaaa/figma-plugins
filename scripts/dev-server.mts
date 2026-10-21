/**
 * Structure Dump の開発用サーバー。使い方は plugins/structure-dump/README.md の「開発ループ」。
 *
 *   npm run dev:server                       # 受けた結果は .dev-dump/ に置く
 *   npm run dev:server -- --out <ディレクトリ>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createDevServer, DEV_PORT, listenOnHosts, portInUseMessage } from "./dev-server-lib.mts";

const { values } = parseArgs({
  options: { out: { type: "string", default: ".dev-dump" } },
});
const outDir = path.resolve(values.out as string);

const handler = createDevServer({
  outDir,
  log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
});

// localhost が IPv4 と IPv6 のどちらに解決されても届くよう両方で受ける。
// LAN へは開かない (依頼を受けると Figma の中身を書き出すため)
const outcome = await listenOnHosts(handler, DEV_PORT, ["127.0.0.1", "::1"]);
outcome.errors.forEach((e) => console.error(`待ち受けられない: ${e}`));
if (outcome.inUse !== undefined) {
  // localhost に聞くと、もう片方のアドレスで別のものに届きうるので、使用中だったアドレスに聞く
  const message = await portInUseMessage(`http://${outcome.inUse}:${DEV_PORT}`);
  console.error(`ポート ${DEV_PORT} は使用中で起動できない。${message}`);
  process.exit(1);
}
if (outcome.servers.length === 0) process.exit(1);
console.log(`dev サーバー: http://localhost:${DEV_PORT} (結果は ${outDir}/latest)`);
