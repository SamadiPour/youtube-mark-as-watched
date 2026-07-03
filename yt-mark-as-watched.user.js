// ==UserScript==
// @name         YouTube Mark as Watched
// @description  Adds a hover button on video thumbnails to mark the video as fully watched
// @namespace    https://github.com/SamadiPour/youtube-mark-as-watched
// @author       Amir Hossein SamadiPour
// @version      1.3.0
// @license      GNU General Public License v3.0
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Thumbnail link variants across YouTube surfaces:
  //  - a.ytLockupViewModelContentImage        → current lockup view model (home, search, watch sidebar)
  //  - a.yt-lockup-view-model__content-image  → previous lockup class naming
  //  - a#thumbnail                            → legacy ytd-* renderers (channels, playlists, subscriptions)
  const THUMB_SELECTOR = [
    'a.ytLockupViewModelContentImage[href*="/watch?v="]',
    'a.yt-lockup-view-model__content-image[href*="/watch?v="]',
    'a#thumbnail[href*="/watch?v="]',
  ].join(', ');

  const OVERLAY_CLASS = 'maw-overlay';

  // ---------------------------------------------------------------------------
  // Global CSS — overlay visibility is pure :hover, no JS show/hide needed
  // ---------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .${OVERLAY_CLASS} {
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 100;
      display: none;
    }
    :hover > .${OVERLAY_CLASS} {
      display: flex;
    }
    .${OVERLAY_CLASS}.maw-hidden {
      display: none !important;
    }
    .${OVERLAY_CLASS} button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 4px;
      box-sizing: border-box;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      cursor: pointer;
    }
    .${OVERLAY_CLASS} button:not(:disabled):hover {
      background: rgba(0, 0, 0, 0.85);
    }
    .${OVERLAY_CLASS} button:disabled {
      cursor: default;
    }
    .${OVERLAY_CLASS} svg {
      display: block;
      width: 100%;
      height: 100%;
      fill: currentColor;
      pointer-events: none;
    }
    .${OVERLAY_CLASS}.maw-done button { color: #22c55e; }
    .${OVERLAY_CLASS}.maw-err button  { color: #ef4444; }
    .maw-spinner {
      animation: maw-spin 0.9s linear infinite;
      transform-origin: center;
    }
    @keyframes maw-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  function getCookie(name) {
    return document.cookie.split('; ').reduce((val, part) => {
      const [k, ...v] = part.split('=');
      return k === name ? v.join('=') : val;
    }, null);
  }

  async function computeSAPISIDHASH() {
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const msg = `${ts} ${sapisid} https://www.youtube.com`;
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg));
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  function generateCPN() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => chars[b % chars.length]).join('');
  }

  // ---------------------------------------------------------------------------
  // Core: fetch tracking URL then fire the playback-complete ping
  // ---------------------------------------------------------------------------

  async function fetchPlaybackUrl(videoId) {
    // Fetch the watch page and extract from embedded ytInitialPlayerResponse JSON
    const resp = await fetch(`/watch?v=${videoId}`, {credentials: 'include'});
    if (!resp.ok) return null;
    const html = await resp.text();

    // Handle JSON escape sequences (e.g. \u0026 for &, \/ for /)
    const m = html.match(/"videostatsPlaybackUrl":\{"baseUrl":"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch {
      return null;
    }
  }

  async function markAsWatched(videoId) {
    const baseUrl = await fetchPlaybackUrl(videoId);
    if (!baseUrl) throw new Error('Could not get tracking URL — watch page parse failed');

    // Normalize to www.youtube.com (same-origin, no CORS restrictions, cookies auto-sent)
    const urlObj = new URL(baseUrl.replace(/^https:\/\/s\.youtube\.com\//, 'https://www.youtube.com/'));

    // len = current playback position in YouTube's stats API
    urlObj.searchParams.delete('len');

    const statsUrl = `${urlObj.toString()}&ver=2&cpn=${generateCPN()}&final=1`;
    const headers = {
      'x-goog-authuser': '0',
      'x-origin': `https://www.youtube.com/watch?v=${videoId}`,
    };

    const auth = await computeSAPISIDHASH();
    if (auth) headers['authorization'] = auth;

    const visitorData = window.ytcfg?.data_?.VISITOR_DATA
      || window.ytInitialData?.responseContext?.visitorData;
    if (visitorData) headers['x-goog-visitor-id'] = visitorData;

    await fetch(statsUrl, {credentials: 'include', headers});
  }

  // ---------------------------------------------------------------------------
  // Thumbnail watched-state helpers
  // ---------------------------------------------------------------------------

  function getVideoIdFromUrl(url) {
    return url.match(/[?&]v=([\w-]{11})/)?.[1] || null;
  }

  function getThumbnailRoot(thumbAnchor) {
    return thumbAnchor.querySelector('ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost')
      || thumbAnchor.closest('ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost')
      || thumbAnchor;
  }

  function isThumbnailWatched(thumbAnchor) {
    const root = getThumbnailRoot(thumbAnchor);
    const progress = root.querySelector('#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment');
    if (!progress?.style?.width) return false;

    const width = Number.parseFloat(progress.style.width.replace('%', ''));
    return Number.isFinite(width) && width >= 100;
  }

  // Paint a full watched-progress bar on the thumbnail, matching YouTube's own markup
  function markThumbnailDone(thumbAnchor) {
    const root = getThumbnailRoot(thumbAnchor);

    // Case 1: a progress bar already exists (partially watched) — stretch it
    const progressBars = root.querySelectorAll('#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment');
    if (progressBars.length) {
      progressBars.forEach((progress) => {
        progress.style.width = '100%';
      });
      return;
    }

    // Case 2: lockup markup with an (empty) progress host — fill in the bar
    const progressHost = root.querySelector('yt-thumbnail-overlay-progress-bar-view-model, .ytThumbnailOverlayProgressBarHost');
    if (progressHost) {
      let watchedBar = progressHost.querySelector('.ytThumbnailOverlayProgressBarHostWatchedProgressBar');
      if (!watchedBar) {
        watchedBar = document.createElement('div');
        watchedBar.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBar ytThumbnailOverlayProgressBarHostUseLegacyBar';
        progressHost.appendChild(watchedBar);
      }

      let watchedSegment = watchedBar.querySelector('.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment');
      if (!watchedSegment) {
        watchedSegment = document.createElement('div');
        watchedSegment.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment';
        watchedBar.appendChild(watchedSegment);
      }

      watchedSegment.style.width = '100%';
      return;
    }

    // Case 3: lockup markup without any progress host — build one
    const bottomOverlayHost = root.querySelector('yt-thumbnail-bottom-overlay-view-model, .ytThumbnailBottomOverlayViewModelHost');
    if (bottomOverlayHost) {
      const newProgressHost = document.createElement('yt-thumbnail-overlay-progress-bar-view-model');
      newProgressHost.className = 'ytThumbnailOverlayProgressBarHost ytThumbnailOverlayProgressBarHostLarge';

      const watchedBar = document.createElement('div');
      watchedBar.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBar ytThumbnailOverlayProgressBarHostUseLegacyBar';

      const watchedSegment = document.createElement('div');
      watchedSegment.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment';
      watchedSegment.style.width = '100%';

      watchedBar.appendChild(watchedSegment);
      newProgressHost.appendChild(watchedBar);
      bottomOverlayHost.before(newProgressHost);
      return;
    }

    // Case 4: legacy ytd-thumbnail markup — build the resume-playback overlay
    const overlays = root.querySelector('#overlays');
    if (overlays && !overlays.querySelector('#progress')) {
      const bar = document.createElement('div');
      bar.className = 'style-scope ytd-thumbnail';
      Object.assign(bar.style, {
        display: 'block', position: 'absolute',
        bottom: '0', right: '0', left: '0',
        height: '4px', backgroundColor: 'var(--yt-spec-text-disabled)', zIndex: '1',
      });
      const progressBar = document.createElement('div');
      progressBar.id = 'progress';
      progressBar.className = 'style-scope ytd-thumbnail-overlay-resume-playback-renderer';
      progressBar.style.width = '100%';

      bar.appendChild(progressBar);
      overlays.appendChild(bar);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay button
  // ---------------------------------------------------------------------------

  // SVG built via DOM API — youtube.com enforces Trusted Types, innerHTML would throw
  function setIcon(iconHost, state) {
    const paths = {
      idle: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
      done: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
      loading: 'M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2z',
      error: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
    };

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (state === 'loading') svg.setAttribute('class', 'maw-spinner');

    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', paths[state] || paths.idle);
    svg.appendChild(path);
    iconHost.replaceChildren(svg);
  }

  async function onMarkClick(thumbAnchor, overlay, button, iconHost) {
    // Read the video ID at click time — YouTube recycles tiles, binding it earlier goes stale
    const videoId = getVideoIdFromUrl(thumbAnchor.href);
    if (!videoId) return;

    button.disabled = true;
    overlay.classList.remove('maw-done', 'maw-err');
    setIcon(iconHost, 'loading');

    try {
      await markAsWatched(videoId);
      setIcon(iconHost, 'done');
      overlay.classList.add('maw-done');
      markThumbnailDone(thumbAnchor);
      setTimeout(() => overlay.remove(), 1200);
    } catch (err) {
      console.error('[maw]', err);
      setIcon(iconHost, 'error');
      overlay.classList.add('maw-err');
      setTimeout(() => {
        setIcon(iconHost, 'idle');
        overlay.classList.remove('maw-err');
        button.disabled = false;
      }, 2500);
    }
  }

  function createOverlay(thumbAnchor) {
    if (getComputedStyle(thumbAnchor).position === 'static') {
      thumbAnchor.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;

    const button = document.createElement('button');
    button.type = 'button';
    button.title = 'Mark as watched';
    button.setAttribute('aria-label', 'Mark as watched');

    const iconHost = document.createElement('div');
    button.appendChild(iconHost);
    setIcon(iconHost, 'idle');

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      button.blur();
      if (!button.disabled) onMarkClick(thumbAnchor, overlay, button, iconHost);
    });

    overlay.appendChild(button);
    thumbAnchor.appendChild(overlay);
    return overlay;
  }

  function ensureOverlay(thumbAnchor) {
    let overlay = thumbAnchor.querySelector(':scope > .' + OVERLAY_CLASS);
    if (!overlay) overlay = createOverlay(thumbAnchor);

    // Re-check watched state on every hover — tiles get recycled to other videos.
    // Skip while a request is in flight or the success state is showing.
    const busy = overlay.classList.contains('maw-done') || overlay.querySelector('button')?.disabled;
    if (!busy) overlay.classList.toggle('maw-hidden', isThumbnailWatched(thumbAnchor));
  }

  // ---------------------------------------------------------------------------
  // Wiring — a single delegated listener; overlays are created lazily on first
  // hover, so the DOM is always fully rendered and SPA navigation needs no handling
  // ---------------------------------------------------------------------------

  document.addEventListener('mouseover', (e) => {
    if (!(e.target instanceof Element)) return;
    const thumbAnchor = e.target.closest(THUMB_SELECTOR);
    if (thumbAnchor) ensureOverlay(thumbAnchor);
  }, {passive: true, capture: true});
})();
