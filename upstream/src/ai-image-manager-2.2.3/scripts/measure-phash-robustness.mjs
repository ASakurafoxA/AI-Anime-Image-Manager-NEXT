/** 量一下合成图的 pHash 在不同分辨率下的实际距离（判断断言该定多少）。 */
import sharp from "sharp";
import { computePHash } from "../src/services/phash.ts";
import { hammingDistance } from "../src/services/bk-tree.ts";

async function make(kind, size) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      let v;
      if (kind === "gradient") {
        raw[o] = Math.round((x / (size - 1)) * 255);
        raw[o + 1] = Math.round((y / (size - 1)) * 255);
        raw[o + 2] = 128;
        continue;
      }
      if (kind === "checker") {
        v = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 255 : 0;
      } else if (kind === "shapes") {
        // 几个大色块 + 一个圆：低频结构丰富，更接近真实插画
        const cx = size * 0.35;
        const cy = size * 0.4;
        const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < (size * 0.22) ** 2;
        const band = Math.floor((y / size) * 4);
        v = inCircle ? 40 : band % 2 === 0 ? 220 : 90;
      } else {
        v = 128;
      }
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

for (const kind of ["gradient", "shapes", "checker"]) {
  const base = await make(kind, 128);
  const h0 = await computePHash(base);
  const out = [];
  for (const s of [48, 64, 96, 256, 400]) {
    const r = await sharp(base).resize(s, s).png().toBuffer();
    const h = await computePHash(r);
    out.push(`${s}->${hammingDistance(h0, h)}`);
  }
  const jpeg = await sharp(base).jpeg({ quality: 70 }).toBuffer();
  out.push(`jpeg70->${hammingDistance(h0, await computePHash(jpeg))}`);
  console.log(`${kind.padEnd(9)} base=${h0}  距各尺寸: ${out.join("  ")}`);
}

const g = await computePHash(await make("gradient", 128));
const c = await computePHash(await make("checker", 128));
const s = await computePHash(await make("shapes", 128));
console.log(`\n不同内容之间: gradient-checker=${hammingDistance(g, c)}  gradient-shapes=${hammingDistance(g, s)}  checker-shapes=${hammingDistance(c, s)}`);
