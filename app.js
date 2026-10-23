(() => {
  const APP_VERSION = 'v3.8';
  const $ = id => document.getElementById(id);
  
  const verEl = $('versionDisplay');
  if (verEl) verEl.textContent = APP_VERSION;

  let tokenClient = null;
  let accessToken = null;
  let selectedFiles = [];
  let folderHistory = [];
  let uploading = false;
  let currentFolderFiles = [];
  // 備份流程狀態
  let cancelRequested = false;  // 使用者按了「取消備份」
  let currentXhr = null;        // 進行中的上傳；取消時 abort()
  let failedJobs = [];          // 失敗＋未處理的 File，供「只重試」使用
  let wakeLock = null;
  let hiddenDuringUpload = false;
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

  function loadBackupHistory() {
    const list = $('historyList');
    if (!list) return;
    let history = [];
    try { history = JSON.parse(localStorage.getItem('iphoneBackupHistory') || '[]'); } catch (e) { history = []; }
    if (!Array.isArray(history) || history.length === 0) { list.replaceChildren(el('li', { text: '尚無備份紀錄' })); return; }
    list.replaceChildren(...history.map(item => el('li', { class: 'hist-item' },
      el('strong', { text: String(item.time) }), el('br'),
      `成功: ${item.success} | 跳過: ${item.skipped} | 失敗: ${item.failures}`)));
  }

  function saveBackupHistory(success, skipped, failures) {
    const history = JSON.parse(localStorage.getItem('iphoneBackupHistory') || '[]');
    const now = new Date();
    const timeStr = `${now.getMonth()+1}/${now.getDate()} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    history.unshift({ time: timeStr, success, skipped: skipped.length, failures: failures.length });
    localStorage.setItem('iphoneBackupHistory', JSON.stringify(history.slice(0, 5)));
    loadBackupHistory();
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

  async function getTargetFolder(file, rootFolderId) {
    if (!isMedia(file)) return await getOrCreateFolder('其他檔案', rootFolderId);
    const date = await getCaptureDate(file);
    if (date) {
      const yearFolderId = await getOrCreateFolder(date.getFullYear().toString(), rootFolderId);
      return await getOrCreateFolder((date.getMonth() + 1).toString().padStart(2, '0') + '月', yearFolderId);
    }
    return await getOrCreateFolder('未分類照片', rootFolderId);
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

  async function uploadFileWithRetry(file, parentId, onProgress, uploadName, maxRetries = 3) {
    let authRetries = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ensureToken(); // 每次嘗試前確認 token 仍有效
        throwIfCancelled();
        const result = await uploadFile(file, parentId, onProgress, uploadName);
        if (result.size && Number(result.size) !== file.size) throw new Error(`檔案大小不符 (本地: ${file.size}, 雲端: ${result.size})`);
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
      xhr.open('POST','https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,webViewLink');
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

  // --- 雲端檔案瀏覽與下載 ---
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
        // 資料夾名稱來自雲端，一律以純文字顯示
        nodes.push(el('span', { class: 'crumb-path', text: '📍 目前位置：' + folderHistory.map(f => f.name).join(' / ') }));
        crumbEl.replaceChildren(...nodes);
      }

      const query = `'${currentId}' in parents and trashed = false`;
      const res = await apiRequest(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,size,mimeType,createdTime)&pageSize=1000&orderBy=folder,createdTime desc`);

      if (!res.files || res.files.length === 0) { setList(el('li', { text: '此資料夾內尚無檔案。' })); return; }

      const rows = res.files.map(file => {
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
          const btn = el('button', { class: 'secondary btn-small', type: 'button', text: '下載' });
          btn.addEventListener('click', () => downloadFile(file.id, file.name));
          li.append(info, el('div', null, btn));
        }
        return li;
      });
      setList(...rows);

      if (currentFolderFiles.length > 0 && batchBar) batchBar.style.display = 'block';

    } catch (err) { setList(el('li', { class: 'error', text: '載入失敗：' + err.message })); }
  }

  async function downloadFile(fileId, fileName, isBatch = false) {
    try {
      if (!isBatch) showResult(`正在準備下載：${fileName}...`, 'success');
      const response = await authFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      if (!response.ok) throw new Error(`下載失敗 (HTTP ${response.status})`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      if (!isBatch) showResult(`已觸發下載：${fileName}`, 'success');
      return true;
    } catch (err) { 
      if (!isBatch) showResult(`下載失敗：${err.message}`, 'error'); 
      return false;
    }
  }

  async function batchDownload() {
    if (currentFolderFiles.length === 0) return;
    const btn = $('btnDownloadFolder');
    btn.disabled = true;
    btn.textContent = `⏳ 正在下載 (0/${currentFolderFiles.length})...`;
    
    let successCount = 0;
    for (let i = 0; i < currentFolderFiles.length; i++) {
      const file = currentFolderFiles[i];
      btn.textContent = `⏳ 正在下載 (${i+1}/${currentFolderFiles.length})...`;
      const ok = await downloadFile(file.id, file.name, true);
      if (ok) successCount++;
      await new Promise(r => setTimeout(r, 500));
    }
    
    btn.textContent = `⬇️ 下載此資料夾所有檔案`;
    btn.disabled = false;
    showResult(`批次下載完成，共觸發 ${successCount} 個檔案下載。`, 'success');
  }

  // --- 事件綁定 ---
  if ($('mediaPicker')) $('mediaPicker').addEventListener('change', e => addFiles(e.target.files));
  if ($('docPicker')) $('docPicker').addEventListener('change', e => addFiles(e.target.files));
  // 勾選匯出的當下才請求唯讀授權（漸進授權）；這次點擊本身就是 iOS 要求的使用者手勢
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
  if ($('btnDownloadFolder')) $('btnDownloadFolder').addEventListener('click', batchDownload);

  // ===== 小工具 =====
  // 以 DOM 方法建立元素；字串子節點一律當純文字，不會被解析成 HTML（雲端檔名、錯誤訊息都不可信）
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
  function setWakeNote(msg, warn = false) {
    const n = $('wakeNote'); if (!n) return;
    n.textContent = msg; n.className = 'hint' + (warn ? ' warn-text' : '');
  }
  async function acquireWakeLock() {
    if (wakeLock && !wakeLock.released) return;
    if (!('wakeLock' in navigator)) { setWakeNote('⚠️ 這個瀏覽器不支援螢幕常亮，備份期間請手動保持螢幕亮起。', true); return; }
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!uploading) { try { await lock.release(); } catch (e) { /* 忽略 */ } return; } // 等待期間備份已結束
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
  // 頁面被切到背景時系統會自動釋放喚醒鎖；回到前景要重新要求
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (uploading) hiddenDuringUpload = true; return; }
    if (uploading) acquireWakeLock();
    if (swReg) swReg.update().catch(() => {});
  });

  // ===== 上傳前檢查雲端剩餘空間 =====
  // 回傳 { proceed }。取不到容量資訊時不擋（只記 console）；空間不足時交給使用者決定，
  // 因為「已存在的重複檔」會被跳過，實際需要的空間可能比總大小少。
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
    if (!quota || !quota.limit) return { proceed: true }; // 沒有容量上限
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
  // 記住「哪個本機檔案已備份成 Drive 上的哪個檔案」，之後重複選取同一批照片時，
  // 不必逐檔做 EXIF 分類、查資料夾、查重複、上傳。
  // 帳本只是加速用的快取，Drive 才是事實：命中帳本的檔案，跳過前一定會向 Drive 驗證
  // 「檔案還在、沒進垃圾桶、大小相符」，驗證不過就照常重新備份。所以帳本遺失或過時只會變慢，不會漏備份。
  // 帳本以 Google 帳號（permissionId）分開，換帳號不會互相影響。
  const LEDGER_DB = 'iphoneBackupLedger';
  const LEDGER_STORE = 'files';
  const LEDGER_VERIFY_GET_LIMIT = 25; // 命中數 ≤ 此值：逐檔 files.get；超過：一次列出整個備份清單比對
  const fingerprint = f => `${f.name}|${f.size}|${f.lastModified}`;
  const ledgerId = (acct, f) => `${acct}|${fingerprint(f)}`;
  const inLedger = f => !!ledgerAcct && ledgerKeys.has(ledgerId(ledgerAcct, f));
  const generatedFiles = new WeakSet(); // 程式產生的 .vcf/.ics（檔名帶時間戳，每次都是新檔），不進帳本

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

  // 以 Drive 的 permissionId 當帳號識別碼（不含 email）。取不到就回傳 null：本次不使用帳本，備份照常進行。
  async function getLedgerAccount() {
    if (ledgerAcct) return ledgerAcct;
    if (!ledgerAcctPromise) {
      const epoch = ledgerEpoch;
      ledgerAcctPromise = (async () => {
        try {
          const r = await apiRequest('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');
          const id = r && r.user && r.user.permissionId;
          if (!id) throw new Error('Drive 沒有回傳帳號識別碼');
          if (epoch === ledgerEpoch) ledgerAcct = id; // 期間若已斷線／換帳號，不採用這個結果
          return id;
        } catch (e) {
          console.warn('無法取得 Google 帳號識別碼，本次不使用帳本:', e.message);
          if (epoch === ledgerEpoch) ledgerAcctPromise = null; // 失敗不快取，下次再試
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

  // 成功上傳、或發現 Drive 已有「同名同大小」檔案時記一筆。寫入失敗不影響備份。
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

  // 向 Drive 確認這些帳本紀錄對應的檔案是否還在。
  // 回傳 { confirmed, stale }（都是 Drive 檔案 ID 的 Set）：
  //   confirmed = 仍存在、不在垃圾桶、大小相符；stale = 確定已不存在／在垃圾桶／大小不符。
  //   兩者都不含的（例如網路錯誤）代表「無法確認」：不跳過、也不刪帳本，交給一般流程處理。
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

    // 筆數多：一次列出本 App 建立的所有未刪除檔案（每頁 1000 筆），比逐檔查詢省很多請求
    const sizes = new Map(records.map(r => [r.driveId, r.size]));
    const q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    let pageToken = null;
    do {
      check();
      const res = await apiRequest(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,size)&pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      for (const f of res.files || []) if (sizes.has(f.id) && Number(f.size) === sizes.get(f.id)) confirmed.add(f.id);
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    // 整份清單都讀完了才會走到這裡：沒出現在清單裡的，就是確定不在了
    sizes.forEach((_, id) => { if (!confirmed.has(id)) stale.add(id); });
    return { confirmed, stale };
  }

  // 備份前先比對帳本：已備份且 Drive 驗證仍在的檔案直接跳過（不分類、不查重複、不上傳）。
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

  // ----- 設定頁：帳本資訊、同步驗證、清除；備份頁：移除已備份的檔案 -----
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
      try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* 不支援就略過 */ }
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

  // ===== 備份流程：忙碌狀態、取消、執行、只重試失敗 =====
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
    if (currentXhr) currentXhr.abort();                       // 正在傳的檔案立刻中止
    if (!$('reauthBox').hidden) $('reauthCancel').click();    // 正在等重新授權：一併結束等待
  }

  async function runJobs(allJobs, notes = []) {
    failedJobs = allJobs.slice(); // 先假設全部都要重試；途中若丟出例外，下次仍可重試
    exifrMissingCount = 0;
    let success = 0;
    const skipped = [], renamed = [], failures = [], failedFiles = [];
    let stopIndex = -1, stopReason = null; // stopIndex 起算的檔案都視為「未處理」

    // 先比對本機帳本：已備份且 Drive 驗證仍在的檔案直接跳過，不做分類／查重複／上傳
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
          console.log(`跳過重複檔案（檔名與大小相同）: ${file.name}`);
          await ledgerRecord(file, dup.existingId, targetFolderId, dup.existingName); // 認領 Drive 上既有的備份，下次可直接由帳本跳過
        } else {
          $('progressText').textContent = `正在上傳：${file.name}`;
          const up = await uploadFileWithRetry(file, targetFolderId, fraction => {
            $('progress').value = ((i + fraction) / jobs.length) * 100;
          }, dup.uploadName);
          if (dup.uploadName !== file.name) renamed.push(`${file.name} → ${dup.uploadName}`);
          success++;
          await ledgerRecord(file, up && up.id, targetFolderId, up && up.name);
        }
      } catch (err) {
        // 使用者取消：這個檔案算「未處理」（可能傳到一半），重試時會再檢查重複
        if (err.cancelled || (err.aborted && cancelRequested)) { stopIndex = i; stopReason = 'cancel'; break; }
        failures.push(`${file.name}：${err.message}`);
        failedFiles.push(file);
        if (err.aborted) { stopIndex = i + 1; stopReason = 'reauth'; break; } // 放棄重新授權：停止後續檔案
        if (err.quota) { stopIndex = i + 1; stopReason = 'quota'; break; }    // 雲端空間已滿：停止後續檔案
      }
      $('progress').value = ((i + 1) / jobs.length) * 100;
    }

    const unprocessed = stopIndex >= 0 ? jobs.slice(stopIndex) : [];
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
  }

  async function startBackup() {
    if (uploading || ledgerBusy || !accessToken) return;
    const wantContacts = $('includeContacts').checked;
    const wantCalendar = $('includeCalendar').checked;
    if (selectedFiles.length === 0 && !wantContacts && !wantCalendar) return;
    if (wantContacts && !hasScope(SCOPE_CONTACTS)) { showResult('尚未授權讀取聯絡人，請取消勾選後重新勾選一次。', 'error'); return; }
    if (wantCalendar && !hasScope(SCOPE_CALENDAR)) { showResult('尚未授權讀取行事曆，請取消勾選後重新勾選一次。', 'error'); return; }

    // EXIF 套件沒載入時，照片會改用檔案時間分類，結果可能不對：先讓使用者知道
    if (!window.exifr && selectedFiles.some(f => isMedia(f) && (f.type.startsWith('image/') || EXIF_EXT.test(f.name)))) {
      if (!confirm('⚠️ EXIF 解析套件沒有載入成功。\n\n照片會改用「檔案修改時間」分類，可能被放到錯誤的年月或「未分類照片」。\n\n建議先重新整理頁面。要仍然繼續備份嗎？')) return;
    }

    setBusy(true);
    failedJobs = [];
    $('uploadState').textContent = '準備中'; showResult('');

    // 先確認授權有效（若需要續期，此時仍在使用者點擊的手勢內，彈窗較不會被 iOS 擋下）
    try { await ensureToken(); }
    catch (err) {
      showResult('授權未完成：' + err.message, 'error'); $('uploadState').textContent = '失敗';
      setBusy(false); return;
    }

    const notes = [];
    const generated = []; // 產生的 .vcf/.ics 另外存放，不混進使用者的選取清單
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
      setBusy(false); return; // failedJobs 保持不變，仍可再試
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
  // 原本的問題：① 按確定後立刻 reload，新 SW 還沒接手，可能又載到舊版；
  // ② 備份進行中跳 confirm 並重新載入，會把上傳整個中斷；
  // ③ 上次忽略提示後，下次開啟時新版仍在待命，但不會再有任何提示。
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

    // 新 SW 真正接手後才重新載入（不是按下按鈕就載入）
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return; // 第一次安裝時 clients.claim() 也會觸發，不需重載
      if (updateRequested && !uploading) { reloading = true; location.reload(); return; }
      mode = 'reload'; renderBar();            // 其他視窗已更新，或更新途中使用者開始了備份
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
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting); // 先前忽略、仍在待命的新版
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing; if (!nw) return;
          const check = () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw); };
          nw.addEventListener('statechange', check);
          check();
        });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // 常駐的 App 也會定期檢查
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
