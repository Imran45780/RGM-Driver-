// ==UserScript==
// @name         RGM Driver Early Alert (R4G + Dockmaster + FMC)
// @namespace    rgm.gateops.earlyalert
// @version      0.1.0
// @description  Detects an early driver arrival on the Sesame Gate Console (R4G): for a Vendor Inbound ISA load, auto-opens the existing Dockmaster link to read Earliest/Expected Arrival Time; for a VRID (box truck) load, auto-opens the existing FMC link to read Planned Dock Arrival. Compares against the site's local time shown on R4G and pops an alert if the driver is early.
// @match        https://trans-logistics.amazon.com/yms/sesameGateConsole*
// @match        https://trans-logistics.amazon.com/fmc/execution/search/*
// @match        https://prod-na.us-east-1.idx-website.aft.amazon.dev/en_US/*/appointment/view/*/appointmentDetail*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// ==/UserScript==

/*
  STATUS: v0.1 -- built from screenshots of the three apps, not from live DOM
  inspection. DOM reads below are done by matching on VISIBLE LABEL TEXT
  ("Load type", "VRID/ISA/PO#", "Earliest Arrival Time", "Planned Dock", etc.)
  rather than CSS class names, since class names in a minified SPA are the
  first thing that breaks and we cannot see them from a screenshot. This
  needs to be verified against the real page.

  FLOW
  ----
  1. On R4G: scan each gate transaction row.
     - If the "VRID/ISA/PO#" box has an ISA link -> Vendor Inbound (ISA) load.
       Open that link's href (Dockmaster) in a background tab with a tracking
       query param.
     - Else if it has a VRID link only -> box truck / VRID load. Open that
       link's href (FMC) in a background tab with a tracking query param.
     - Remember what we're waiting for (requestId -> row description).
  2. On Dockmaster (only if our tracking query param is present):
     - Read "Scheduled as Load Type" (LIVE/DROP), "Earliest Arrival Time",
       "Expected Arrival Date".
     - Write the relevant one back via GM_setValue, keyed by requestId.
  3. On FMC (only if our tracking query param is present):
     - Read the site code we embedded in the query param, find the stop row
       whose Stop label matches that site, read its "Planned Dock" Arrival.
     - Write it back via GM_setValue, keyed by requestId.
  4. Back on R4G: GM_addValueChangeListener wakes up when step 2/3 writes an
     answer. Re-read R4G's own SITE LOCAL TIME at that moment, compare, and
     show a popup if the driver is early. Then clear the entry so it is not
     re-processed.

  REQUIRES: the browser must allow pop-ups for trans-logistics.amazon.com and
  prod-na.us-east-1.idx-website.aft.amazon.dev, or step 1's window.open() will
  be silently blocked. First run shows a one-time notice about this.
*/

