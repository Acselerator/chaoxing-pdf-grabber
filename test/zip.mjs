// 只认 STORE（本项目的 ZIP 写入器就是 STORE），用来在测试里自解包校验。
import assert from "node:assert/strict";

export function crc32Ref(bytes) {
  let table = crc32Ref.table;
  if (!table) {
    table = crc32Ref.table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  assert.ok(eocd >= 0, "找不到 ZIP 的 EOCD 记录");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, "中央目录签名不对");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.push({ name, flags, method, crc, compSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  for (const entry of entries) {
    assert.equal(view.getUint32(entry.localOffset, true), 0x04034b50, "局部头签名不对");
    const nameLen = view.getUint16(entry.localOffset + 26, true);
    const extraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    entry.data = bytes.subarray(dataStart, dataStart + entry.compSize);
  }
  return entries;
}
