/* 增量式 MD5（Web Crypto 不支援 MD5）。
 * 用途：備份後與 Google Drive 回傳的 md5Checksum 比對。不是用在安全性用途。
 * 以 4MB 為單位分段讀檔，記憶體用量固定；每段之間讓出執行緒，頁面不會卡住。 */
(function (root) {
  'use strict';

  const S = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ]);
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  function create() {
    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const tail = new Uint8Array(64);
    let tailLen = 0, total = 0, finished = false;
    const M = new Int32Array(16);

    function block(u8, off) {
      for (let j = 0, p = off; j < 16; j++, p += 4) {
        M[j] = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24);
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = S[i];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    function update(u8) {
      if (finished) throw new Error('MD5 已結束');
      let pos = 0; const len = u8.length;
      total += len;
      if (tailLen) {
        const need = 64 - tailLen;
        if (len < need) { tail.set(u8, tailLen); tailLen += len; return; }
        tail.set(u8.subarray(0, need), tailLen);
        block(tail, 0); tailLen = 0; pos = need;
      }
      for (; pos + 64 <= len; pos += 64) block(u8, pos);
      if (pos < len) { tail.set(u8.subarray(pos), 0); tailLen = len - pos; }
    }

    function hex32le(n) {
      let s = '';
      for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 255).toString(16).padStart(2, '0');
      return s;
    }

    function digest() {
      if (!finished) {
        finished = true;
        const bitsLow = (total << 3) >>> 0;
        const bitsHigh = Math.floor(total / 536870912) >>> 0; // total * 8 / 2^32
        const padLen = (tailLen < 56 ? 56 : 120) - tailLen;
        const pad = new Uint8Array(padLen + 8);
        pad[0] = 0x80;
        for (let i = 0; i < 4; i++) { pad[padLen + i] = (bitsLow >>> (i * 8)) & 255; pad[padLen + 4 + i] = (bitsHigh >>> (i * 8)) & 255; }
        const savedTotal = total;
        finished = false; update(pad); finished = true; total = savedTotal;
      }
      return hex32le(a0) + hex32le(b0) + hex32le(c0) + hex32le(d0);
    }

    return { update, digest };
  }

  const CHUNK = 4 * 1024 * 1024;
  const yieldToUi = () => new Promise(r => setTimeout(r, 0));

  // 計算 Blob/File 的 MD5。onProgress(0..1)；shouldStop() 回傳 true 時丟出 {cancelled:true}
  async function ofBlob(blob, opts = {}) {
    const h = create();
    for (let off = 0; off < blob.size; off += CHUNK) {
      if (opts.shouldStop && opts.shouldStop()) { const e = new Error('已取消'); e.cancelled = true; throw e; }
      const buf = await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer();
      h.update(new Uint8Array(buf));
      if (opts.onProgress) opts.onProgress(Math.min(1, (off + CHUNK) / blob.size));
      await yieldToUi();
    }
    return h.digest();
  }

  const api = { create, ofBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IBMd5 = api;
})(typeof self !== 'undefined' ? self : this);
