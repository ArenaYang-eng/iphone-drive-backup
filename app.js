(() => {
  const APP_VERSION = 'v3.9';
  const $ = id => document.getElementById(id);

  const verEl = $('versionDisplay');
  if (verEl) verEl.textContent = APP_VERSION;

  let tokenClient = null;
  let accessToken = null;
  let selectedFiles = [];
  let folderHistory = [];
  let uploading = false;
  let currentFolderFiles = [];
  let cancelRequested = false;
  let currentXhr = null;
  let failedJobs = [];
  let wakeLock = null;
  let hiddenDuringUpload = false;
  let exifrMissingCount = 0;
  let swReg = null;
  let syncUpdateBar = () => {};
  let ledgerAcct = null;
  let ledgerAcctPromise = null;
  let ledgerEpoch = 0;
  let ledgerDbPromise = null;
  let ledgerBusy = false;
  const ledgerKeys = new Set();
  let lastBackupStartedAt = 0;
  let historyDetailOpen = false;

  const savedClientId = localStorage.getItem('iphoneDriveBackupClientId') || '';
  if ($('clientId')) $('clientId').value = savedClientId;

  // --- Tab 切換邏輯 ---
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.target).classList.add('active');
    });
  });

  // --- 輔助函式 ---
  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    if (bytes < 1024*1024*1024) return (bytes/1024/1024).toFixed(1) + ' MB';
    return (bytes/1024/1024/1024).toFixed(2) + ' GB';
  }

  function showResult(message, type='') {
    if ($('result')) { $('result').className = type; $('result').textContent = message; }
  }

  function refreshSelection() {
    if (!$('selectionCount')) return;
    $('selectionCount').textContent = selectedFiles.length ? `${selectedFiles.length} 個檔案` : '尚未選取檔案';
    $('fileList').replaceChildren();
    selectedFiles.forEach((file, index) => {
      const li = document.createElement('li'); li.className = 'file';
      const name = document.createElement('div'); name.textContent = `${index+1}. ${file.name}`;
      if (inLedger(file)) { const b = document.createElement('span'); b.className = 'pill ok'; b.style.marginLeft = '6px'; b.textContent = '帳本：已備份'; name.append(b); }
      const meta = document.createElement('div'); meta.className = 'filemeta'; meta.textContent = `${humanSize(file.size)} · ${file.type || '未知格式'}`;
      li.append(name, meta); $('fileList').append(li);
    });
    const ledgerHits = selectedFiles.filter(inLedger).length;
    if ($('ledgerHint')) {
      $('ledgerHint').hidden = !ledgerHits;
      $('ledgerHint').textContent = ledgerHits ? `${ledgerHits} 個檔案先前已備份過（依本機帳本）。備份時會先向 Google Drive 驗證檔案仍在，驗證通過就直接跳過。` : '';
    }
    if ($('pruneBackedUp')) $('pruneBackedUp').hidden = !(ledgerHits && accessToken && !uploading && !ledgerBusy);
    $('backup').disabled = !accessToken || (!selectedFiles.length && !$('includeContacts').checked && !$('includeCalendar').checked) || uploading || ledgerBusy;
  }

  function addFiles(list) {
    const existing = new Set(selectedFiles.map(f => `${f.name}|${f.size}|${f.lastModified}`));
    for (const f of list) {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (!existing.has(key)) { selectedFiles.push(f); existing.add(key); }
    }
    refreshSelection();
  }

  // ===== 新增：備份紀錄（IndexedDB）=====
  const HISTORY_DB = 'iphoneBackupHistory';
  const HISTORY_STORE = 'runs';
  let historyDbPromise = null;

  function openHistoryDb() {
    if (!historyDbPromise) {
      historyDbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('此瀏覽器不支援 IndexedDB'));
        const req = indexedDB.open(HISTORY_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(HISTORY_STORE)) {
            const st = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
            st.createIndex('endedAt', 'endedAt');
          }
        };
        req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error || new Error('無法開啟備份紀錄資料庫'));
      });
      historyDbPromise.catch(() => { historyDbPromise = null; });
    }
    return historyDbPromise;
  }

  async function saveBackupRun(run) {
    try {
      const db = await openHistoryDb();
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).put(run);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      const all = await listBackupRuns(200);
      if (all.length > 50) {
        const tx2 = db.transaction(HISTORY_STORE, 'readwrite');
        const st = tx2.objectStore(HISTORY_STORE);
        all.slice(50).forEach(r => st.delete(r.id));
        await new Promise((res, rej) => { tx2.oncomplete = res; tx2.onerror = () => rej(tx2.error); });
      }
    } catch (e) { console.warn('儲存備份紀錄失敗:', e); }
  }

  async function listBackupRuns(limit = 50) {
    try {
      const db = await openHistoryDb();
      const tx = db.transaction(HISTORY_STORE, 'readonly');
      const st = tx.objectStore(HISTORY_STORE);
      const idx = st.index('endedAt');
      const req = idx.openCursor(null, 'prev');
      const out = [];
      await new Promise((resolve, reject) => {
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor && out.length < limit) { out.push(cursor.value); cursor.continue(); }
          else resolve();
        };
        req.onerror = () => reject(req.error);
      });
      return out;
    } catch (e) { console.warn('讀取備份紀錄失敗:', e); return []; }
  }

  async function clearBackupRuns() {
    try {
      const db = await openHistoryDb();
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).clear();
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { console.warn('清除備份紀錄失敗:', e); }
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }

  async function loadBackupHistory() {
    const list = $('historyList');
    if (!list) return;
    let runs = await listBackupRuns(5);
    // 若 IndexedDB 沒有資料，退回 localStorage 舊資料（相容）
    if (!runs.length) {
      let old = [];
      try { old = JSON.parse(localStorage.getItem('iphoneBackupHistory') || '[]'); } catch (e) { old = []; }
      if (Array.isArray(old) && old.length) {
        list.replaceChildren(...old.map(item => el('li', { class: 'hist-item' },
          el('strong', { text: String(item.time) }), el('br'),
          `成功: ${item.success} | 跳過: ${item.skipped} | 失敗: ${item.failures}`)));
        if ($('lastBackupInfo')) $('lastBackupInfo').textContent = `上次備份（舊版紀錄）：${old[0].time}`;
        return;
      }
      list.replaceChildren(el('li', { text: '尚無備份紀錄' }));
      if ($('lastBackupInfo')) $('lastBackupInfo').textContent = '尚無備份紀錄';
      return;
    }
    if ($('lastBackupInfo')) {
      const r = runs[0];
      $('lastBackupInfo').textContent = `上次備份：${fmtTime(r.endedAt)}｜成功 ${r.success} / 跳過 ${r.skipped} / 失敗 ${r.failures}${r.unprocessed ? ` / 未處理 ${r.unprocessed}` : ''}`;
    }
    list.replaceChildren(...runs.map(run => {
      const li = el('li', { class: 'hist-item' });
      const head = el('div', null,
        el('strong', { text: fmtTime(run.endedAt) }),
        el('br'),
        `成功: ${run.success} | 帳本跳過: ${run.ledgerSkipped || 0} | 跳過重複: ${(run.skipped || 0) - (run.ledgerSkipped || 0) > 0 ? (run.skipped || 0) - (run.ledgerSkipped || 0) : 0} | 失敗: ${run.failures}${run.unprocessed ? ` | 未處理: ${run.unprocessed}` : ''}`
      );
      li.append(head);
      return li;
    }));
    if (historyDetailOpen) renderHistoryDetails();
  }

  async function renderHistoryDetails() {
    const box = $('historyDetail');
    if (!box) return;
    if (!historyDetailOpen) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren(el('div', { text: '載入中…' }));
    const runs = await listBackupRuns(10);
    if (!runs.length) { box.replaceChildren(el('div', { text: '尚無詳細紀錄。' })); return; }
    const parts = [];
    runs.forEach(run => {
      const wrap = el('div', { class: 'hist-detail' });
      wrap.append(el('div', null, el('strong', { text: fmtTime(run.endedAt) }), ' ', el('span', { text: run.stopReason ? `（結束原因：${run.stopReason}）` : '' })));
      if (run.notes && run.notes.length) wrap.append(el('div', { text: '備註：' + run.notes.join('、') }));
      (run.files || []).forEach(f => {
        const cls = f.status === 'success' ? 'ok' : f.status === 'failure' ? 'fail' : 'skip';
        const label = f.status === 'success' ? '✅' : f.status === 'failure' ? '❌' : f.status === 'skipped' ? '⏭️' : f.status === 'ledger-skipped' ? '📒' : '⏸️';
        wrap.append(el('div', { class: 'hist-file ' + cls, text: `${label} ${f.name}${f.message ? ' — ' + f.message : ''}${f.md5Verified ? ' （MD5 已驗證）' : ''}` }));
      });
      parts.push(wrap);
    });
    box.replaceChildren(...parts);
  }

  async function exportHistoryJson() {
    const runs = await listBackupRuns(200);
    if (!runs.length) { showResult('沒有可匯出的紀錄。', 'error'); return; }
    const blob = new Blob([JSON.stringify(runs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `backup-history-${stampTag()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showResult(`已匯出 ${runs.length} 筆紀錄。`, 'success');
  }

  // 保留舊函式以相容（會被 runJobs 同時呼叫）
  function saveBackupHistory(success, skipped, failures) {
    try {
      const history = JSON.parse(localStorage.getItem('iphoneBackupHistory') || '[]');
      const now = new Date();
      const timeStr = `${now.getMonth()+1}/${now.getDate()} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
      history.unshift({ time: timeStr, success, skipped: skipped.length, failures: failures.length });
      localStorage.setItem('iphoneBackupHistory', JSON.stringify(history.slice(0, 5)));
    } catch (e) { /* 忽略 */ }
  }

  // ===== 新增：MD5（純 JS）=====
  const md5 = (() => {
    function safeAdd(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
    function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q,a,b,x,s,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
    function binl(x, len) {
      x[len >> 5] |= 0x80 << (len % 32);
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
      for (let i=0;i<x.length;i+=16) {
        const oa=a,ob=b,oc=c,od=d;
        a=ff(a,b,c,d,x[i],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
        a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
        a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
        a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
        a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i],20,-373897302);
        a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
        a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
        a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
        a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
        a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
        a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i],11,-358537222);c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
        a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
        a=ii(a,b,c,d,x[i],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
        a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
        a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
        a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
        a=safeAdd(a,oa);b=safeAdd(b,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
      }
      return [a,b,c,d];
    }
    function binl2hex(arr) {
      let out='';const h='0123456789abcdef';
      for (let i=0;i<arr.length*4;i++) { const b=(arr[i>>2]>>((i%4)*8))&0xff; out+=h.charAt((b>>4)&0xf)+h.charAt(b&0xf); }
      return out;
    }
    return function md5ArrayBuffer(buf) {
      const u8 = new Uint8Array(buf);
      const x = [];
      const len = u8.length * 8;
      for (let i = 0; i < u8.length; i++) x[i >> 2] = (x[i >> 2] || 0) | (u8[i] << ((i % 4) * 8));
      return binl2hex(binl(x, len));
    };
  })();

  // ===== 新增：ZIP（STORE，Blob 拼接不複製資料）=====
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[i]=c>>>0;}
    return t;
  })();
  function dosDateTime(d = new Date()) {
    const time = ((d.getHours()&0x1F)<<11)|((d.getMinutes()&0x3F)<<5)|((d.getSeconds()>>1)&0x1F);
    const date = (((d.getFullYear()-1980)&0x7F)<<9)|(((d.getMonth()+1)&0x0F)<<5)|(d.getDate()&0x1F);
    return { time, date };
  }
  function makeZipLocalHeader(nameBytes, crc, size) {
    const { time, date } = dosDateTime();
    const buf = new ArrayBuffer(30 + nameBytes.length);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    new Uint8Array(buf, 30).set(nameBytes);
    return new Uint8Array(buf);
  }
  function makeZipCentralHeader(nameBytes, crc, size, offset) {
    const { time, date } = dosDateTime();
    const buf = new ArrayBuffer(46 + nameBytes.length);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, offset, true);
    new Uint8Array(buf, 46).set(nameBytes);
    return new Uint8Array(buf);
  }
  function makeZipEocd(count, cdSize, cdOffset) {
    const buf = new ArrayBuffer(22);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, count, true);
    dv.setUint16(10, count, true);
    dv.setUint32(12, cdSize, true);
    dv.setUint32(16, cdOffset, true);
    dv.setUint16(20, 0, true);
    return new Uint8Array(buf);
  }
  async function crc32OfBlob(blob) {
    let crc = 0xFFFFFFFF;
    const reader = blob.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ value[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  async function buildZip(entries, onStatus) {
    const enc = new TextEncoder();
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i++) {
      const { name, blob } = entries[i];
      if (onStatus) onStatus(`計算檢查碼 (${i+1}/${entries.length})：${name}`);
      const crc = await crc32OfBlob(blob);
      const nameBytes = enc.encode(name);
      parts.push(makeZipLocalHeader(nameBytes, crc, blob.size), blob);
      centrals.push(makeZipCentralHeader(nameBytes, crc, blob.size, offset));
      offset += 30 + nameBytes.length + blob.size;
    }
    let cdSize = 0;
    centrals.forEach(p => cdSize += p.length);
    return new Blob([...parts, ...centrals, makeZipEocd(entries.length, cdSize, offset)], { type: 'application/zip' });
  }

  // ===== 新增：儲存或分享 Blob =====
  async function saveBlob(blob, name, mode = 'download') {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return { shared: true }; }
      catch (e) { if (e.name === 'AbortError') return { shared: true, aborted: true }; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { shared: false };
  }

  // --- Google 授權 ---
  const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.file';
  const SCOPE_CONTACTS = 'https://www.googleapis.com/auth/contacts.readonly';
  const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';
  let tokenClientId = null;
  let tokenExpiresAt = 0;
  let grantedScopes = new Set();
  let pendingAuth = null;
  let reauthWaiter = null;
  let connectedOnce = false;

  const hasScope = sc => grantedScopes.has(sc);
  const tokenFresh = (marginMs = 60000) => !!accessToken && Date.now() < tokenExpiresAt - marginMs;
  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('等待逾時')), ms));

  function initTokenClient() {
    const id = $('clientId').value.trim();
    if (tokenClient && tokenClientId === id) return tokenClient;
    tokenClientId = id;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE_DRIVE,
      callback: response => {
        const p = pendingAuth; pendingAuth = null;
        if (response.error) { if (p) p.reject(new Error(response.error)); return; }
        applyToken(response);
        if (p) p.resolve(response);
      },
      error_callback: err => {
        const p = pendingAuth; pendingAuth = null;
        if (p) p.reject(new Error(err.message || err.type || '授權視窗發生問題'));
      }
    });
    return tokenClient;
  }

  function applyToken(r) {
    accessToken = r.access_token;
    tokenExpiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000;
    if (r.scope) grantedScopes = new Set(r.scope.split(' ').filter(Boolean));
    connectedOnce = true;
    $('connection').textContent = '已連線'; $('connection').className = 'pill ok';
  }

  function requestToken(overrides = {}) {
    return new Promise((resolve, reject) => {
      if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google 登入元件尚未載入'));
      if (pendingAuth) pendingAuth.reject(new Error('已被新的授權要求取代'));
      pendingAuth = { resolve, reject };
      try { initTokenClient().requestAccessToken(overrides); }
      catch (e) { pendingAuth = null; reject(e); }
    });
  }

  function ensureToken(force = false) {
    if (!connectedOnce) return Promise.reject(new Error('尚未連線 Google'));
    if (!force && tokenFresh()) return Promise.resolve();
    if (reauthWaiter) return reauthWaiter;
    reauthWaiter = (async () => {
      try {
        try { await Promise.race([requestToken({ prompt: '' }), timeout(20000)]); return; }
        catch (e) { console.warn('自動續期失敗，改為手動重新授權:', e.message); }
        await waitForManualReauth();
      } finally { reauthWaiter = null; }
    })();
    return reauthWaiter;
  }

  function waitForManualReauth() {
    return new Promise((resolve, reject) => {
      const box = $('reauthBox'), ok = $('reauthBtn'), no = $('reauthCancel');
      const cleanup = () => { box.hidden = true; ok.disabled = false; ok.removeEventListener('click', onOk); no.removeEventListener('click', onNo); };
      const onOk = async () => {
        ok.disabled = true;
        try {
          await requestToken({ prompt: '' });
          cleanup();
          $('uploadState').textContent = uploading ? '處理中' : '已連線';
          resolve();
        } catch (e) {
          ok.disabled = false;
          $('reauthMsg').textContent = `授權未完成（${e.message}），請再按一次「重新授權並繼續」。`;
        }
      };
      const onNo = () => { cleanup(); const e = new Error('已放棄重新授權'); e.aborted = true; reject(e); };
      $('reauthMsg').textContent = 'Google 授權已過期，無法自動續期。請按下方按鈕重新授權，備份會從目前的檔案繼續。';
      box.hidden = false;
      $('uploadState').textContent = '需要重新授權';
      $('connection').textContent = '授權已過期'; $('connection').className = 'pill warn';
      ok.addEventListener('click', onOk); no.addEventListener('click', onNo);
    });
  }

  async function authFetch(url, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensureToken(attempt > 0);
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', 'Bearer ' + accessToken);
      const response = await fetch(url, { ...options, headers });
      if (response.status !== 401 || attempt === 1) return response;
    }
  }

  async function apiRequest(url, options = {}) {
    const response = await authFetch(url, options);
    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`Google API ${response.status}: ${body.slice(0, 500)}`);
      err.status = response.status;
      throw err;
    }
    return response.status === 204 ? null : response.json();
  }

  // --- 資料夾快取 ---
  const ROOT_NAME = 'iPhone 手動備份';
  const folderCache = new Map();
  let rootFolderPromise = null;
  const qEsc = v => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const rootKey = () => 'iphoneBackupRootFolderId:' + $('clientId').value.trim();

  function resetDriveCaches() { folderCache.clear(); rootFolderPromise = null; ledgerEpoch++; ledgerAcct = null; ledgerAcctPromise = null; ledgerKeys.clear(); }

  function getOrCreateFolder(folderName, parentId = null) {
    const key = `${parentId || 'root'}/${folderName}`;
    if (!folderCache.has(key)) {
      const p = (async () => {
        let query = `name = '${qEsc(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        if (parentId) query += ` and '${parentId}' in parents`;
        const found = await apiRequest(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
        if (found.files && found.files.length > 0) return found.files[0].id;
        const metadata = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
        if (parentId) metadata.parents = [parentId];
        const folder = await apiRequest('https://www.googleapis.com/drive/v3/files?fields=id', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
        });
        return folder.id;
      })();
      folderCache.set(key, p);
      p.catch(() => folderCache.delete(key));
    }
    return folderCache.get(key);
  }

  function getRootFolderId() {
    if (!rootFolderPromise) {
      rootFolderPromise = (async () => {
        const saved = localStorage.getItem(rootKey());
        if (saved) {
          try {
            const f = await apiRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(saved)}?fields=id,trashed,mimeType`);
            if (f && !f.trashed && f.mimeType === 'application/vnd.google-apps.folder') return f.id;
          } catch (e) { console.warn('已儲存的根資料夾無法使用，改為重新尋找:', e.message); }
        }
        const id = await getOrCreateFolder(ROOT_NAME);
        try { localStorage.setItem(rootKey(), id); } catch (e) { /* 忽略 */ }
        return id;
      })();
      rootFolderPromise.catch(() => { rootFolderPromise = null; });
    }
    return rootFolderPromise;
  }

  const MEDIA_EXT = /\.(jpe?g|png|heic|heif|gif|webp|tiff?|bmp|dng|avif|mov|mp4|m4v|3gp|avi|mkv)$/i;
  const EXIF_EXT = /\.(jpe?g|png|heic|heif|tiff?|dng|avif)$/i;

  function isMedia(file) { return /^(image|video)\//.test(file.type) || MEDIA_EXT.test(file.name); }
  function isPlausibleDate(d) { return d instanceof Date && !isNaN(d) && d.getFullYear() >= 1990 && d.getTime() <= Date.now() + 86400000; }

  async function getCaptureDate(file) {
    if (file.type.startsWith('image/') || EXIF_EXT.test(file.name)) {
      if (window.exifr) {
        try {
          const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
          const raw = exif && (exif.DateTimeOriginal || exif.CreateDate);
          const d = raw instanceof Date ? raw : (raw ? new Date(raw) : null);
          if (isPlausibleDate(d)) return d;
        } catch (e) { console.warn('無法讀取 EXIF 時間:', e); }
      } else {
        exifrMissingCount++;
      }
    }
    if (file.lastModified) {
      const d = new Date(file.lastModified);
      if (isPlausibleDate(d) && Date.now() - d.getTime() > 5 * 60 * 1000) return d;
    }
    return null;
  }

  async function getTargetFolder(file, rootFolderId) {
    if (!isMedia(file)) return await getOrCreateFolder('其他檔案', rootFolderId);
    const date = await getCaptureDate(file);
    if (date) {
      const yearFolderId = await getOrCreateFolder(date.getFullYear().toString(), rootFolderId);
      return await getOrCreateFolder((date.getMonth() + 1).toString().padStart(2, '0') + '月', yearFolderId);
    }
    return await getOrCreateFolder('未分類照片', rootFolderId);
  }

  function altName(name, size) {
    const i = name.lastIndexOf('.');
    return i > 0 ? `${name.slice(0, i)}_${size}${name.slice(i)}` : `${name}_${size}`;
  }

  async function checkDuplicate(file, parentId) {
    const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const alt = altName(file.name, file.size);
    const query = `'${parentId}' in parents and trashed = false and (name = '${q(file.name)}' or name = '${q(alt)}')`;
    const res = await apiRequest(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,size)&pageSize=100`);
    const files = res.files || [];
    const match = files.find(f => Number(f.size) === file.size);
    if (match) return { duplicate: true, existingId: match.id, existingName: match.name };
    const nameTaken = files.some(f => f.name === file.name);
    return { duplicate: false, uploadName: nameTaken ? alt : file.name };
  }

  async function uploadFileWithRetry(file, parentId, onProgress, uploadName, maxRetries = 3) {
    let authRetries = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ensureToken();
        throwIfCancelled();
        const result = await uploadFile(file, parentId, onProgress, uploadName);
        if (result.size && Number(result.size) !== file.size) throw new Error(`檔案大小不符 (本地: ${file.size}, 雲端: ${result.size})`);
        return result;
      } catch (err) {
        if (err.cancelled || err.aborted || err.quota) throw err;
        if (err.status === 401 && authRetries < 2) {
          authRetries++; attempt--;
          if (onProgress) onProgress(0);
          await ensureToken(true);
          continue;
        }
        console.warn(`第 ${attempt} 次上傳失敗:`, err);
        if (attempt === maxRetries) throw new Error(`重試 ${maxRetries} 次後仍失敗: ${err.message}`);
        await sleep(2000);
        throwIfCancelled();
        if (onProgress) onProgress(0);
      }
    }
  }

  function uploadFile(file, parentId, onProgress, uploadName) {
    return new Promise((resolve, reject) => {
      const boundary = '-------iphoneBackupBoundary' + Math.random().toString(16).slice(2);
      const metadata = {name:uploadName || file.name, mimeType:file.type || 'application/octet-stream', parents:[parentId], description:`iPhone 手動備份；原始檔案大小 ${file.size} bytes`};
      const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
      const suffix = `\r\n--${boundary}--`;
      const body = new Blob([prefix, file, suffix]);
      const xhr = new XMLHttpRequest();
      xhr.open('POST','https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,webViewLink,md5Checksum');
      xhr.setRequestHeader('Authorization','Bearer '+accessToken);
      xhr.setRequestHeader('Content-Type','multipart/related; boundary='+boundary);
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded/e.total); };
      xhr.onload = () => {
        currentXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch(e) { reject(new Error('Google 回傳資料無法解析')); }
        } else {
          const e = new Error(`上傳失敗（HTTP ${xhr.status}）：${xhr.responseText.slice(0,400)}`);
          e.status = xhr.status;
          if (xhr.status === 403 && /storageQuotaExceeded/.test(xhr.responseText)) { e.quota = true; e.message = 'Google 雲端空間已滿（storageQuotaExceeded）'; }
          reject(e);
        }
      };
      xhr.onerror = () => { currentXhr = null; reject(new Error('網路連線中斷，請確認網路後重試。')); };
      xhr.onabort = () => { currentXhr = null; const e = new Error('上傳已取消。'); e.cancelled = true; reject(e); };
      currentXhr = xhr;
      xhr.send(body);
    });
  }

  // --- vCard 與 iCal 生成（新增：每行折疊、跳脫、分頁、多行事曆）---
  const pad2 = n => String(n).padStart(2, '0');
  const stampTag = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; };

  function esc(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }

  function foldLine(line) {
    const enc = new TextEncoder(); const out = []; let cur = '', bytes = 0, limit = 75;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  const toLines = lines => lines.filter(Boolean).map(foldLine).join('\r\n') + '\r\n';

  async function fetchAllPages(baseUrl, listKey) {
    let items = [], pageToken = null;
    do {
      const url = baseUrl + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await apiRequest(url);
      items = items.concat(res[listKey] || []);
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    return items;
  }

  const PHONE_TYPE = { mobile: 'CELL', home: 'HOME', work: 'WORK', main: 'PREF', homeFax: 'HOME,FAX', workFax: 'WORK,FAX', pager: 'PAGER' };
  const MAIL_TYPE = { home: 'HOME', work: 'WORK' };
  const ADDR_TYPE = { home: 'HOME', work: 'WORK' };

  async function generateContactsVcf() {
    showResult('正在取得 Google 聯絡人...', 'success');
    const fields = 'names,nicknames,phoneNumbers,emailAddresses,organizations,addresses,birthdays,biographies,urls';
    const people = await fetchAllPages(`https://people.googleapis.com/v1/people/me/connections?pageSize=1000&personFields=${fields}`, 'connections');
    const flat = v => String(v ?? '').replace(/\r?\n/g, ' ');
    const out = [];
    people.forEach(p => {
      const n = (p.names || []).find(x => x.metadata && x.metadata.primary) || (p.names || [])[0] || {};
      const org = (p.organizations || [])[0] || {};
      const fn = n.displayName || org.name || (p.emailAddresses || [])[0]?.value || (p.phoneNumbers || [])[0]?.value || '未命名';
      const L = ['BEGIN:VCARD', 'VERSION:3.0'];
      L.push(`N:${esc(n.familyName)};${esc(n.givenName)};${esc(n.middleName)};${esc(n.honorificPrefix)};${esc(n.honorificSuffix)}`);
      L.push(`FN:${esc(fn)}`);
      const nick = (p.nicknames || [])[0]?.value; if (nick) L.push(`NICKNAME:${esc(nick)}`);
      if (org.name || org.department) L.push(`ORG:${esc(org.name)}${org.department ? ';' + esc(org.department) : ''}`);
      if (org.title) L.push(`TITLE:${esc(org.title)}`);
      if (org.name && !n.familyName && !n.givenName) L.push('X-ABShowAs:COMPANY');
      (p.phoneNumbers || []).forEach(ph => L.push(`TEL;TYPE=${PHONE_TYPE[ph.type] || 'VOICE'}:${flat(ph.value)}`));
      (p.emailAddresses || []).forEach(em => L.push(`EMAIL;TYPE=${MAIL_TYPE[em.type] || 'INTERNET'}:${flat(em.value)}`));
      (p.addresses || []).forEach(a => L.push(`ADR;TYPE=${ADDR_TYPE[a.type] || 'POSTAL'}:;;${esc(a.streetAddress)};${esc(a.city)};${esc(a.region)};${esc(a.postalCode)};${esc(a.country)}`));
      const b = (p.birthdays || [])[0]?.date;
      if (b && b.month && b.day) L.push(`BDAY:${b.year ? String(b.year).padStart(4, '0') : '1604'}-${pad2(b.month)}-${pad2(b.day)}`);
      (p.urls || []).forEach(u => L.push(`URL:${flat(u.value)}`));
      const note = (p.biographies || [])[0]?.value; if (note) L.push(`NOTE:${esc(note)}`);
      L.push('END:VCARD');
      out.push(toLines(L));
    });
    const file = new File([out.join('')], `Google_Contacts_${stampTag()}.vcf`, { type: 'text/vcard' });
    return { file, count: people.length };
  }

  // 修正：全天事件用 VALUE=DATE；定時事件用 UTC，避免 +0800Z
  const icsUtc = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  function icsTimeProp(name, t) {
    if (t.date) return `${name};VALUE=DATE:${t.date.replace(/-/g, '')}`;
    return `${name}:${icsUtc(t.dateTime)}`;
  }

  async function generateCalendarIcs() {
    showResult('正在取得 Google 行事曆...', 'success');
    const rangeVal = $('calendarRange') ? $('calendarRange').value : '1';
    const now = new Date();
    const timeMin = rangeVal === 'all' ? new Date('2000-01-01T00:00:00Z') : new Date(now.getFullYear() - Number(rangeVal), now.getMonth(), now.getDate());
    const timeMax = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());

    const cals = await fetchAllPages('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', 'items');
    const own = cals.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
    const targets = own.length ? own : [{ id: 'primary', summary: '主要行事曆' }];

    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Backup Center//TW//ZH', 'CALSCALE:GREGORIAN'];
    const seen = new Set(); let count = 0;
    for (const cal of targets) {
      const calName = cal.summaryOverride || cal.summary || cal.id;
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?maxResults=2500&singleEvents=true&orderBy=startTime&showDeleted=false&timeMin=${encodeURIComponent(timeMin.toISOString())}&timeMax=${encodeURIComponent(timeMax.toISOString())}`;
      const events = await fetchAllPages(url, 'items');
      for (const ev of events) {
        if (ev.status === 'cancelled' || !ev.start || !(ev.start.date || ev.start.dateTime)) continue;
        const key = `${ev.iCalUID || ev.id}|${ev.start.date || ev.start.dateTime}`;
        if (seen.has(key)) continue; seen.add(key);
        L.push('BEGIN:VEVENT');
        L.push(`UID:${ev.id}@google-calendar-backup`);
        L.push(`DTSTAMP:${icsUtc(ev.updated || now)}`);
        L.push(icsTimeProp('DTSTART', ev.start));
        if (ev.end && (ev.end.date || ev.end.dateTime)) L.push(icsTimeProp('DTEND', ev.end));
        L.push(`SUMMARY:${esc(ev.summary || '未命名事件')}`);
        if (ev.location) L.push(`LOCATION:${esc(ev.location)}`);
        if (ev.description) L.push(`DESCRIPTION:${esc(ev.description)}`);
        L.push(`STATUS:${ev.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`);
        L.push(`CATEGORIES:${esc(calName)}`);
        L.push('END:VEVENT');
        count++;
      }
    }
    L.push('END:VCALENDAR');
    const file = new File([toLines(L)], `Google_Calendar_${stampTag()}.ics`, { type: 'text/calendar' });
    return { file, count, calendars: targets.length };
  }

  // --- 雲端檔案瀏覽與下載 ---
  async function listChildren(parentId) {
    const files = [];
    let pageToken = null;
    do {
      const q = `'${parentId}' in parents and trashed = false`;
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,mimeType,createdTime)&pageSize=1000&orderBy=folder,createdTime desc`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res = await apiRequest(url);
      files.push(...(res.files || []));
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    return files;
  }

  async function loadCloudFiles(targetId = null, targetName = '') {
    if (!accessToken) { showResult('請先連線 Google 才能讀取雲端清單。', 'error'); return; }
    const listEl = $('cloudFileList');
    const crumbEl = $('folderBreadcrumb');
    const batchBar = $('batchActionBar');
    const setList = (...nodes) => listEl.replaceChildren(...nodes);
    setList(el('li', { text: '載入中...' }));
    currentFolderFiles = [];
    if (batchBar) batchBar.style.display = 'none';

    try {
      let currentId = targetId;
      if (!currentId) {
        currentId = await getRootFolderId();
        folderHistory = [{ id: currentId, name: 'iPhone 手動備份' }];
      } else {
        const existingIdx = folderHistory.findIndex(f => f.id === currentId);
        if (existingIdx !== -1) folderHistory = folderHistory.slice(0, existingIdx + 1);
        else folderHistory.push({ id: currentId, name: targetName });
      }

      if (crumbEl) {
        const nodes = [];
        if (folderHistory.length > 1) {
          const back = el('button', { class: 'secondary btn-small', type: 'button', text: '🔙 返回上一層' });
          back.addEventListener('click', () => {
            const prevFolder = folderHistory[folderHistory.length - 2];
            loadCloudFiles(prevFolder.id, prevFolder.name);
          });
          nodes.push(back, el('br'));
        }
        nodes.push(el('span', { class: 'crumb-path', text: '📍 目前位置：' + folderHistory.map(f => f.name).join(' / ') }));
        crumbEl.replaceChildren(...nodes);
      }

      const files = await listChildren(currentId);
      if (!files.length) { setList(el('li', { text: '此資料夾內尚無檔案。' })); return; }

      const rows = files.map(file => {
        const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
        const sizeStr = file.size ? humanSize(Number(file.size)) : '';
        const dateStr = new Date(file.createdTime).toLocaleDateString('zh-TW');
        const li = el('li', { class: 'cloud-row' });
        if (isFolder) {
          const info = el('div', { class: 'cloud-info' },
            el('div', { class: 'cloud-folder', text: '📁 ' + file.name }),
            el('span', { class: 'cloud-sub', text: dateStr }));
          info.addEventListener('click', () => loadCloudFiles(file.id, file.name));
          li.append(info);
        } else {
          currentFolderFiles.push(file);
          const info = el('div', { class: 'cloud-info' },
            el('div', { class: 'cloud-file', text: '📄 ' + file.name }),
            el('span', { class: 'cloud-sub', text: `${dateStr} · ${sizeStr}` }));
          const btnWrap = el('div', { style: 'display:flex; gap:6px; flex:none;' });
          const d = el('button', { class: 'secondary btn-small', type: 'button', text: '下載' });
          d.addEventListener('click', () => downloadFile(file.id, file.name, false, 'download'));
          const s = el('button', { class: 'secondary btn-small', type: 'button', text: '分享' });
          s.addEventListener('click', () => downloadFile(file.id, file.name, false, 'share'));
          btnWrap.append(d, s);
          li.append(info, btnWrap);
        }
        return li;
      });
      setList(...rows);
      if (currentFolderFiles.length > 0 && batchBar) batchBar.style.display = 'flex';
    } catch (err) { setList(el('li', { class: 'error', text: '載入失敗：' + err.message })); }
  }

  async function downloadFile(fileId, fileName, isBatch = false, mode = 'download') {
    try {
      if (!isBatch) showResult(`正在準備${mode === 'share' ? '分享' : '下載'}：${fileName}...`, 'success');
      const response = await authFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      if (!response.ok) throw new Error(`下載失敗 (HTTP ${response.status})`);
      const blob = await response.blob();
      const r = await saveBlob(blob, fileName, mode);
      if (!isBatch) showResult(mode === 'share' && r.shared ? `已分享：${fileName}` : `已觸發下載：${fileName}`, 'success');
      return true;
    } catch (err) {
      if (!isBatch) showResult(`下載失敗：${err.message}`, 'error');
      return false;
    }
  }

  async function batchDownloadZip() {
    if (currentFolderFiles.length === 0) return;
    const btn = $('btnDownloadFolder');
    btn.disabled = true;
    try {
      const entries = [];
      for (let i = 0; i < currentFolderFiles.length; i++) {
        const f = currentFolderFiles[i];
        btn.textContent = `⏳ 下載中 (${i+1}/${currentFolderFiles.length})：${f.name}`;
        const response = await authFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
        if (!response.ok) { console.warn('跳過', f.name, response.status); continue; }
        const blob = await response.blob();
        entries.push({ name: f.name, blob });
      }
      if (!entries.length) { showResult('沒有可下載的檔案。', 'error'); return; }
      btn.textContent = '⏳ 打包 ZIP...';
      const zip = await buildZip(entries, msg => { btn.textContent = '⏳ ' + msg; });
      await saveBlob(zip, `iPhoneBackup_${stampTag()}.zip`, 'download');
      showResult(`已下載 ZIP（${entries.length} 個檔案，共 ${humanSize(zip.size)}）。`, 'success');
    } catch (e) {
      showResult('批次下載失敗：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇️ 打包成 ZIP 下載（此資料夾）';
    }
  }

  async function batchShareFiles() {
    if (currentFolderFiles.length === 0) return;
    if (!navigator.canShare) { showResult('此瀏覽器不支援檔案分享，請使用 ZIP 下載。', 'error'); return; }
    const btn = $('btnShareFolder');
    btn.disabled = true;
    try {
      const files = [];
      for (let i = 0; i < currentFolderFiles.length; i++) {
        const f = currentFolderFiles[i];
        btn.textContent = `⏳ 準備中 (${i+1}/${currentFolderFiles.length})：${f.name}`;
        const response = await authFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
        if (!response.ok) continue;
        const blob = await response.blob();
        files.push(new File([blob], f.name, { type: blob.type || 'application/octet-stream' }));
      }
      if (!files.length) { showResult('沒有可分享的檔案。', 'error'); return; }
      if (!navigator.canShare({ files })) { showResult('此瀏覽器不支援多檔分享，請使用 ZIP 下載。', 'error'); return; }
      await navigator.share({ files, title: '備份檔案' });
      showResult(`已分享 ${files.length} 個檔案。`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') showResult('分享失敗：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📤 逐檔分享（存到相簿／檔案）';
    }
  }

  // --- 事件綁定 ---
  if ($('mediaPicker')) $('mediaPicker').addEventListener('change', e => addFiles(e.target.files));
  if ($('docPicker')) $('docPicker').addEventListener('change', e => addFiles(e.target.files));

  async function onExportToggle(e, scope, label) {
    const box = e.target;
    if (box.checked && !hasScope(scope)) {
      if (!accessToken) {
        box.checked = false;
        showResult('請先連線 Google，再勾選匯出。', 'error');
      } else {
        try {
          await requestToken({ scope, include_granted_scopes: true });
          if (!hasScope(scope)) throw new Error('授權視窗中未勾選此項目');
        } catch (err) {
          box.checked = false;
          showResult(`未取得「${label}」讀取授權：${err.message}`, 'error');
        }
      }
    }
    refreshSelection();
  }
  if ($('includeContacts')) $('includeContacts').addEventListener('change', e => onExportToggle(e, SCOPE_CONTACTS, 'Google 聯絡人'));
  if ($('includeCalendar')) $('includeCalendar').addEventListener('change', e => onExportToggle(e, SCOPE_CALENDAR, 'Google 行事曆'));

  if ($('clearSelection')) {
    $('clearSelection').addEventListener('click', () => {
      selectedFiles = [];
      if ($('mediaPicker')) $('mediaPicker').value='';
      if ($('docPicker')) $('docPicker').value='';
      if ($('includeContacts')) $('includeContacts').checked = false;
      if ($('includeCalendar')) $('includeCalendar').checked = false;
      refreshSelection(); showResult('');
    });
  }

  if ($('saveClient')) {
    $('saveClient').addEventListener('click', () => {
      const id = $('clientId').value.trim();
      const msgEl = $('saveResult');
      if (!id || !id.includes('.apps.googleusercontent.com')) {
        if(msgEl) { msgEl.className = 'error'; msgEl.textContent = '請輸入有效格式的 Google OAuth Web 用戶端 ID。'; }
        return;
      }
      localStorage.setItem('iphoneDriveBackupClientId', id);
      tokenClient = null; resetDriveCaches();
      if(msgEl) { msgEl.className = 'success'; msgEl.textContent = '已儲存用戶端 ID。請按「連線 Google」。'; }
    });
  }

  if ($('connect')) {
    $('connect').addEventListener('click', async () => {
      const id = $('clientId').value.trim();
      if (!id) { showResult('請先輸入 Google OAuth 用戶端 ID。','error'); return; }
      if (!window.google || !google.accounts || !google.accounts.oauth2) { showResult('Google 登入元件尚未載入，請確認網路連線後重試。','error'); return; }
      try {
        resetDriveCaches();
        grantedScopes = new Set();
        await requestToken({ prompt: '' });
        if (!hasScope(SCOPE_DRIVE)) throw new Error('未授予 Google Drive 權限，無法備份');
        $('disconnect').disabled = false;
        $('uploadState').textContent = '已連線';
        refreshSelection();
        showResult('Google Drive 已連線。現在可以選取檔案並備份。','success');
        loadCloudFiles();
        initLedger();
      } catch (err) { showResult('Google 授權失敗：' + err.message, 'error'); }
    });
  }

  if ($('disconnect')) {
    $('disconnect').addEventListener('click', () => {
      if (uploading) { showResult('備份進行中，請先按「取消備份」，再清除連線狀態。', 'error'); return; }
      if (accessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(accessToken, () => {});
      accessToken = null; tokenExpiresAt = 0; connectedOnce = false; grantedScopes = new Set(); resetDriveCaches();
      if ($('reauthBox')) $('reauthBox').hidden = true;
      $('connection').textContent = '尚未連線'; $('connection').className = 'pill warn';
      $('disconnect').disabled = true; $('uploadState').textContent = '待命'; refreshSelection(); renderLedgerStats();
      showResult('已清除本頁的連線狀態。');
    });
  }

  if ($('loadCloudFiles')) $('loadCloudFiles').addEventListener('click', () => loadCloudFiles());
  if ($('btnDownloadFolder')) $('btnDownloadFolder').addEventListener('click', batchDownloadZip);
  if ($('btnShareFolder')) $('btnShareFolder').addEventListener('click', batchShareFiles);

  // ===== 小工具 =====
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    n.append(...children.filter(c => c != null));
    return n;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function throwIfCancelled() {
    if (cancelRequested) { const e = new Error('已取消'); e.cancelled = true; throw e; }
  }

  // ===== 螢幕喚醒 =====
  function setWakeNote(msg, warn = false) {
    const n = $('wakeNote'); if (!n) return;
    n.textContent = msg; n.className = 'hint' + (warn ? ' warn-text' : '');
  }
  async function acquireWakeLock() {
    if (wakeLock && !wakeLock.released) return;
    if (!('wakeLock' in navigator)) { setWakeNote('⚠️ 這個瀏覽器不支援螢幕常亮，備份期間請手動保持螢幕亮起。', true); return; }
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!uploading) { try { await lock.release(); } catch (e) { /* 忽略 */ } return; }
      wakeLock = lock;
      setWakeNote('🔆 備份期間會保持螢幕亮起。');
    } catch (e) {
      wakeLock = null;
      setWakeNote(`⚠️ 無法啟用螢幕常亮（${e.name || '未知原因'}），備份期間請手動保持螢幕亮起。`, true);
    }
  }
  async function releaseWakeLock() {
    const lock = wakeLock; wakeLock = null;
    if (lock && !lock.released) { try { await lock.release(); } catch (e) { /* 忽略 */ } }
    setWakeNote('');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (uploading) hiddenDuringUpload = true; return; }
    if (uploading) acquireWakeLock();
    if (swReg) swReg.update().catch(() => {});
  });

  async function confirmEnoughSpace(jobs) {
    const need = jobs.reduce((sum, f) => sum + f.size, 0);
    let quota;
    try {
      const res = await apiRequest('https://www.googleapis.com/drive/v3/about?fields=storageQuota');
      quota = res && res.storageQuota;
    } catch (e) {
      console.warn('無法取得雲端容量，略過空間檢查:', e.message);
      return { proceed: true };
    }
    if (!quota || !quota.limit) return { proceed: true };
    const free = Math.max(0, Number(quota.limit) - Number(quota.usage || 0));
    if (need <= free) return { proceed: true };
    const ok = confirm(
      `雲端剩餘約 ${humanSize(free)}，本次最多需要 ${humanSize(need)}。\n\n` +
      '空間可能不足（Google 儲存空間與 Gmail、Google 相簿共用）。已存在的重複檔案會被跳過，實際用量可能較少。\n\n' +
      '要仍然開始備份嗎？若中途空間用完，會自動停止並保留未完成的檔案。'
    );
    return { proceed: ok };
  }

  // ===== 本機備份帳本 =====
  const LEDGER_DB = 'iphoneBackupLedger';
  const LEDGER_STORE = 'files';
  const LEDGER_VERIFY_GET_LIMIT = 25;
  const fingerprint = f => `${f.name}|${f.size}|${f.lastModified}`;
  const ledgerId = (acct, f) => `${acct}|${fingerprint(f)}`;
  const inLedger = f => !!ledgerAcct && ledgerKeys.has(ledgerId(ledgerAcct, f));
  const generatedFiles = new WeakSet();

  const idbReq = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const txDone = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('帳本交易中止'));
  });

  function openLedgerDb() {
    if (!ledgerDbPromise) {
      ledgerDbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('此瀏覽器不支援 IndexedDB'));
        const req = indexedDB.open(LEDGER_DB, 1);
        req.onupgradeneeded = () => {
          const st = req.result.createObjectStore(LEDGER_STORE, { keyPath: 'id' });
          st.createIndex('acct', 'acct');
        };
        req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error || new Error('無法開啟帳本資料庫'));
        req.onblocked = () => reject(new Error('帳本資料庫被其他分頁占用'));
      });
      ledgerDbPromise.catch(() => { ledgerDbPromise = null; });
    }
    return ledgerDbPromise;
  }

  async function ledgerStore(mode = 'readonly') {
    const db = await openLedgerDb();
    const tx = db.transaction(LEDGER_STORE, mode);
    return { tx, store: tx.objectStore(LEDGER_STORE) };
  }
  async function ledgerRecords(acct) {
    const { store } = await ledgerStore();
    return idbReq(store.index('acct').getAll(IDBKeyRange.only(acct)));
  }
  async function ledgerGetMany(ids) {
    if (!ids.length) return [];
    const { store } = await ledgerStore();
    return Promise.all(ids.map(id => idbReq(store.get(id))));
  }
  async function ledgerDeleteMany(ids) {
    if (!ids.length) return;
    const { tx, store } = await ledgerStore('readwrite');
    ids.forEach(id => store.delete(id));
    await txDone(tx);
    ids.forEach(id => ledgerKeys.delete(id));
  }

  async function getLedgerAccount() {
    if (ledgerAcct) return ledgerAcct;
    if (!ledgerAcctPromise) {
      const epoch = ledgerEpoch;
      ledgerAcctPromise = (async () => {
        try {
          const r = await apiRequest('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');
          const id = r && r.user && r.user.permissionId;
          if (!id) throw new Error('Drive 沒有回傳帳號識別碼');
          if (epoch === ledgerEpoch) ledgerAcct = id;
          return id;
        } catch (e) {
          console.warn('無法取得 Google 帳號識別碼，本次不使用帳本:', e.message);
          if (epoch === ledgerEpoch) ledgerAcctPromise = null;
          return null;
        }
      })();
    }
    return ledgerAcctPromise;
  }

  async function refreshLedgerKeys() {
    ledgerKeys.clear();
    try {
      const acct = await getLedgerAccount();
      if (!acct) return;
      const { store } = await ledgerStore();
      const ids = await idbReq(store.index('acct').getAllKeys(IDBKeyRange.only(acct)));
      if (acct !== ledgerAcct) return;
      ids.forEach(k => ledgerKeys.add(k));
    } catch (e) { console.warn('讀取帳本失敗:', e); }
  }

  async function ledgerRecord(file, driveId, folderId, uploadName) {
    if (!driveId || generatedFiles.has(file)) return;
    try {
      const acct = await getLedgerAccount();
      if (!acct) return;
      const now = Date.now();
      const rec = {
        id: ledgerId(acct, file), acct, name: file.name, size: file.size, lastModified: file.lastModified,
        driveId, folderId: folderId || null, uploadName: uploadName || file.name, uploadedAt: now, verifiedAt: now
      };
      const { tx, store } = await ledgerStore('readwrite');
      store.put(rec);
      await txDone(tx);
      ledgerKeys.add(rec.id);
    } catch (e) { console.warn('寫入帳本失敗（不影響備份）:', e); }
  }

  async function verifyDriveFiles(records, opts = {}) {
    const check = opts.cancellable === false ? () => {} : throwIfCancelled;
    const confirmed = new Set(), stale = new Set();
    if (!records.length) return { confirmed, stale };

    if (!opts.forceList && records.length <= LEDGER_VERIFY_GET_LIMIT) {
      for (const r of records) {
        check();
        try {
          const f = await apiRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(r.driveId)}?fields=id,size,trashed`);
          if (f && !f.trashed && Number(f.size) === r.size) confirmed.add(r.driveId); else stale.add(r.driveId);
        } catch (e) {
          if (e.cancelled || e.aborted) throw e;
          if (e.status === 404) stale.add(r.driveId);
          else console.warn('驗證帳本項目失敗，視為無法確認:', e.message);
        }
      }
      return { confirmed, stale };
    }

    const sizes = new Map(records.map(r => [r.driveId, r.size]));
    const q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    let pageToken = null;
    do {
      check();
      const res = await apiRequest(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,size)&pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      for (const f of res.files || []) if (sizes.has(f.id) && Number(f.size) === sizes.get(f.id)) confirmed.add(f.id);
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    sizes.forEach((_, id) => { if (!confirmed.has(id)) stale.add(id); });
    return { confirmed, stale };
  }

  async function planWithLedger(jobs) {
    const plan = { toProcess: jobs, ledgerSkipped: [], stale: 0 };
    const acct = await getLedgerAccount();
    if (!acct) return plan;

    const hits = [];
    try {
      const candidates = jobs.filter(f => !generatedFiles.has(f));
      const recs = await ledgerGetMany(candidates.map(f => ledgerId(acct, f)));
      candidates.forEach((f, i) => { if (recs[i]) hits.push({ file: f, rec: recs[i] }); });
    } catch (e) { console.warn('讀取帳本失敗，改走一般流程:', e); return plan; }
    if (!hits.length) return plan;

    $('progressText').textContent = `本機帳本：${hits.length} 個檔案先前已備份，正在向 Google Drive 驗證…`;
    let v;
    try { v = await verifyDriveFiles(hits.map(h => h.rec)); }
    catch (e) {
      if (e.cancelled || e.aborted) throw e;
      console.warn('帳本驗證失敗，改走一般流程:', e.message);
      return plan;
    }

    const skip = new Set(), staleIds = [];
    hits.forEach(({ file, rec }) => {
      if (v.confirmed.has(rec.driveId)) skip.add(file);
      else if (v.stale.has(rec.driveId)) staleIds.push(rec.id);
    });
    try { await ledgerDeleteMany(staleIds); } catch (e) { console.warn('清理過時帳本項目失敗:', e); }
    plan.ledgerSkipped = jobs.filter(f => skip.has(f));
    plan.toProcess = jobs.filter(f => !skip.has(f));
    plan.stale = staleIds.length;
    return plan;
  }

  function setLedgerMsg(msg, ok) {
    const m = $('ledgerMsg'); if (!m) return;
    m.className = 'hint ' + (ok === true ? 'success' : ok === false ? 'error' : '');
    m.textContent = msg;
  }

  async function renderLedgerStats() {
    const box = $('ledgerStats'); if (!box) return;
    if ($('ledgerSync')) $('ledgerSync').disabled = true;
    try {
      let persisted = null;
      try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* 忽略 */ }
      const persistText = persisted === true ? '已啟用' : persisted === false ? '未啟用（儲存空間吃緊時，系統可能清除帳本；清除只會讓備份變慢）' : '未知';
      if (!accessToken) {
        const { store } = await ledgerStore();
        const n = await idbReq(store.count());
        box.textContent = `帳本筆數（所有帳號合計）：${n}。連線 Google 後可看到目前帳號的明細。瀏覽器儲存保護：${persistText}`;
        return;
      }
      const acct = await getLedgerAccount();
      if (!acct) { box.textContent = '目前無法取得 Google 帳號識別碼，帳本暫停使用（備份仍會照常進行）。'; return; }
      const recs = await ledgerRecords(acct);
      let bytes = 0, last = 0;
      recs.forEach(r => { bytes += r.size || 0; if (r.uploadedAt > last) last = r.uploadedAt; });
      box.textContent = `目前帳號帳本筆數：${recs.length}｜合計容量：${humanSize(bytes)}｜最近記錄：${last ? new Date(last).toLocaleString() : '—'}｜瀏覽器儲存保護：${persistText}`;
      if ($('ledgerSync')) $('ledgerSync').disabled = false;
    } catch (e) { box.textContent = '無法讀取帳本：' + e.message; }
  }

  async function initLedger() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* 忽略 */ }
    await refreshLedgerKeys();
    refreshSelection();
    renderLedgerStats();
  }

  async function pruneBackedUp() {
    if (uploading || ledgerBusy || !accessToken) return;
    ledgerBusy = true; refreshSelection();
    showResult('正在向 Google Drive 驗證已備份的檔案…');
    try {
      const acct = await getLedgerAccount();
      if (!acct) throw new Error('目前無法取得 Google 帳號識別碼');
      const files = selectedFiles.filter(inLedger);
      const recs = await ledgerGetMany(files.map(f => ledgerId(acct, f)));
      const pairs = files.map((f, i) => ({ f, rec: recs[i] })).filter(p => p.rec);
      const v = await verifyDriveFiles(pairs.map(p => p.rec), { cancellable: false });
      const drop = new Set(pairs.filter(p => v.confirmed.has(p.rec.driveId)).map(p => p.f));
      const staleIds = pairs.filter(p => v.stale.has(p.rec.driveId)).map(p => p.rec.id);
      await ledgerDeleteMany(staleIds);
      selectedFiles = selectedFiles.filter(f => !drop.has(f));
      showResult(`已從清單移除 ${drop.size} 個已備份、且驗證仍在 Drive 的檔案。` +
        (staleIds.length ? `\n另有 ${staleIds.length} 個在 Drive 已不存在，已從帳本移除；它們仍在清單中，會重新備份。` : ''), 'success');
    } catch (e) { showResult('驗證失敗，清單未更動：' + e.message, 'error'); }
    finally { ledgerBusy = false; renderLedgerStats(); refreshSelection(); }
  }

  async function syncLedger() {
    if (uploading || ledgerBusy || !accessToken) return;
    ledgerBusy = true; refreshSelection();
    setLedgerMsg('正在列出 Drive 上的備份檔並比對…');
    try {
      const acct = await getLedgerAccount();
      if (!acct) throw new Error('目前無法取得 Google 帳號識別碼');
      const recs = await ledgerRecords(acct);
      if (!recs.length) { setLedgerMsg('帳本是空的，沒有需要驗證的項目。', true); return; }
      const v = await verifyDriveFiles(recs, { forceList: true, cancellable: false });
      const staleIds = recs.filter(r => v.stale.has(r.driveId)).map(r => r.id);
      await ledgerDeleteMany(staleIds);
      setLedgerMsg(`同步完成：保留 ${recs.length - staleIds.length} 筆，移除 ${staleIds.length} 筆（Drive 上已不存在、在垃圾桶或大小不符）。`, true);
    } catch (e) { setLedgerMsg('同步失敗，帳本未更動：' + e.message, false); }
    finally { ledgerBusy = false; await renderLedgerStats(); refreshSelection(); }
  }

  async function clearLedger() {
    if (uploading || ledgerBusy) return;
    if (!confirm('要清除本機備份帳本嗎？\n\n不會刪除 Drive 上的任何檔案。清除後，下次備份會改成逐檔向 Drive 檢查重複，速度較慢，但結果仍然正確。')) return;
    ledgerBusy = true; refreshSelection();
    try {
      const { tx, store } = await ledgerStore('readwrite');
      store.clear();
      await txDone(tx);
      ledgerKeys.clear();
      setLedgerMsg('已清除本機帳本。', true);
    } catch (e) { setLedgerMsg('清除失敗：' + e.message, false); }
    finally { ledgerBusy = false; await renderLedgerStats(); refreshSelection(); }
  }

  if ($('ledgerSync')) $('ledgerSync').addEventListener('click', syncLedger);
  if ($('ledgerClear')) $('ledgerClear').addEventListener('click', clearLedger);
  if ($('pruneBackedUp')) $('pruneBackedUp').addEventListener('click', pruneBackedUp);

  // 備份紀錄 UI
  if ($('toggleHistory')) $('toggleHistory').addEventListener('click', () => {
    historyDetailOpen = !historyDetailOpen;
    $('toggleHistory').textContent = historyDetailOpen ? '收合詳細' : '顯示詳細';
    renderHistoryDetails();
  });
  if ($('exportHistory')) $('exportHistory').addEventListener('click', exportHistoryJson);
  if ($('clearHistory')) $('clearHistory').addEventListener('click', async () => {
    if (!confirm('要清除本機備份紀錄嗎？（不影響 Drive 上的檔案與帳本）')) return;
    await clearBackupRuns();
    showResult('已清除備份紀錄。', 'success');
    loadBackupHistory();
  });

  // ===== 備份流程 =====
  function setBusy(busy) {
    uploading = busy;
    if (busy) {
      cancelRequested = false; hiddenDuringUpload = false;
      $('cancelBackup').hidden = false; $('cancelBackup').disabled = false; $('cancelBackup').textContent = '取消備份';
      $('retryFailed').hidden = true;
      $('backup').disabled = true; $('progress').hidden = false; $('progress').value = 0;
      acquireWakeLock();
    } else {
      $('cancelBackup').hidden = true;
      releaseWakeLock();
      $('retryFailed').hidden = failedJobs.length === 0;
      $('retryFailed').textContent = `只重試失敗／未完成的檔案（${failedJobs.length}）`;
    }
    syncUpdateBar();
    refreshSelection();
  }

  function requestCancel() {
    if (!uploading || cancelRequested) return;
    cancelRequested = true;
    $('cancelBackup').disabled = true; $('cancelBackup').textContent = '正在取消…';
    $('uploadState').textContent = '取消中';
    if (currentXhr) currentXhr.abort();
    if (!$('reauthBox').hidden) $('reauthCancel').click();
  }

  async function runJobs(allJobs, notes = []) {
    lastBackupStartedAt = Date.now();
    const startedAt = lastBackupStartedAt;
    failedJobs = allJobs.slice();
    exifrMissingCount = 0;
    let success = 0;
    const skipped = [], renamed = [], failures = [], failedFiles = [];
    const fileResults = [];
    let stopIndex = -1, stopReason = null;

    $('uploadState').textContent = '比對本機帳本';
    let plan;
    try { plan = await planWithLedger(allJobs); }
    catch (err) {
      if (err.cancelled || (err.aborted && cancelRequested)) {
        $('uploadState').textContent = '已取消'; $('progressText').textContent = '';
        showResult('備份已取消，尚未上傳任何檔案。可按「只重試失敗／未完成的檔案」。');
        return;
      }
      throw err;
    }
    plan.ledgerSkipped.forEach(f => fileResults.push({ name: f.name, size: f.size, status: 'ledger-skipped', message: '先前已備份且驗證仍在 Drive' }));

    const jobs = plan.toProcess;
    failedJobs = jobs.slice();
    if (jobs.length === 0) $('progress').value = 100;

    $('uploadState').textContent = '檢查雲端空間';
    $('progressText').textContent = '正在檢查 Google 雲端剩餘空間…';
    const space = jobs.length ? await confirmEnoughSpace(jobs) : { proceed: true };
    if (!space.proceed) {
      $('uploadState').textContent = '已取消'; $('progressText').textContent = '';
      showResult('已取消：雲端空間可能不足。清出空間後，可按「只重試失敗／未完成的檔案」。', 'error');
      await saveBackupRun({ id: startedAt, startedAt, endedAt: Date.now(), total: allJobs.length, success: 0, skipped: 0, ledgerSkipped: plan.ledgerSkipped.length, failures: 0, unprocessed: jobs.length, notes, files: fileResults, stopReason: 'space-cancelled' });
      loadBackupHistory();
      return;
    }

    const rootFolderId = jobs.length ? await getRootFolderId() : null;

    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { stopIndex = i; stopReason = 'cancel'; break; }
      const file = jobs[i];
      $('uploadState').textContent = `處理中 ${i+1}/${jobs.length}`;
      try {
        $('progressText').textContent = `分析分類：${file.name}`;
        const targetFolderId = await getTargetFolder(file, rootFolderId);
        throwIfCancelled();
        $('progressText').textContent = `檢查是否重複：${file.name}`;
        const dup = await checkDuplicate(file, targetFolderId);
        throwIfCancelled();

        if (dup.duplicate) {
          skipped.push(file.name);
          fileResults.push({ name: file.name, size: file.size, status: 'skipped', driveId: dup.existingId, message: 'Drive 已有同名同大小檔案' });
          await ledgerRecord(file, dup.existingId, targetFolderId, dup.existingName);
        } else {
          $('progressText').textContent = `正在上傳：${file.name}`;
          const up = await uploadFileWithRetry(file, targetFolderId, fraction => {
            $('progress').value = ((i + fraction) / jobs.length) * 100;
          }, dup.uploadName);
          if (dup.uploadName !== file.name) renamed.push(`${file.name} → ${dup.uploadName}`);

          // 新增：可選的 MD5 驗證（≤100MB）
          let md5Verified = false;
          if (up && up.md5Checksum && $('md5Verify') && $('md5Verify').checked && file.size <= 100 * 1024 * 1024) {
            try {
              $('progressText').textContent = `驗證 MD5：${file.name}`;
              const localMd5 = md5(await file.arrayBuffer());
              if (localMd5 !== up.md5Checksum) throw new Error(`MD5 不符（本地 ${localMd5}，雲端 ${up.md5Checksum}）`);
              md5Verified = true;
            } catch (e) {
              if (e.message && e.message.startsWith('MD5')) throw e;
              console.warn('MD5 驗證失敗（略過）:', e);
            }
          }

          success++;
          fileResults.push({ name: file.name, size: file.size, status: 'success', driveId: up && up.id, uploadName: up && up.name, md5Verified });
          await ledgerRecord(file, up && up.id, targetFolderId, up && up.name);
        }
      } catch (err) {
        if (err.cancelled || (err.aborted && cancelRequested)) { stopIndex = i; stopReason = 'cancel'; break; }
        failures.push(`${file.name}：${err.message}`);
        failedFiles.push(file);
        fileResults.push({ name: file.name, size: file.size, status: 'failure', message: err.message });
        if (err.aborted) { stopIndex = i + 1; stopReason = 'reauth'; break; }
        if (err.quota) { stopIndex = i + 1; stopReason = 'quota'; break; }
      }
      $('progress').value = ((i + 1) / jobs.length) * 100;
    }

    const unprocessed = stopIndex >= 0 ? jobs.slice(stopIndex) : [];
    unprocessed.forEach(f => fileResults.push({ name: f.name, size: f.size, status: 'unprocessed' }));
    failedJobs = [...failedFiles, ...unprocessed];

    $('uploadState').textContent = stopReason === 'cancel' ? '已取消' : (failures.length || unprocessed.length ? '部分完成' : '完成');
    let msg = stopReason === 'cancel' ? '備份已取消。' : (stopReason ? '備份已中止。' : '備份完成！');
    msg += `\n成功上傳：${success} 個`;
    if (notes.length) msg += `\n（${notes.join('、')}）`;
    if (plan.ledgerSkipped.length > 0) msg += `\n帳本跳過：${plan.ledgerSkipped.length} 個（先前已備份，且已向 Drive 驗證仍在）`;
    if (skipped.length > 0) msg += `\n跳過重複：${skipped.length} 個`;
    if (plan.stale > 0) msg += `\n帳本中有 ${plan.stale} 個項目在 Drive 已不存在或已變更，已重新備份並更新帳本。`;
    if (renamed.length > 0) msg += `\n同名但內容不同，已改名上傳：${renamed.length} 個\n` + renamed.join('\n');
    if (failures.length > 0) msg += `\n失敗：${failures.length} 個\n` + failures.join('\n');
    if (stopReason === 'cancel') msg += `\n尚未處理：${unprocessed.length} 個（已取消）`;
    if (stopReason === 'reauth') msg += `\n其餘 ${unprocessed.length} 個檔案未處理（已放棄重新授權）`;
    if (stopReason === 'quota') msg += `\n雲端空間已滿，已停止；其餘 ${unprocessed.length} 個檔案未處理。清出空間後可按「只重試失敗／未完成的檔案」。`;
    if (failedJobs.length > 0 && stopReason !== 'quota') msg += '\n可按下方「只重試失敗／未完成的檔案」。';
    if (hiddenDuringUpload) msg += '\n⚠️ 備份期間曾離開此畫面，iOS 可能中斷了部分上傳；失敗的檔案可直接重試。';
    if (exifrMissingCount > 0) msg += `\n⚠️ EXIF 套件未載入，有 ${exifrMissingCount} 張照片改用檔案時間分類。`;

    showResult(msg, (failures.length || stopReason === 'reauth' || stopReason === 'quota') ? 'error' : (stopReason === 'cancel' ? '' : 'success'));
    $('progressText').textContent = '上傳工作已結束。';
    saveBackupHistory(success, skipped.concat(plan.ledgerSkipped), failures);
    await saveBackupRun({
      id: startedAt, startedAt, endedAt: Date.now(),
      total: allJobs.length, success,
      skipped: skipped.length + plan.ledgerSkipped.length,
      ledgerSkipped: plan.ledgerSkipped.length,
      failures: failures.length, unprocessed: unprocessed.length,
      notes, files: fileResults, stopReason: stopReason || null
    });
    loadBackupHistory();
  }

  async function startBackup() {
    if (uploading || ledgerBusy || !accessToken) return;
    const wantContacts = $('includeContacts').checked;
    const wantCalendar = $('includeCalendar').checked;
    if (selectedFiles.length === 0 && !wantContacts && !wantCalendar) return;
    if (wantContacts && !hasScope(SCOPE_CONTACTS)) { showResult('尚未授權讀取聯絡人，請取消勾選後重新勾選一次。', 'error'); return; }
    if (wantCalendar && !hasScope(SCOPE_CALENDAR)) { showResult('尚未授權讀取行事曆，請取消勾選後重新勾選一次。', 'error'); return; }

    if (!window.exifr && selectedFiles.some(f => isMedia(f) && (f.type.startsWith('image/') || EXIF_EXT.test(f.name)))) {
      if (!confirm('⚠️ EXIF 解析套件沒有載入成功。\n\n照片會改用「檔案修改時間」分類，可能被放到錯誤的年月或「未分類照片」。\n\n建議先重新整理頁面。要仍然繼續備份嗎？')) return;
    }

    setBusy(true);
    failedJobs = [];
    $('uploadState').textContent = '準備中'; showResult('');

    try { await ensureToken(); }
    catch (err) {
      showResult('授權未完成：' + err.message, 'error'); $('uploadState').textContent = '失敗';
      setBusy(false); return;
    }

    const notes = [];
    const generated = [];
    try {
      if (wantContacts) { const r = await generateContactsVcf(); generated.push(r.file); notes.push(`聯絡人 ${r.count} 筆`); throwIfCancelled(); }
      if (wantCalendar) { const r = await generateCalendarIcs(); generated.push(r.file); notes.push(`行事曆事件 ${r.count} 筆（${r.calendars} 個行事曆）`); throwIfCancelled(); }
    } catch (err) {
      if (err.cancelled) { showResult('已取消，尚未上傳任何檔案。'); $('uploadState').textContent = '已取消'; }
      else { showResult('產生 Google 資料失敗：' + err.message, 'error'); $('uploadState').textContent = '失敗'; }
      setBusy(false); return;
    }

    try {
      generated.forEach(f => generatedFiles.add(f));
      await runJobs([...selectedFiles, ...generated], notes);
    } catch (err) {
      $('uploadState').textContent = '失敗'; showResult('備份準備失敗：' + err.message, 'error');
    } finally {
      $('includeContacts').checked = false;
      $('includeCalendar').checked = false;
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (uploading || failedJobs.length === 0) return;
    if (!accessToken) { showResult('請先重新連線 Google，再重試。', 'error'); return; }
    const jobs = failedJobs.slice();
    setBusy(true);
    showResult(''); $('uploadState').textContent = '準備中';
    try { await ensureToken(); }
    catch (err) {
      showResult('授權未完成：' + err.message, 'error'); $('uploadState').textContent = '失敗';
      setBusy(false); return;
    }
    try {
      await runJobs(jobs, ['這是只重試失敗／未完成檔案的結果']);
    } catch (err) {
      $('uploadState').textContent = '失敗'; showResult('重試準備失敗：' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  $('backup').addEventListener('click', startBackup);
  $('cancelBackup').addEventListener('click', requestCancel);
  $('retryFailed').addEventListener('click', retryFailed);

  // ===== PWA 更新流程 =====
  function initServiceWorker() {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
    const hadController = !!navigator.serviceWorker.controller;
    let waiting = null, updateRequested = false, reloading = false, mode = 'update';

    function renderBar() {
      const bar = $('updateBar');
      bar.hidden = false;
      const base = mode === 'update' ? '🆕 發現新版本。' : '🆕 已更新到新版，請重新整理以使用新版。';
      $('updateMsg').textContent = uploading ? base + '備份進行中，結束後再更新，不會打斷上傳。' : base;
      $('updateNow').textContent = mode === 'update' ? '立即更新' : '重新整理';
      $('updateNow').disabled = uploading || updateRequested;
    }
    syncUpdateBar = () => { if (!$('updateBar').hidden) renderBar(); };

    function offer(worker) { waiting = worker; mode = 'update'; updateRequested = false; renderBar(); }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      if (updateRequested && !uploading) { reloading = true; location.reload(); return; }
      mode = 'reload'; renderBar();
    });

    $('updateNow').addEventListener('click', () => {
      if (uploading) return;
      if (mode === 'update' && waiting) {
        updateRequested = true; renderBar();
        waiting.postMessage({ action: 'skipWaiting' });
        setTimeout(() => {
          if (reloading) return;
          updateRequested = false; renderBar();
          $('updateMsg').textContent = '更新沒有完成。請完全關閉此 App 再重新開啟。';
        }, 6000);
      } else { location.reload(); }
    });

    async function register() {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        swReg = reg;
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing; if (!nw) return;
          const check = () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw); };
          nw.addEventListener('statechange', check);
          check();
        });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      } catch (err) { console.error('SW 註冊失敗:', err); }
    }
    if (document.readyState === 'complete') register(); else window.addEventListener('load', register);
  }
  initServiceWorker();

  if (!window.exifr && $('exifrWarn')) $('exifrWarn').hidden = false;
  refreshSelection();
  loadBackupHistory();
  renderLedgerStats();
})();