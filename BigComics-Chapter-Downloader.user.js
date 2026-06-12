// ==UserScript==
// @name         BigComics Chapter Downloader
// @namespace    https://bigcomics.jp/
// @version      5.21
// @description  Download BigComics chapters as ZIP or CBZ
// @author       Lord Karasuma 
// @match        https://bigcomics.jp/episodes/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────────────
    const STABLE_CHECKS    = 3;    // consecutive identical checks = canvas stable
    const STABLE_INTERVAL  = 250;  // ms between stability checks
    const AFTER_CLICK_WAIT = 600;  // ms to wait after a click before checking stability
    const MAX_PAGES        = 200;  // safety cap per chapter
    const STUCK_LIMIT      = 5;    // clicks with no new pages = chapter end
    const BETWEEN_CHAPTERS = 2000; // ms to wait after navigating to a new chapter URL
    const FULLSCREEN_WAIT  = 1200; // ms to wait after entering fullscreen for canvas to resize
    // ────────────────────────────────────────────────────────────────────

    // ── Preferences (persisted in localStorage) ─────────────────────────
    let outputFormat  = localStorage.getItem('bc-dl-format')   || 'zip';  // 'zip' | 'cbz'
    let imageFormat   = localStorage.getItem('bc-dl-imgfmt')   || 'png';  // 'png' | 'jpg' | 'webp'
    let imageQuality  = parseFloat(localStorage.getItem('bc-dl-quality') || '0.95'); // 0.01–1.0

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // canvasKey uses PNG always (for dedup fingerprint regardless of output format)
    function canvasKey(dataURL) {
        const b64 = dataURL.substring(22);
        const mid = Math.floor(b64.length / 2);
        return b64.substring(mid - 100, mid + 100);
    }

    // Capture a canvas to dataURL using current imageFormat/imageQuality settings
    function captureCanvas(canvas) {
        if (imageFormat === 'png') {
            return canvas.toDataURL('image/png');
        } else if (imageFormat === 'jpg') {
            return canvas.toDataURL('image/jpeg', imageQuality);
        } else {
            return canvas.toDataURL('image/webp', imageQuality);
        }
    }

    function imgExt() {
        if (imageFormat === 'jpg') return 'jpg';
        if (imageFormat === 'webp') return 'webp';
        return 'png';
    }

    function getEpisodeId() {
        return location.pathname.split('/').filter(Boolean).pop() || '';
    }

    // ── Title extraction ─────────────────────────────────────────────────
    function getSeriesTitle() {
        const seriesEls = [...document.querySelectorAll('[class*="series"]')];
        for (const el of seriesEls) {
            const t = el.textContent.trim();
            if (t.length < 2 || t.length > 60) continue;
            if (t.startsWith('#') || /^\d/.test(t)) continue;
            if (/更新|最新|話無料/.test(t)) continue;
            if (/[\s　]の[\s　\p{Script=Han}]/u.test(t)) continue;
            return t;
        }
        const og = document.querySelector('meta[property="og:title"]')?.content || '';
        if (og) {
            let t = og.replace(/\s*[|｜].*$/, '').trim();
            t = t.replace(/・[^・]+$/, '').trim();
            return t || og;
        }
        let t = document.title || '';
        t = t.replace(/\s*[|｜].*$/, '').trim();
        t = t.replace(/・[^・]+$/, '').trim();
        return t || 'chapter';
    }

    function getEpisodeTitle() {
        const titleEls = [...document.querySelectorAll('[class*="title"]')];
        for (const el of titleEls) {
            const t = el.textContent.trim();
            if (t.length >= 2 && t.length <= 80) return t;
        }
        const parts = (document.title || '').split('・');
        return parts[parts.length - 1].replace(/\s*[|｜].*$/, '').trim() || 'episode';
    }

    function sanitize(str) {
        return str.replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    // ── Fullscreen helpers ───────────────────────────────────────────────

    function isFullscreen() {
        return !!document.fullscreenElement;
    }

    async function ensureFullscreen() {
        if (isFullscreen()) return;
        setStatus('🔲 Entering fullscreen for max resolution...');
        const btn = document.querySelector('.-cv-f-btn.mode-fullscreen, [class*="-cv-f-btn"][class*="fullscreen"]');
        if (btn) {
            btn.click();
            await sleep(FULLSCREEN_WAIT);
        } else {
            const viewer = document.querySelector('.-cv, [class*="mode-viewer"]') || document.documentElement;
            try { await viewer.requestFullscreen(); } catch(e) { /* ignore */ }
            await sleep(FULLSCREEN_WAIT);
        }
        if (!isFullscreen()) {
            setStatus('⚠️ Fullscreen not available — canvas resolution may be lower.');
            await sleep(600);
        }
    }

    // ── Canvas helpers ───────────────────────────────────────────────────

    function waitStableCanvases(minCount = 1, timeoutMs = 6000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            let sameCount = 0;
            let lastSig = '';
            const check = () => {
                if (Date.now() - start > timeoutMs) {
                    // Timeout: resolve with whatever is on screen (even if < minCount),
                    // only reject if truly nothing is there.
                    const cs = getValidCanvases();
                    return cs.length > 0 ? resolve(cs) : reject('Timeout: no canvas');
                }
                const cs = getValidCanvases();
                const sig = cs.map(c => {
                    try { return c.toDataURL('image/png').length; } catch(e) { return 0; }
                }).join(',');
                if (sig === lastSig && sig !== '' && cs.length >= minCount) {
                    sameCount++;
                    if (sameCount >= STABLE_CHECKS) return resolve(cs);
                } else if (sig === lastSig && sig !== '' && cs.length > 0 && minCount > 1) {
                    // We wanted minCount but only fewer canvases are stable — count them too.
                    // This handles single-page spreads (e.g. cover) without waiting for timeout.
                    sameCount++;
                    if (sameCount >= STABLE_CHECKS) return resolve(cs);
                } else {
                    sameCount = 0;
                    lastSig = sig;
                }
                setTimeout(check, STABLE_INTERVAL);
            };
            check();
        });
    }

    function getValidCanvases() {
        const all = [...document.querySelectorAll('canvas')]
            .filter(c => c.width > 200 && c.height > 200);

        const isRTLSpread = !!document.querySelector('.-cv.mode-dir-rtl, [class*="mode-dir-rtl"]');
        if (!isRTLSpread) return all;

        // The viewer keeps ~5 canvases in DOM as a circular buffer.
        // Only collect canvases whose left edge is on-screen: left >= 0 && left < innerWidth.
        const vw = window.innerWidth;
        return all
            .filter(c => {
                const left = c.getBoundingClientRect().left;
                return left >= 0 && left < vw;
            })
            .sort((a, b) => {
                const ax = a.getBoundingClientRect().left;
                const bx = b.getBoundingClientRect().left;
                return bx - ax; // descending: rightmost first = RTL reading order
            });
    }

    function clickNext() {
        const nav = document.querySelector('.-cv-nav.mode-l, [class*="-cv-nav"][class*="mode-l"]');
        if (nav) { nav.click(); return; }
        const x = 30, y = window.innerHeight / 2;
        const el = document.elementFromPoint(x, y);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    }

    async function goToFirstPage() {
        setStatus('⏩ Going to first page...');
        // RTL viewer: ArrowRight goes backward toward cover (page 1 = rightmost)
        for (let i = 0; i < 60; i++) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }));
            await sleep(80);
        }
        await sleep(1000);
    }

    // ── Cover image — reload with crossOrigin=anonymous to allow canvas export ─
    function loadCoverFromUrl(src) {
        return new Promise((resolve) => {
            const tempImg = new Image();
            tempImg.crossOrigin = 'anonymous';
            tempImg.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width  = tempImg.naturalWidth;
                    canvas.height = tempImg.naturalHeight;
                    canvas.getContext('2d').drawImage(tempImg, 0, 0);
                    console.log(`[BigComics DL] Cover loaded: ${tempImg.naturalWidth}x${tempImg.naturalHeight} from ${src}`);
                    resolve(canvas.toDataURL('image/jpeg', 0.95));
                } catch(e) {
                    console.warn('[BigComics DL] Cover canvas export failed (tainted):', e);
                    resolve(null);
                }
            };
            tempImg.onerror = () => resolve(null);
            tempImg.src = src + (src.includes('?') ? '&' : '?') + '_cors=1';
        });
    }

    async function getCoverDataURL() {
        const img = document.querySelector('img[src*="articlevisual"]');
        if (!img) return null;

        // Try full-res URL first: remove "-lg" suffix (e.g. "cover-lg.jpg" → "cover.jpg")
        const fullResSrc = img.src.replace(/-lg(\.[a-z]+)(\?|$)/i, '$1$2');
        if (fullResSrc !== img.src) {
            console.log('[BigComics DL] Trying full-res cover:', fullResSrc);
            const dataURL = await loadCoverFromUrl(fullResSrc);
            if (dataURL) return dataURL;
            console.warn('[BigComics DL] Full-res cover failed, falling back to original URL.');
        }

        // Fallback to original URL
        return loadCoverFromUrl(img.src);
    }


    async function buildArchive(pages) {
        const zip = new JSZip();
        const seriesTitle = sanitize(getSeriesTitle());
        const episodeTitle = sanitize(getEpisodeTitle());
        const folderName = `${seriesTitle} - ${episodeTitle}`;
        const folder = zip.folder(folderName);
        const ext = imgExt();

        // Pages are in RTL reading order: index 0 = cover, last = final page.
        // 001.ext = cover, 002.ext = page 2, etc. — correct for both ZIP and CBZ.
        // CBZ readers should be set to RTL/manga mode to navigate correctly.
        pages.forEach((dataURL, i) => {
            const b64 = dataURL.split(',')[1];
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
            folder.file(`${String(i + 1).padStart(3, '0')}.${ext}`, arr);
        });

        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 5 }
        });
        return { blob, folderName };
    }

    let statusEl = null;

    function setStatus(msg) {
        if (statusEl) { statusEl.textContent = msg; }
        console.log('[BigComics DL]', msg);
    }

    // ── Download a single chapter (current page) and return archive info ──
    async function downloadChapter() {
        const startId = getEpisodeId();

        // ① Ensure fullscreen BEFORE going to first page
        await ensureFullscreen();

        await goToFirstPage();

        if (getEpisodeId() !== startId) {
            throw new Error('Chapter changed during navigation, aborting.');
        }

        const collected = new Map();
        let stuckCount = 0;
        let clicks = 0;

        while (clicks < MAX_PAGES) {
            if (getEpisodeId() !== startId) {
                console.log('[BigComics DL] Chapter change detected, stopping.');
                break;
            }

            let canvases;
            try {
                // Wait for 2 canvases (spread). If only 1 arrives (last page or single-page
                // spread), waitStableCanvases falls back: after timeoutMs it resolves with
                // whatever is available (≥1). We use a shorter timeout (4s) so the fallback
                // kicks in quickly on the final single page.
                canvases = await waitStableCanvases(2, 4000);
            } catch(e) {
                console.log('[BigComics DL] waitStableCanvases timeout → chapter end detected, stopping.');
                break;
            }

            let newThisRound = 0;
            for (const c of canvases) {
                try {
                    // Fingerprint always in PNG (consistent regardless of output format)
                    const fingerprint = c.toDataURL('image/png');
                    const k = canvasKey(fingerprint);
                    if (!collected.has(k)) {
                        // Store in the chosen output format
                        collected.set(k, captureCanvas(c));
                        newThisRound++;
                    }
                } catch(e) { /* tainted canvas, skip */ }
            }
            console.log(`[BigComics DL] click ${clicks}: saw ${canvases.length} canvas(es) (wanted 2), +${newThisRound} new → total ${collected.size}`);

            setStatus(`⏳ Collected: ${collected.size} pages (click ${clicks})`);

            if (newThisRound === 0) {
                stuckCount++;
                if (stuckCount >= STUCK_LIMIT) break;
            } else {
                stuckCount = 0;
            }

            clickNext();
            clicks++;
            await sleep(AFTER_CLICK_WAIT);
        }

        if (collected.size === 0) throw new Error('No pages collected.');

        // Exit fullscreen so the browser UI is restored after download
        if (document.fullscreenElement) {
            try { await document.exitFullscreen(); } catch(e) { /* ignore */ }
        }

        // Fetch the cover image (rendered as <img>, not canvas)
        setStatus('🖼 Fetching cover image...');
        const coverDataURL = await getCoverDataURL();
        const pages = [...collected.values()];
        if (coverDataURL) {
            pages.unshift(coverDataURL);
            console.log('[BigComics DL] Cover fetched and prepended as page 1.');
        } else {
            console.warn('[BigComics DL] Cover not found — ZIP will start from page 2.');
        }

        setStatus(`📦 ${pages.length} pages — building archive...`);

        const { blob, folderName } = await buildArchive(pages);
        return { blob, folderName, pages: pages.length };
    }

    function triggerDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
    }

    function archiveExt() {
        return outputFormat === 'cbz' ? 'cbz' : 'zip';
    }

    // ── Single chapter handler ──
    async function onDownloadCurrent() {
        lockUI();
        try {
            const { blob, folderName, pages } = await downloadChapter();
            triggerDownload(blob, `${folderName}.${archiveExt()}`);
            setStatus(`✅ Done! ${pages} pages → ${folderName}.${archiveExt()}`);
        } catch(err) {
            console.error('[BigComics DL]', err);
            setStatus('❌ Error: ' + String(err));
        } finally {
            unlockUI();
        }
    }

    // ── UI ──────────────────────────────────────────────────────────────

    function lockUI() {
        document.querySelectorAll('.bc-dl-action').forEach(b => {
            b.disabled = true;
            b.style.opacity = '0.5';
            b.style.cursor = 'default';
        });
    }

    function unlockUI() {
        document.querySelectorAll('.bc-dl-action').forEach(b => {
            b.disabled = false;
            b.style.opacity = '1';
            b.style.cursor = 'pointer';
        });
    }

    function makeBtn(id, label, handler) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.className = 'bc-dl-action';
        btn.textContent = label;
        Object.assign(btn.style, {
            display: 'block', width: '100%',
            padding: '8px 12px', marginTop: '6px',
            background: '#e63946', color: '#fff',
            border: 'none', borderRadius: '6px',
            fontSize: '12px', fontWeight: 'bold',
            cursor: 'pointer', textAlign: 'center',
            lineHeight: '1.4',
        });
        btn.addEventListener('click', handler);
        return btn;
    }

    // ── Archive format toggle: ZIP ↔ CBZ ─────────────────────────────────
    function makeArchiveToggle() {
        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'flex', gap: '4px', marginTop: '6px',
        });

        ['zip', 'cbz'].forEach(fmt => {
            const btn = document.createElement('button');
            btn.textContent = fmt.toUpperCase();
            btn.dataset.fmt = fmt;
            btn.className = 'bc-dl-fmt-btn';
            Object.assign(btn.style, {
                flex: '1', padding: '5px 0',
                border: '1px solid #555', borderRadius: '5px',
                fontSize: '11px', fontWeight: 'bold',
                cursor: 'pointer', transition: 'all .15s',
            });

            const applyActive = () => {
                document.querySelectorAll('.bc-dl-fmt-btn').forEach(b => {
                    const active = b.dataset.fmt === outputFormat;
                    b.style.background = active ? '#e63946' : '#2a2a2a';
                    b.style.color      = active ? '#fff'     : '#888';
                    b.style.borderColor = active ? '#e63946' : '#555';
                });
            };

            btn.addEventListener('click', () => {
                outputFormat = fmt;
                localStorage.setItem('bc-dl-format', fmt);
                applyActive();
                setStatus(`Archive format: .${fmt}`);
            });

            wrapper.appendChild(btn);
            requestAnimationFrame(applyActive);
        });

        return wrapper;
    }

    // ── Settings panel (overlay) ─────────────────────────────────────────
    function makeSettingsPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'bc-dl-settings';
        Object.assign(overlay.style, {
            display: 'none',
            position: 'absolute', inset: '0',
            background: '#111', borderRadius: '10px',
            padding: '12px 14px',
            zIndex: '2',
            boxSizing: 'border-box',
            overflowY: 'auto',
        });

        // ── Header row ──
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: '10px',
        });

        const heading = document.createElement('span');
        heading.textContent = '⚙ Settings';
        Object.assign(heading.style, { fontWeight: 'bold', fontSize: '12px', color: '#e63946' });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        Object.assign(closeBtn.style, {
            background: 'none', border: 'none', color: '#888',
            fontSize: '13px', cursor: 'pointer', padding: '0',
        });
        closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });

        header.appendChild(heading);
        header.appendChild(closeBtn);
        overlay.appendChild(header);

        // ── Image format section ──
        const imgLabel = makeSettingsLabel('Image format:');
        overlay.appendChild(imgLabel);

        const imgToggle = document.createElement('div');
        Object.assign(imgToggle.style, { display: 'flex', gap: '4px', marginTop: '4px' });

        ['png', 'jpg', 'webp'].forEach(fmt => {
            const btn = document.createElement('button');
            btn.textContent = fmt.toUpperCase();
            btn.dataset.imgfmt = fmt;
            btn.className = 'bc-dl-imgfmt-btn';
            Object.assign(btn.style, {
                flex: '1', padding: '5px 0',
                border: '1px solid #555', borderRadius: '5px',
                fontSize: '11px', fontWeight: 'bold',
                cursor: 'pointer', transition: 'all .15s',
            });

            btn.addEventListener('click', () => {
                imageFormat = fmt;
                localStorage.setItem('bc-dl-imgfmt', fmt);
                refreshImgFmtBtns();
                refreshQualityRow();
                setStatus(`Image format: ${fmt.toUpperCase()}`);
            });

            imgToggle.appendChild(btn);
        });

        overlay.appendChild(imgToggle);

        // ── Quality row (hidden for PNG) ──
        const qualityRow = document.createElement('div');
        qualityRow.id = 'bc-dl-quality-row';
        Object.assign(qualityRow.style, {
            marginTop: '10px',
            display: imageFormat === 'png' ? 'none' : 'block',
        });

        const qualLabel = makeSettingsLabel('Quality: <span id="bc-dl-q-val"></span>');
        qualLabel.style.marginBottom = '4px';
        qualityRow.appendChild(qualLabel);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1'; slider.max = '100';
        slider.value = String(Math.round(imageQuality * 100));
        slider.id = 'bc-dl-quality-slider';
        Object.assign(slider.style, {
            width: '100%', accentColor: '#e63946',
            cursor: 'pointer', margin: '0',
        });

        slider.addEventListener('input', () => {
            const v = parseInt(slider.value, 10);
            imageQuality = v / 100;
            localStorage.setItem('bc-dl-quality', String(imageQuality));
            updateQualLabel();
        });

        qualityRow.appendChild(slider);
        overlay.appendChild(qualityRow);

        // ── Helpers ──
        function refreshImgFmtBtns() {
            document.querySelectorAll('.bc-dl-imgfmt-btn').forEach(b => {
                const active = b.dataset.imgfmt === imageFormat;
                b.style.background  = active ? '#e63946' : '#2a2a2a';
                b.style.color       = active ? '#fff'    : '#888';
                b.style.borderColor = active ? '#e63946' : '#555';
            });
        }

        function refreshQualityRow() {
            const row = document.getElementById('bc-dl-quality-row');
            if (row) row.style.display = imageFormat === 'png' ? 'none' : 'block';
        }

        function updateQualLabel() {
            const el = document.getElementById('bc-dl-q-val');
            const sl = document.getElementById('bc-dl-quality-slider');
            if (el && sl) el.textContent = sl.value + '%';
        }

        requestAnimationFrame(() => {
            refreshImgFmtBtns();
            updateQualLabel();
        });

        return overlay;
    }

    function makeSettingsLabel(html) {
        const el = document.createElement('div');
        el.innerHTML = html;
        Object.assign(el.style, {
            fontSize: '10px', color: '#666',
            marginTop: '6px', marginBottom: '2px',
        });
        return el;
    }

    // ── Main panel ───────────────────────────────────────────────────────
    function injectUI() {
        if (document.getElementById('bc-dl-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'bc-dl-panel';
        Object.assign(panel.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '99999',
            background: '#1a1a1a', color: '#fff',
            border: '1px solid #444', borderRadius: '10px',
            padding: '12px 14px', width: '210px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            fontFamily: 'sans-serif', fontSize: '12px',
            // settings overlay uses position:absolute inset:0 → clip to panel bounds
            overflow: 'hidden',
        });

        // ── Wrapper (normal flow content) ──
        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, { position: 'relative' });

        // ── Title row ──
        const titleRow = document.createElement('div');
        Object.assign(titleRow.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: '4px',
        });

        const titleText = document.createElement('span');
        titleText.textContent = '⬇ BigComics Downloader';
        Object.assign(titleText.style, {
            fontWeight: 'bold', fontSize: '13px', color: '#e63946',
        });

        const gearBtn = document.createElement('button');
        gearBtn.textContent = '⚙';
        gearBtn.title = 'Settings';
        Object.assign(gearBtn.style, {
            background: 'none', border: 'none',
            color: '#666', fontSize: '14px',
            cursor: 'pointer', padding: '0', lineHeight: '1',
            transition: 'color .15s',
        });
        gearBtn.addEventListener('mouseenter', () => { gearBtn.style.color = '#e63946'; });
        gearBtn.addEventListener('mouseleave', () => { gearBtn.style.color = '#666'; });

        titleRow.appendChild(titleText);
        titleRow.appendChild(gearBtn);

        // ── Status ──
        statusEl = document.createElement('div');
        statusEl.id = 'bc-dl-status';
        statusEl.textContent = 'Ready.';
        Object.assign(statusEl.style, {
            fontSize: '11px', color: '#aaa', marginBottom: '8px',
            minHeight: '28px', lineHeight: '1.4', wordBreak: 'break-word',
            marginTop: '8px',
        });

        const btnCurrent = makeBtn('bc-dl-current', '⬇ Download this chapter', onDownloadCurrent);

        // ── Settings overlay ──
        const settingsPanel = makeSettingsPanel();

        gearBtn.addEventListener('click', () => {
            const visible = settingsPanel.style.display !== 'none';
            settingsPanel.style.display = visible ? 'none' : 'block';
        });

        // ── Archive format toggle (main panel) ──
        const archLabel = document.createElement('div');
        archLabel.textContent = 'Archive format:';
        Object.assign(archLabel.style, {
            fontSize: '10px', color: '#666',
            marginTop: '10px', marginBottom: '2px',
        });

        wrapper.appendChild(titleRow);
        wrapper.appendChild(statusEl);
        wrapper.appendChild(btnCurrent);
        wrapper.appendChild(archLabel);
        wrapper.appendChild(makeArchiveToggle());

        panel.appendChild(settingsPanel);   // overlay sopra tutto, ancorato al panel
        panel.appendChild(wrapper);
        document.body.appendChild(panel);
    }

    const iv = setInterval(() => {
        if (document.querySelector('.-cv-nav, [class*="-cv-nav"]')) {
            injectUI();
            clearInterval(iv);
        }
    }, 500);
    setTimeout(() => {
        injectUI();
    }, 6000);

})();
