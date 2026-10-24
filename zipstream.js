/* 串流 ZIP 寫入器（只存不壓縮，照片／影片本來就已壓縮過）。
 * - 記憶體用量固定：一次只處理一個資料片段，不會把整個檔案或整份 ZIP 放進記憶體。
 * - 每個檔案用「資料描述區（data descriptor）」，所以不必事先知道 CRC32。
 * - 已知檔案大小 ≥ 4GB 的項目、或整份 ZIP 超過 4GB／65535 個項目時，自動使用 ZIP64。
 * - 檔名以 UTF-8 儲存（旗標 bit 11），中文檔名可正常解壓。
 *
 * 用法：
 *   const stream = IBZip.createZipStream(asyncIterableOfEntries);
 *   entry = { name: 'a/b.jpg', lastModified: Date|ms, size?: number, data?: Uint8Array, stream?: ReadableStream }
 *   有給 size 時會在結尾檢查實際位元組數是否相符，不符就讓整個串流失敗（不會默默產生壞檔）。 */
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32Update(crc, u8) {
    let c = crc ^ 0xffffffff;
    const t = CRC_TABLE, n = u8.length;
    let i = 0;
    for (; i + 4 <= n; i += 4) {
      c = t[(c ^ u8[i]) & 255] ^ (c >>> 8);
      c = t[(c ^ u8[i + 1]) & 255] ^ (c >>> 8);
      c = t[(c ^ u8[i + 2]) & 255] ^ (c >>> 8);
      c = t[(c ^ u8[i + 3]) & 255] ^ (c >>> 8);
    }
    for (; i < n; i++) c = t[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const U32_MAX = 0xffffffff;
  const U16_MAX = 0xffff;
  const enc = new TextEncoder();

  function dosDateTime(d) {
    const dt = d instanceof Date ? d : new Date(d || Date.now());
    let y = dt.getFullYear();
    if (!(y >= 1980)) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
    if (y > 2107) y = 2107;
    return {
      time: (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate()
    };
  }

  // 小工具：以 DataView 寫入 little-endian 欄位
  function writer(len) {
    const buf = new Uint8Array(len), dv = new DataView(buf.buffer);
    return {
      buf,
      u16: (o, v) => dv.setUint16(o, v, true),
      u32: (o, v) => dv.setUint32(o, v >>> 0, true),
      u64: (o, v) => { dv.setUint32(o, v % 4294967296, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true); }
    };
  }

  function localHeader(nameBytes, dt, zip64) {
    const extraLen = zip64 ? 20 : 0;
    const w = writer(30 + nameBytes.length + extraLen);
    w.u32(0, 0x04034b50);
    w.u16(4, zip64 ? 45 : 20);
    w.u16(6, 0x0808);            // bit 3：CRC／大小放在資料之後；bit 11：UTF-8 檔名
    w.u16(8, 0);                 // 方法 0：只存不壓縮
    w.u16(10, dt.time); w.u16(12, dt.date);
    w.u32(14, 0);                // CRC32：稍後在資料描述區補上
    w.u32(18, zip64 ? U32_MAX : 0);
    w.u32(22, zip64 ? U32_MAX : 0);
    w.u16(26, nameBytes.length);
    w.u16(28, extraLen);
    w.buf.set(nameBytes, 30);
    if (zip64) { const o = 30 + nameBytes.length; w.u16(o, 1); w.u16(o + 2, 16); /* 兩個 8 位元組大小，先填 0 */ }
    return w.buf;
  }

  function dataDescriptor(crc, size, zip64) {
    if (zip64) { const w = writer(24); w.u32(0, 0x08074b50); w.u32(4, crc); w.u64(8, size); w.u64(16, size); return w.buf; }
    const w = writer(16); w.u32(0, 0x08074b50); w.u32(4, crc); w.u32(8, size); w.u32(12, size); return w.buf;
  }

  function centralRecord(r) {
    const bigOffset = r.offset >= U32_MAX;
    const extraFields = (r.zip64 ? 2 : 0) + (bigOffset ? 1 : 0);
    const extraLen = extraFields ? 4 + extraFields * 8 : 0;
    const w = writer(46 + r.nameBytes.length + extraLen);
    w.u32(0, 0x02014b50);
    w.u16(4, 45);
    w.u16(6, (r.zip64 || bigOffset) ? 45 : 20);
    w.u16(8, 0x0808);
    w.u16(10, 0);
    w.u16(12, r.dt.time); w.u16(14, r.dt.date);
    w.u32(16, r.crc);
    w.u32(20, r.zip64 ? U32_MAX : r.size);
    w.u32(24, r.zip64 ? U32_MAX : r.size);
    w.u16(28, r.nameBytes.length);
    w.u16(30, extraLen);
    w.u16(32, 0); w.u16(34, 0); w.u16(36, 0); w.u32(38, 0);
    w.u32(42, bigOffset ? U32_MAX : r.offset);
    w.buf.set(r.nameBytes, 46);
    if (extraLen) {
      let o = 46 + r.nameBytes.length;
      w.u16(o, 1); w.u16(o + 2, extraFields * 8); o += 4;
      if (r.zip64) { w.u64(o, r.size); w.u64(o + 8, r.size); o += 16; }
      if (bigOffset) w.u64(o, r.offset);
    }
    return w.buf;
  }

  function endRecords(count, cdSize, cdOffset, force64) {
    const need64 = force64 || count >= U16_MAX || cdSize >= U32_MAX || cdOffset >= U32_MAX;
    const parts = [];
    if (need64) {
      const z = writer(56);
      z.u32(0, 0x06064b50); z.u64(4, 44); z.u16(12, 45); z.u16(14, 45);
      z.u32(16, 0); z.u32(20, 0); z.u64(24, count); z.u64(32, count); z.u64(40, cdSize); z.u64(48, cdOffset);
      parts.push(z.buf);
      const l = writer(20);
      l.u32(0, 0x07064b50); l.u32(4, 0); l.u64(8, cdOffset + cdSize); l.u32(16, 1);
      parts.push(l.buf);
    }
    const e = writer(22);
    e.u32(0, 0x06054b50); e.u16(4, 0); e.u16(6, 0);
    e.u16(8, need64 ? U16_MAX : count); e.u16(10, need64 ? U16_MAX : count);
    e.u32(12, need64 ? U32_MAX : cdSize); e.u32(16, need64 ? U32_MAX : cdOffset);
    e.u16(20, 0);
    parts.push(e.buf);
    return parts;
  }

  function readerOf(entry) {
    if (entry.data != null) {
      const bytes = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      let done = false;
      return { read: async () => { if (done || !bytes.length) { done = true; return { done: true }; } done = true; return { done: false, value: bytes }; }, cancel: async () => {} };
    }
    if (entry.stream && entry.stream.getReader) return entry.stream.getReader();
    return { read: async () => ({ done: true }), cancel: async () => {} };
  }

  function createZipStream(entries, opts = {}) {
    const iter = entries[Symbol.asyncIterator] ? entries[Symbol.asyncIterator]() : entries[Symbol.iterator]();
    const force64 = !!opts.forceZip64;
    const central = [];
    let offset = 0, state = 'next', cur = null;

    const emit = (controller, u8) => { controller.enqueue(u8); offset += u8.length; };
    async function abortAll(reason) {
      try { if (cur && cur.reader) await cur.reader.cancel(reason); } catch (e) { /* 忽略 */ }
      try { if (iter.return) await iter.return(); } catch (e) { /* 忽略 */ }
    }

    return new ReadableStream({
      async pull(controller) {
        try {
          if (state === 'next') {
            const r = await iter.next();
            if (r.done) {
              const cdStart = offset;
              central.forEach(rec => emit(controller, centralRecord(rec)));
              const cdSize = offset - cdStart;
              endRecords(central.length, cdSize, cdStart, force64).forEach(p => emit(controller, p));
              state = 'done'; controller.close(); return;
            }
            const e = r.value;
            const nameBytes = enc.encode(String(e.name));
            if (nameBytes.length > U16_MAX) throw new Error('檔名過長：' + e.name);
            const declared = e.data != null ? (e.data.byteLength ?? e.data.length) : (typeof e.size === 'number' ? e.size : null);
            const zip64 = force64 || (declared != null && declared >= U32_MAX);
            const dt = dosDateTime(e.lastModified);
            cur = { entry: e, nameBytes, dt, zip64, declared, offset, crc: 0, size: 0, reader: readerOf(e) };
            emit(controller, localHeader(nameBytes, dt, zip64));
            state = 'data'; return;
          }
          if (state === 'data') {
            const { done, value } = await cur.reader.read();
            if (!done) {
              if (value && value.length) {
                cur.crc = crc32Update(cur.crc, value);
                cur.size += value.length;
                if (!cur.zip64 && cur.size >= U32_MAX) throw new Error('檔案超過 4GB 但事先不知道大小：' + cur.entry.name);
                emit(controller, value);
              }
              return;
            }
            if (cur.declared != null && cur.declared !== cur.size) {
              throw new Error(`「${cur.entry.name}」實際收到 ${cur.size} bytes，與預期 ${cur.declared} bytes 不符`);
            }
            emit(controller, dataDescriptor(cur.crc, cur.size, cur.zip64));
            central.push({ nameBytes: cur.nameBytes, dt: cur.dt, zip64: cur.zip64, crc: cur.crc, size: cur.size, offset: cur.offset });
            cur = null; state = 'next'; return;
          }
        } catch (err) {
          await abortAll(err);
          state = 'done';
          controller.error(err);
        }
      },
      cancel(reason) { state = 'done'; return abortAll(reason); }
    }, new CountQueuingStrategy({ highWaterMark: 1 }));
  }

  const api = { createZipStream, crc32Update };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IBZip = api;
})(typeof self !== 'undefined' ? self : this);
