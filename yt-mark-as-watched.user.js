// ==UserScript==
// @name         YouTube Mark as Watched
// @description  Allows users to mark a video as fully watched
// @namespace    https://github.com/SamadiPour/youtube-mark-as-watched
// @author       Amir Hossein SamadiPour
// @version      1.1.0
// @license      GNU General Public License v3.0
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Global CSS – style the action like YouTube's hover overlay controls
  // ---------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    .maw-native-action button {
      display: flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      cursor: pointer;
    }
    .maw-native-action button:disabled {
      cursor: default;
      opacity: 0.7;
    }
    .maw-native-action .yt-spec-button-shape-next__icon,
    .maw-native-action .ytIconWrapperHost,
    .maw-native-action .yt-icon-shape,
    .maw-native-action svg {
      pointer-events: none;
    }
    .maw-native-action.done button {
      color: #22c55e;
    }
    .maw-native-action.err button {
      color: #ef4444;
    }
    .maw-native-action .maw-spinner {
      animation: maw-spin 0.9s linear infinite;
      transform-origin: 12px 12px;
    }
    @keyframes maw-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
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
  // Core: fetch vm/of tokens then fire the playback-complete ping
  // ---------------------------------------------------------------------------

  async function fetchPlaybackUrl(videoId) {
    // // Fast path: player response already on the page (watch page, no fetch needed)
    // const ipr = window.ytInitialPlayerResponse;
    // if (ipr?.videoDetails?.videoId === videoId) {
    //   const url = ipr?.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
    //   if (url) return url;
    // }

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
  // UI injection
  // ---------------------------------------------------------------------------

  const BTN_SELECTOR = '.maw-native-action';
  const HOVER_HOST_SELECTOR = 'yt-thumbnail-hover-overlay-toggle-actions-view-model.ytThumbnailHoverOverlayToggleActionsViewModelHost';
  const hostObservers = new WeakMap();
  const scheduledHosts = new WeakSet();

  function getVideoIdFromUrl(url) {
    return url.match(/[?&]v=([\w-]{11})/)?.[1] || null;
  }

  function getThumbnailRoot(thumbAnchor) {
    return thumbAnchor.querySelector('ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost')
      || thumbAnchor.closest('ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost')
      || thumbAnchor;
  }

  function scheduleHostAttach(host) {
    if (!host || scheduledHosts.has(host)) return;

    scheduledHosts.add(host);
    queueMicrotask(() => {
      scheduledHosts.delete(host);
      if (host.isConnected) attachButton(host);
    });
  }

  function observeHoverHost(host) {
    if (!host || hostObservers.has(host)) return;

    const observer = new MutationObserver(() => {
      if (!host.isConnected) return;
      if (!host.querySelector(BTN_SELECTOR)) {
        scheduleHostAttach(host);
      }
    });

    observer.observe(host, {childList: true, subtree: false});
    hostObservers.set(host, observer);
  }


  function markThumbnailDone(thumbAnchor) {
    const root = getThumbnailRoot(thumbAnchor);

    const progressBars = root.querySelectorAll('#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment');
    if (progressBars.length) {
      progressBars.forEach((progress) => {
        progress.style.width = '100%';
      });
      return;
    }

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

    const overlays = root.querySelector('#overlays');
    if (overlays && !overlays.querySelector('#progress')) {
      const bar = document.createElement('div');
      bar.className = 'style-scope ytd-thumbnail';
      bar.style.display = 'block';
      bar.style.position = 'absolute';
      bar.style.bottom = '0';
      bar.style.right = '0';
      bar.style.left = '0';
      bar.style.height = '4px';
      bar.style.backgroundColor = 'var(--yt-spec-text-disabled)';
      bar.style.zIndex = '1';

      const progressBar = document.createElement('div');
      progressBar.id = 'progress';
      progressBar.className = 'style-scope ytd-thumbnail-overlay-resume-playback-renderer';
      progressBar.style.width = '100%';

      bar.appendChild(progressBar);
      overlays.appendChild(bar);
      return;
    }
  }

  function isThumbnailWatched(thumbAnchor) {
    const root = getThumbnailRoot(thumbAnchor);
    const progress = root.querySelector('#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment');
    if (!progress?.style?.width) return false;

    const width = Number.parseFloat(progress.style.width.replace('%', ''));
    return Number.isFinite(width) && width >= 100;
  }

  function setButtonIcon(btn, state = 'idle') {
    const iconHost = btn._mawIconHost;
    if (!iconHost) return;

    const replaceIcon = (pathData, extraClass = '') => {
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('xmlns', svgNs);
      svg.setAttribute('height', '24');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '24');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('aria-hidden', 'true');
      if (extraClass) svg.setAttribute('class', extraClass);
      svg.style.pointerEvents = 'none';
      svg.style.display = 'inherit';
      svg.style.width = '100%';
      svg.style.height = '100%';

      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
      iconHost.replaceChildren(svg);
    };

    if (state === 'done') {
      replaceIcon('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');
      return;
    }
    if (state === 'error') {
      replaceIcon('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z');
      return;
    }
    if (state === 'loading') {
      replaceIcon('M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2z', 'maw-spinner');
      return;
    }
    replaceIcon('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');
  }

  function attachButton(overlayHost) {
    if (!overlayHost) return;
    observeHoverHost(overlayHost);
    if (overlayHost.querySelector(BTN_SELECTOR)) return;

    const thumbAnchor = overlayHost.closest('a.yt-lockup-view-model__content-image, a#thumbnail');
    if (!thumbAnchor) return;

    const videoId = getVideoIdFromUrl(thumbAnchor.href);
    if (!videoId || isThumbnailWatched(thumbAnchor)) return;

    const template = overlayHost.querySelector('.ytThumbnailHoverOverlayToggleActionsViewModelButton');
    if (!template) return;

    const wrapper = template.cloneNode(true);
    wrapper.classList.add('maw-native-action');

    const button = wrapper.querySelector('button');
    const iconHost = wrapper.querySelector('.yt-spec-button-shape-next__icon div');
    if (!button || !iconHost) return;

    button._mawIconHost = iconHost;
    button.type = 'button';
    button.title = '';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-disabled', 'false');
    button.setAttribute('aria-label', 'Mark as watched');
    setButtonIcon(button, 'idle');
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      button.blur();
      setButtonIcon(button, 'loading');
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      wrapper.className = 'ytThumbnailHoverOverlayToggleActionsViewModelButton maw-native-action';
      try {
        await markAsWatched(videoId);
        setButtonIcon(button, 'done');
        wrapper.className = 'ytThumbnailHoverOverlayToggleActionsViewModelButton maw-native-action done';
        markThumbnailDone(thumbAnchor);
        setTimeout(() => {
          wrapper.remove();
        }, 1200);
      } catch (err) {
        console.error('[maw]', err);
        setButtonIcon(button, 'error');
        wrapper.className = 'ytThumbnailHoverOverlayToggleActionsViewModelButton maw-native-action err';
        setTimeout(() => {
          setButtonIcon(button, 'idle');
          wrapper.className = 'ytThumbnailHoverOverlayToggleActionsViewModelButton maw-native-action';
          button.disabled = false;
          button.setAttribute('aria-disabled', 'false');
        }, 2500);
      }
    });

    overlayHost.appendChild(wrapper);
  }

  function scanPage() {
    document.querySelectorAll(HOVER_HOST_SELECTOR).forEach((host) => {
      observeHoverHost(host);
      attachButton(host);
    });
  }

  // ---------------------------------------------------------------------------
  // Watch-page button (next to Like/Share)
  // ---------------------------------------------------------------------------

  function injectWatchPageButton() {
    if (!location.pathname.startsWith('/watch')) return;
    if (document.getElementById('maw-watch-btn')) return;
    const m = location.search.match(/[?&]v=([\w-]{11})/);
    if (!m) return;
    const videoId = m[1];

    const target = document.querySelector('#actions-inner, ytd-menu-renderer#menu');
    if (!target) return;

    const btn = document.createElement('button');
    btn.id = 'maw-watch-btn';
    btn.textContent = '✓ Mark as Watched';
    Object.assign(btn.style, {
      marginLeft: '8px', padding: '6px 14px', fontSize: '13px', fontWeight: '600',
      color: '#fff', background: '#333', border: 'none', borderRadius: '18px',
      cursor: 'pointer', verticalAlign: 'middle', flexShrink: '0',
    });

    btn.addEventListener('click', async () => {
      btn.textContent = '…';
      btn.disabled = true;
      try {
        await markAsWatched(videoId);
        btn.textContent = '✓ Marked!';
        btn.style.background = '#166534';
      } catch (err) {
        console.error('[maw]', err);
        btn.textContent = '✗ Failed';
        btn.style.background = '#991b1b';
        setTimeout(() => {
          btn.textContent = '✓ Mark as Watched';
          btn.style.background = '#333';
          btn.disabled = false;
        }, 2500);
      }
    });

    target.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // SPA navigation + MutationObserver
  // ---------------------------------------------------------------------------

  let timer = null;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      scanPage();
      injectWatchPageButton();
    }, 400);
  }

  // YouTube fires this event on every SPA navigation
  window.addEventListener('yt-navigate-finish', () => {
    document.getElementById('maw-watch-btn')?.remove();
    schedule();
  });

  new MutationObserver((mutations) => {
    let shouldSchedule = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;

        if (node.matches?.(HOVER_HOST_SELECTOR)) {
          observeHoverHost(node);
          scheduleHostAttach(node);
          continue;
        }

        node.querySelectorAll?.(HOVER_HOST_SELECTOR).forEach((host) => {
          observeHoverHost(host);
          scheduleHostAttach(host);
        });

        if (
          node.matches?.('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model, ytd-playlist-video-renderer')
          || node.querySelector?.('a.yt-lockup-view-model__content-image[href*="/watch?v="], a#thumbnail[href*="/watch?v="]')
        ) {
          shouldSchedule = true;
        }
      }
    }

    if (shouldSchedule) schedule();
  }).observe(document.body, {childList: true, subtree: true});

  // Initial scan
  scanPage();
  injectWatchPageButton();
  schedule();
})();
