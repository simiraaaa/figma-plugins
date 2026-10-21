/**
 * Structure Dump の開発用サーバー。使い方は plugins/structure-dump/README.md の「開発ループ」。
 *
 *   npm run dev:server                       # 受けた結果は .dev-dump/ に置く
 *   npm run dev:server -- --out <ディレクトリ>
 */
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDevServer, DEV_PORT } from "./dev-server-lib.mts";

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
let listening = 0;
for (const host of ["127.0.0.1", "::1"]) {
  const server = http.createServer(handler);
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`ポート ${DEV_PORT} は使用中 (dev サーバーがもう起動していないか確かめる)`);
      process.exit(1);
    }
    console.error(`${host} で待ち受けられない: ${e.message}`);
  });
  server.listen(DEV_PORT, host, () => {
    listening += 1;
    if (listening === 1) {
      console.log(`dev サーバー: http://localhost:${DEV_PORT} (結果は ${outDir}/latest)`);
    }
  });
}
