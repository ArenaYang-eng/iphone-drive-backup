(() => {
  const APP_VERSION = 'v4.3';
  const $ = id => document.getElementById(id);
  
  const verEl = $('versionDisplay');
  if (verEl) verEl.textContent = APP_VERSION;

  let tokenClient = null;
  let accessToken = null;
  let selectedFiles = [];
  let folderHistory = [];
  let uploading = false;
  // 備份流程狀態
  let cancelRequested = false;  // 使用者按了「取消備份」
  let currentXhr = null;        // 進行中的上傳；取消時 abort()
  let failedJobs = [];          // 失敗＋未處理的 File，供「只重試」使用
  let wakeLock = null;
  let hiddenDuringUpload = false;
  let dlDiag = null;              // 進行中的單檔下載診斷（供畫面離開／網路事件記錄）
  let exifrMissingCount = 0;
  let swReg = null;
  let syncUpdateBar = () => {}; // 由 initServiceWorker() 接手
  // 本機備份帳本（IndexedDB）狀態
  let ledgerAcct = null;          // 目前 Google 帳號的 permissionId；null = 尚未取得，帳本暫停使用
  let ledgerAcctPromise = null;
  let ledgerEpoch = 0;            // 斷線／換帳號時 +1，避免舊的非同步結果寫進新狀態
  let ledgerDbPromise = null;
  let ledgerBusy = false;         // 帳本維護（驗證／清除）進行中：暫停備份按鈕
  const ledgerKeys = new Set();   // 目前帳號的帳本鍵（記憶體副本，用來在選取清單標示「已備份」）
  // 備份後驗證模式：'size' 只比對大小｜'md5-100' 另加 MD5（100MB 以下）｜'md5-all' 另加 MD5（全部）
  const VERIFY_KEY = 'iphoneBackupVerifyMode';
  const VERIFY_MAX_BYTES = 100 * 1024 * 1024;
  let verifyMode = 'md5-100';
  try { const v = localStorage.getItem(VERIFY_KEY); if (['size', 'md5-100', 'md5-all'].includes(v)) verifyMode = v; } catch (e) { /* 讀不到就用預設 */ }


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
    const pimN = typeof pimFiles !== 'undefined' ? pimFiles.length : 0;
    const totalN = selectedFiles.length + pimN;
    $('selectionCount').textContent = totalN ? `${totalN} 個檔案` : '尚未選取檔案';
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
    $('backup').disabled = !accessToken || (!totalN && !$('includeContacts').checked && !$('includeCalendar').checked) || uploading || ledgerBusy;
  }

  function addFiles(list) {
    const existing = new Set(selectedFiles.map(f => `${f.name}|${f.size}|${f.lastModified}`));
    for (const f of list) {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (!existing.has(key)) { selectedFiles.push(f); existing.add(key); }
    }
    refreshSelection();
  }

  // --- Google 授權（Token 管理 / 漸進授權） ---
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
      scope: SCOPE_DRIVE, // 連線時只要求 Drive；聯絡人／行事曆在勾選匯出時才額外請求
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
    
    // 【新增】把 Token 暫存到本機，避免 PWA 重開後遺失
    try {
      localStorage.setItem('iphoneBackupAuth', JSON.stringify({
        token: accessToken,
        expire: tokenExpiresAt,
        scopes: Array.from(grantedScopes)
      }));
    } catch (e) { /* 忽略 */ }
  }

  // overrides 可帶 { prompt, scope, include_granted_scopes }；需在使用者點擊（手勢）中呼叫，iOS 才不會擋彈窗
  function requestToken(overrides = {}) {
    return new Promise((resolve, reject) => {
      if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google 登入元件尚未載入'));
      if (pendingAuth) pendingAuth.reject(new Error('已被新的授權要求取代'));
      pendingAuth = { resolve, reject };
      try { initTokenClient().requestAccessToken(overrides); }
      catch (e) { pendingAuth = null; reject(e); }
    });
  }

  // 確保手上的 token 有效：先嘗試自動續期；失敗就暫停並請使用者按鈕重新授權，授權後從原處繼續
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
      notifyReauthNeeded();
      ok.addEventListener('click', onOk); no.addEventListener('click', onNo);
    });
  }

  // --- API 請求 ---
  // 所有 Drive / People / Calendar 請求都經過這裡：先確保 token 有效，遇到 401 強制續期後重試一次
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

  // --- 資料夾（本次連線期間快取，省下重複查詢） ---
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
      p.catch(() => folderCache.delete(key)); // 失敗的結果不要留在快取裡
    }
    return folderCache.get(key);
  }

  // 備份根資料夾 ID 記在本機；每次連線先驗證它還在（沒被刪除／丟進垃圾桶），避免重複建立同名根資料夾
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
        try { localStorage.setItem(rootKey(), id); } catch (e) { /* 儲存失敗不影響備份 */ }
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

  // 取得拍攝日期：EXIF → 檔案修改時間 → null（未分類）
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
        exifrMissingCount++; // 備份結束時會在結果訊息中明確提醒
      }
    }
    // 影片、或沒有 EXIF 的圖片：改用檔案修改時間。
    // 若修改時間落在「選取當下」5 分鐘內，視為不可靠（可能是 iOS 選取時才產生），改放未分類。
    if (file.lastModified) {
      const d = new Date(file.lastModified);
      if (isPlausibleDate(d) && Date.now() - d.getTime() > 5 * 60 * 1000) return d;
    }
    return null;
  }

  // 回傳 { id, path }：path 只用來寫進備份紀錄（例如「2024/03月」）
  async function getTargetFolder(file, rootFolderId) {
    if (!isMedia(file)) return { id: await getOrCreateFolder('其他檔案', rootFolderId), path: '其他檔案' };
    const date = await getCaptureDate(file);
    if (date) {
      const y = date.getFullYear().toString(), m = (date.getMonth() + 1).toString().padStart(2, '0') + '月';
      const yearFolderId = await getOrCreateFolder(y, rootFolderId);
      return { id: await getOrCreateFolder(m, yearFolderId), path: `${y}/${m}` };
    }
    return { id: await getOrCreateFolder('未分類照片', rootFolderId), path: '未分類照片' };
  }

  // 重複判斷：「檔名＋大小」都相同才算重複。
  // 同名但大小不同 → 視為不同檔案，改用「檔名_大小.副檔名」上傳，避免被誤跳過。
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

  // 上傳後驗證：大小一定比對；MD5 依設定比對 Drive 回傳的 md5Checksum。
  // 不符時把剛上傳的壞檔移到垃圾桶（可復原），丟出錯誤讓外層重傳。
  const md5Wanted = file => verifyMode !== 'size' && (verifyMode === 'md5-all' || file.size <= VERIFY_MAX_BYTES);

  async function trashQuietly(driveId) {
    if (!driveId) return;
    try {
      await apiRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
      });
    } catch (e) { console.warn('無法把驗證失敗的雲端檔案移到垃圾桶:', e.message); }
  }

  async function verifyUploaded(file, result, vstate, ctx) {
    if (verifyMode === 'size') { vstate.md5 = 'off'; return; }
    if (!md5Wanted(file)) { vstate.md5 = 'skipped-large'; return; }
    let remote = result.md5Checksum;
    if (!remote && result.id) { // 上傳回應沒帶 MD5：單獨查一次
      try { const g = await apiRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(result.id)}?fields=md5Checksum`); remote = g && g.md5Checksum; }
      catch (e) { if (e.cancelled || e.aborted) throw e; console.warn('查詢 md5Checksum 失敗:', e.message); }
    }
    if (!remote) { vstate.md5 = 'unavailable'; return; }
    if (!ctx.localMd5) { // 重試時不必重算
      const pt = $('progressText');
      ctx.localMd5 = await IBMd5.ofBlob(file, {
        shouldStop: () => cancelRequested,
        onProgress: f => { pt.textContent = `驗證 MD5：${file.name}（${Math.round(f * 100)}%）`; }
      });
    }
    if (ctx.localMd5 === String(remote).toLowerCase()) { vstate.md5 = 'ok'; return; }
    vstate.md5 = 'mismatch';
    await trashQuietly(result.id);
    throw new Error(`MD5 不符（本機 ${ctx.localMd5}，雲端 ${remote}），已把雲端的檔案移到垃圾桶並重傳`);
  }

  async function uploadFileWithRetry(file, parentId, onProgress, uploadName, vstate = { md5: '' }, maxRetries = 3) {
    let authRetries = 0;
    const ctx = { localMd5: null };
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ensureToken(); // 每次嘗試前確認 token 仍有效
        throwIfCancelled();
        const result = await uploadFile(file, parentId, onProgress, uploadName);
        if (result.size && Number(result.size) !== file.size) {
          await trashQuietly(result.id);
          throw new Error(`檔案大小不符 (本地: ${file.size}, 雲端: ${result.size})`);
        }
        await verifyUploaded(file, result, vstate, ctx);
        return result;
      } catch (err) {
        // 使用者取消、放棄重新授權、雲端空間已滿：重試沒有意義，直接往外丟
        if (err.cancelled || err.aborted || err.quota) throw err;
        if (err.status === 401 && authRetries < 2) { // 授權過期不算一次失敗：續期後用同一次機會重來
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
      xhr.open('POST','https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum,webViewLink');
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
          // 空間已滿：標記成不可重試的錯誤，整批停止
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

  // --- vCard 與 iCal 生成 ---
  const pad2 = n => String(n).padStart(2, '0');
  const stampTag = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; };

  // RFC 6350 / 5545 TEXT 跳脫：反斜線、換行、逗號、分號
  function esc(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }

  // 每行最多 75 octets（UTF-8），續行以空白開頭；不切斷多位元組字元
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

  // 讀取所有分頁
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
      // 沒有年份時沿用 Apple 慣例 1604 作為占位年
      if (b && b.month && b.day) L.push(`BDAY:${b.year ? String(b.year).padStart(4, '0') : '1604'}-${pad2(b.month)}-${pad2(b.day)}`);
      (p.urls || []).forEach(u => L.push(`URL:${flat(u.value)}`));
      const note = (p.biographies || [])[0]?.value; if (note) L.push(`NOTE:${esc(note)}`);
      L.push('END:VCARD');
      out.push(toLines(L));
    });
    const file = new File([out.join('')], `Google_Contacts_${stampTag()}.vcf`, { type: 'text/vcard' });
    return { file, count: people.length };
  }

  const icsUtc = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsDate = s => s.replace(/-/g, '');
  const icsTime = (name, t) => t.date ? `${name};VALUE=DATE:${icsDate(t.date)}` : `${name}:${icsUtc(t.dateTime)}`;

  async function generateCalendarIcs() {
    showResult('正在取得 Google 行事曆...', 'success');
    const rangeVal = $('calendarRange') ? $('calendarRange').value : '1';
    const now = new Date();
    const timeMin = rangeVal === 'all' ? new Date('2000-01-01T00:00:00Z') : new Date(now.getFullYear() - Number(rangeVal), now.getMonth(), now.getDate());
    const timeMax = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());

    // 自己擁有／可編輯的所有行事曆（不含訂閱的節日等唯讀行事曆）
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
        L.push(icsTime('DTSTART', ev.start));
        if (ev.end && (ev.end.date || ev.end.dateTime)) L.push(icsTime('DTEND', ev.end));
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

  // ===== 雲端還原：清單（分頁）、單檔下載、ZIP 串流、存到相簿 =====
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const CLOUD_PAGE = 100;
  const BLOB_LIMIT = 150 * 1024 * 1024;
  const SHARE_BATCH_FILES = 20;
  const SHARE_BATCH_BYTES = 150 * 1024 * 1024;
  const SHARE_BIG_FILE = 300 * 1024 * 1024;
  const ZIP_PART_BYTES = 200 * 1024 * 1024;
  const FLUSH_BYTES = 512 * 1024;
  let cloudFolderId = null, cloudNextToken = null, cloudSeq = 0, cloudOp = null;
  const cloudLoaded = new Map();
  const cloudSelected = new Set();

  const isMediaMime = m => /^(image|video)\//.test(m || '');
  const cancelledError = () => { const e = new Error('已取消'); e.cancelled = true; return e; };
  const safeSeg = s => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim(); return (!t || t === '.' || t === '..') ? '_' : t; };
  function uniquePaths(list) {
    const seen = new Set();
    for (const f of list) {
      let p = f.path, n = 2;
      while (seen.has(p.toLowerCase())) {
        const slash = p.lastIndexOf('/'), dot = p.lastIndexOf('.');
        p = (dot > slash + 1) ? `${f.path.slice(0, dot)} (${n})${f.path.slice(dot)}` : `${f.path} (${n})`;
        n++;
      }
      seen.add(p.toLowerCase()); f.path = p;
    }
    return list;
  }

  function setCloudList(...nodes) { $('cloudFileList').replaceChildren(...nodes); }
  function currentFolderName() { return folderHistory.length ? folderHistory[folderHistory.length - 1].name : 'iPhone 手動備份'; }

  function updateCloudSelUi() {
    const n = cloudSelected.size;
    let bytes = 0; cloudSelected.forEach(id => { const f = cloudLoaded.get(id); if (f) bytes += Number(f.size) || 0; });
    if ($('cloudSelCount')) $('cloudSelCount').textContent = n ? `已選 ${n} 個（${humanSize(bytes)}）` : '未選取（處理整個資料夾）';
    if ($('cloudSelectAll')) {
      $('cloudSelectAll').disabled = cloudLoaded.size === 0;
      $('cloudSelectAll').checked = cloudLoaded.size > 0 && n === cloudLoaded.size;
    }
  }

  function setCloudButtons(disabled) {
    document.querySelectorAll('#tab-cloud .cloud-act, #btnZip, #btnShare').forEach(b => { b.disabled = disabled; });
  }

  // ----- 清單 -----
  function renderBreadcrumb() {
    const crumbEl = $('folderBreadcrumb'); if (!crumbEl) return;
    const nodes = [];
    if (folderHistory.length > 1) {
      const back = el('button', { class: 'secondary btn-small', type: 'button', text: '🔙 返回上一層' });
      back.addEventListener('click', () => { const prev = folderHistory[folderHistory.length - 2]; loadCloudFiles(prev.id, prev.name); });
      nodes.push(back, el('br'));
    }
    nodes.push(el('span', { class: 'crumb-path', text: '📍 目前位置：' + folderHistory.map(f => f.name).join(' / ') }));
    crumbEl.replaceChildren(...nodes);
  }

  function renderCloudRow(file) {
    const isFolder = file.mimeType === FOLDER_MIME;
    const sizeStr = file.size ? humanSize(Number(file.size)) : '';
    const dateStr = new Date(file.createdTime).toLocaleDateString('zh-TW');
    const li = el('li', { class: 'cloud-row' });
    if (isFolder) {
      const info = el('div', { class: 'cloud-info' },
        el('div', { class: 'cloud-folder', text: '📁 ' + file.name }),
        el('span', { class: 'cloud-sub', text: dateStr }));
      info.addEventListener('click', () => loadCloudFiles(file.id, file.name));
      li.append(info);
      return li;
    }
    cloudLoaded.set(file.id, file);
    const cb = el('input', { type: 'checkbox', class: 'cloud-pick', 'aria-label': '選取 ' + file.name });
    cb.dataset.id = file.id;
    cb.checked = cloudSelected.has(file.id);
    cb.addEventListener('change', () => { if (cb.checked) cloudSelected.add(file.id); else cloudSelected.delete(file.id); updateCloudSelUi(); });
    const info = el('div', { class: 'cloud-info' },
      el('div', { class: 'cloud-file', text: '📄 ' + file.name }),
      el('span', { class: 'cloud-sub', text: `${dateStr} · ${sizeStr}` }));
    const btns = el('div', { class: 'row' });
    const dl = el('button', { class: 'secondary btn-small cloud-act', type: 'button', text: '下載' });
    dl.addEventListener('click', () => downloadOne(file));
    btns.append(dl);
    if (isMediaMime(file.mimeType)) {
      const sh = el('button', { class: 'secondary btn-small cloud-act', type: 'button', text: '相簿' });
      sh.addEventListener('click', () => shareToPhotos([file]));
      btns.append(sh);
    }
    li.append(el('div', { class: 'cloud-left' }, cb, info), btns);
    return li;
  }

  async function loadCloudPage(seq, first) {
    const query = `'${cloudFolderId}' in parents and trashed = false`;
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) +
      '&fields=nextPageToken,files(id,name,size,mimeType,createdTime,modifiedTime)' +
      `&pageSize=${CLOUD_PAGE}&orderBy=folder,createdTime desc` +
      (cloudNextToken ? '&pageToken=' + encodeURIComponent(cloudNextToken) : '');
    const res = await apiRequest(url);
    if (seq !== cloudSeq) return;
    cloudNextToken = res.nextPageToken || null;
    const files = res.files || [];
    if (first && !files.length) { setCloudList(el('li', { text: '此資料夾內尚無檔案。' })); $('cloudMore').hidden = true; $('batchActionBar').hidden = true; return; }
    const rows = files.map(renderCloudRow);
    if (first) setCloudList(...rows); else $('cloudFileList').append(...rows);
    $('cloudMore').hidden = !cloudNextToken;
    $('cloudMore').disabled = false; $('cloudMore').textContent = '載入更多';
    $('batchActionBar').hidden = false;
    updateCloudSelUi();
  }

  async function loadCloudFiles(targetId = null, targetName = '') {
    if (!accessToken) { setCloudList(el('li', { class: 'error', text: '請先連線 Google 才能讀取雲端清單。' })); return; }
    const seq = ++cloudSeq;
    cloudLoaded.clear(); cloudSelected.clear(); cloudNextToken = null; updateCloudSelUi();
    setCloudList(el('li', { text: '載入中...' }));
    $('cloudMore').hidden = true; $('batchActionBar').hidden = true;
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
      if (seq !== cloudSeq) return;
      cloudFolderId = currentId;
      renderBreadcrumb();
      await loadCloudPage(seq, true);
    } catch (err) { if (seq === cloudSeq) setCloudList(el('li', { class: 'error', text: '載入失敗：' + err.message })); }
  }

  async function loadMoreCloud() {
    if (!cloudNextToken) return;
    const seq = cloudSeq, btn = $('cloudMore');
    btn.disabled = true; btn.textContent = '載入中…';
    try { await loadCloudPage(seq, false); }
    catch (err) {
      if (seq !== cloudSeq) return;
      $('cloudFileList').append(el('li', { class: 'error', text: '載入更多失敗：' + err.message }));
      btn.disabled = false; btn.textContent = '重試載入更多';
    }
  }

  // ----- 操作面板 -----
  function opStart(msg) {
    const ctrl = { aborted: false, ac: new AbortController(), rejectTap: null };
    cloudOp = ctrl;
    $('cloudOp').hidden = false;
    $('cloudOpMsg').className = 'hint'; $('cloudOpMsg').textContent = msg;
    $('cloudOpProgress').hidden = false; $('cloudOpProgress').value = 0;
    $('cloudOpTap').hidden = true;
    $('cloudOpCancel').hidden = false; $('cloudOpCancel').disabled = false; $('cloudOpCancel').textContent = '取消';
    setCloudButtons(true);
    acquireWakeLock('下載');
    return ctrl;
  }
  function opSet(msg, pct) {
    if (msg != null) $('cloudOpMsg').textContent = msg;
    if (pct != null && isFinite(pct)) $('cloudOpProgress').value = Math.max(0, Math.min(100, pct));
  }
  function opEnd(msg, kind = '') {
    cloudOp = null;
    $('cloudOpMsg').className = 'hint ' + kind; $('cloudOpMsg').textContent = msg;
    $('cloudOpProgress').hidden = true; $('cloudOpTap').hidden = true;
    $('cloudOpCancel').hidden = false; $('cloudOpCancel').disabled = false; $('cloudOpCancel').textContent = '關閉';
    setCloudButtons(false);
    showIosNote(false);
    if (!uploading) releaseWakeLock();
  }
  function opCancel() {
    if (!cloudOp) { $('cloudOp').hidden = true; return; }
    cloudOp.aborted = true; cloudOp.ac.abort();
    if (cloudOp.rejectTap) cloudOp.rejectTap(cancelledError());
    $('cloudOpCancel').disabled = true; $('cloudOpMsg').textContent = '正在取消…';
  }
  function opTap(ctrl, msg, label, action) {
    return new Promise((resolve, reject) => {
      const btn = $('cloudOpTap');
      opSet(msg, 100);
      btn.textContent = label; btn.hidden = false; btn.disabled = false;
      const cleanup = () => { btn.hidden = true; btn.removeEventListener('click', onTap); ctrl.rejectTap = null; };
      const onTap = () => {
        btn.disabled = true;
        let p; try { p = Promise.resolve(action()); } catch (e) { p = Promise.reject(e); }
        p.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
      };
      ctrl.rejectTap = e => { cleanup(); reject(e); };
      btn.addEventListener('click', onTap);
    });
  }
  function notifyReauthNeeded() {
    if (cloudOp) opSet('⚠️ Google 授權已過期。請切到「備份資料」分頁，按「重新授權並繼續」，下載會自動接續。');
  }

  // ----- 取得 Drive 檔案內容 -----
  async function openDriveFile(id, ctrl) {
    let res;
    try { res = await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { signal: ctrl ? ctrl.ac.signal : undefined }); }
    catch (e) { if (ctrl && ctrl.aborted) throw cancelledError(); throw e; }
    if (!res.ok) { const e = new Error(`下載失敗 (HTTP ${res.status})`); e.status = res.status; throw e; }
    return res;
  }

  async function fetchAsBlob(file, ctrl, onBytes) {
    const res = await openDriveFile(file.id, ctrl);
    if (!res.body) return await res.blob();
    const reader = res.body.getReader(), chunks = []; let got = 0;
    for (;;) {
      if (ctrl.aborted) { reader.cancel().catch(() => {}); throw cancelledError(); }
      let r;
      try { r = await reader.read(); } catch (e) { if (ctrl.aborted) throw cancelledError(); throw e; }
      if (r.done) break;
      chunks.push(r.value); got += r.value.byteLength;
      if (onBytes) onBytes(got);
    }
    return new Blob(chunks, { type: file.mimeType || 'application/octet-stream' });
  }

  // 【修改】支援透過 iOS 原生分享面板儲存，避開 PWA 下載預覽卡死的問題
  async function anchorDownload(blob, name) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    
    // 優先使用分享面板（PWA 或 iOS 支援時）
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      } catch (e) {
        if (e.name === 'AbortError') return 'aborted';
        console.warn('分享失敗，退回傳統下載', e);
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return 'downloaded';
  }

  function isStandalone() {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  const IOS_PREVIEW_NOTE =
    '⚠️ 主畫面 App 的限制：下載完成後，iOS 會跳出檔案預覽，而且沒有返回鍵。\n' +
    '・影片／照片：點「更多…」→「儲存影片／儲存影像」就會存入相簿。\n' +
    '・要回到本頁：先從螢幕左邊緣往右滑；沒反應就從螢幕底部上滑、把本 App 往上滑掉，再從主畫面重新開啟（重開後會自動接續授權）。\n' +
    '・想避開這個預覽畫面：單一檔案建議改用「相簿」按鈕，或改用 Safari 分頁開啟本網址下載。';
  function showIosNote(show) {
    const n = $('cloudIosNote'); if (!n) return;
    n.textContent = show ? IOS_PREVIEW_NOTE : ''; n.hidden = !show;
  }

  // ----- 下載診斷 -----
  function makeDiag(name, size) {
    const t0 = Date.now(), ev = [];
    const d = {
      name, size, read: 0, sent: 0, resumes: 0, hidden: 0, mode: 'stream',
      ev, secs: () => Math.round((Date.now() - t0) / 1000),
      log(what) { ev.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`); if (ev.length > 40) ev.splice(1, 1); console.log('[下載診斷]', what); }
    };
    d.log(`開始：${name}（${size ? humanSize(size) : '大小未知'}）`);
    return d;
  }
  function stageError(stage, message) { const e = new Error(message); e.stage = stage; return e; }
  const STAGE_HEAD = {
    'google-open': '第 1 步：向 Google 要檔案（還沒開始傳送）',
    'google-read': '第 2 步：從 Google 接收資料時中斷（已自動續傳仍失敗）',
    'handoff': '第 3 步：交給系統下載（Safari 沒有接手）',
    'sw-stall': '第 3 步：系統下載停止索取資料',
    'sw-cancel': '第 3 步：系統端取消或停止了下載'
  };
  const STAGE_TIP = {
    'google-open': '請確認網路與 Google 授權（可到「備份資料」分頁重新授權）後再試。',
    'google-read': '最常見的原因是下載途中螢幕鎖定或切到別的 App：iOS 會凍結網頁並切斷連線。請保持螢幕亮起、停留在本頁，再試一次。',
    'handoff': 'Safari 沒有開始接手下載。請重新整理本頁後再試；仍失敗的話，改用「相簿」按鈕。',
    'sw-stall': '請重新整理本頁後再試（iOS 回收背景程序後，下載通道會重建）。',
    'sw-cancel': '若不是你在 iOS 下載清單按的取消，代表 Safari 中斷了它。請到下載清單刪除未完成的檔案，再重新下載。'
  };
  function explainFailure(err, d) {
    const stage = err.stage || (d.mode === 'blob' ? 'google-read' : 'handoff');
    const lines = [
      `下載失敗：${STAGE_HEAD[stage] || '未知環節'}`,
      `原因：${err.message}`,
      `進度：從 Google 收到 ${humanSize(d.read)}${d.size ? ' / ' + humanSize(d.size) : ''}；交給系統 ${humanSize(d.sent)}；耗時 ${d.secs()} 秒；自動續傳 ${d.resumes} 次；離開畫面 ${d.hidden} 次。`
    ];
    if (d.hidden > 0) lines.push('⚠️ 下載期間曾離開畫面，這很可能就是中斷原因。');
    if (STAGE_TIP[stage]) lines.push(STAGE_TIP[stage]);
    lines.push('診斷紀錄：', ...d.ev.slice(-8));
    return lines.join('\n');
  }

  // ----- 可續傳的 Drive 讀取串流 -----
  const RESUME_MAX_CONSECUTIVE = 5, RESUME_MAX_TOTAL = 40;
  function isResumableError(err) {
    if (err && typeof err.status === 'number') return err.status === 408 || err.status === 429 || err.status >= 500;
    return !(err && err.fatal);
  }
  function waitOnline(ms) {
    return new Promise(res => {
      if (navigator.onLine !== false) return res();
      const done = () => { clearTimeout(t); window.removeEventListener('online', done); res(); };
      const t = setTimeout(done, ms);
      window.addEventListener('online', done);
    });
  }
  function resumableDriveStream(file, firstRes, size, ctrl, diag) {
    let offset = 0, reader = firstRes.body.getReader(), consecutive = 0;
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    async function reopen() {
      const res = await authFetch(url, { signal: ctrl.ac.signal, headers: { Range: `bytes=${offset}-` } });
      if (res.status !== 206) { const e = new Error(`續傳失敗（HTTP ${res.status}）`); e.status = res.status; throw e; }
      const m = /bytes\s+(\d+)-/.exec(res.headers.get('Content-Range') || '');
      if (m && Number(m[1]) !== offset) { const e = new Error('續傳起點不符'); e.fatal = true; throw e; }
      return res.body.getReader();
    }
    return new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (ctrl.aborted) throw cancelledError();
          try {
            if (!reader) { await waitOnline(120000); reader = await reopen(); diag.log(`續傳連線成功，從 ${humanSize(offset)} 接續`); }
            const r = await reader.read();
            if (r.done) {
              if (size && offset < size) throw new Error(`資料提前結束（${offset} / ${size} bytes）`);
              controller.close(); return;
            }
            offset += r.value.byteLength; diag.read = offset; consecutive = 0;
            controller.enqueue(r.value);
            return;
          } catch (err) {
            if (ctrl.aborted) throw cancelledError();
            if (reader) { try { reader.cancel().catch(() => {}); } catch (e) { /* 忽略 */ } }
            reader = null; consecutive++; diag.resumes++;
            diag.log(`Google 讀取中斷於 ${humanSize(offset)}：${err.message}`);
            if (!isResumableError(err) || consecutive > RESUME_MAX_CONSECUTIVE || diag.resumes > RESUME_MAX_TOTAL) {
              if (!err.stage) err.stage = 'google-read';
              throw err;
            }
            await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (consecutive - 1), 8000)));
          }
        }
      },
      cancel(reason) { if (reader) reader.cancel(reason).catch(() => {}); }
    }, { highWaterMark: 0 });
  }

  // ----- 串流存檔 -----
  async function canStreamSave() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller || typeof ReadableStream === 'undefined' || typeof MessageChannel === 'undefined') return false;
    return new Promise(resolve => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(false), 1500);
      ch.port1.onmessage = e => { clearTimeout(t); resolve(!!(e.data && e.data.type === 'ready')); };
      try { navigator.serviceWorker.controller.postMessage({ action: 'dl-probe' }, [ch.port2]); }
      catch (e) { clearTimeout(t); resolve(false); }
    });
  }

  const PULL_WATCHDOG_MS = 6 * 60 * 1000;
  function streamSave(filename, source, { size = null, ctrl = null, onProgress = null, diag = null } = {}) {
    return new Promise((resolve, reject) => {
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      const ch = new MessageChannel();
      const reader = (source || new Blob([]).stream()).getReader();
      if (isStandalone()) showIosNote(true);
      let sent = 0, srcDone = false, settled = false, pumping = false, lastPull = Date.now(), loggedAt = 0, pulled = false;
      const log = m => { if (diag) diag.log(m); };

      const startTimer = setTimeout(() => fail(stageError('handoff', '串流下載沒有啟動（瀏覽器沒有接手下載）')), 15000);
      const watchdog = setInterval(() => {
        if (!settled && !pumping && Date.now() - lastPull > PULL_WATCHDOG_MS) {
          fail(stageError('sw-stall', `系統下載已超過 ${Math.round(PULL_WATCHDOG_MS / 60000)} 分鐘沒有索取資料（Service Worker 可能已被 iOS 終止）`));
        }
      }, 5000);
      const cleanup = () => { settled = true; clearTimeout(startTimer); clearInterval(watchdog); try { ch.port1.close(); } catch (e) { /* 忽略 */ } };
      const fail = err => {
        if (settled) return;
        if (diag) { diag.sent = sent; diag.log(`中止：${err.message}`); }
        try { ch.port1.postMessage({ type: 'error', message: err.message }); } catch (e) { /* 忽略 */ }
        cleanup(); reader.cancel(err).catch(() => {}); reject(err);
      };
      if (ctrl) ctrl.ac.signal.addEventListener('abort', () => fail(cancelledError()), { once: true });

      async function pump() {
        if (pumping || settled) return;
        pumping = true;
        try {
          const parts = []; let n = 0;
          while (n < FLUSH_BYTES) {
            let r;
            try { r = await reader.read(); } catch (e) { if (!e.stage) e.stage = 'google-read'; throw e; }
            if (r.done) { srcDone = true; break; }
            parts.push(r.value); n += r.value.byteLength;
          }
          if (settled) return;
          if (n) {
            const buf = new Uint8Array(n); let o = 0;
            for (const p of parts) { buf.set(p, o); o += p.byteLength; }
            sent += n;
            ch.port1.postMessage({ type: 'chunk', data: buf.buffer }, [buf.buffer]);
            if (diag) { diag.sent = sent; if (sent - loggedAt >= 32 * 1024 * 1024) { loggedAt = sent; diag.log(`已交給系統 ${humanSize(sent)}`); } }
            if (onProgress) onProgress(sent);
          }
          if (srcDone) { ch.port1.postMessage({ type: 'end' }); cleanup(); log(`資料全部送出（${humanSize(sent)}）`); resolve(sent); }
        } catch (err) { fail(ctrl && ctrl.aborted ? cancelledError() : err); }
        finally { pumping = false; }
      }

      ch.port1.onmessage = e => {
        const m = e.data || {};
        if (m.type === 'ready') {
          const a = document.createElement('a');
          a.href = new URL(`./__dl/${id}/${encodeURIComponent(filename)}`, location.href).href;
          a.hidden = true;
          document.body.appendChild(a); a.click(); a.remove();
          log('已通知瀏覽器開始下載');
        } else if (m.type === 'pull') {
          lastPull = Date.now();
          if (!pulled) { pulled = true; log('系統開始索取資料'); }
          clearTimeout(startTimer); pump();
        }
        else if (m.type === 'cancel') fail(ctrl && ctrl.aborted ? cancelledError() : stageError('sw-cancel', '系統端取消或停止了下載'));
        else if (m.type === 'expired') fail(stageError('handoff', '下載連結逾時（30 秒內瀏覽器沒有取用）'));
      };
      try {
        navigator.serviceWorker.controller.postMessage({ action: 'dl-start', id, filename, size }, [ch.port2]);
      } catch (e) { fail(stageError('handoff', e.message)); }
    });
  }

  // ----- 單檔下載 -----
  async function downloadOne(file) {
    if (cloudOp) return;
    const size = Number(file.size) || 0;
    const ctrl = opStart(`準備下載：${file.name}`);
    const diag = makeDiag(file.name, size); dlDiag = diag;
    try {
      // 【新增】PWA 模式且支援分享時，改用 Blob + 分享面板，避開預覽卡死
      const useBlobShare = isStandalone() && navigator.canShare && size < 800 * 1024 * 1024;

      if (useBlobShare) {
        diag.mode = 'blob-share';
        const blob = await fetchAsBlob(file, ctrl, n => { diag.read = n; opSet(`下載中：${file.name}\n${humanSize(n)} / ${humanSize(size)}`, size ? n / size * 100 : null); });
        const res = await anchorDownload(blob, file.name);
        if (res === 'aborted') throw cancelledError();
        opEnd(`已觸發儲存：${file.name}。請在跳出的選單選擇「儲存到檔案」或「儲存影像」。`, 'success');
      } else if (await canStreamSave()) {
        diag.mode = 'stream';
        if (isStandalone() && size > 800 * 1024 * 1024) {
          if (!confirm(`這個檔案約 ${humanSize(size)}，較大。\n在 iOS 主畫面模式下，下載完成後可能會卡在預覽頁無法返回。\n\n建議改用「相簿」按鈕存到照片，或把網址複製到 Safari 分頁中下載。\n\n仍要繼續嗎？`)) throw cancelledError();
        }
        let res;
        try { res = await openDriveFile(file.id, ctrl); }
        catch (e) { if (!e.cancelled && !e.stage) e.stage = 'google-open'; throw e; }
        diag.log(`Google 回應 HTTP ${res.status}，Content-Length ${res.headers.get('Content-Length') || '未提供'}`);
        const source = resumableDriveStream(file, res, size, ctrl, diag);
        await streamSave(file.name, source, {
          size: size || null, ctrl, diag,
          onProgress: n => opSet(`傳送中：${file.name}\n${humanSize(n)} / ${humanSize(size)}` + (diag.resumes ? `\n（網路中斷後已自動續傳 ${diag.resumes} 次）` : ''), size ? n / size * 100 : null)
        });
        opEnd(`已交給系統下載：${file.name}。`, 'success');
      } else {
        diag.mode = 'blob';
        const blob = await fetchAsBlob(file, ctrl, n => { diag.read = n; opSet(`下載中：${file.name}\n${humanSize(n)} / ${humanSize(size)}`, size ? n / size * 100 : null); });
        const res = await anchorDownload(blob, file.name);
        if (res === 'aborted') throw cancelledError();
        opEnd(`已觸發下載：${file.name}`, 'success');
      }
    } catch (err) {
      diag.log(err.cancelled ? '使用者取消' : `失敗：${err.message}`);
      opEnd(err.cancelled ? '已取消。' : explainFailure(err, diag), err.cancelled ? '' : 'error');
    } finally { dlDiag = null; }
  }

  // ----- 批次：決定要處理哪些檔案 -----
  async function listFolderTree(rootId, rootPath, recursive, ctrl, onCount) {
    const out = [], stack = [{ id: rootId, path: rootPath }];
    while (stack.length) {
      const dir = stack.pop();
      let token = null;
      do {
        if (ctrl.aborted) throw cancelledError();
        const q = `'${dir.id}' in parents and trashed = false`;
        let res;
        try {
          res = await apiRequest('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
            '&fields=nextPageToken,files(id,name,size,mimeType,modifiedTime)&pageSize=1000' +
            (token ? '&pageToken=' + encodeURIComponent(token) : ''), { signal: ctrl.ac.signal });
        } catch (e) { if (ctrl.aborted) throw cancelledError(); throw e; }
        for (const f of res.files || []) {
          if (f.mimeType === FOLDER_MIME) { if (recursive) stack.push({ id: f.id, path: dir.path + safeSeg(f.name) + '/' }); }
          else out.push({ ...f, path: dir.path + safeSeg(f.name) });
        }
        token = res.nextPageToken || null;
        onCount(out.length);
      } while (token);
    }
    out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant'));
    return uniquePaths(out);
  }

  async function resolveBatchEntries(ctrl) {
    if (cloudSelected.size) {
      const picked = [...cloudSelected].map(id => cloudLoaded.get(id)).filter(Boolean).map(f => ({ ...f, path: safeSeg(f.name) }));
      return uniquePaths(picked);
    }
    opSet('正在列出雲端檔案…');
    return await listFolderTree(cloudFolderId, '', $('cloudRecursive').checked, ctrl, n => opSet(`正在列出雲端檔案…已找到 ${n} 個`));
  }

  // ----- ZIP -----
  function makeZipEntries(files, ctrl, failures, state, appendFailureList) {
    return (async function* () {
      for (const f of files) {
        if (ctrl.aborted) throw cancelledError();
        if (/^application\/vnd\.google-apps\./.test(f.mimeType || '')) { failures.push(`${f.path}：Google 原生文件，無法下載`); continue; }
        state.current = f.path;
        let res;
        try { res = await openDriveFile(f.id, ctrl); }
        catch (e) { if (e.cancelled) throw e; failures.push(`${f.path}：${e.message}`); continue; }
        state.done++;
        const entry = { name: f.path, lastModified: f.modifiedTime ? new Date(f.modifiedTime) : Date.now() };
        if (f.size != null && f.size !== '') entry.size = Number(f.size);
        if (res.body) entry.stream = res.body; else { entry.data = new Uint8Array(0); }
        yield entry;
      }
      if (appendFailureList && failures.length) {
        yield { name: '_下載失敗清單.txt', lastModified: Date.now(), data: new TextEncoder().encode('以下檔案沒有放進這個 ZIP：\r\n\r\n' + failures.join('\r\n') + '\r\n') };
      }
    })();
  }

  async function zipStreaming(entries, total, zipName, ctrl) {
    const failures = [], state = { current: '', done: 0 };
    const zip = IBZip.createZipStream(makeZipEntries(entries, ctrl, failures, state, true));
    await streamSave(zipName, zip, {
      size: null, ctrl,
      onProgress: n => opSet(`打包下載中（${state.done}/${entries.length}）\n${state.current}\n已傳送 ${humanSize(n)} / 約 ${humanSize(total)}`, total ? n / total * 100 : null)
    });
    opEnd(`ZIP 已交給系統下載（${state.done} 個檔案）。請在 iOS 的下載清單，或「檔案」App 的「下載項目」查看。` +
      (failures.length ? `\n有 ${failures.length} 個檔案沒能放進去，詳見 ZIP 內的「_下載失敗清單.txt」。` : ''), failures.length ? 'error' : 'success');
  }

  async function zipInParts(entries, total, zipName, ctrl) {
    const parts = []; let cur = [], curBytes = 0;
    for (const f of entries) {
      const s = Number(f.size) || 0;
      if (cur.length && curBytes + s > ZIP_PART_BYTES) { parts.push(cur); cur = []; curBytes = 0; }
      cur.push(f); curBytes += s;
    }
    if (cur.length) parts.push(cur);
    const base = zipName.replace(/\.zip$/i, ''), failures = [];
    for (let i = 0; i < parts.length; i++) {
      const state = { current: '', done: 0 };
      const stream = IBZip.createZipStream(makeZipEntries(parts[i], ctrl, failures, state, i === parts.length - 1));
      const reader = stream.getReader(), chunks = []; let bytes = 0;
      for (;;) {
        if (ctrl.aborted) { reader.cancel().catch(() => {}); throw cancelledError(); }
        let r;
        try { r = await reader.read(); } catch (e) { if (ctrl.aborted) throw cancelledError(); throw e; }
        if (r.done) break;
        chunks.push(r.value); bytes += r.value.byteLength;
        opSet(`準備第 ${i + 1}/${parts.length} 份（${state.done}/${parts[i].length}）\n${state.current}`, (i + bytes / Math.max(1, parts[i].reduce((s, f) => s + (Number(f.size) || 0), 0))) / parts.length * 100);
      }
      const blob = new Blob(chunks, { type: 'application/zip' });
      const name = parts.length > 1 ? `${base}_第${i + 1}份共${parts.length}份.zip` : zipName;
      await opTap(ctrl, `第 ${i + 1}/${parts.length} 份已準備好（${humanSize(blob.size)}）。請點下方按鈕下載。`, `💾 下載第 ${i + 1}/${parts.length} 份`, () => anchorDownload(blob, name));
    }
    opEnd(`已觸發 ${parts.length} 份 ZIP 下載。` + (failures.length ? `\n有 ${failures.length} 個檔案沒能放進去，詳見最後一份 ZIP 內的「_下載失敗清單.txt」。` : ''), failures.length ? 'error' : 'success');
  }

  async function batchZip() {
    if (cloudOp) return;
    const ctrl = opStart('正在準備…');
    try {
      const entries = await resolveBatchEntries(ctrl);
      if (!entries.length) throw new Error('沒有可下載的檔案。');
      const total = entries.reduce((s, f) => s + (Number(f.size) || 0), 0);
      const streaming = await canStreamSave();
      
      let msg = `即將打包 ${entries.length} 個檔案，約 ${humanSize(total)}。\n\n` +
        (streaming ? '會以單一 ZIP 串流下載，不會佔用大量記憶體。' : '目前無法使用串流下載，會分成約 200 MB 一份，每份需要你點一下按鈕。');
      
      // 【新增】PWA 模式警告
      if (isStandalone()) {
        msg += `\n\n⚠️ 注意：在主畫面 App 模式下，iOS 下載後可能會跳出預覽頁且沒有返回鍵。\n若卡住，請從底部上滑關閉 App 重開（Token 會自動記住）。\n若要避免此問題，建議改用上方「存到相簿」，或把網址複製到 Safari 操作。`;
      }
      
      if (!confirm(msg + '\n\n要開始嗎？')) throw cancelledError();
      
      const zipName = `${safeSeg(currentFolderName())}_${stampTag()}.zip`;
      if (streaming) await zipStreaming(entries, total, zipName, ctrl);
      else await zipInParts(entries, total, zipName, ctrl);
    } catch (err) { opEnd(err.cancelled ? '已取消。' : `打包失敗：${err.message}`, err.cancelled ? '' : 'error'); }
  }

  // ----- 存到相簿（分享表單） -----
  async function shareToPhotos(files) {
    if (cloudOp) return;
    const ctrl = opStart('正在準備…');
    try {
      if (!(navigator.share && navigator.canShare)) throw new Error('這個瀏覽器不支援從網頁分享檔案。請改用「下載」，再從「檔案」App 存到相簿。');
      const list = files || await resolveBatchEntries(ctrl);
      const media = list.filter(f => isMediaMime(f.mimeType));
      const skippedOther = list.length - media.length;
      if (!media.length) throw new Error('沒有可存到相簿的照片或影片。');

      const batches = []; let cur = [], curBytes = 0;
      for (const f of media) {
        const s = Number(f.size) || 0;
        if (cur.length && (cur.length >= SHARE_BATCH_FILES || curBytes + s > SHARE_BATCH_BYTES)) { batches.push(cur); cur = []; curBytes = 0; }
        cur.push(f); curBytes += s;
      }
      if (cur.length) batches.push(cur);

      const total = media.reduce((s, f) => s + (Number(f.size) || 0), 0);
      const big = media.filter(f => Number(f.size) > SHARE_BIG_FILE).length;
      if ((!files || batches.length > 1 || big) && !confirm(`共 ${media.length} 個照片／影片，約 ${humanSize(total)}${skippedOther ? `（另有 ${skippedOther} 個非照片影片檔會略過）` : ''}。\n` +
        `會分成 ${batches.length} 批，每批都要點一下按鈕開啟分享表單，再選「儲存影像」或「儲存影片」。` +
        (big ? `\n\n⚠️ 其中 ${big} 個檔案超過 ${humanSize(SHARE_BIG_FILE)}，需要先放進記憶體，iOS 可能會重新整理頁面；大影片建議改用「下載」。` : '') + '\n\n要開始嗎？')) throw cancelledError();

      let opened = 0, dismissed = 0;
      for (let b = 0; b < batches.length; b++) {
        const group = batches[b], shareFiles = [];
        for (let i = 0; i < group.length; i++) {
          const f = group[i], sz = Number(f.size) || 0;
          const blob = await fetchAsBlob(f, ctrl, n => opSet(`第 ${b + 1}/${batches.length} 批：下載 ${i + 1}/${group.length}\n${f.name}\n${humanSize(n)} / ${humanSize(sz)}`, sz ? ((b + (i + n / sz) / group.length) / batches.length) * 100 : null));
          shareFiles.push(new File([blob], f.name, { type: f.mimeType, lastModified: f.modifiedTime ? Date.parse(f.modifiedTime) : Date.now() }));
        }
        if (!navigator.canShare({ files: shareFiles })) throw new Error('這個瀏覽器無法分享這批檔案。請改用「下載」。');
        try {
          await opTap(ctrl, `第 ${b + 1}/${batches.length} 批已準備好（${group.length} 個，${humanSize(shareFiles.reduce((s, f) => s + f.size, 0))}）。請點下方按鈕，在分享表單選「儲存影像／儲存影片」。`,
            `📲 開啟分享表單（${b + 1}/${batches.length}）`, () => navigator.share({ files: shareFiles }));
          opened++;
        } catch (e) {
          if (e && e.name === 'AbortError') dismissed++;
          else throw e;
        }
      }
      opEnd(`完成：已開啟 ${opened} 批分享表單` + (dismissed ? `，你關閉了 ${dismissed} 批（那幾批沒有儲存）` : '') + (skippedOther ? `，略過 ${skippedOther} 個非照片影片檔` : '') + '。', dismissed ? '' : 'success');
    } catch (err) { opEnd(err.cancelled ? '已取消。' : `存到相簿失敗：${err.message}`, err.cancelled ? '' : 'error'); }
  }

  // --- 事件綁定 ---
  if ($('mediaPicker')) $('mediaPicker').addEventListener('change', e => addFiles(e.target.files));
  if ($('docPicker')) $('docPicker').addEventListener('change', e => addFiles(e.target.files));
  if ($('vcfPicker')) $('vcfPicker').addEventListener('change', async e => { const fl = Array.from(e.target.files); e.target.value = ''; await addPimFiles(fl, 'vcf'); });
  if ($('icsPicker')) $('icsPicker').addEventListener('change', async e => { const fl = Array.from(e.target.files); e.target.value = ''; await addPimFiles(fl, 'ics'); });
  
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
      pimFiles.length = 0; renderPim(); if ($('pimMsg')) $('pimMsg').textContent = '';
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
      try { localStorage.removeItem('iphoneBackupAuth'); } catch(e) {} // 【新增】清除暫存
      if ($('reauthBox')) $('reauthBox').hidden = true;
      $('connection').textContent = '尚未連線'; $('connection').className = 'pill warn';
      cloudSeq++;
      $('disconnect').disabled = true; $('uploadState').textContent = '待命'; refreshSelection(); renderLedgerStats(); renderHistory(); renderLastBackup();
      showResult('已清除本頁的連線狀態。');
    });
  }

  if ($('loadCloudFiles')) $('loadCloudFiles').addEventListener('click', () => loadCloudFiles());
  if ($('cloudMore')) $('cloudMore').addEventListener('click', loadMoreCloud);
  if ($('btnZip')) $('btnZip').addEventListener('click', () => batchZip());
  if ($('btnShare')) $('btnShare').addEventListener('click', () => shareToPhotos());
  if ($('cloudOpCancel')) $('cloudOpCancel').addEventListener('click', opCancel);
  if ($('cloudSelectAll')) $('cloudSelectAll').addEventListener('change', e => {
    document.querySelectorAll('#cloudFileList .cloud-pick').forEach(cb => { cb.checked = e.target.checked; if (e.target.checked) cloudSelected.add(cb.dataset.id); else cloudSelected.delete(cb.dataset.id); });
    updateCloudSelUi();
  });

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

  // ===== 螢幕喚醒保持 =====
  function wakeWanted() { return uploading || !!cloudOp; }
  function setWakeNote(msg, warn = false) {
    for (const id of ['wakeNote', 'cloudWakeNote']) {
      const n = $(id); if (!n) continue;
      n.textContent = msg; n.className = 'hint' + (warn ? ' warn-text' : '');
    }
  }
  async function acquireWakeLock(what = '備份') {
    if (wakeLock && !wakeLock.released) return true;
    if (!('wakeLock' in navigator)) { setWakeNote(`⚠️ 這個瀏覽器不支援螢幕常亮，${what}期間請手動保持螢幕亮起。`, true); return false; }
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!wakeWanted()) { try { await lock.release(); } catch (e) { /* 忽略 */ } return false; }
      wakeLock = lock;
      setWakeNote(`🔆 ${what}期間會保持螢幕亮起。`);
      return true;
    } catch (e) {
      wakeLock = null;
      setWakeNote(`⚠️ 無法啟用螢幕常亮（${e.name || '未知原因'}），${what}期間請手動保持螢幕亮起。`, true);
      return false;
    }
  }
  async function releaseWakeLock() {
    const lock = wakeLock; wakeLock = null;
    if (lock && !lock.released) { try { await lock.release(); } catch (e) { /* 忽略 */ } }
    setWakeNote('');
  }
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    if (dlDiag) { dlDiag.log(hidden ? '畫面離開（切到背景或螢幕鎖定）' : '畫面回到前景'); if (hidden) dlDiag.hidden++; }
    if (hidden) { if (uploading) hiddenDuringUpload = true; return; }
    if (wakeWanted()) acquireWakeLock(cloudOp && !uploading ? '下載' : '備份');
    if (swReg) swReg.update().catch(() => {});
  });
  window.addEventListener('online', () => { if (dlDiag) dlDiag.log('網路恢復'); });
  window.addEventListener('offline', () => { if (dlDiag) dlDiag.log('網路中斷'); });

  // ===== 上傳前檢查雲端剩餘空間 =====
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

  // ===== 本機備份帳本（IndexedDB） =====
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
        const req = indexedDB.open(LEDGER_DB, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(LEDGER_STORE)) {
            const st = db.createObjectStore(LEDGER_STORE, { keyPath: 'id' });
            st.createIndex('acct', 'acct');
          }
          if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('runItems')) db.createObjectStore('runItems', { keyPath: 'runId' });
        };
        req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error || new Error('無法開啟帳本資料庫'));
        req.onblocked = () => reject(new Error('帳本資料庫被其他分頁占用'));
      });
      ledgerDbPromise.catch(() => { ledgerDbPromise = null; });
    }
    return ledgerDbPromise;
  }

  async function ledgerStore(mode = 'readonly', name = LEDGER_STORE) {
    const db = await openLedgerDb();
    const tx = db.transaction(name, mode);
    return { tx, store: tx.objectStore(name) };
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

  async function ledgerRecord(file, driveId, folderId, uploadName, md5) {
    if (!driveId || generatedFiles.has(file)) return;
    try {
      const acct = await getLedgerAccount();
      if (!acct) return;
      const now = Date.now();
      const rec = {
        id: ledgerId(acct, file), acct, name: file.name, size: file.size, lastModified: file.lastModified,
        driveId, folderId: folderId || null, uploadName: uploadName || file.name, uploadedAt: now, verifiedAt: now,
        md5: md5 || null
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
    const plan = { toProcess: jobs, ledgerSkipped: [], stale: 0, skipRecs: new Map() };
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
      if (v.confirmed.has(rec.driveId)) { skip.add(file); plan.skipRecs.set(file, rec); }
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
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* 盡力而為 */ }
    await refreshLedgerKeys();
    refreshSelection();
    renderLedgerStats();
    renderHistory(); renderLastBackup();
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

  // ===== 備份紀錄 =====
  const RUNS_STORE = 'runs';
  const ITEMS_STORE = 'runItems';
  const RUNS_KEEP = 50;
  const RUN_ITEMS_CAP = 20000;
  const REMIND_KEY = 'iphoneBackupRemindDays';
  const RUN_STATUS = { running: '進行中', complete: '完成', partial: '部分完成', cancelled: '已取消', stopped: '已中止', interrupted: '中斷', failed: '失敗' };
  const RESULT_LABEL = { uploaded: '已上傳', 'dup-skip': '跳過（雲端已有）', 'ledger-skip': '跳過（帳本）', failed: '失敗', unprocessed: '未處理' };
  const MD5_LABEL = { ok: 'MD5 相符', mismatch: 'MD5 不符', 'skipped-large': '未驗證 MD5（檔案超過上限）', unavailable: '雲端沒有提供 MD5', off: '' };
  let currentRun = null;

  const pad = n => String(n).padStart(2, '0');
  const fmtTime = ms => { if (!ms) return '—'; const d = new Date(ms); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return '剛剛';
    if (s < 3600) return Math.round(s / 60) + ' 分鐘前';
    if (s < 86400) return Math.round(s / 3600) + ' 小時前';
    return Math.floor(s / 86400) + ' 天前';
  }
  const fmtDuration = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小時 ${Math.floor(s % 3600 / 60)} 分`; };

  async function runsAll() {
    const { store } = await ledgerStore('readonly', RUNS_STORE);
    const all = await idbReq(store.getAll());
    return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  async function runItemsOf(runId) {
    const { store } = await ledgerStore('readonly', ITEMS_STORE);
    const rec = await idbReq(store.get(runId));
    return (rec && rec.items) || [];
  }
  function runSummary(run) { const { items, _saved, ...summary } = run; return summary; }
  async function runPersist(run, withItems = true) {
    const db = await openLedgerDb();
    const tx = db.transaction(withItems ? [RUNS_STORE, ITEMS_STORE] : [RUNS_STORE], 'readwrite');
    tx.objectStore(RUNS_STORE).put(runSummary(run));
    if (withItems) tx.objectStore(ITEMS_STORE).put({ runId: run.id, items: run.items });
    await txDone(tx);
    run._saved = run.items ? run.items.length : 0;
  }
  async function runsDelete(ids) {
    if (!ids.length) return;
    const db = await openLedgerDb();
    const tx = db.transaction([RUNS_STORE, ITEMS_STORE], 'readwrite');
    ids.forEach(id => { tx.objectStore(RUNS_STORE).delete(id); tx.objectStore(ITEMS_STORE).delete(id); });
    await txDone(tx);
  }
  async function runsPrune() {
    const all = await runsAll();
    await runsDelete(all.slice(RUNS_KEEP).map(r => r.id));
  }

  async function beginRun(kind, notes) {
    try { await getLedgerAccount(); } catch (e) { /* 取不到帳號就不分帳號 */ }
    const startedAt = Date.now();
    const run = {
      id: 'r' + startedAt + Math.random().toString(36).slice(2, 6),
      acct: ledgerAcct || null, startedAt, updatedAt: startedAt, endedAt: null,
      status: 'running', kind, verifyMode, notes: notes.slice(), itemsTruncated: false,
      counts: { total: 0, uploaded: 0, dupSkipped: 0, ledgerSkipped: 0, failed: 0, unprocessed: 0, bytesUploaded: 0, md5Ok: 0, md5Mismatch: 0, md5Skipped: 0 },
      items: [], _saved: 0
    };
    currentRun = run;
    try { await runPersist(run); } catch (e) { console.warn('建立備份紀錄失敗（不影響備份）:', e); }
    return run;
  }

  function recordItem(run, file, f) {
    const c = run.counts;
    c.total++;
    if (f.result === 'uploaded') { c.uploaded++; c.bytesUploaded += file.size; }
    else if (f.result === 'dup-skip') c.dupSkipped++;
    else if (f.result === 'ledger-skip') c.ledgerSkipped++;
    else if (f.result === 'failed') c.failed++;
    else if (f.result === 'unprocessed') c.unprocessed++;
    if (f.md5 === 'ok') c.md5Ok++; else if (f.md5 === 'mismatch') c.md5Mismatch++; else if (f.md5 === 'skipped-large') c.md5Skipped++;
    const item = {
      name: file.name, size: file.size, result: f.result, folder: f.folder || '', driveId: f.driveId || '',
      uploadName: f.uploadName || '', md5: f.md5 || '', error: f.error || '', ms: f.ms || 0, at: Date.now()
    };
    if (run.items.length < RUN_ITEMS_CAP) run.items.push(item); else run.itemsTruncated = true;
    run.updatedAt = item.at;
  }

  let checkpointBusy = false;
  async function runCheckpoint(run) {
    const n = run.items.length;
    if (checkpointBusy || n - (run._saved || 0) < Math.max(10, n * 0.1)) return;
    checkpointBusy = true;
    try { await runPersist(run); } catch (e) { console.warn('備份紀錄存檔失敗:', e); }
    finally { checkpointBusy = false; }
  }

  async function finishRun(run, status, errorMsg) {
    run.status = status; run.endedAt = Date.now(); run.updatedAt = run.endedAt;
    if (errorMsg) run.error = String(errorMsg).slice(0, 500);
    try { await runPersist(run); await runsPrune(); } catch (e) { console.warn('寫入備份紀錄失敗:', e); }
    if (currentRun === run) currentRun = null;
  }

  async function markInterruptedRuns() {
    try {
      const stuck = (await runsAll()).filter(r => r.status === 'running' && !(currentRun && currentRun.id === r.id));
      for (const r of stuck) { r.status = 'interrupted'; r.endedAt = r.updatedAt || r.startedAt; await runPersist(r, false); }
    } catch (e) { console.warn('整理中斷的備份紀錄失敗:', e); }
  }

  async function migrateLegacyHistory() {
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem('iphoneBackupHistory') || '[]'); } catch (e) { return; }
    if (!Array.isArray(legacy) || !legacy.length) return;
    try {
      const now = new Date();
      for (let i = 0; i < legacy.length; i++) {
        const h = legacy[i], m = /^(\d+)\/(\d+) (\d+):(\d+)$/.exec(String(h.time));
        let ts = now.getTime() - (i + 1) * 3600000;
        if (m) {
          let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
          if (d.getTime() > now.getTime() + 86400000) d = new Date(now.getFullYear() - 1, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
          ts = d.getTime();
        }
        const failed = Number(h.failures) || 0;
        await runPersist({
          id: 'legacy-' + ts + '-' + i, acct: null, startedAt: ts, updatedAt: ts, endedAt: ts,
          status: failed ? 'partial' : 'complete', kind: 'legacy', legacy: true, verifyMode: 'size', notes: ['舊版紀錄：只有數量統計，沒有逐檔資料'],
          counts: { total: 0, uploaded: Number(h.success) || 0, dupSkipped: Number(h.skipped) || 0, ledgerSkipped: 0, failed, unprocessed: 0, bytesUploaded: 0, md5Ok: 0, md5Mismatch: 0, md5Skipped: 0 },
          items: []
        }, false);
      }
      localStorage.removeItem('iphoneBackupHistory');
    } catch (e) { console.warn('搬移舊版紀錄失敗:', e); }
  }

  async function visibleRuns() {
    const all = await runsAll();
    return (accessToken && ledgerAcct) ? all.filter(r => !r.acct || r.acct === ledgerAcct) : all;
  }

  const getRemindDays = () => { const v = Number(localStorage.getItem(REMIND_KEY)); return Number.isFinite(v) && localStorage.getItem(REMIND_KEY) !== null ? v : 7; };

  async function renderLastBackup() {
    const card = $('lastBackupCard'); if (!card) return;
    let runs;
    try { runs = await visibleRuns(); }
    catch (e) { $('lastBackupPill').textContent = '無法讀取'; $('lastBackupPill').className = 'pill warn'; $('lastBackupDetail').textContent = '無法讀取備份紀錄：' + e.message; return; }
    const finished = r => r.status !== 'running' && (r.counts.uploaded + r.counts.dupSkipped + r.counts.ledgerSkipped) > 0;
    const last = runs.find(finished);
    const latest = runs.find(r => r.status !== 'running');
    const remind = getRemindDays();
    const title = $('lastBackupTitle'), pill = $('lastBackupPill'), detail = $('lastBackupDetail');
    let level = '';

    if (!last) {
      title.textContent = '⏱ 上次備份：尚無紀錄';
      detail.textContent = '還沒有成功備份的紀錄。選好檔案後按「備份所選資料到 Google Drive」。';
      pill.textContent = remind ? '建議立刻備份' : '尚未備份'; level = remind ? 'bad' : '';
    } else {
      const t = last.endedAt || last.updatedAt || last.startedAt;
      const days = Math.floor((Date.now() - t) / 86400000);
      title.textContent = `⏱ 上次備份：${fmtTime(t)}（${ago(t)}）`;
      const c = last.counts;
      detail.textContent = `成功上傳 ${c.uploaded}、跳過 ${c.dupSkipped + c.ledgerSkipped}、失敗 ${c.failed}` + (last.legacy ? '（舊版紀錄，時間為估算）' : '');
      if (remind && days >= remind) { pill.textContent = `已 ${days} 天沒備份`; level = 'bad'; detail.textContent += `\n已超過你設定的 ${remind} 天，建議現在備份。`; }
      else { pill.textContent = '正常'; level = ''; }
    }
    if (latest) {
      const c = latest.counts;
      if (c.failed + c.unprocessed > 0) {
        detail.textContent += `\n最近一次（${fmtTime(latest.endedAt || latest.startedAt)}，${RUN_STATUS[latest.status] || latest.status}）有 ${c.failed} 個失敗、${c.unprocessed} 個未處理，可按「只重試」。`;
        if (level !== 'bad') { level = 'warn'; if (pill.textContent === '正常') pill.textContent = '有未完成的檔案'; }
      }
    }
    card.className = 'card lastbk' + (level ? ' ' + level : '');
    pill.className = 'pill' + (level === 'bad' ? ' bad' : level === 'warn' ? ' warn' : ' ok');
    detail.style.whiteSpace = 'pre-line';
  }

  const FILE_PAGE = 200;

  function runFileRow(it) {
    const label = RESULT_LABEL[it.result] || it.result;
    const row = el('div', { class: 'hist-file' },
      el('span', { class: 'r-' + it.result, text: label }), ` · ${it.name}（${humanSize(it.size)}）`);
    const extra = [];
    if (it.folder) extra.push('📁 ' + it.folder);
    if (it.uploadName && it.uploadName !== it.name) extra.push('雲端檔名：' + it.uploadName);
    if (MD5_LABEL[it.md5]) extra.push(MD5_LABEL[it.md5]);
    if (it.error) extra.push('⚠️ ' + it.error);
    if (extra.length) row.append(el('br'), el('span', { class: 'filemeta', text: extra.join('｜') }));
    return row;
  }

  function renderRunDetail(box, run) {
    box.replaceChildren();
    const c = run.counts;
    const lines = [];
    lines.push(`開始：${fmtTime(run.startedAt)}` + (run.endedAt ? `｜花費 ${fmtDuration(run.endedAt - run.startedAt)}` : ''));
    if (!run.legacy) lines.push(`處理 ${c.total} 個檔案｜上傳量 ${humanSize(c.bytesUploaded)}｜驗證：${run.verifyMode === 'size' ? '只比對大小' : run.verifyMode === 'md5-all' ? '大小＋MD5（全部）' : '大小＋MD5（100 MB 以下）'}`);
    if (c.md5Ok || c.md5Mismatch || c.md5Skipped) lines.push(`MD5：相符 ${c.md5Ok}｜不符 ${c.md5Mismatch}｜未驗證 ${c.md5Skipped}`);
    if (run.kind === 'retry') lines.push('這次是「只重試失敗／未完成的檔案」');
    (run.notes || []).forEach(n => lines.push(n));
    if (run.error) lines.push('錯誤：' + run.error);
    if (run.itemsTruncated) lines.push(`逐檔紀錄只保留前 ${RUN_ITEMS_CAP} 筆（統計數字仍是完整的）。`);
    box.append(el('div', { class: 'hint', text: lines.join('\n'), style: 'white-space:pre-line; margin-top:6px;' }));

    const acts = el('div', { class: 'row', style: 'margin:8px 0;' });
    const bCsv = el('button', { class: 'secondary btn-small', type: 'button', text: '匯出此次 CSV' });
    const bJson = el('button', { class: 'secondary btn-small', type: 'button', text: '匯出此次 JSON' });
    const bDel = el('button', { class: 'secondary btn-small', type: 'button', text: '刪除此筆' });
    bCsv.addEventListener('click', () => exportRuns([run.id], 'csv'));
    bJson.addEventListener('click', () => exportRuns([run.id], 'json'));
    bDel.addEventListener('click', async () => {
      if (!confirm('刪除這一次的備份紀錄？（不會刪除 Drive 上的檔案）')) return;
      try { await runsDelete([run.id]); } catch (e) { setHistMsg('刪除失敗：' + e.message, false); return; }
      await renderHistory(); renderLastBackup();
    });
    acts.append(bCsv, bJson, bDel);
    box.append(acts);
    if (run.legacy) return;

    const filter = el('select', { 'aria-label': '篩選檔案結果' });
    [['all', '全部'], ['failed', '失敗'], ['uploaded', '已上傳'], ['skip', '跳過'], ['unprocessed', '未處理']].forEach(([v, t]) => filter.append(el('option', { value: v, text: t })));
    const list = el('div', { class: 'hist-files' });
    const more = el('button', { class: 'secondary btn-small', type: 'button', text: '顯示更多', style: 'margin-top:6px;' });
    box.append(filter, list, more);
    let items = null, shown = 0, filtered = [];
    const paint = reset => {
      if (reset) { list.replaceChildren(); shown = 0; }
      filtered.slice(shown, shown + FILE_PAGE).forEach(it => list.append(runFileRow(it)));
      shown = Math.min(filtered.length, shown + FILE_PAGE);
      more.hidden = shown >= filtered.length;
      if (!filtered.length) list.replaceChildren(el('div', { class: 'hist-file', text: items && items.length === 0 ? '沒有逐檔紀錄（可能是備份途中 App 被關閉）。' : '沒有符合的檔案。' }));
    };
    const applyFilter = () => {
      const v = filter.value;
      filtered = items.filter(it => v === 'all' || (v === 'skip' ? (it.result === 'dup-skip' || it.result === 'ledger-skip') : it.result === v));
      paint(true);
    };
    filter.addEventListener('change', applyFilter);
    more.addEventListener('click', () => paint(false));
    runItemsOf(run.id).then(r => { items = r; applyFilter(); }).catch(e => { list.replaceChildren(el('div', { class: 'hist-file error', text: '讀取逐檔紀錄失敗：' + e.message })); });
  }

  function setHistMsg(msg, ok) { const m = $('histMsg'); if (m) { m.className = 'hint ' + (ok === true ? 'success' : ok === false ? 'error' : ''); m.textContent = msg; } }

  async function renderHistory() {
    const list = $('historyList'); if (!list) return;
    let runs = [];
    try { runs = await visibleRuns(); }
    catch (e) { list.replaceChildren(el('li', { text: '無法讀取備份紀錄：' + e.message })); return; }
    if ($('historyCount')) $('historyCount').textContent = `${runs.length} 次`;
    ['histExportCsv', 'histExportJson', 'histClear'].forEach(id => { if ($(id)) $(id).disabled = !runs.length; });
    if (!runs.length) { list.replaceChildren(el('li', { text: '尚無備份紀錄' })); return; }
    list.replaceChildren(...runs.map(run => {
      const c = run.counts, level = run.status === 'complete' ? 'ok' : (run.status === 'running' ? '' : (run.status === 'failed' || c.failed ? 'bad' : 'warn'));
      const det = el('details', { class: 'hist-item' });
      det.append(el('summary', { class: 'hist-head' },
        el('div', { class: 'hist-line' },
          el('strong', { text: fmtTime(run.startedAt) + (run.kind === 'retry' ? '（重試）' : '') }),
          el('span', { class: 'pill ' + level, text: RUN_STATUS[run.status] || run.status })),
        el('div', { class: 'filemeta', text: `成功 ${c.uploaded}｜跳過 ${c.dupSkipped + c.ledgerSkipped}｜失敗 ${c.failed}` + (c.unprocessed ? `｜未處理 ${c.unprocessed}` : '') + (c.md5Ok ? `｜MD5 驗證 ${c.md5Ok}` : '') })));
      const body = el('div');
      det.append(body);
      det.addEventListener('toggle', () => { if (det.open && !body.childNodes.length) renderRunDetail(body, run); });
      return el('li', null, det);
    }));
  }

  const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function runsToCsv(runs) {
    const head = ['備份開始', '備份結束', '狀態', '檔名', '大小(bytes)', '結果', '雲端資料夾', 'Drive檔案ID', '雲端檔名', 'MD5驗證', '錯誤訊息', '耗時(ms)'];
    const rows = [head.map(csvCell).join(',')];
    for (const r of runs) {
      if (r.legacy) { rows.push([fmtTime(r.startedAt), fmtTime(r.endedAt), RUN_STATUS[r.status], '（舊版紀錄，無逐檔資料）', '', `成功${r.counts.uploaded}/跳過${r.counts.dupSkipped}/失敗${r.counts.failed}`, '', '', '', '', '', ''].map(csvCell).join(',')); continue; }
      for (const it of r.items) {
        rows.push([fmtTime(r.startedAt), fmtTime(r.endedAt), RUN_STATUS[r.status] || r.status, it.name, it.size, RESULT_LABEL[it.result] || it.result,
          it.folder, it.driveId, it.uploadName, MD5_LABEL[it.md5] || it.md5 || '', it.error, it.ms].map(csvCell).join(','));
      }
    }
    return '﻿' + rows.join('\r\n') + '\r\n';
  }

  async function deliverFile(file) {
    if (navigator.maxTouchPoints > 1 && navigator.canShare && navigator.share) {
      try { if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return 'shared'; } }
      catch (e) { if (e && e.name === 'AbortError') return 'dismissed'; }
    }
    anchorDownload(file, file.name);
    return 'downloaded';
  }

  async function exportRuns(ids, fmt) {
    try {
      const all = await visibleRuns();
      const runs = (ids ? all.filter(r => ids.includes(r.id)) : all).slice();
      if (!runs.length) { setHistMsg('沒有可匯出的紀錄。', false); return; }
      for (const r of runs) r.items = r.legacy ? [] : await runItemsOf(r.id);
      const stamp = stampTag();
      let file;
      if (fmt === 'csv') file = new File([runsToCsv(runs)], `備份紀錄_${stamp}.csv`, { type: 'text/csv' });
      else {
        const payload = { app: 'iphone-drive-backup', version: APP_VERSION, exportedAt: new Date().toISOString(), runs: runs.map(r => { const { acct, _saved, ...rest } = r; return rest; }) };
        file = new File([JSON.stringify(payload, null, 2)], `備份紀錄_${stamp}.json`, { type: 'application/json' });
      }
      const how = await deliverFile(file);
      setHistMsg(how === 'dismissed' ? '已取消匯出。' : `已匯出 ${runs.length} 次備份紀錄（${fmt.toUpperCase()}）。`, how === 'dismissed' ? undefined : true);
    } catch (e) { setHistMsg('匯出失敗：' + e.message, false); }
  }

  async function clearHistory() {
    if (!confirm('清除所有備份紀錄？\n\n只會清除這台裝置上的紀錄，不會刪除 Drive 上的檔案，也不影響「本機備份帳本」。')) return;
    try {
      const all = await visibleRuns();
      await runsDelete(all.map(r => r.id));
      setHistMsg('已清除備份紀錄。', true);
    } catch (e) { setHistMsg('清除失敗：' + e.message, false); }
    await renderHistory(); renderLastBackup();
  }

  // ===== iPhone 本機／iCloud 聯絡人與行事曆 =====
  const pimFiles = []; // { key, orig, file, kind, count }
  const PIM = {
    vcf: { label: '聯絡人', icon: '👤', head: /^BEGIN:VCARD/i, marker: 'BEGIN:VCARD', unit: '位聯絡人', mime: 'text/vcard', ext: '.vcf' },
    ics: { label: '行事曆', icon: '📅', head: /^BEGIN:VCALENDAR/i, marker: 'BEGIN:VEVENT', unit: '個事件', mime: 'text/calendar', ext: '.ics' }
  };

  async function countMarker(file, marker) {
    const re = new RegExp('\\n' + marker, 'gi');
    const dec = new TextDecoder('utf-8');
    const CH = 2 * 1024 * 1024, keep = marker.length;
    let carry = '\n', count = 0;
    for (let off = 0; off < file.size; off += CH) {
      const buf = new Uint8Array(await file.slice(off, Math.min(off + CH, file.size)).arrayBuffer());
      const text = carry + dec.decode(buf, { stream: off + CH < file.size });
      re.lastIndex = 0;
      while (re.exec(text)) count++;
      carry = text.slice(-keep);
      await sleep(0);
    }
    return count;
  }

  async function inspectPim(file, kind) {
    const spec = PIM[kind];
    if (!file.size) return { ok: false, why: '檔案是空的。' };
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return { ok: false, why: '檔案是 UTF-16 編碼，請改用 UTF-8 的檔案。' };
    const text = new TextDecoder('utf-8').decode(head).replace(/^﻿/, '').trimStart();
    if (!spec.head.test(text)) return { ok: false, why: `看起來不是${spec.label}檔（開頭應該是 ${spec.marker === 'BEGIN:VCARD' ? 'BEGIN:VCARD' : 'BEGIN:VCALENDAR'}），是不是選錯檔案了？` };
    const count = await countMarker(file, spec.marker);
    if (!count) return { ok: false, why: `檔案裡找不到任何${kind === 'vcf' ? '聯絡人' : '事件'}。` };
    return { ok: true, count };
  }

  async function addPimFiles(fileList, kind) {
    const spec = PIM[kind], notes = [];
    for (const f of Array.from(fileList)) {
      const key = `${kind}|${fingerprint(f)}`;
      if (pimFiles.some(p => p.key === key)) continue;
      let info;
      try { info = await inspectPim(f, kind); } catch (e) { info = { ok: false, why: '讀取失敗：' + e.message }; }
      if (!info.ok) { notes.push(`「${f.name}」沒有加入：${info.why}`); continue; }
      const base = f.name.replace(/\.[^.]*$/, '') || spec.label;
      const file = new File([f], `iPhone_${spec.label}_${safeSeg(base)}_${stampTag()}${spec.ext}`, { type: spec.mime, lastModified: f.lastModified });
      generatedFiles.add(file);
      pimFiles.push({ key, orig: f.name, file, kind, count: info.count });
    }
    const m = $('pimMsg');
    if (m) { m.className = 'hint ' + (notes.length ? 'error' : ''); m.textContent = notes.join('\n'); }
    renderPim(); refreshSelection();
  }

  function renderPim() {
    const ul = $('pimList'); if (!ul) return;
    ul.replaceChildren(...pimFiles.map(p => {
      const rm = el('button', { class: 'secondary btn-small', type: 'button', text: '移除' });
      rm.addEventListener('click', () => { const i = pimFiles.indexOf(p); if (i >= 0) pimFiles.splice(i, 1); renderPim(); refreshSelection(); });
      return el('li', { class: 'pim-row' },
        el('div', null, `${PIM[p.kind].icon} ${p.orig}`, el('br'),
          el('span', { class: 'filemeta', text: `${p.count} ${PIM[p.kind].unit}｜${humanSize(p.file.size)}｜備份後檔名：${p.file.name}` })), rm);
    }));
  }

  // ===== 備份流程 =====
  function setBusy(busy) {
    uploading = busy;
    if (busy) {
      cancelRequested = false; hiddenDuringUpload = false;
      $('cancelBackup').hidden = false; $('cancelBackup').disabled = false; $('cancelBackup').textContent = '取消備份';
      $('retryFailed').hidden = true;
      $('backup').disabled = true; $('progress').hidden = false; $('progress').value = 0;
      acquireWakeLock('備份');
    } else {
      $('cancelBackup').hidden = true;
      if (!cloudOp) releaseWakeLock();
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

  async function runJobs(allJobs, notes = [], kind = 'backup') {
    const run = await beginRun(kind, notes);
    const seen = new Set();
    try {
      await runJobsCore(allJobs, notes, run, seen);
    } catch (err) {
      if (run.status === 'running') { addUnprocessed(run, allJobs, seen); await finishRun(run, err.cancelled ? 'cancelled' : 'failed', err.cancelled ? '' : err.message); }
      throw err;
    } finally {
      if (run.status === 'running') { addUnprocessed(run, allJobs, seen); await finishRun(run, 'cancelled'); }
      renderHistory(); renderLastBackup();
    }
  }

  function addUnprocessed(run, jobs, seen) {
    jobs.forEach(f => { if (!seen.has(f)) { seen.add(f); recordItem(run, f, { result: 'unprocessed' }); } });
  }

  async function runJobsCore(allJobs, notes, run, seen) {
    failedJobs = allJobs.slice();
    exifrMissingCount = 0;
    let success = 0;
    const skipped = [], renamed = [], failures = [], failedFiles = [];
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
    plan.ledgerSkipped.forEach(f => {
      seen.add(f);
      const rec = plan.skipRecs.get(f);
      recordItem(run, f, { result: 'ledger-skip', driveId: rec && rec.driveId, uploadName: rec && rec.uploadName, folder: '' });
    });
    const jobs = plan.toProcess;
    failedJobs = jobs.slice();
    if (jobs.length === 0) $('progress').value = 100;

    $('uploadState').textContent = '檢查雲端空間';
    $('progressText').textContent = '正在檢查 Google 雲端剩餘空間…';
    const space = jobs.length ? await confirmEnoughSpace(jobs) : { proceed: true };
    if (!space.proceed) {
      $('uploadState').textContent = '已取消'; $('progressText').textContent = '';
      showResult('已取消：雲端空間可能不足。清出空間後，可按「只重試失敗／未完成的檔案」。', 'error');
      return;
    }

    const rootFolderId = jobs.length ? await getRootFolderId() : null;
    let md5Ok = 0, md5Skipped = 0;

    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { stopIndex = i; stopReason = 'cancel'; break; }
      const file = jobs[i];
      $('uploadState').textContent = `處理中 ${i+1}/${jobs.length}`;
      const t0 = Date.now();
      const vstate = { md5: '' };

      try {
        $('progressText').textContent = `分析分類：${file.name}`;
        const target = await getTargetFolder(file, rootFolderId);
        const targetFolderId = target.id;
        throwIfCancelled();
        $('progressText').textContent = `檢查是否重複：${file.name}`;
        const dup = await checkDuplicate(file, targetFolderId);
        throwIfCancelled();

        if (dup.duplicate) {
          skipped.push(file.name);
          console.log(`跳過重複檔案（檔名與大小相同）: ${file.name}`);
          await ledgerRecord(file, dup.existingId, targetFolderId, dup.existingName);
          seen.add(file);
          recordItem(run, file, { result: 'dup-skip', driveId: dup.existingId, uploadName: dup.existingName, folder: target.path, ms: Date.now() - t0 });
        } else {
          $('progressText').textContent = `正在上傳：${file.name}`;
          const up = await uploadFileWithRetry(file, targetFolderId, fraction => {
            $('progress').value = ((i + fraction) / jobs.length) * 100;
          }, dup.uploadName, vstate);
          if (dup.uploadName !== file.name) renamed.push(`${file.name} → ${dup.uploadName}`);
          success++;
          if (vstate.md5 === 'ok') md5Ok++; else if (vstate.md5 === 'skipped-large') md5Skipped++;
          await ledgerRecord(file, up && up.id, targetFolderId, up && up.name, up && up.md5Checksum);
          seen.add(file);
          recordItem(run, file, { result: 'uploaded', driveId: up && up.id, uploadName: up && up.name, folder: target.path, md5: vstate.md5, ms: Date.now() - t0 });
        }
      } catch (err) {
        if (err.cancelled || (err.aborted && cancelRequested)) { stopIndex = i; stopReason = 'cancel'; break; }
        failures.push(`${file.name}：${err.message}`);
        failedFiles.push(file);
        seen.add(file);
        recordItem(run, file, { result: 'failed', error: err.message, md5: vstate.md5, ms: Date.now() - t0 });
        if (err.aborted) { stopIndex = i + 1; stopReason = 'reauth'; break; }
        if (err.quota) { stopIndex = i + 1; stopReason = 'quota'; break; }
      }
      $('progress').value = ((i + 1) / jobs.length) * 100;
      runCheckpoint(run);
    }

    const unprocessed = stopIndex >= 0 ? jobs.slice(stopIndex) : [];
    failedJobs = [...failedFiles, ...unprocessed];

    $('uploadState').textContent = stopReason === 'cancel' ? '已取消' : (failures.length || unprocessed.length ? '部分完成' : '完成');
    let msg = stopReason === 'cancel' ? '備份已取消。' : (stopReason ? '備份已中止。' : '備份完成！');
    msg += `\n成功上傳：${success} 個`;
    if (notes.length) msg += `\n（${notes.join('、')}）`;
    if (md5Ok > 0) msg += `\nMD5 驗證通過：${md5Ok} 個`;
    if (md5Skipped > 0) msg += `\n未做 MD5 驗證（檔案超過 100 MB，只比對了大小）：${md5Skipped} 個`;
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

    addUnprocessed(run, unprocessed, seen);
    const status = stopReason === 'cancel' ? 'cancelled' : stopReason ? 'stopped' : (failures.length ? 'partial' : 'complete');
    await finishRun(run, status);
  }

  async function startBackup() {
    if (uploading || ledgerBusy || !accessToken) return;
    const wantContacts = $('includeContacts').checked;
    const wantCalendar = $('includeCalendar').checked;
    if (selectedFiles.length === 0 && pimFiles.length === 0 && !wantContacts && !wantCalendar) return;
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
      const pimJobs = pimFiles.map(p => p.file);
      if (pimFiles.length) notes.push(`iPhone 本機檔 ${pimFiles.length} 個（${pimFiles.map(p => `${p.count} ${PIM[p.kind].unit}`).join('、')}）`);
      await runJobs([...selectedFiles, ...pimJobs, ...generated], notes);
    } catch (err) {
      $('uploadState').textContent = '失敗'; showResult('備份準備失敗：' + err.message, 'error');
    } finally {
      $('includeContacts').checked = false;
      $('includeCalendar').checked = false;
      pimFiles.length = 0; renderPim();
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
      await runJobs(jobs, ['這是只重試失敗／未完成檔案的結果'], 'retry');
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

  // 【新增】App 啟動時嘗試恢復尚未過期的 Token
  (function restoreToken() {
    try {
      const saved = JSON.parse(localStorage.getItem('iphoneBackupAuth') || 'null');
      if (saved && saved.expire > Date.now() + 60000) {
        accessToken = saved.token;
        tokenExpiresAt = saved.expire;
        grantedScopes = new Set(saved.scopes || []);
        connectedOnce = true;
        $('connection').textContent = '已連線 (自動恢復)'; $('connection').className = 'pill ok';
        $('disconnect').disabled = false;
        $('uploadState').textContent = '已連線';
        refreshSelection();
        // 背景自動載入帳本與雲端清單
        initLedger();
        loadCloudFiles();
      }
    } catch (e) { console.warn('恢復授權失敗', e); }
  })();

  if (!window.exifr && $('exifrWarn')) $('exifrWarn').hidden = false;
  // ===== 設定項目與啟動 =====
  if ($('verifyMode')) {
    $('verifyMode').value = verifyMode;
    $('verifyMode').addEventListener('change', e => { verifyMode = e.target.value; try { localStorage.setItem(VERIFY_KEY, verifyMode); } catch (err) { /* 存不下就只在這次生效 */ } });
  }
  if ($('remindDays')) {
    $('remindDays').value = String(getRemindDays());
    $('remindDays').addEventListener('change', e => { try { localStorage.setItem(REMIND_KEY, e.target.value); } catch (err) { /* 忽略 */ } renderLastBackup(); });
  }
  if ($('histExportCsv')) $('histExportCsv').addEventListener('click', () => exportRuns(null, 'csv'));
  if ($('histExportJson')) $('histExportJson').addEventListener('click', () => exportRuns(null, 'json'));
  if ($('histClear')) $('histClear').addEventListener('click', clearHistory);

  refreshSelection();
  renderLedgerStats();
  (async () => {
    try { await migrateLegacyHistory(); await markInterruptedRuns(); } catch (e) { console.warn('整理備份紀錄失敗:', e); }
    renderHistory(); renderLastBackup();
  })();
  setInterval(renderLastBackup, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderLastBackup(); });
})();