(function () {
  'use strict';

  const RESULT_KEY = 'rgmEarlyAlert_results';
  const SEEN_KEY_PREFIX = 'rgmEarlyAlert_seen_';
  const LIVE_EARLY_THRESHOLD_MIN = 30;
  const POPUP_NOTICE_KEY = 'rgmEarlyAlert_popupNoticeShown';

  const host = location.hostname;
  const isR4G = host === 'trans-logistics.amazon.com' && location.hash.includes('relayGate');
  const isFMC = host === 'trans-logistics.amazon.com' && location.pathname.startsWith('/fmc/execution/search/');
  const isDockmaster = host === 'prod-na.us-east-1.idx-website.aft.amazon.dev' && /\/appointment\/view\//.test(location.pathname);

  function findLabelValue(labelText) {
    const all = Array.from(document.querySelectorAll('body *'));
    for (const el of all) {
      const txt = (el.textContent || '').trim();
      if (txt === labelText && el.children.length === 0) {
        if (el.nextElementSibling && el.nextElementSibling.textContent.trim()) {
          return el.nextElementSibling.textContent.trim();
        }
        const parent = el.parentElement;
        if (parent) {
          const parentText = parent.textContent.trim();
          if (parentText.startsWith(labelText)) {
            const rest = parentText.slice(labelText.length).replace(/^:\s*/, '').trim();
            if (rest) return rest;
          }
          if (parent.nextElementSibling && parent.nextElementSibling.textContent.trim()) {
            return parent.nextElementSibling.textContent.trim();
          }
        }
      }
    }
    return null;
  }

  function findHeaderIndexMap(table) {
    const headerRow = table.querySelector('thead tr') || table.firstElementChild;
    if (!headerRow) return {};
    const cells = Array.from(headerRow.children);
    const map = {};
    cells.forEach((cell, i) => {
      const t = cell.textContent.trim();
      if (t) map[t] = i;
    });
    return map;
  }

  function qsAppend(url, params) {
    const u = new URL(url, location.origin);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  function newRequestId() {
    return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function injectStyles() {
    if (document.getElementById('rgm-ea-style')) return;
    const style = document.createElement('style');
    style.id = 'rgm-ea-style';
    style.textContent = `
      .rgm-ea-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        z-index: 999999; display: flex; align-items: center; justify-content: center;
        font-family: "Amazon Ember", Arial, sans-serif;
      }
      .rgm-ea-box {
        background: #fff; border-radius: 8px; padding: 22px 26px;
        width: 440px; max-width: 90vw; box-shadow: 0 8px 30px rgba(0,0,0,0.3);
        border-top: 6px solid #ff9900;
      }
      .rgm-ea-title { font-size: 17px; font-weight: 700; color: #16191f; margin-bottom: 8px; }
      .rgm-ea-body { font-size: 14px; color: #414750; line-height: 1.45; margin-bottom: 16px; white-space: pre-line; }
      .rgm-ea-actions { display: flex; justify-content: flex-end; }
      .rgm-ea-btn {
        padding: 8px 18px; border-radius: 4px; font-size: 14px; cursor: pointer;
        border: 1px solid #0972d3; background: #0972d3; color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  const popupQueue = [];
  let popupShowing = false;

  function showAlert(title, body) {
    popupQueue.push({ title, body });
    drainQueue();
  }

  function drainQueue() {
    if (popupShowing || popupQueue.length === 0) return;
    popupShowing = true;
    injectStyles();
    const next = popupQueue.shift();
    const overlay = document.createElement('div');
    overlay.className = 'rgm-ea-overlay';
    overlay.innerHTML =
      '<div class="rgm-ea-box">' +
      '<div class="rgm-ea-title">' + next.title + '</div>' +
      '<div class="rgm-ea-body">' + next.body + '</div>' +
      '<div class="rgm-ea-actions"><button class="rgm-ea-btn">OK</button></div>' +
      '</div>';
    overlay.querySelector('.rgm-ea-btn').addEventListener('click', () => {
      overlay.remove();
      popupShowing = false;
      drainQueue();
    });
    document.body.appendChild(overlay);
  }

  function maybeShowPopupNotice() {
    if (GM_getValue(POPUP_NOTICE_KEY, false)) return;
    GM_setValue(POPUP_NOTICE_KEY, true);
    showAlert(
      'Driver Early Alert enabled',
      'This script opens a background tab to Dockmaster or FMC when it needs to check an arrival time.\n\nMake sure pop-ups are ALLOWED for trans-logistics.amazon.com, otherwise those checks will silently fail. (Chrome: click the blocked-popup icon in the address bar once and choose Always allow.)'
    );
  }

  function parseWallClock(text) {
    if (!text) return null;
    const m = text.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})[^\d]+(\d{2}):(\d{2})/);
    if (m) {
      const y = m[1], mo = m[2], d = m[3], h = m[4], mi = m[5];
      return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    }
    const m2 = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    const m3 = text.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
    if (m2 && m3) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const mon = months.indexOf(m3[2]);
      if (mon >= 0) {
        return new Date(Number(m3[3]), mon, Number(m3[1]), Number(m2[1]), Number(m2[2]), Number(m2[3]));
      }
    }
    return null;
  }

  function fmt(d) {
    if (!d) return '(unknown)';
    return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function r4gGetSiteCode() {
    const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(el => el.textContent.trim())
      .find(t => /Entry Gate|Exit Gate/.test(t));
    if (!heading) return null;
    const m = heading.match(/^([A-Z0-9]{3,6})\s+(Entry|Exit)\s+Gate/);
    return m ? m[1] : null;
  }

  function r4gGetSiteLocalTime() {
    const raw = findLabelValue('SITE LOCAL TIME:') || findLabelValue('SITE LOCAL TIME');
    return parseWallClock(raw || '');
  }

  function findGateRowsTable() {
    const candidates = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'));
    for (const c of candidates) {
      if (/VRID\s*\/\s*ISA\s*\/\s*PO/i.test(c.textContent)) return c;
    }
    return null;
  }

  const pending = {};

  function r4gScan() {
    const table = findGateRowsTable();
    if (!table) return;
    const headerMap = findHeaderIndexMap(table);
    const headerKeys = Object.keys(headerMap);
    const loadTypeKey = headerKeys.find(k => /load type/i.test(k));
    const idKey = headerKeys.find(k => /VRID\s*\/\s*ISA\s*\/\s*PO/i.test(k));
    if (loadTypeKey === undefined || idKey === undefined) return;

    const rows = Array.from(table.querySelectorAll('tbody tr')).length
      ? Array.from(table.querySelectorAll('tbody tr'))
      : Array.from(table.children).slice(1);

    const siteCode = r4gGetSiteCode();

    rows.forEach(row => {
      const cells = row.children;
      const idCell = cells[headerMap[idKey]];
      const loadTypeCell = cells[headerMap[loadTypeKey]];
      if (!idCell) return;

      const isaLink = Array.from(idCell.querySelectorAll('a')).find(a => /^ISA/i.test(a.textContent.trim()));
      const vridLink = Array.from(idCell.querySelectorAll('a')).find(a => /^VRID/i.test(a.textContent.trim()));

      const rowKey = (isaLink && isaLink.textContent.trim()) || (vridLink && vridLink.textContent.trim()) || row.textContent.trim().slice(0, 80);
      const seenKey = SEEN_KEY_PREFIX + rowKey;
      if (sessionStorage.getItem(seenKey)) return;

      const idText = rowKey.replace(/^(ISA|VRID)\s*/, '');
      const bannerText = Array.from(document.querySelectorAll('div, p'))
        .map(el => el.textContent)
        .find(t => t.includes(idText) && /vendor (drop|live)/i.test(t)) || '';
      const bannerSaysDrop = /vendor drop/i.test(bannerText);
      const bannerSaysLive = /vendor live/i.test(bannerText);

      if (isaLink && isaLink.href) {
        const requestId = newRequestId();
        sessionStorage.setItem(seenKey, '1');
        pending[requestId] = {
          kind: 'dockmaster',
          rowKey,
          loadTypeHint: bannerSaysDrop ? 'DROP' : (bannerSaysLive ? 'LIVE' : null),
        };
        const url = qsAppend(isaLink.href, { rgmReq: requestId });
        maybeShowPopupNotice();
        window.open(url, '_blank');
      } else if (vridLink && vridLink.href && !isaLink) {
        if (!siteCode) return;
        const requestId = newRequestId();
        sessionStorage.setItem(seenKey, '1');
        pending[requestId] = { kind: 'fmc', rowKey };
        const url = qsAppend(vridLink.href, { rgmReq: requestId, rgmSite: siteCode });
        maybeShowPopupNotice();
        window.open(url, '_blank');
      }
    });
  }

  function r4gOnResult(requestId, result) {
    const info = pending[requestId];
    if (!info || !result || !result.ok) return;
    delete pending[requestId];

    const siteNow = r4gGetSiteLocalTime();
    if (!siteNow) {
      showAlert('Driver Early Alert could not compare', info.rowKey + ': got data back, but could not read SITE LOCAL TIME off this R4G page to compare against.');
      return;
    }

    if (info.kind === 'dockmaster') {
      const loadType = result.loadType || info.loadTypeHint;
      const arrivalText = loadType === 'LIVE' ? result.expectedArrival : result.earliestArrival;
      const arrival = parseWallClock(arrivalText || '');
      if (!arrival) {
        showAlert('Driver Early Alert: no arrival time found', info.rowKey + ': Dockmaster did not have a readable ' + (loadType === 'LIVE' ? 'Expected Arrival Date' : 'Earliest Arrival Time') + ' for this appointment.');
        return;
      }
      const diffMin = Math.round((arrival - siteNow) / 60000);
      if (loadType === 'LIVE') {
        if (diffMin > LIVE_EARLY_THRESHOLD_MIN) {
          showAlert('Driver is EARLY (Live Unload)', info.rowKey + '\nExpected Arrival: ' + fmt(arrival) + '\nSite time now: ' + fmt(siteNow) + '\nDriver is ' + diffMin + ' min early (threshold ' + LIVE_EARLY_THRESHOLD_MIN + ' min).');
        }
      } else {
        if (diffMin > 0) {
          showAlert('Driver is EARLY (Vendor Inbound Drop)', info.rowKey + '\nEarliest Arrival Time: ' + fmt(arrival) + '\nSite time now: ' + fmt(siteNow) + '\nDriver is ' + diffMin + ' min early.');
        }
      }
    } else if (info.kind === 'fmc') {
      const arrival = parseWallClock(result.plannedDockArrival || '');
      if (!arrival) {
        showAlert('Driver Early Alert: no arrival time found', info.rowKey + ': FMC did not have a readable Planned Dock Arrival for this stop.');
        return;
      }
      const diffMin = Math.round((arrival - siteNow) / 60000);
      if (diffMin > LIVE_EARLY_THRESHOLD_MIN) {
        showAlert('Driver is EARLY (Box Truck / VRID)', info.rowKey + '\nPlanned Dock Arrival: ' + fmt(arrival) + '\nSite time now: ' + fmt(siteNow) + '\nDriver is ' + diffMin + ' min early (threshold ' + LIVE_EARLY_THRESHOLD_MIN + ' min).');
      }
    }
  }

  function initR4G() {
    const listenerId = GM_addValueChangeListener(RESULT_KEY, (name, oldVal, newVal) => {
      if (!newVal) return;
      Object.keys(newVal).forEach((requestId) => {
        const result = newVal[requestId];
        if (pending[requestId]) {
          r4gOnResult(requestId, result);
          const current = GM_getValue(RESULT_KEY, {});
          delete current[requestId];
          GM_setValue(RESULT_KEY, current);
        }
      });
    });
    setInterval(r4gScan, 15000);
    setTimeout(r4gScan, 2000);
    window.addEventListener('unload', () => GM_removeValueChangeListener(listenerId));
  }

  function writeResult(requestId, data) {
    const current = GM_getValue(RESULT_KEY, {});
    current[requestId] = data;
    GM_setValue(RESULT_KEY, current);
  }

  function waitFor(conditionFn, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (conditionFn()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error('timeout waiting for page content'));
        }
      }, 400);
    });
  }

  function initDockmaster() {
    const params = new URLSearchParams(location.search);
    const requestId = params.get('rgmReq');
    if (!requestId) return;

    waitFor(() => findLabelValue('Earliest Arrival Time') !== null || findLabelValue('Expected Arrival Date') !== null, 15000)
      .then(() => {
        const loadTypeRaw = (findLabelValue('Scheduled as Load Type') || '').toUpperCase();
        const loadType = loadTypeRaw.includes('LIVE') ? 'LIVE' : (loadTypeRaw.includes('DROP') ? 'DROP' : null);
        const result = {
          ok: true,
          loadType: loadType,
          earliestArrival: findLabelValue('Earliest Arrival Time'),
          expectedArrival: findLabelValue('Expected Arrival Date'),
        };
        writeResult(requestId, result);
        setTimeout(() => { if (window.opener) window.close(); }, 1500);
      })
      .catch(() => writeResult(requestId, { ok: false }));
  }

  function initFMC() {
    const params = new URLSearchParams(location.search);
    const requestId = params.get('rgmReq');
    const siteCode = params.get('rgmSite');
    if (!requestId) return;

    waitFor(() => /Planned Dock/i.test(document.body.textContent), 15000)
      .then(() => {
        const table = Array.from(document.querySelectorAll('table, [role="table"]'))
          .find(t => /Planned Dock/i.test(t.textContent));
        let plannedDockArrival = null;
        if (table && siteCode) {
          const headerMap = findHeaderIndexMap(table);
          const stopKey = Object.keys(headerMap).find(k => /stop/i.test(k));
          const plannedDockKey = Object.keys(headerMap).find(k => /planned dock/i.test(k));
          const rows = Array.from(table.querySelectorAll('tbody tr')).length
            ? Array.from(table.querySelectorAll('tbody tr'))
            : Array.from(table.children).slice(1);
          const match = rows.find(r => {
            const stopCell = r.children[headerMap[stopKey]];
            return stopCell && stopCell.textContent.trim().toUpperCase().includes(siteCode.toUpperCase());
          });
          if (match) {
            const cell = match.children[headerMap[plannedDockKey]];
            plannedDockArrival = cell ? cell.textContent.trim() : null;
          }
        }
        writeResult(requestId, { ok: !!plannedDockArrival, plannedDockArrival: plannedDockArrival });
        setTimeout(() => { if (window.opener) window.close(); }, 1500);
      })
      .catch(() => writeResult(requestId, { ok: false }));
  }

  if (isR4G) initR4G();
  else if (isDockmaster) initDockmaster();
  else if (isFMC) initFMC();
})();
