/**
 * 由宽幅 logo 生成**正方形**浏览器标签页图标。
 *
 * 为什么需要：品牌 logo 是 693×417（约 5:3）。浏览器标签页图标位是正方形，
 * 直接塞进去会上下留大片空白、视觉上缩得很小——就是"图标太小"的实际成因。
 * 正确做法是做一张正方形画布，把 logo 按宽度铺满、垂直居中，四周留极小边距。
 *
 * 纯 Node 实现（不引依赖）：手写 PNG 解码/编码 + 面积平均缩放。
 * 保留透明通道，浅色与深色标签栏都能看清。
 *
 * 用法：node scripts/make-square-icon.mjs <源 png> <输出 png> [边长]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

function decodePng(buffer) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`仅支持 8 位色深，当前 ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const line = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels === 4) { out.copy(rgba, i * 4, s, s + 4); }
    else if (channels === 3) { rgba[i*4]=out[s]; rgba[i*4+1]=out[s+1]; rgba[i*4+2]=out[s+2]; rgba[i*4+3]=255; }
    else if (channels === 2) { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=out[s]; rgba[i*4+3]=out[s+1]; }
    else { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=out[s]; rgba[i*4+3]=255; }
  }
  return { width, height, rgba };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** 面积平均缩放：比最近邻平滑得多，图标缩小时边缘不会碎 */
function resize(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3];
          // 按 alpha 加权，避免透明像素把颜色冲淡出灰边
          r += src[i] * alpha; g += src[i + 1] * alpha; b += src[i + 2] * alpha;
          a += alpha; n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { dst[o] = Math.round(r / a); dst[o + 1] = Math.round(g / a); dst[o + 2] = Math.round(b / a); }
      dst[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

const [srcPath, outPath, sizeArg] = process.argv.slice(2);
const SIZE = Number(sizeArg ?? 512);
/* 左右几乎顶满：logo 是 5:3 的宽幅，放进正方形本就会上下留白，
   再留大边距就会在 16px 的标签页里显得很小。左右留 2% 即可。 */
const MARGIN = 0.02;

const src = decodePng(readFileSync(srcPath));
const maxW = Math.round(SIZE * (1 - MARGIN * 2));
const scale = maxW / src.width;
const dw = maxW;
const dh = Math.round(src.height * scale);
const scaled = resize(src.rgba, src.width, src.height, dw, dh);

const canvas = Buffer.alloc(SIZE * SIZE * 4); // 全透明
const offX = Math.round((SIZE - dw) / 2);
const offY = Math.round((SIZE - dh) / 2);
for (let y = 0; y < dh; y++) {
  scaled.copy(canvas, ((y + offY) * SIZE + offX) * 4, y * dw * 4, (y + 1) * dw * 4);
}
writeFileSync(outPath, encodePng(SIZE, SIZE, canvas));
console.log(`✓ ${outPath}  ${SIZE}×${SIZE}（logo ${dw}×${dh}，垂直居中，透明底）`);
