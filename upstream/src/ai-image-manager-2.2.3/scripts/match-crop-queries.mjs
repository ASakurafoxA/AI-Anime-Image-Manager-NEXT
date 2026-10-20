/**
 * 用户提供的裁剪图 → 与图库全部指纹比对，看 pHash 到底能不能认出来。
 * 用法：electron.exe --experimental-strip-types scripts/match-crop-queries.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { hammingDistance } from "../src/services/bk-tree.ts";
import { computePHash } from "../src/services/phash.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "crop-query.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

/** 用户这次给的 4 张裁剪图（DSH 附件的规范化副本） */
const QUERIES = [
  ["图1 猫耳粉发少女", "d7f93d2fb9599e54e69ce77d1cc3d135bf6a183824199b1c2befd7e005901aa1"],
  ["图2 金发蓝眼女仆", "f85af0e3079783d39df258de832fb2eb8c336f77ea5341c94020fac73f0cff62"],
  ["图3 樱花和服（倒置）", "74f0a5cc55fd06435f3c51f7ea1f1da3026d1f14e1af75222722cfd09f1bebd8"],
  ["图4 粉眼蕾丝边", "31fdba7e1518223b0d5bbc21747b83b690c7b6f266aac9c12e81f093f17cd608"],
].map(([name, sha]) => [
  name,
  `C:\\Users\\Sakura\\.dsh\\attachments\\v1\\objects\\${sha.slice(0, 2)}\\${sha}`,
]);

const db = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
const rows = db
  .prepare(
    "SELECT id, path, phash, width, height FROM photos WHERE deleted_at IS NULL AND phash IS NOT NULL"
  )
  .all();
db.close();
log(`图库指纹 ${rows.length} 条\n`);

for (const [name, file] of QUERIES) {
  if (!fs.existsSync(file)) {
    log(`[${name}] 附件文件不存在：${file}\n`);
    continue;
  }
  const phash = await computePHash(file);
  const scored = rows
    .map((r) => ({ d: hammingDistance(r.phash, phash), ...r }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  log(`[${name}]`);
  log(`   查询图指纹 ${phash}`);
  log(`   与图库最接近的 5 张（距离越小越像）：`);
  for (const s of scored) {
    log(
      `     ${String(s.d).padStart(2)}  ${(s.path.split("\\").pop() ?? "").slice(0, 42)}  ${s.width}x${s.height}`
    );
  }
  log(`   → 最小距离 ${scored[0]?.d}`);
  log("");
}
log("判读标准：0~4 快档命中；5~8 生产默认命中；9~12 细档命中；>12 都抓不到");
log("         （不同内容的图之间实测约 26~40）");
log("DONE");
