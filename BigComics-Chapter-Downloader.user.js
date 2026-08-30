// ==UserScript==
// @name         BigComics Chapter Downloader
// @namespace    https://bigcomics.jp/
// @version      6.4
// @description  Download BigComics chapters as ZIP or CBZ, with auto-detected metadata (embedded in images + ComicInfo.xml) and page-count verification
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
    const STUCK_LIMIT      = 7;    // rounds with genuinely no new pages = chapter end
    const FULLSCREEN_WAIT  = 1200; // ms to wait after entering fullscreen for canvas to resize
    const SETTLE_TIMEOUT   = 6000; // ms waitStableCanvases will wait for a round to settle
    const MAX_SAME_RETRIES = 4;    // extra in-place re-checks if a page looks unchanged (slow image load)
    const SAME_RETRY_WAIT  = 900;  // ms to wait between in-place re-checks
    const TIMEOUT_RETRIES  = 3;    // full waitStableCanvases timeouts to tolerate before accepting chapter end (network hiccups)
    const TIMEOUT_RETRY_WAIT = 2500; // ms to wait before retrying after a full stability timeout
    // ────────────────────────────────────────────────────────────────────

    // ── Preferences (persisted in localStorage) ─────────────────────────
    let outputFormat  = localStorage.getItem('bc-dl-format')   || 'zip';  // 'zip' | 'cbz'
    let imageFormat   = localStorage.getItem('bc-dl-imgfmt')   || 'png';  // 'png' | 'jpg' | 'webp'
    let imageQuality  = parseFloat(localStorage.getItem('bc-dl-quality') || '0.95'); // 0.01–1.0
    if (!isFinite(imageQuality) || imageQuality <= 0 || imageQuality > 1) imageQuality = 0.95; // guard against corrupt/legacy stored values

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // canvasKey uses PNG always (for dedup fingerprint regardless of output format).
    // Hashes the ENTIRE base64 string (FNV-1a) instead of a fixed middle slice —
    // a narrow slice can collide between different pages that share a similar
    // background region (e.g. flat-color panels), causing real pages to be
    // wrongly dropped as duplicates.
    function canvasKey(dataURL) {
        const b64 = dataURL.substring(22);
        let h = 0x811c9dc5;
        for (let i = 0; i < b64.length; i++) {
            h ^= b64.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16) + '_' + b64.length;
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
                // Full-content comparison (not just byte length): two different frames —
                // e.g. a loading placeholder vs. the real page — can coincidentally
                // encode to the same PNG length, which previously caused the script to
                // treat a half-rendered canvas as "stable" and capture it too early.
                const sig = cs.map(c => {
                    try { return c.toDataURL('image/png'); } catch(e) { return ''; }
                }).join('|');
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
        // Collect canvases that are at least partially on-screen.
        // Use rect.right > 0 && rect.left < vw (standard intersection test) instead of
        // left >= 0, because the right-hand canvas of an RTL spread can have a slightly
        // negative left edge due to viewer layout, causing it to be wrongly excluded.
        const vw = window.innerWidth;
        return all
            .filter(c => {
                const rect = c.getBoundingClientRect();
                return rect.right > 0 && rect.left < vw;
            })
            .sort((a, b) => {
                const ax = a.getBoundingClientRect().left;
                const bx = b.getBoundingClientRect().left;
                return bx - ax; // descending: rightmost first = RTL reading order
            });
    }

    // Best-effort detection of a "current / total" page counter in the viewer chrome.
    // Comici-style viewers commonly show one somewhere in the nav UI, but the exact
    // markup isn't guaranteed, so this only ever produces an advisory warning —
    // it never blocks or alters the download itself.
    function detectReportedTotalPages() {
        const scope = document.querySelectorAll('[class*="-cv"], [class*="pagenum"], [class*="page-num"], [class*="pager"]');
        let best = 0;
        for (const root of scope) {
            // Check leaf nodes first (counter as a single "27/53" text node) — the
            // common case. ALSO check every element's own concatenated textContent
            // with whitespace stripped: some viewers split the counter across two
            // sibling elements (e.g. a big "27" span + a small "/53" span, confirmed
            // via testing/screenshot), so no single leaf node ever contains the full
            // "N/M" string and the leaf-only check silently finds nothing. Restrict
            // to short concatenations (<=12 chars) to avoid false positives from
            // unrelated page text picked up by the broader selectors above.
            const nodes = root.children.length ? [...root.querySelectorAll('*')].filter(n => !n.children.length) : [root];
            for (const el of nodes) {
                const t = (el.textContent || '').trim();
                const m = t.match(/^(\d{1,4})\s*[\/／]\s*(\d{1,4})$/);
                if (m) {
                    const total = parseInt(m[2], 10);
                    if (total > best && total < MAX_PAGES) best = total;
                }
            }
            const candidates = [root, ...root.querySelectorAll('*')];
            for (const el of candidates) {
                const t = (el.textContent || '').replace(/\s+/g, '');
                if (t.length === 0 || t.length > 12) continue;
                const m = t.match(/^(\d{1,4})[\/／](\d{1,4})$/);
                if (m) {
                    const total = parseInt(m[2], 10);
                    if (total > best && total < MAX_PAGES) best = total;
                }
            }
        }
        return best || null;
    }

    function clickNext() {
        const nav = document.querySelector('.-cv-nav.mode-l, [class*="-cv-nav"][class*="mode-l"]');
        if (nav) { nav.click(); return; }
        const x = 30, y = window.innerHeight / 2;
        const el = document.elementFromPoint(x, y);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    }

    function isVisible(el) {
        return !!el && !!el.offsetParent && getComputedStyle(el).display !== 'none';
    }

    async function goToFirstPage() {
        setStatus('⏩ Going to first page...');
        const viewer = document.getElementById('comici-viewer');
        // RTL viewer: ArrowRight goes backward toward cover (page 1 = rightmost)
        for (let i = 0; i < 60; i++) {
            if (viewer && viewer.classList.contains('mode-first-page')) {
                console.log('[BigComics DL] Reached first page (mode-first-page).');
                break;
            }
            const modal = document.getElementById('xCVConfirmDialog');
            if (isVisible(modal)) {
                console.log('[BigComics DL] "Read previous chapter?" prompt detected — dismissing.');
                document.getElementById('xCVConfirmCancelButton')?.click();
                break;
            }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }));
            await sleep(80);
        }
        await sleep(1000);
    }

    // ── Cover image — reload with crossOrigin=anonymous to allow canvas export ─
    // NOTE: this selector sometimes grabs a promotional banner instead of the
    // real cover (confirmed via testing) — accepted trade-off per user request;
    // any wrong covers can be swapped out manually afterward.
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

    // ── Metadata embedding (Author / Publisher / Date) ──────────────────
    let metaEnabled       = localStorage.getItem('bc-dl-meta-enabled')       !== '0'; // on by default
    // These are OVERRIDES only — left empty, the real values are scraped straight off
    // the episode page at download time (see extractAuthorFromPage() and friends
    // below). The user no longer has to type anything in for normal use.
    let metaAuthorOverride    = localStorage.getItem('bc-dl-meta-author')    || '';
    let metaPublisherOverride = localStorage.getItem('bc-dl-meta-publisher') || '';
    let metaDateOverride      = localStorage.getItem('bc-dl-meta-date')      || ''; // 'YYYY-MM-DD'

    // ── Metadata auto-detection (scraped from the page, not typed by the user) ──

    // Author links are plain <a href="/authors/ID">Name(role)</a> tags, e.g.
    // <a href="https://bigcomics.jp/authors/941">青木潤太朗(原作)</a>
    // <a href="https://bigcomics.jp/authors/936">LAB(漫画)</a>
    // A chapter commonly credits MORE THAN ONE author (original story / art), each
    // with their role baked into the link text itself. Querying `a[href*="/authors/"]`
    // over the whole document ALSO picks up unrelated authors from the "recommended
    // for you" section further down the page (confirmed via testing) plus the
    // "作家一覧" (author list) link — so first narrow to the one specific credits
    // line, which is the only [class*="series"] element containing a role marker
    // like "(原作)"/"(漫画)", and only read author links inside that.
    function extractAuthorFromPage() {
        const seriesEls = [...document.querySelectorAll('[class*="series"]')];
        const matches = seriesEls.filter(el => /[（(][^（()）]*(原作|漫画|作画|原案)[）)]/.test(el.textContent));
        // Confirmed via testing: the real credits line sits in an element with a
        // "credit-user" class (e.g. class="series-h-credit-user", 2 authors only).
        // Other matches include ancestor wrappers (also containing the "recommended
        // for you" section) and unrelated recommended-manga credit lines, which can
        // be even shorter than ours on some pages — so prefer the credit-user class
        // by name first, and only fall back to "shortest textContent" (most specific
        // match) if that class isn't found.
        const creditsEl = matches.find(el => /credit[-_]?user/i.test(el.className))
            || matches.sort((a, b) => a.textContent.length - b.textContent.length)[0];
        const scope = creditsEl || document;

        const links = [...scope.querySelectorAll('a[href*="/authors/"]')]
            .filter(a => /\/authors\/\d+/.test(a.href)); // exclude "/authors/list" etc.
        const seen = new Set();
        const names = [];
        for (const a of links) {
            const t = a.textContent.trim();
            if (t.length < 1 || t.length > 40) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            names.push(t);
        }
        return names.join(', ');
    }

    // BigComics is Shogakukan's platform; every page's footer carries a
    // "© Shogakukan Inc. <year> All rights reserved." (or the Japanese equivalent)
    // notice. Extract it so the credit is accurate even if it ever changes, and
    // fall back to the known static publisher name otherwise.
    function extractPublisherFromPage() {
        const bodyText = document.body.innerText || '';
        const m = bodyText.match(/©\s*([^\d\n]+?)\s*\d{4}/);
        if (m && m[1].trim()) return m[1].trim();
        return '小学館 / Shogakukan';
    }

    // The current episode's own release date shows up as plain text either as
    // "2021/03/30" (chapter list rows) or "2026年6月26日" (printed directly under
    // the chapter title on the episode page itself). Try, in order:
    //   1. Match on the episode ID from the URL in the chapter list, so we read
    //      the date of the chapter actually being viewed, not some other one.
    //   2. A machine-readable <time> element on the page.
    //   3. A short standalone text node near the top of the page matching either
    //      date format — covers the "printed under the title" case above.
    const DATE_PATTERN = /(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/;

    function extractPublicationDate() {
        const id = getEpisodeId();
        if (id) {
            const links = [...document.querySelectorAll(`a[href*="/episodes/${id}"]`)];
            for (const a of links) {
                const m = (a.textContent || '').match(DATE_PATTERN);
                if (m) {
                    const [, y, mo, d] = m;
                    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
                }
            }
        }

        const timeEl = document.querySelector('time[datetime]');
        const dt = timeEl && timeEl.getAttribute('datetime');
        const m2 = dt && dt.match(/(\d{4}-\d{2}-\d{2})/);
        if (m2) return m2[1];

        // Best-effort scan of short leaf text nodes (a lone date string is short;
        // capped at 400 elements so this stays cheap even on a long page).
        const candidates = [...document.querySelectorAll('body *')]
            .filter(el => !el.children.length)
            .slice(0, 400);
        for (const el of candidates) {
            const t = (el.textContent || '').trim();
            if (t.length === 0 || t.length > 20) continue;
            const m = t.match(DATE_PATTERN);
            if (m) {
                const [, y, mo, d] = m;
                return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
            }
        }
        return '';
    }

    // Combines auto-detection with the (usually empty) manual override.
    function resolveMetadata() {
        return {
            author:    metaAuthorOverride    || extractAuthorFromPage(),
            publisher: metaPublisherOverride || extractPublisherFromPage(),
            date:      metaDateOverride      || extractPublicationDate(),
        };
    }

    function strToBytes(str) {
        // Latin-1 byte-per-char — safe subset for PNG tEXt / TIFF ASCII fields.
        // Non-Latin1 chars (e.g. Japanese) are dropped to keep the binary chunks valid;
        // put non-ASCII text (series/episode titles) in filenames instead, not metadata.
        return Array.from(str, ch => ch.charCodeAt(0) & 0xFF);
    }

    function crc32(bytes) {
        if (!crc32.table) {
            const t = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                t[n] = c >>> 0;
            }
            crc32.table = t;
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = crc32.table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function u32be(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }

    function utf8Bytes(str) {
        return Array.from(new TextEncoder().encode(str));
    }

    function buildPngITxtChunk(keyword, text) {
        // iTXt chunk (PNG spec §11.3.4.4): keyword stays Latin-1/ASCII (we only ever
        // pass ASCII keywords like "Author"), but the text itself is UTF-8 — unlike
        // tEXt, which is Latin-1 only and silently mangles non-Latin1 text (confirmed
        // via testing: Japanese author names came out as garbage bytes). Compression
        // flag/method = 0 (uncompressed), language tag and translated keyword both
        // left empty (allowed by spec).
        const data = [
            ...strToBytes(keyword), 0,   // keyword + null separator
            0,                             // compression flag = uncompressed
            0,                             // compression method
            0,                             // language tag (empty) + null separator
            0,                             // translated keyword (empty) + null separator
            ...utf8Bytes(text),
        ];
        const typeAndData = [0x69, 0x54, 0x58, 0x74, ...data]; // 'iTXt'
        const crc = crc32(new Uint8Array(typeAndData));
        return new Uint8Array([...u32be(data.length), ...typeAndData, ...u32be(crc)]);
    }

    // Inserts standard PNG iTXt chunks (Author, Copyright, Description, Creation Time)
    // right after IHDR, per the PNG spec's list of recognized keywords.
    function injectPngMetadata(bytes, fields) {
        if (bytes.length < 33 || bytes[0] !== 0x89) return bytes; // not a PNG, bail safely
        const ihdrLen = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
        const insertAt = 8 + 4 + 4 + ihdrLen + 4; // signature + len + type + data + crc
        const keywordMap = { description: 'Description', artist: 'Author', copyright: 'Copyright', dateTime: 'Creation Time' };
        const chunks = Object.entries(fields)
            .filter(([, v]) => v)
            .map(([k, v]) => buildPngITxtChunk(keywordMap[k] || k, v));
        if (chunks.length === 0) return bytes;
        const extra = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(bytes.length + extra);
        out.set(bytes.subarray(0, insertAt), 0);
        let off = insertAt;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        out.set(bytes.subarray(insertAt), off);
        return out;
    }

    function isPureAscii(str) {
        return /^[\x00-\x7F]*$/.test(str);
    }

    // UTF-16LE bytes with a 2-byte null terminator, for the Windows-specific
    // XP* tags below. Iterates by code point (not UTF-16 code unit) so surrogate
    // pairs for characters outside the BMP round-trip correctly.
    function utf16leBytesNullTerm(str) {
        const bytes = [];
        for (const ch of str) {
            const code = ch.codePointAt(0);
            if (code > 0xFFFF) {
                const c = code - 0x10000;
                const hi = 0xD800 + (c >> 10);
                const lo = 0xDC00 + (c & 0x3FF);
                bytes.push(hi & 0xFF, (hi >> 8) & 0xFF, lo & 0xFF, (lo >> 8) & 0xFF);
            } else {
                bytes.push(code & 0xFF, (code >> 8) & 0xFF);
            }
        }
        bytes.push(0, 0);
        return bytes;
    }

    // Builds a minimal valid TIFF/Exif blob (little-endian).
    // Reused for both JPEG (wrapped in an APP1 "Exif\0\0" segment) and WEBP (raw, in an EXIF chunk).
    //
    // Two tag families, since standard Exif string fields are ASCII-only (type 2)
    // and silently mangle non-Latin1 text (confirmed via testing: Japanese author
    // names came out as garbage bytes):
    //  - Standard ASCII tags (ImageDescription 0x010E, Artist 0x013B, Copyright
    //    0x8298, DateTime 0x0132) — only added when the value is pure ASCII, for
    //    compatibility with tools that only read the standard fields.
    //  - Windows-specific XP* tags (XPTitle 0x9C9B, XPAuthor 0x9C9D, XPComment
    //    0x9C9C), type 1 (BYTE) holding UTF-16LE text — these are what Windows
    //    Explorer's own Properties > Details tab actually reads for Title/Authors/
    //    Comments on JPEG, and they support the full Unicode range. Added whenever
    //    the field has a value, ASCII or not.
    function buildMinimalExifTiff(fields) {
        const asciiTagMap = [
            ['description', 0x010E],
            ['artist',      0x013B],
            ['copyright',   0x8298],
            ['dateTime',    0x0132],
        ];
        const xpTagMap = [
            ['description', 0x9C9B], // XPTitle
            ['artist',      0x9C9D], // XPAuthor
            ['copyright',   0x9C9C], // XPComment
        ];

        const entries = [];
        for (const [k, tag] of asciiTagMap) {
            if (fields[k] && isPureAscii(fields[k])) {
                entries.push({ tag, type: 2, bytes: strToBytes(fields[k] + '\0') });
            }
        }
        for (const [k, tag] of xpTagMap) {
            if (fields[k]) {
                entries.push({ tag, type: 1, bytes: utf16leBytesNullTerm(fields[k]) });
            }
        }
        if (entries.length === 0) return null;
        entries.sort((a, b) => a.tag - b.tag); // Exif IFD entries must be in ascending tag order

        const ifdOffset = 8;
        const ifdSize = 2 + entries.length * 12 + 4;
        let dataOffset = ifdOffset + ifdSize;

        const items = entries.map(e => {
            const inline = e.bytes.length <= 4;
            const off = inline ? 0 : dataOffset;
            if (!inline) dataOffset += e.bytes.length + (e.bytes.length % 2); // word-align
            return { ...e, inline, off };
        });

        const buf = new Uint8Array(dataOffset);
        const dv = new DataView(buf.buffer);
        buf[0] = 0x49; buf[1] = 0x49; // 'II' little-endian
        dv.setUint16(2, 42, true);
        dv.setUint32(4, ifdOffset, true);
        dv.setUint16(ifdOffset, entries.length, true);

        let p = ifdOffset + 2;
        for (const e of items) {
            dv.setUint16(p, e.tag, true);
            dv.setUint16(p + 2, e.type, true);
            dv.setUint32(p + 4, e.bytes.length, true); // count, incl. null terminator
            if (e.inline) buf.set(e.bytes, p + 8);
            else { dv.setUint32(p + 8, e.off, true); buf.set(e.bytes, e.off); }
            p += 12;
        }
        dv.setUint32(p, 0, true); // next IFD offset = 0
        return buf;
    }

    function injectJpegExif(bytes, exifTiff) {
        if (!exifTiff || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
        const prefix = strToBytes('Exif\0\0');
        const segLen = 2 + prefix.length + exifTiff.length;
        const app1 = new Uint8Array(2 + 2 + prefix.length + exifTiff.length);
        app1.set([0xFF, 0xE1], 0);
        app1.set([(segLen >>> 8) & 0xFF, segLen & 0xFF], 2);
        app1.set(prefix, 4);
        app1.set(exifTiff, 4 + prefix.length);

        const out = new Uint8Array(2 + app1.length + (bytes.length - 2));
        out.set(bytes.subarray(0, 2), 0);              // SOI
        out.set(app1, 2);                                // APP1/Exif
        out.set(bytes.subarray(2), 2 + app1.length);     // rest of the JPEG
        return out;
    }

    function injectWebpExif(bytes, exifTiff, width, height) {
        if (!exifTiff || bytes.length < 16) return bytes;
        const sig = String.fromCharCode(...bytes.subarray(0, 4));
        const wp  = String.fromCharCode(...bytes.subarray(8, 12));
        if (sig !== 'RIFF' || wp !== 'WEBP') return bytes;

        const pad = n => n % 2 === 0 ? n : n + 1;
        const riffChunk = (fourCC, data) => {
            const out = new Uint8Array(8 + pad(data.length));
            out.set(strToBytes(fourCC), 0);
            new DataView(out.buffer).setUint32(4, data.length, true);
            out.set(data, 8);
            return out;
        };

        const fourcc = String.fromCharCode(...bytes.subarray(12, 16));
        if (fourcc === 'VP8X') {
            const out = bytes.slice();
            out[20] |= 0x08; // set Exif flag bit
            const exifChunk = riffChunk('EXIF', exifTiff);
            const combined = new Uint8Array(out.length + exifChunk.length);
            combined.set(out, 0);
            combined.set(exifChunk, out.length);
            new DataView(combined.buffer).setUint32(4, combined.length - 8, true);
            return combined;
        }

        // Simple lossy/lossless format → wrap into an extended (VP8X) container.
        const origChunk = bytes.subarray(12); // fourcc+size+data(+pad) through EOF
        const vp8xData = new Uint8Array(10);
        vp8xData[0] = 0x08; // Exif flag set
        const w1 = width - 1, h1 = height - 1;
        vp8xData[4] = w1 & 0xFF; vp8xData[5] = (w1 >> 8) & 0xFF; vp8xData[6] = (w1 >> 16) & 0xFF;
        vp8xData[7] = h1 & 0xFF; vp8xData[8] = (h1 >> 8) & 0xFF; vp8xData[9] = (h1 >> 16) & 0xFF;
        const vp8xChunk = riffChunk('VP8X', vp8xData);
        const exifChunk = riffChunk('EXIF', exifTiff);

        const payload = new Uint8Array(4 + vp8xChunk.length + origChunk.length + exifChunk.length);
        let off = 0;
        payload.set(strToBytes('WEBP'), off); off += 4;
        payload.set(vp8xChunk, off); off += vp8xChunk.length;
        payload.set(origChunk, off); off += origChunk.length;
        payload.set(exifChunk, off); off += exifChunk.length;

        const out = new Uint8Array(8 + payload.length);
        out.set(strToBytes('RIFF'), 0);
        new DataView(out.buffer).setUint32(4, payload.length, true);
        out.set(payload, 8);
        return out;
    }

    function getImageDims(dataURL) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 0, h: 0 });
            img.src = dataURL;
        });
    }

    function extFromDataURL(dataURL) {
        const m = dataURL.match(/^data:image\/(\w+);/);
        if (!m) return imgExt();
        const t = m[1].toLowerCase();
        if (t === 'jpeg') return 'jpg';
        if (t === 'webp') return 'webp';
        return 'png';
    }

    // Splits an author string like "青木潤太朗(原作), LAB(漫画)" (the format
    // extractAuthorFromPage() produces) into story credit (原作/原案 →
    // ComicInfo's Writer) and art credit (漫画/作画 → Penciller). A name with
    // an unrecognized or missing role falls back into Writer — this also
    // covers a manual override typed as a plain name with no role at all.
    function splitAuthorsByRole(authorString) {
        if (!authorString) return { writer: '', penciller: '' };
        const writer = [], penciller = [];
        const re = /([^,]+?)\(([^)]*)\)/g;
        let m, matchedAny = false;
        while ((m = re.exec(authorString))) {
            matchedAny = true;
            const name = m[1].trim();
            const role = m[2];
            if (/漫画|作画/.test(role)) penciller.push(name);
            else writer.push(name); // 原作/原案/unrecognized role → Writer
        }
        if (!matchedAny) return { writer: authorString.trim(), penciller: '' };
        return { writer: writer.join(', '), penciller: penciller.join(', ') };
    }

    // Short synopsis, when the page provides one. Best-effort only — many
    // episode pages don't carry a per-chapter summary, in which case this
    // stays empty and <Summary> is simply omitted from ComicInfo.xml.
    function extractSummaryFromPage() {
        const og = document.querySelector('meta[property="og:description"]')?.content?.trim();
        if (og) return og;
        return document.querySelector('meta[name="description"]')?.content?.trim() || '';
    }

    function xmlEscape(str) {
        return String(str).replace(/[&<>'"]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;',
        }[c]));
    }

    // Best-effort chapter number extraction from the episode title, e.g.
    // "第2話 サブタイトル" → "2", "第12.5話" → "12.5". Left empty (and the
    // <Number> tag omitted) if the title doesn't follow this pattern —
    // ComicInfo's <Number> is optional and readers handle its absence fine.
    function extractEpisodeNumber(episodeTitle) {
        const m = episodeTitle.match(/第\s*(\d+(?:\.\d+)?)\s*話/);
        return m ? m[1] : '';
    }

    // Builds a ComicInfo.xml (ComicRack/Anansi schema, read by ComicRack,
    // Komga, Kavita, YACReader, CDisplayEx, etc.) describing the chapter at
    // the archive level. This is also the only practical way to see title/
    // author/publisher/date on Windows WITHOUT running a script: Explorer's
    // own Properties > Details tab doesn't read PNG text chunks at all, and
    // only surfaces a handful of the JPEG EXIF fields the per-image metadata
    // above writes. Only fields with a non-empty value are emitted.
    function buildComicInfoXml({ series, title, number, writer, penciller, publisher, date, pageCount, summary, web, notes }) {
        let year = '', month = '', day = '';
        const m = date && date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) { year = m[1]; month = String(parseInt(m[2], 10)); day = String(parseInt(m[3], 10)); }

        const fields = [
            ['Title', title],
            ['Series', series],
            ['Number', number],
            ['Summary', summary],
            ['Notes', notes],
            ['Writer', writer],
            ['Penciller', penciller],
            ['Publisher', publisher],
            ['Year', year],
            ['Month', month],
            ['Day', day],
            ['LanguageISO', 'ja'],
            ['Manga', 'YesAndRightToLeft'], // pages are collected/ordered RTL — see buildArchive
            ['PageCount', String(pageCount)],
            ['Web', web],
        ].filter(([, v]) => v !== '' && v != null);

        const body = fields.map(([k, v]) => `  <${k}>${xmlEscape(v)}</${k}>`).join('\n');
        return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${body}\n</ComicInfo>\n`;
    }

    async function buildArchive(pages, mismatchInfo) {
        const zip = new JSZip();
        const seriesTitle = sanitize(getSeriesTitle());
        const episodeTitle = sanitize(getEpisodeTitle());
        const folderName = `${seriesTitle} - ${episodeTitle}`;
        const folder = zip.folder(folderName);

        // Auto-detected from the page (extractAuthorFromPage/extractPublisherFromPage/
        // extractPublicationDate), with the settings-panel fields only ever acting as
        // an optional manual override — see resolveMetadata(). Previously this read
        // from metaAuthor/metaPublisher/metaDate, three globals that were never
        // declared anywhere, so with 'use strict' this threw a ReferenceError and
        // broke every download that had metadata embedding enabled (the default).
        const resolved = metaEnabled ? resolveMetadata() : { author: '', publisher: '', date: '' };
        const metaFields = metaEnabled ? {
            description: `${seriesTitle} - ${episodeTitle}`,
            artist: resolved.author,
            copyright: resolved.publisher,
            dateTime: resolved.date ? resolved.date.replace(/-/g, ':') + ' 00:00:00' : '',
        } : {};
        const hasAnyMeta = metaEnabled && Object.values(metaFields).some(v => v);
        const exifTiff = hasAnyMeta ? buildMinimalExifTiff(metaFields) : null;

        // ComicInfo.xml at the archive root, alongside the pages. Title/Series/
        // PageCount are always available; Writer/Publisher/date only when
        // metadata embedding is on (same toggle as the per-image metadata above).
        // PageCount always reflects the REAL number of pages saved in this archive
        // (not the viewer's own counter, which can include promo slides we skip —
        // see mismatchInfo below). When the collection stopped on an ambiguous
        // condition (stability timeout / stuck limit) with fewer pages than the
        // viewer reported, that's recorded in <Notes> too, so it's visible from
        // inside a comic reader later on — not just in the browser console at
        // download time.
        if (metaEnabled) {
            const { writer, penciller } = splitAuthorsByRole(resolved.author);
            const notes = mismatchInfo
                ? `Possibly incomplete: BigComics viewer reported ${mismatchInfo.reportedTotal} pages, ${pages.length} were captured (BigComics Chapter Downloader).`
                : '';
            const comicInfoXml = buildComicInfoXml({
                series: seriesTitle,
                title: episodeTitle,
                number: extractEpisodeNumber(episodeTitle),
                writer,
                penciller,
                publisher: resolved.publisher,
                date: resolved.date,
                pageCount: pages.length,
                summary: extractSummaryFromPage(),
                web: location.href,
                notes,
            });
            folder.file('ComicInfo.xml', comicInfoXml);
        }

        // Pages are in RTL reading order: index 0 = cover, last = final page.
        // "<folder>_001.ext" = cover, "<folder>_002.ext" = page 2, etc. — correct
        // for both ZIP and CBZ. CBZ readers should be set to RTL/manga mode.
        // Extension is derived per-page from the actual dataURL mime type: the
        // cover is always JPEG (see loadCoverFromUrl) regardless of the chosen
        // output format, so a single global extension would mislabel it.
        for (let i = 0; i < pages.length; i++) {
            const dataURL = pages[i];
            const pageExt = extFromDataURL(dataURL);
            const b64 = dataURL.split(',')[1];
            const bin = atob(b64);
            let arr = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);

            if (hasAnyMeta) {
                if (pageExt === 'png') {
                    arr = injectPngMetadata(arr, metaFields);
                } else if (pageExt === 'jpg') {
                    arr = injectJpegExif(arr, exifTiff);
                } else if (pageExt === 'webp') {
                    const { w, h } = await getImageDims(dataURL);
                    if (w > 0 && h > 0) arr = injectWebpExif(arr, exifTiff, w, h);
                }
            }

            folder.file(`${folderName}_${String(i + 1).padStart(3, '0')}.${pageExt}`, arr);
        }

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
    // Some transitions may momentarily show mode-pr-page while the viewer's
    // preload buffer is preparing the promo slide, before it's actually the
    // displayed page. Require the class to persist across a short re-check
    // before trusting it, to avoid stopping too early.
    async function isConfirmedPromoPage(viewer) {
        if (!viewer || !viewer.classList.contains('mode-pr-page')) return false;
        await sleep(350);
        return viewer.classList.contains('mode-pr-page');
    }

    let cancelRequested = false;

    async function downloadChapter() {
        try {
            return await downloadChapterInner();
        } finally {
            // Always restore browser chrome, even if collection threw partway through.
            if (document.fullscreenElement) {
                try { await document.exitFullscreen(); } catch(e) { /* ignore */ }
            }
        }
    }

    async function downloadChapterInner() {
        const startId = getEpisodeId();
        const viewer = document.getElementById('comici-viewer');

        // ① Ensure fullscreen BEFORE going to first page
        await ensureFullscreen();

        await goToFirstPage();

        if (getEpisodeId() !== startId) {
            throw new Error('Chapter changed during navigation, aborting.');
        }

        const collected = new Map();
        let stuckCount = 0;
        let clicks = 0;
        let prevRoundSig = null; // full-content signature of the last round's canvases
        let timeoutRetries = 0;  // full waitStableCanvases timeouts tolerated in a row (network hiccups)
        let stopReason = null;   // why the loop ended — used below to decide whether the page-count warning is meaningful

        while (clicks < MAX_PAGES) {
            if (cancelRequested) {
                console.log(`[BigComics DL] STOP REASON: cancelled by user at click ${clicks}, ${collected.size} pages collected.`);
                stopReason = 'cancelled';
                break;
            }

            if (getEpisodeId() !== startId) {
                console.log(`[BigComics DL] STOP REASON: chapter/episode changed mid-loop at click ${clicks}, ${collected.size} pages collected.`);
                stopReason = 'chapter-changed';
                break;
            }

            // The viewer tags promotional/ad slides (sign-up banners, mailing-list
            // ads, etc. shown after the real chapter content) with mode-pr-page.
            // Stop BEFORE collecting these — the in-viewer page counter includes
            // them in its total, so it can't be used as a stop condition on its own.
            if (await isConfirmedPromoPage(viewer)) {
                console.log(`[BigComics DL] STOP REASON: promotional page confirmed at click ${clicks}, ${collected.size} pages collected.`);
                stopReason = 'promo';
                break;
            }

            // Wait for the round to settle, then — if its content is identical to the
            // previous round's — retry in place a few times before giving up. A slow
            // image load can otherwise look exactly like "no new page", causing a real
            // page to be silently skipped once clickNext() moves the viewer past it.
            let canvases = null;
            let sig = null;
            for (let attempt = 0; attempt <= MAX_SAME_RETRIES; attempt++) {
                try {
                    canvases = await waitStableCanvases(2, SETTLE_TIMEOUT);
                } catch(e) {
                    canvases = null;
                    break;
                }
                sig = canvases.map(c => {
                    try { return c.toDataURL('image/png'); } catch(e) { return ''; }
                }).join('|');

                if (sig !== prevRoundSig || attempt === MAX_SAME_RETRIES) break;

                console.log(`[BigComics DL] click ${clicks}: content unchanged from previous round — likely still loading, retrying in place (${attempt + 1}/${MAX_SAME_RETRIES})`);
                await sleep(SAME_RETRY_WAIT);
                if (cancelRequested || getEpisodeId() !== startId) break;
            }

            if (!canvases) {
                // A full stability timeout (not a single "content unchanged" round —
                // see MAX_SAME_RETRIES above — but NO canvas ever stabilizing at all)
                // is ambiguous: it can mean either a genuine end of chapter OR just a
                // slow network hiccup on one particular page. Confirmed via a real
                // capture: this used to be treated as an immediate, unconditional
                // "chapter end", silently truncating the download partway through
                // (e.g. stopped at 25/53 real pages). Tolerate a few full retries
                // with a longer pause before actually giving up.
                if (timeoutRetries < TIMEOUT_RETRIES && !cancelRequested && getEpisodeId() === startId) {
                    timeoutRetries++;
                    console.log(`[BigComics DL] click ${clicks}: full stability timeout — retrying (${timeoutRetries}/${TIMEOUT_RETRIES}), possible slow page load.`);
                    setStatus(`⏳ Slow page load, retrying (${timeoutRetries}/${TIMEOUT_RETRIES})...`);
                    await sleep(TIMEOUT_RETRY_WAIT);
                    continue; // stay at the same click position, don't advance/give up yet
                }
                console.log(`[BigComics DL] STOP REASON: waitStableCanvases timeout at click ${clicks}, ${collected.size} pages collected — treated as chapter end.`);
                stopReason = 'timeout';
                break;
            }
            timeoutRetries = 0; // reset once a round succeeds again
            if (cancelRequested || getEpisodeId() !== startId) continue; // let the top-of-loop checks handle the stop

            prevRoundSig = sig;

            // Re-check after the canvases settle, in case the promo page just loaded.
            if (await isConfirmedPromoPage(viewer)) {
                console.log(`[BigComics DL] STOP REASON: promotional page confirmed (post-stabilize) at click ${clicks}, ${collected.size} pages collected.`);
                stopReason = 'promo';
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
                if (stuckCount >= STUCK_LIMIT) {
                    console.log(`[BigComics DL] STOP REASON: stuck limit (${STUCK_LIMIT} rounds, no new pages even after in-place retries) at click ${clicks}, ${collected.size} pages collected.`);
                    stopReason = 'stuck';
                    break;
                }
            } else {
                stuckCount = 0;
            }

            clickNext();
            clicks++;
            await sleep(AFTER_CLICK_WAIT);
        }
        if (!stopReason) stopReason = 'max-pages'; // loop exhausted MAX_PAGES without any break above

        if (collected.size === 0) throw new Error('No pages collected.');

        // Advisory-only cross-check against whatever page counter the viewer chrome
        // exposes. This can't be guaranteed to match 1:1 (it may or may not include
        // the cover / promo slides), so it's surfaced as a warning, not a hard error —
        // and ONLY when the stop itself was ambiguous. A confirmed promo-page stop
        // ('promo') is expected to fall short of the viewer's own total, since that
        // total includes the promotional slides we deliberately don't save (confirmed
        // via a real capture: 53 reported vs. 47 real pages + cover, entirely correct,
        // yet the old unconditional check still flagged it as "possibly incomplete").
        const reportedTotal = detectReportedTotalPages();
        const ambiguousStop = stopReason === 'timeout' || stopReason === 'stuck' || stopReason === 'max-pages';
        const mismatchInfo = (ambiguousStop && reportedTotal && reportedTotal > collected.size)
            ? { reportedTotal }
            : null;
        if (mismatchInfo) {
            console.warn(`[BigComics DL] Possible missing pages: viewer reports ${reportedTotal}, collected ${collected.size} (stop reason: ${stopReason}).`);
            setStatus(`⚠️ Possibile capitolo incompleto: il viewer indica ${reportedTotal} pagine, ne sono state raccolte ${collected.size}.`);
            await sleep(2500); // let the warning be visible before the next status overwrites it
        }

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

        const { blob, folderName } = await buildArchive(pages, mismatchInfo);
        return {
            blob, folderName, pages: pages.length,
            pageMismatch: mismatchInfo ? mismatchInfo.reportedTotal : null,
        };
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
        cancelRequested = false;
        lockUI();
        try {
            const { blob, folderName, pages, pageMismatch } = await downloadChapter();
            if (cancelRequested) {
                setStatus(`⏹ Cancelled — ${pages} pages collected, nothing saved.`);
                return;
            }
            triggerDownload(blob, `${folderName}.${archiveExt()}`);
            if (pageMismatch) {
                setStatus(`⚠️ Done, but the viewer reports ${pageMismatch} pages and only ${pages} were saved — check the chapter manually. → ${folderName}.${archiveExt()}`);
            } else {
                setStatus(`✅ Done! ${pages} pages → ${folderName}.${archiveExt()}`);
            }
        } catch(err) {
            console.error('[BigComics DL]', err);
            setStatus('❌ Error: ' + String(err));
        } finally {
            unlockUI();
        }
    }

    // ── UI ──────────────────────────────────────────────────────────────

    // Non-primary buttons (format toggles, gear icon) get disabled during a run;
    // the main download button instead turns into a Cancel control, since the
    // user has no other way to stop a long chapter mid-collection.
    function lockUI() {
        document.querySelectorAll('.bc-dl-action').forEach(b => {
            if (b.id === 'bc-dl-current') return;
            b.disabled = true;
            b.style.opacity = '0.5';
            b.style.cursor = 'default';
        });
        const main = document.getElementById('bc-dl-current');
        if (main) {
            main.dataset.originalLabel = main.textContent;
            main.textContent = '✕ Cancel';
            main.style.background = '#555';
        }
    }

    function unlockUI() {
        document.querySelectorAll('.bc-dl-action').forEach(b => {
            b.disabled = false;
            b.style.opacity = '1';
            b.style.cursor = 'pointer';
        });
        const main = document.getElementById('bc-dl-current');
        if (main) {
            main.textContent = main.dataset.originalLabel || '⬇ Download this chapter';
            main.style.background = '#e63946';
        }
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
        btn.addEventListener('click', () => {
            // While a download is running, this same button acts as Cancel.
            if (btn.id === 'bc-dl-current' && btn.textContent === '✕ Cancel') {
                cancelRequested = true;
                setStatus('⏹ Cancelling — finishing current page...');
                return;
            }
            handler();
        });
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

        // ── Metadata section ──
        overlay.appendChild(makeSettingsLabel('Metadata:'));

        const metaToggleRow = document.createElement('label');
        Object.assign(metaToggleRow.style, {
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: '#ccc', marginTop: '2px', cursor: 'pointer',
        });
        const metaToggle = document.createElement('input');
        metaToggle.type = 'checkbox';
        metaToggle.checked = metaEnabled;
        metaToggle.addEventListener('change', () => {
            metaEnabled = metaToggle.checked;
            localStorage.setItem('bc-dl-meta-enabled', metaEnabled ? '1' : '0');
        });
        metaToggleRow.appendChild(metaToggle);
        metaToggleRow.appendChild(document.createTextNode('Embed in images (Author/Publisher/Date)'));
        overlay.appendChild(metaToggleRow);

        // Author/Publisher/Date are auto-detected straight off the episode page
        // (see resolveMetadata()) — nothing below is required for normal use.
        // These three fields are manual OVERRIDES only, for the rare case the
        // page's own data is wrong or missing; leave them empty to keep auto-detect.
        overlay.appendChild(makeSettingsLabel('Detected (auto):'));
        const detectedPreview = document.createElement('div');
        detectedPreview.id = 'bc-dl-meta-preview';
        Object.assign(detectedPreview.style, {
            fontSize: '10px', color: '#999', lineHeight: '1.5',
            marginBottom: '4px', wordBreak: 'break-word',
        });
        overlay.appendChild(detectedPreview);

        function refreshDetectedPreview() {
            if (!detectedPreview.isConnected) return;
            try {
                const d = resolveMetadata();
                detectedPreview.textContent =
                    `Author: ${d.author || '—'} | Publisher: ${d.publisher || '—'} | Date: ${d.date || '—'}`;
            } catch (e) {
                detectedPreview.textContent = 'Author: — | Publisher: — | Date: —';
            }
        }
        // Re-scanned every time the settings overlay is opened — see gearBtn's
        // click handler below, which calls window._bcDlRefreshMetaPreview().
        requestAnimationFrame(refreshDetectedPreview);
        window._bcDlRefreshMetaPreview = refreshDetectedPreview; // hook so gearBtn can call it directly

        overlay.appendChild(makeSettingsLabel('Manual override (leave empty to auto-detect):'));

        function makeMetaInput(placeholder, value, type, onInput) {
            const input = document.createElement('input');
            input.type = type;
            input.placeholder = placeholder;
            input.value = value;
            Object.assign(input.style, {
                width: '100%', boxSizing: 'border-box',
                marginTop: '6px', padding: '5px 6px',
                background: '#2a2a2a', color: '#fff',
                border: '1px solid #555', borderRadius: '5px',
                fontSize: '11px',
            });
            input.addEventListener('input', () => onInput(input.value));
            return input;
        }

        overlay.appendChild(makeMetaInput('Author override', metaAuthorOverride, 'text', (v) => {
            metaAuthorOverride = v;
            localStorage.setItem('bc-dl-meta-author', v);
        }));
        overlay.appendChild(makeMetaInput('Publisher override', metaPublisherOverride, 'text', (v) => {
            metaPublisherOverride = v;
            localStorage.setItem('bc-dl-meta-publisher', v);
        }));
        overlay.appendChild(makeMetaInput('Publication date override', metaDateOverride, 'date', (v) => {
            metaDateOverride = v;
            localStorage.setItem('bc-dl-meta-date', v);
        }));

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
            if (!visible && typeof window._bcDlRefreshMetaPreview === 'function') {
                window._bcDlRefreshMetaPreview(); // re-scan the page each time the panel opens
            }
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

    // ── Debug hook — lets you call these from the F12 console for verification,
    // since everything above lives inside this IIFE and isn't otherwise reachable
    // from outside the script (e.g. `window.__bcDlDebug.resolveMetadata()`).
    window.__bcDlDebug = {
        extractAuthorFromPage,
        extractPublisherFromPage,
        extractPublicationDate,
        resolveMetadata,
        getSeriesTitle,
        getEpisodeTitle,
        extractEpisodeNumber,
        splitAuthorsByRole,
        extractSummaryFromPage,
    };

})();
