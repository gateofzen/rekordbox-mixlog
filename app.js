(() => {
  "use strict";
  const CFG = window.MIXLOG_CONFIG || {};
  const SCOPES = [
    "openid", "email",
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    "https://www.googleapis.com/auth/drive.appdata",
  ].join(" ");
  const PICKER = "https://photospicker.googleapis.com/v1";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const DRIVE_UP = "https://www.googleapis.com/upload/drive/v3";
  const FILE_NAME = "mixlog.json";
  const CACHE_KEY = "rbmixlog.cache.v1";

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // =====================================================================
  // Auth (Google Identity Services token client)
  // =====================================================================
  let tokenClient = null, token = null, tokenExp = 0, tokenWaiter = null;

  function initAuth() {
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: resp => {
        const w = tokenWaiter; tokenWaiter = null;
        if (resp.error) { w?.reject(resp); return; }
        const granted = SCOPES.split(" ").filter(s => s.startsWith("https://")).every(s => google.accounts.oauth2.hasGrantedAllScopes(resp, s));
        if (!granted) { w?.reject({ error: "scope_denied" }); return; }
        token = resp.access_token;
        tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        w?.resolve(token);
      },
      error_callback: err => { const w = tokenWaiter; tokenWaiter = null; w?.reject(err); },
    });
    $("#signinBtn").disabled = false;
  }
  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject({ error: "not_ready" });
      tokenWaiter = { resolve, reject };
      tokenClient.requestAccessToken({ prompt });
    });
  }
  function getToken() {
    if (token && Date.now() < tokenExp - 60e3) return token;
    showSignin("ログインの有効期限が切れました。もう一度ログインしてください。");
    throw { error: "reauth" };
  }

  async function signIn() {
    $("#signinErr").hidden = true;
    try {
      await requestToken(localStorage.getItem("rbmixlog.signedIn") ? "" : "consent");
      try { localStorage.setItem("rbmixlog.signedIn", "1"); } catch {}
      $("#signin").hidden = true; $("#addSec").hidden = false; $("#who").hidden = false;
      await syncNow();
    } catch (e) {
      const m = e?.error === "scope_denied"
        ? "写真の選択とドライブ保存の両方を許可してください。"
        : e?.type === "popup_closed" || e?.error === "access_denied" ? "ログインが中断されました。" : "ログインできませんでした。";
      $("#signinErr").textContent = m; $("#signinErr").hidden = false;
    }
  }
  function showSignin(msg) {
    $("#signin").hidden = false;
    if (msg) { $("#signinErr").textContent = msg; $("#signinErr").hidden = false; }
  }
  $("#signinBtn").disabled = true;
  $("#signinBtn").onclick = signIn;
  $("#signout").onclick = () => {
    if (token) { try { google.accounts.oauth2.revoke(token); } catch {} }
    token = null; tokenExp = 0;
    try { localStorage.removeItem("rbmixlog.signedIn"); } catch {}
    $("#addSec").hidden = true; $("#who").hidden = true; showSignin();
  };

  async function gfetch(url, opts = {}) {
    const t = getToken();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    if (r.status === 401) { token = null; showSignin("ログインの有効期限が切れました。もう一度ログインしてください。"); throw { error: "reauth" }; }
    return r;
  }

  // =====================================================================
  // Records + Google Drive appDataFolder sync
  // =====================================================================
  let all = new Map(); // id -> record (including tombstones {deleted:true})
  let fileId = null, saveTimer = null, saving = false, dirty = false;
  const live = () => [...all.values()].filter(r => !r.deleted);

  function loadCache() {
    try { const a = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]"); all = new Map(a.map(r => [r.id, r])); } catch {}
  }
  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify([...all.values()])); }
    catch { try { localStorage.setItem(CACHE_KEY, JSON.stringify([...all.values()].map(({ thumb, ...r }) => r))); } catch {} }
  }
  function merge(a, b) {
    const m = new Map(a);
    for (const r of b) { const cur = m.get(r.id); if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) m.set(r.id, r); }
    return m;
  }
  function setSync(state, text) { const el = $("#sync"); el.className = "sync " + state; el.textContent = text; }

  async function driveRead() {
    const q = encodeURIComponent(`name='${FILE_NAME}'`);
    const r = await gfetch(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
    if (!r.ok) throw { error: "drive_list", status: r.status };
    const files = (await r.json()).files || [];
    if (!files.length) { fileId = null; return []; }
    fileId = files[0].id;
    const c = await gfetch(`${DRIVE}/files/${fileId}?alt=media`);
    if (!c.ok) throw { error: "drive_read", status: c.status };
    const data = await c.json().catch(() => ({}));
    return Array.isArray(data.records) ? data.records : [];
  }
  async function driveWrite() {
    const body = JSON.stringify({ app: "rekordbox-mixlog", version: 1, savedAt: Date.now(), records: [...all.values()] });
    if (fileId) {
      const r = await gfetch(`${DRIVE_UP}/files/${fileId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      if (r.status === 404) { fileId = null; return driveWrite(); }
      if (!r.ok) throw { error: "drive_write", status: r.status };
    } else {
      const meta = { name: FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" };
      const boundary = "mixlog" + uid();
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await gfetch(`${DRIVE_UP}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
      if (!r.ok) throw { error: "drive_create", status: r.status };
      fileId = (await r.json()).id;
    }
  }
  async function syncNow() {
    if (!token) return;
    if (saving) { dirty = true; return; }
    saving = true; dirty = false;
    setSync("busy", "同期中");
    try {
      const remote = await driveRead();
      all = merge(all, remote);
      render();
      await driveWrite();
      writeCache();
      setSync("ok", "ドライブ保存済み");
      $("#storeNote").textContent = "記録はGoogleドライブのアプリ専用領域に保存され、同じアカウントでログインした端末どうしで同期します。";
    } catch (e) {
      if (e?.error !== "reauth") setSync("err", "同期エラー");
      writeCache();
    } finally {
      saving = false;
      if (dirty) scheduleSave();
    }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(syncNow, 800); }

  function put(rec) { rec.updatedAt = Date.now(); all.set(rec.id, rec); writeCache(); render(); scheduleSave(); }
  function remove(id) { all.set(id, { id, deleted: true, updatedAt: Date.now() }); writeCache(); render(); scheduleSave(); }

  // =====================================================================
  // Worker (photo proxy + Claude reading)
  // =====================================================================
  async function worker(path, opts = {}) {
    const t = getToken();
    const r = await fetch(CFG.WORKER_URL + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    if (r.status === 401) {
      const e = await r.json().catch(() => ({}));
      throw { error: "worker_auth", detail: e.error };
    }
    return r;
  }
  const READ_ERRORS = {
    worker_auth: "Workerで認証できませんでした。許可したGoogleアカウントでログインしているか確認してください。",
    photo_fetch_failed: "写真を取得できませんでした。選んでから60分以上たった場合は選び直してください。",
    claude_error: "Claudeの呼び出しでエラーが出ました。APIキーと利用枠を確認してください。",
    invalid_json: "読み取り結果を解釈できませんでした。「もう一度」を押してください。",
    image_too_large: "画像が大きすぎます。",
    network: "Workerにつながりませんでした。config.jsのWORKER_URLを確認してください。",
  };
  async function readPhoto(job) {
    let r;
    try {
      if (job.baseUrl) {
        r = await worker("/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: job.baseUrl }) });
      } else {
        const image = await fileToBase64(job.file, 1600);
        r = await worker("/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, mediaType: "image/jpeg" }) });
      }
    } catch (e) {
      if (e?.error === "reauth" || e?.error === "worker_auth") throw e;
      throw { error: "network" };
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      if (data.raw) console.warn("read failed", data.error, data.detail, data.raw);
      throw { error: data.error || "claude_error", detail: [data.detail, data.status].filter(Boolean).join(" ") };
    }
    return data.result;
  }
  async function photoThumb(job) {
    try {
      const r = await worker(`/photo?u=${encodeURIComponent(job.baseUrl)}&w=480`);
      if (!r.ok) return "";
      return await blobToThumb(await r.blob());
    } catch { return ""; }
  }

  // =====================================================================
  // Image helpers + EXIF
  // =====================================================================
  async function blobToThumb(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const w = 240, h = Math.round(bmp.height * w / bmp.width);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return c.toDataURL("image/jpeg", 0.6);
    } catch { return ""; }
  }
  async function fileToBase64(file, max) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }
  function nameTime(file) {
    const m = file.name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  async function exifTime(file) {
    try {
      const buf = await file.slice(0, 256 * 1024).arrayBuffer();
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xFFD8) return null;
      let p = 2;
      while (p + 4 < v.byteLength) {
        const marker = v.getUint16(p), len = v.getUint16(p + 2);
        if ((marker & 0xFF00) !== 0xFF00) return null;
        if (marker === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) return parseTiff(v, p + 10);
        if (marker === 0xFFDA) return null;
        p += 2 + len;
      }
    } catch {}
    return null;
  }
  function parseTiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = o => v.getUint16(t + o, le), u32 = o => v.getUint32(t + o, le);
    const str = (off, n) => { let s = ""; for (let i = 0; i < n; i++) { const c = v.getUint8(t + off + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    const readIfd = off => { const out = {}; const n = u16(off); for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), val: e + 8 }; } return out; };
    const asStr = e => e && e.type === 2 ? str(e.count > 4 ? u32(e.val) : e.val, e.count) : "";
    const ifd0 = readIfd(u32(4));
    let dt = "", off = "";
    if (ifd0[0x8769]) { const ex = readIfd(u32(ifd0[0x8769].val)); dt = asStr(ex[0x9003]) || asStr(ex[0x9004]); off = asStr(ex[0x9011]); }
    dt = dt || asStr(ifd0[0x0132]);
    const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m || m[1] === "0000") return null;
    if (/^[+-]\d{2}:\d{2}$/.test(off)) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  // =====================================================================
  // Google Photos Picker
  // =====================================================================
  const dur = s => (parseFloat(String(s || "0").replace("s", "")) || 0) * 1000;
  let picking = null;

  async function pickFromPhotos() {
    if (picking) return;
    let win = null;
    try { getToken(); } catch { return; }
    win = window.open("about:blank", "_blank");
    const note = $("#pickNote");
    note.hidden = false; note.className = "note"; note.textContent = "Google フォトを開いています…";
    picking = { cancelled: false };
    try {
      const cr = await gfetch(`${PICKER}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!cr.ok) throw { error: "session_create", status: cr.status };
      const session = await cr.json();
      const uri = session.pickerUri + "/autoclose";
      if (win && !win.closed) win.location.href = uri;
      else note.innerHTML = `ポップアップが開けませんでした。<a href="${esc(uri)}" target="_blank" rel="noopener">ここを押してGoogle フォトを開く</a>`;
      if (win) note.innerHTML = `Google フォトで写真を選んで「完了」を押してください。<button class="ghost" id="cancelPick">やめる</button>`;
      $("#cancelPick")?.addEventListener("click", () => { picking.cancelled = true; });

      let s = session;
      const deadline = Date.now() + Math.max(dur(s.pollingConfig?.timeoutIn), 10 * 60e3);
      while (!s.mediaItemsSet) {
        if (picking.cancelled) throw { error: "cancelled" };
        if (Date.now() > deadline) throw { error: "timeout" };
        await sleep(Math.max(dur(s.pollingConfig?.pollInterval), 2000));
        const g = await gfetch(`${PICKER}/sessions/${session.id}`);
        if (!g.ok) throw { error: "session_get", status: g.status };
        s = await g.json();
      }

      note.textContent = "選んだ写真を読み込んでいます…";
      const items = [];
      let pageToken = "";
      do {
        const lr = await gfetch(`${PICKER}/mediaItems?sessionId=${encodeURIComponent(session.id)}&pageSize=100${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`);
        if (!lr.ok) throw { error: "list", status: lr.status };
        const page = await lr.json();
        items.push(...(page.mediaItems || []));
        pageToken = page.nextPageToken || "";
      } while (pageToken);

      const known = new Set(live().map(r => r.photoId).filter(Boolean));
      const photos = items.filter(i => i.type !== "VIDEO" && i.mediaFile?.baseUrl);
      const fresh = photos.filter(i => !known.has(i.id));
      const skipped = photos.length - fresh.length;
      const group = { sessionId: session.id, left: fresh.length };
      fresh.sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime)).forEach(i => addJob({
        source: "photos", photoId: i.id, baseUrl: i.mediaFile.baseUrl, fileName: i.mediaFile.filename || "",
        shotAt: Date.parse(i.createTime) || Date.now(), timeSrc: "撮影日時", group,
      }));
      if (!fresh.length) deleteSession(session.id);
      note.textContent = `${fresh.length} 枚を読み取ります。` + (skipped ? `記録済みの ${skipped} 枚は飛ばしました。` : "");
    } catch (e) {
      if (win && !win.closed && e?.error !== "cancelled") try { win.close(); } catch {}
      note.className = "note" + (e?.error === "cancelled" ? "" : " err");
      note.textContent = ({
        cancelled: "写真の選択をやめました。",
        timeout: "時間内に写真が選ばれませんでした。もう一度「Google フォトから選ぶ」を押してください。",
        reauth: "ログインし直してから、もう一度選んでください。",
      })[e?.error] || `Google フォトとのやり取りでエラーが出ました（${esc(e?.error || "")} ${e?.status || ""}）。`;
    } finally {
      picking = null;
    }
  }
  function deleteSession(id) { gfetch(`${PICKER}/sessions/${id}`, { method: "DELETE" }).catch(() => {}); }
  $("#pickBtn").onclick = pickFromPhotos;

  // =====================================================================
  // Queue
  // =====================================================================
  const jobs = [];
  const MAX_PAR = 2;
  let active = 0;

  function addJob(init) {
    const job = { id: uid(), state: "wait", thumb: "", el: document.createElement("div"), ...init };
    job.el.className = "card";
    $("#queue").append(job.el);
    jobs.push(job);
    job.ready = (async () => {
      if (job.file) {
        job.thumb = await blobToThumb(job.file);
        const ex = await exifTime(job.file);
        if (ex) { job.shotAt = ex; job.timeSrc = "EXIF"; }
      } else {
        job.thumb = await photoThumb(job);
      }
      drawJob(job);
    })();
    drawJob(job);
    pump();
  }
  function addFiles(list) {
    for (const f of list) {
      if (!/^image\//.test(f.type)) continue;
      const n = nameTime(f);
      addJob({ source: "file", file: f, fileName: f.name, shotAt: n || f.lastModified || Date.now(), timeSrc: n ? "ファイル名" : "更新日時" });
    }
  }
  function finishGroup(job) {
    if (!job.group) return;
    job.group.left--;
    if (job.group.left <= 0) deleteSession(job.group.sessionId);
  }
  async function pump() {
    while (active < MAX_PAR) {
      const job = jobs.find(j => j.state === "wait");
      if (!job) return;
      active++;
      job.state = "run"; drawJob(job);
      runJob(job).finally(() => { active--; pump(); });
    }
  }
  async function runJob(job) {
    try {
      const r = await readPhoto(job);
      const d1 = r.deck1 || {}, d2 = r.deck2 || {};
      const fromDeck = r.from_deck === 2 ? 2 : 1;
      const decks = { 1: d1, 2: d2 };
      job.result = {
        from: pick(decks[fromDeck], fromDeck),
        to: pick(decks[fromDeck === 1 ? 2 : 1], fromDeck === 1 ? 2 : 1),
        playingBpm: String(r.playing_bpm || ""),
        faders: [num(d1.fader), num(d2.fader)],
        confidence: ["high", "medium", "low"].includes(String(r.confidence).toLowerCase()) ? String(r.confidence).toLowerCase() : "medium",
        reason: String(r.reason || ""),
      };
      job.state = "done";
      if (!job.retried) finishGroup(job);
    } catch (e) {
      job.state = "err";
      job.error = e?.error === "reauth" ? "ログインし直してから「もう一度」を押してください。" : (READ_ERRORS[e?.error] || "読み取りに失敗しました。「もう一度」を押してください。") + (e?.detail ? `（${e.detail}）` : "");
    }
    await job.ready;
    drawJob(job);
  }
  const num = v => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  const pick = (d, deck) => ({ title: String(d.title || ""), artist: String(d.artist || ""), album: String(d.album || ""), bpm: String(d.bpm || ""), deck });

  function trkFields(side, t, jid) {
    return `<div class="trk ${side}">
      <span class="tag">${side === "from" ? "OUT · DECK " + t.deck : "IN · DECK " + t.deck}</span>
      <input class="t" id="${jid}-${side}-title" value="${esc(t.title)}" placeholder="曲名" aria-label="曲名">
      <input id="${jid}-${side}-artist" value="${esc(t.artist)}" placeholder="アーティスト" aria-label="アーティスト">
      <input id="${jid}-${side}-album" value="${esc(t.album)}" placeholder="アルバム" aria-label="アルバム">
      <div class="mini"><input id="${jid}-${side}-bpm" value="${esc(t.bpm)}" placeholder="BPM" aria-label="BPM"></div>
    </div>`;
  }
  function readFields(jid, side, deck) {
    const v = k => document.getElementById(`${jid}-${side}-${k}`)?.value.trim() || "";
    return { title: v("title"), artist: v("artist"), album: v("album"), bpm: v("bpm"), deck };
  }
  const tlabel = job => `${fmtDate(job.shotAt)} <span class="pill${job.timeSrc === "更新日時" ? " low" : ""}" title="撮影時刻の取得元">${job.timeSrc}</span>`;

  function drawJob(job) {
    if (job.state === "gone") return;
    const img = job.thumb ? `<img class="thumb" src="${job.thumb}" alt="撮影した画面">` : `<div></div>`;
    let body = "";
    if (job.state === "wait") body = `<div class="status">順番待ち · ${tlabel(job)}</div>`;
    else if (job.state === "run") body = `<div class="status">読み取り中… · ${tlabel(job)}</div>`;
    else if (job.state === "err") body = `<div class="status">${tlabel(job)}</div><p class="note err">${esc(job.error)}</p>
      <div class="row"><button data-act="retry">もう一度</button><button class="ghost" data-act="drop">取り消す</button></div>`;
    else {
      const r = job.result;
      const fd = r.faders.map((f, i) => `CH${i + 1} ${f == null ? "?" : Math.round(f * 100) + "%"}`).join(" / ");
      body = `<div class="status"><span>${tlabel(job)}</span><span class="pill ${r.confidence}">判定 ${({ high: "確実", medium: "たぶん", low: "要確認" })[r.confidence]}</span><span class="pill">${fd}</span></div>
        ${r.reason ? `<p class="reason">${esc(r.reason)}</p>` : ""}
        ${trkFields("from", r.from, job.id)}
        ${trkFields("to", r.to, job.id)}
        <textarea id="${job.id}-memo" placeholder="メモ（どこで入れたか、EQの使い方など）" aria-label="メモ"></textarea>
        <div class="row"><button class="primary" data-act="save">記録する</button><button data-act="swap">順番を入れ替える</button><button class="ghost" data-act="drop">取り消す</button></div>`;
    }
    const memo = document.getElementById(job.id + "-memo")?.value;
    job.el.innerHTML = img + `<div class="body">${body}</div>`;
    if (memo) { const m = document.getElementById(job.id + "-memo"); if (m) m.value = memo; }
    job.el.onclick = ev => {
      const act = ev.target.closest("button")?.dataset.act; if (!act) return;
      if (act === "retry") { job.state = "wait"; job.retried = true; drawJob(job); pump(); }
      if (act === "drop") { if (job.state !== "done") finishGroup(job); job.state = "gone"; job.el.remove(); updateQbar(); }
      if (act === "swap") {
        const f = readFields(job.id, "from", job.result.from.deck), t = readFields(job.id, "to", job.result.to.deck);
        job.result.from = t; job.result.to = f; drawJob(job);
      }
      if (act === "save") saveJob(job);
    };
    updateQbar();
  }

  function saveJob(job) {
    const r = job.result;
    put({
      id: job.id, shotAt: job.shotAt, timeSrc: job.timeSrc, createdAt: Date.now(),
      source: job.source, photoId: job.photoId || null, fileName: job.fileName || "",
      from: readFields(job.id, "from", r.from.deck), to: readFields(job.id, "to", r.to.deck),
      playingBpm: r.playingBpm, faders: r.faders, confidence: r.confidence,
      memo: document.getElementById(job.id + "-memo")?.value.trim() || "", thumb: job.thumb,
    });
    job.state = "gone"; job.el.remove(); updateQbar();
  }
  function updateQbar() {
    const alive = jobs.filter(j => j.state !== "gone");
    const done = alive.filter(j => j.state === "done").length;
    const busy = alive.filter(j => j.state === "wait" || j.state === "run").length;
    $("#qbar").hidden = alive.length < 2 && done < 2;
    $("#qcount").textContent = `読み取り済み ${done} 枚` + (busy ? ` · 残り ${busy} 枚` : "");
    $("#saveAll").disabled = !done;
  }
  $("#saveAll").onclick = () => {
    const ready = jobs.filter(j => j.state === "done");
    ready.forEach(saveJob);
    if (ready.length) selectSessionAt(Math.min(...ready.map(j => j.shotAt)));
  };

  // =====================================================================
  // Log
  // =====================================================================
  function nightKey(ts) { const d = new Date(ts - 6 * 3600e3); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function hhmm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtDate(ts) { const d = new Date(ts); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm(ts)}`; }
  const trackLine = t => `${t.title || "?"}${t.artist ? " / " + t.artist : ""}`;
  let confirmId = null, editId = null;

  function entryHtml(r) {
    const m = t => [t.album ? "(" + t.album + ")" : "", t.bpm ? t.bpm + " BPM" : ""].filter(Boolean).join("  ");
    if (editId === r.id) {
      return `<div class="entry" data-id="${r.id}"><div class="time">${hhmm(r.shotAt)}</div>
        <div class="mix" style="gap:8px">${trkFields("from", r.from, "e" + r.id)}${trkFields("to", r.to, "e" + r.id)}
        <textarea id="e${r.id}-memo" aria-label="メモ">${esc(r.memo)}</textarea>
        <div class="row"><button class="primary" data-act="esave">保存</button><button data-act="eswap">入れ替え</button><button class="ghost" data-act="ecancel">やめる</button></div></div><div></div></div>`;
    }
    const acts = confirmId === r.id
      ? `<span class="confirm">削除しますか？</span><button data-act="del2">削除</button><button class="ghost" data-act="del0">やめる</button>`
      : `<button data-act="edit">編集</button><button data-act="swapsaved">入れ替え</button><button class="ghost" data-act="del1">削除</button>`;
    return `<div class="entry" data-id="${r.id}">
      <div class="time">${hhmm(r.shotAt)}${r.thumb ? `<img src="${r.thumb}" alt="">` : ""}</div>
      <div class="mix">
        <div class="from"><b>${esc(r.from.title || "?")}</b><span class="artist">${esc(r.from.artist)}</span><span class="meta">${esc(m(r.from))}</span></div>
        <div class="to"><b>${esc(r.to.title || "?")}</b><span class="artist">${esc(r.to.artist)}</span><span class="meta">${esc(m(r.to))}</span></div>
        ${r.playingBpm ? `<div class="meta" style="margin-left:36px">プレイ中 ${esc(r.playingBpm)} BPM</div>` : ""}
        ${r.memo ? `<p class="memo">${esc(r.memo)}</p>` : ""}
      </div>
      <div class="acts">${acts}</div></div>`;
  }

  function render() {
    renderSetlist();
    const recs = live();
    const log = $("#log");
    if (!recs.length) {
      log.innerHTML = `<div class="empty"><p class="note" style="margin:0">まだ記録がありません。ログインして「Google フォトから選ぶ」でつなぎの写真を選ぶと、読み取り結果を確認してから記録できます。claude.ai版のMix LogからJSONを書き出していれば「JSONを読み込む」で移せます。</p></div>`;
      return;
    }
    const sorted = recs.sort((a, b) => b.shotAt - a.shotAt);
    const groups = new Map();
    for (const r of sorted) { const k = nightKey(r.shotAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    log.innerHTML = [...groups].map(([k, rs]) =>
      `<div class="night"><h3><span>${k.replace(/-/g, "/")} の夜</span><span>${rs.length} mix</span></h3>${rs.map(entryHtml).join("")}</div>`
    ).join("");
  }

  $("#log").addEventListener("click", ev => {
    const btn = ev.target.closest("button"); if (!btn) return;
    const id = btn.closest(".entry")?.dataset.id, act = btn.dataset.act;
    const rec = all.get(id); if (!rec) return;
    if (act === "del1") { confirmId = id; render(); return; }
    if (act === "del0") { confirmId = null; render(); return; }
    if (act === "del2") { confirmId = null; remove(id); return; }
    if (act === "edit") { editId = id; render(); return; }
    if (act === "ecancel") { editId = null; render(); return; }
    if (act === "swapsaved") { put({ ...rec, from: rec.to, to: rec.from }); return; }
    if (act === "eswap" || act === "esave") {
      const f = readFields("e" + id, "from", rec.from.deck), t = readFields("e" + id, "to", rec.to.deck);
      const memo = document.getElementById("e" + id + "-memo").value.trim();
      if (act === "eswap") { all.set(id, { ...rec, from: t, to: f, memo }); render(); return; }
      editId = null; put({ ...rec, from: f, to: t, memo });
    }
  });

  // =====================================================================
  // Setlist
  // =====================================================================
  const GAP = 60 * 60e3;
  const norm = s => String(s || "").toLowerCase().replace(/\.{2,}|…/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
  function sameTrack(a, b) {
    const x = norm(a.title), y = norm(b.title);
    if (!x || !y) return false;
    if (x === y) return true;
    const [s, l] = x.length < y.length ? [x, y] : [y, x];
    return s.length >= 6 && l.startsWith(s);
  }
  const better = (a, b) => ({ ...a, title: (b.title || "").length > (a.title || "").length ? b.title : a.title, artist: (b.artist || "").length > (a.artist || "").length ? b.artist : a.artist, album: (b.album || "").length > (a.album || "").length ? b.album : a.album, bpm: a.bpm || b.bpm });
  function sessionsOf(list) {
    const sorted = [...list].sort((a, b) => a.shotAt - b.shotAt), out = [];
    for (const r of sorted) {
      const cur = out[out.length - 1];
      if (cur && r.shotAt - cur.end <= GAP) { cur.end = r.shotAt; cur.n++; }
      else out.push({ start: r.shotAt, end: r.shotAt, n: 1 });
    }
    return out;
  }
  function buildSetlist(list) {
    const items = [];
    let last = null;
    for (const r of [...list].sort((a, b) => a.shotAt - b.shotAt)) {
      if (last && sameTrack(r.to, last) && !sameTrack(r.from, last)) continue;
      if (last && sameTrack(r.from, last)) Object.assign(last, better(last, r.from));
      else { if (last) items.push({ gap: true }); last = { ...r.from, at: null }; items.push(last); }
      if (sameTrack(r.to, last)) continue;
      last = { ...r.to, at: r.shotAt };
      items.push(last);
    }
    return items;
  }
  let slFrom = null, slTo = null, slItems = [];
  const toLocal = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fromLocal = v => v ? new Date(v).getTime() : null;
  function selectSessionAt(ts) {
    const ss = sessionsOf(live());
    const s = ss.find(x => ts >= x.start && ts <= x.end) || ss[ss.length - 1];
    if (!s) return;
    slFrom = s.start; slTo = s.end; renderSetlist();
  }
  function renderSetlist() {
    const recs = live();
    const ss = sessionsOf(recs);
    if (ss.length && (slFrom == null || slTo == null)) { const s = ss[ss.length - 1]; slFrom = s.start; slTo = s.end; }
    $("#sessions").innerHTML = ss.slice().reverse().map(s => {
      const on = slFrom === s.start && slTo === s.end;
      return `<button data-s="${s.start}" data-e="${s.end}" aria-pressed="${on}">${fmtDate(s.start).slice(5)}–${hhmm(s.end)} · ${s.n}</button>`;
    }).join("");
    const fEl = $("#slFrom"), tEl = $("#slTo");
    if (document.activeElement !== fEl) fEl.value = slFrom != null ? toLocal(slFrom) : "";
    if (document.activeElement !== tEl) tEl.value = slTo != null ? toLocal(slTo) : "";
    const lo = slFrom != null ? Math.floor(slFrom / 60e3) * 60e3 : -Infinity;
    const hi = slTo != null ? Math.floor(slTo / 60e3) * 60e3 + 60e3 - 1 : Infinity;
    const inRange = recs.filter(r => r.shotAt >= lo && r.shotAt <= hi);
    slItems = buildSetlist(inRange);
    const tracks = slItems.filter(i => !i.gap), gaps = slItems.length - tracks.length;
    $("#slSummary").textContent = recs.length
      ? (inRange.length ? `${inRange.length} 回のつなぎ → ${tracks.length} 曲` + (gaps ? ` · つながらない箇所 ${gaps}（間の写真がない可能性）` : "") : "この時間帯の記録はありません。")
      : "写真を記録するとここにセットリストができます。";
    let no = 0;
    $("#setlist").hidden = !slItems.length;
    $("#setlist").innerHTML = slItems.map(i => i.gap
      ? `<li class="gap">― ここで記録が途切れています ―</li>`
      : `<li><span class="no">${pad(++no)}</span><span class="tm">${i.at ? hhmm(i.at) : "start"}</span><span class="tt"><b>${esc(i.title || "?")}</b><span>${esc(i.artist)}</span>${i.album ? `<span>(${esc(i.album)})</span>` : ""}</span><span class="bk">${i.bpm ? esc(i.bpm) + " BPM" : ""}</span></li>`
    ).join("");
  }
  $("#sessions").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    slFrom = +b.dataset.s; slTo = +b.dataset.e; $("#slOut").hidden = true; renderSetlist();
  });
  $("#slFrom").addEventListener("change", e => { slFrom = fromLocal(e.target.value); renderSetlist(); });
  $("#slTo").addEventListener("change", e => { slTo = fromLocal(e.target.value); renderSetlist(); });

  // =====================================================================
  // Export / import
  // =====================================================================
  const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const ordered = () => live().sort((a, b) => a.shotAt - b.shotAt);
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function copyText(btn, text, outSel) {
    try { await navigator.clipboard.writeText(text); const o = btn.textContent; btn.textContent = "コピーしました"; setTimeout(() => btn.textContent = o, 1600); }
    catch { const o = $(outSel); o.hidden = false; o.textContent = text; const s = getSelection(), rg = document.createRange(); rg.selectNodeContents(o); s.removeAllRanges(); s.addRange(rg); }
  }
  const stamp = ts => { const d = new Date(ts); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };

  // 曲名 / アーティスト名 (アルバム名) [bpm]
  const setLine = i => `${i.title || "?"}${i.artist ? " / " + i.artist : ""}${i.album ? " (" + i.album + ")" : ""}${i.bpm ? " [" + i.bpm + "]" : ""}`;
  function slText() {
    let no = 0;
    return slItems.map(i => i.gap ? "---" : `${pad(++no)}. ${i.at ? hhmm(i.at) : "start"} ${setLine(i)}`).join("\n");
  }
  function slCsv() {
    let no = 0;
    const rows = slItems.map(i => i.gap ? ["", "", "（途切れ）", "", "", "", ""] : [++no, i.at ? fmtDate(i.at) : "", i.title, i.artist, i.album || "", i.bpm, setLine(i)]);
    return "﻿" + [["No", "IN時刻", "曲名", "アーティスト", "アルバム", "BPM", "表記"], ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  }
  function slJson() {
    let no = 0;
    return JSON.stringify({ from: fmtDate(slFrom), to: fmtDate(slTo), tracks: slItems.map(i => i.gap ? { break: true } :
      { no: ++no, in_at: i.at ? fmtDate(i.at) : null, title: i.title, artist: i.artist, album: i.album || "", bpm: i.bpm, line: setLine(i) }) }, null, 2);
  }
  const slName = ext => { const d = new Date(slFrom); return `setlist_${stamp(slFrom)}_${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`; };
  $("#slCsv").onclick = () => slItems.length && download(slName("csv"), slCsv(), "text/csv");
  $("#slJson").onclick = () => slItems.length && download(slName("json"), slJson(), "application/json");
  $("#slCopy").onclick = ev => slItems.length && copyText(ev.currentTarget, slText(), "#slOut");

  function asText() {
    let last = "";
    return ordered().map(r => {
      const k = nightKey(r.shotAt); const head = k !== last ? (last ? "\n" : "") + `■ ${k.replace(/-/g, "/")}\n` : ""; last = k;
      return head + `${hhmm(r.shotAt)}  ${trackLine(r.from)}  →  ${trackLine(r.to)}${r.memo ? "  （" + r.memo + "）" : ""}`;
    }).join("\n");
  }
  function asCsv() {
    const h = ["日時", "OUT曲名", "OUTアーティスト", "OUTアルバム", "OUT BPM", "IN曲名", "INアーティスト", "INアルバム", "IN BPM", "プレイ中BPM", "メモ", "ファイル名"];
    const rows = ordered().map(r => [fmtDate(r.shotAt), r.from.title, r.from.artist, r.from.album || "", r.from.bpm, r.to.title, r.to.artist, r.to.album || "", r.to.bpm, r.playingBpm, r.memo, r.fileName]);
    return "﻿" + [h, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  }
  const asJson = () => JSON.stringify(ordered().map(({ thumb, ...r }) => r), null, 2);
  $("#copyAll").onclick = ev => live().length && copyText(ev.currentTarget, asText(), "#textOut");
  $("#csv").onclick = () => live().length && download(`mixlog_${stamp(Date.now())}.csv`, asCsv(), "text/csv");
  $("#json").onclick = () => live().length && download(`mixlog_${stamp(Date.now())}.json`, asJson(), "application/json");

  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").addEventListener("change", async e => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const note = $("#storeNote");
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : Array.isArray(data.records) ? data.records : null;
      if (!list) throw 0;
      const existing = new Set(live().map(r => `${r.shotAt}|${norm(r.from?.title)}|${norm(r.to?.title)}`));
      let n = 0;
      for (const r of list) {
        if (!r || !r.from || !r.to || !r.shotAt) continue;
        const key = `${r.shotAt}|${norm(r.from.title)}|${norm(r.to.title)}`;
        if (existing.has(key)) continue;
        existing.add(key);
        const id = r.id && !all.has(r.id) ? r.id : uid();
        all.set(id, { ...r, id, source: r.source || "import", updatedAt: Date.now() });
        n++;
      }
      writeCache(); render(); scheduleSave();
      note.textContent = `${n} 件を読み込みました。`;
    } catch { note.textContent = "このファイルは読み込めませんでした。Mix Logで書き出したJSONを選んでください。"; }
  });

  // =====================================================================
  // Inputs + boot
  // =====================================================================
  $("#file").addEventListener("change", e => { try { getToken(); } catch { return; } addFiles(e.target.files); e.target.value = ""; });
  const drop = $("#drop");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); try { getToken(); } catch { return; } addFiles(e.dataTransfer.files); });

  if (!CFG.GOOGLE_CLIENT_ID || /^x+\./.test(CFG.GOOGLE_CLIENT_ID) || !CFG.WORKER_URL || /YOUR-SUBDOMAIN/.test(CFG.WORKER_URL)) {
    $("#signinErr").textContent = "config.js に GOOGLE_CLIENT_ID と WORKER_URL を設定してください。";
    $("#signinErr").hidden = false;
  }
  // PWA: offline shell + install button
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
  window.addEventListener("appinstalled", () => { installEvt = null; $("#installBtn").hidden = true; });
  $("#installBtn").onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null; $("#installBtn").hidden = true;
  };

  loadCache();
  $("#storeNote").textContent = live().length ? "この端末に残っている記録を表示しています。ログインするとGoogleドライブと同期します。" : "";
  render();
  initAuth();
})();
