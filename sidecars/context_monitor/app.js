(() => {
  const POLL_MS = 1500;
  const AGE_TICK_MS = 5000;
  const REQUEST_TIMEOUT_MS = 4000;
  const MAX_BACKOFF_MS = 10000;
  const MAX_BARS = 36;
  const MAX_ROWS = 20;
  const AUTO_COMPACT_TOKENS = 512000;
  const AUTO_COMPACT_WARN_TOKENS = 420000;
  const DELTA_SPIKE_TOKENS = 10000;
  const DELTA_HEAVY_TOKENS = 25000;
  const BUDGET_STORAGE_KEY = 'context_monitor_budget';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    etag: '',
    snapshot: null,
    updatedAtMs: null,
    budget: Number(localStorage.getItem(BUDGET_STORAGE_KEY)) || 512000,
    inFlight: false,
    pollTimer: null,
    ageTimer: null,
    copyTimer: null,
    errorStreak: 0,
    barByKey: new Map(),
    rowByKey: new Map(),
    activeKey: null,
  };

  function syncScheme() {
    const bgVar = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    if (!bgVar && window.matchMedia) {
      document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      return;
    }
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }

  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtCompact = (n) => {
    const v = Number(n || 0);
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
    return `${sign}${abs}`;
  };
  const fmtDelta = (d) => {
    if (d === null || d === undefined || !Number.isFinite(d)) return '—';
    if (d === 0) return '0';
    return d > 0 ? `+${fmtCompact(d)}` : fmtCompact(d);
  };
  const deltaTone = (d) => {
    if (d === null || d === undefined || !Number.isFinite(d) || d === 0) return 'muted';
    if (d <= -DELTA_SPIKE_TOKENS) return 'drop';
    if (d >= DELTA_HEAVY_TOKENS) return 'heavy';
    if (d >= DELTA_SPIKE_TOKENS) return 'spike';
    return 'muted';
  };
  const fmtElapsed = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtAge = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function formatTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
      return { compact: 'Reply', full: 'Reply' };
    }
    const counts = new Map();
    for (const name of tools) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const parts = [];
    for (const [name, count] of counts.entries()) {
      parts.push(count > 1 ? `${name} ×${count}` : name);
    }
    return {
      compact: parts.join(', '),
      full: tools.join(', '),
    };
  }

  function stepKeyOf(s, idx) {
    return `${s.kind || 'step'}:${s.stepIndex}:${idx}`;
  }

  function enrichSteps(steps) {
    let prevContextTokens = null;
    return steps.map((s, idx) => {
      const key = stepKeyOf(s, idx);
      if (s.kind === 'checkpoint') {
        return { ...s, _key: key, deltaTokens: null };
      }
      const deltaTokens = prevContextTokens !== null ? s.contextTokens - prevContextTokens : null;
      prevContextTokens = s.contextTokens;
      return { ...s, _key: key, deltaTokens };
    });
  }

  function setLinkedKey(key) {
    if (state.activeKey === key) return;
    if (state.activeKey) {
      state.barByKey.get(state.activeKey)?.classList.remove('is-active');
      state.rowByKey.get(state.activeKey)?.classList.remove('is-linked');
    }
    state.activeKey = key;
    if (key) {
      state.barByKey.get(key)?.classList.add('is-active');
      state.rowByKey.get(key)?.classList.add('is-linked');
    }
  }

  function locateRow(key) {
    const row = state.rowByKey.get(key);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('is-flash');
    void row.offsetWidth;
    row.classList.add('is-flash');
  }

  function currentConv() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function fetchContext() {
    const qs = new URLSearchParams();
    const conv = currentConv();
    if (conv) qs.set('conversationId', conv);
    const fb = params.get('fallback');
    if (fb === '1' || fb === 'true') qs.set('fallback', '1');
    if (state.etag) qs.set('etag', state.etag);
    const basePath = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
    const apiUrl = `${basePath}api/context?${qs.toString()}`;
    const token = params.get('token');
    const headers = token ? { 'X-Sidecar-Token': token } : {};
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await f(apiUrl, { method: 'GET', headers, cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function renderUpdatedMeta() {
    const el = $('updated-meta');
    if (!el) return;
    const ms = state.updatedAtMs;
    if (!Number.isFinite(ms) || ms <= 0) {
      el.classList.add('hidden');
      return;
    }
    const age = fmtAge(ms);
    el.textContent = `· ${age}`;
    el.title = `Last updated: ${new Date(ms).toLocaleTimeString()}`;
    el.classList.toggle('stale', Date.now() - ms > 120000);
    el.classList.remove('hidden');
  }

  function renderChart(steps) {
    const barsEl = $('chart-bars');
    const tipEl = $('chart-tooltip');
    const slice = steps.slice(-MAX_BARS);
    const maxCtx = Math.max(1, ...slice.map((s) => s.contextTokens));
    const hasCompact = slice.some((s) => s.compacted);

    $('chart-range').textContent = slice.length
      ? `Step ${slice[0].stepIndex}–${slice[slice.length - 1].stepIndex} · Peak ${fmtCompact(maxCtx)}`
      : '';
    $('compact-legend').classList.toggle('hidden', !hasCompact);

    tipEl.classList.add('hidden');
    barsEl.innerHTML = '';
    state.barByKey.clear();

    const bindInteractions = (el, key, html, alignLeft, canLocate) => {
      const show = () => {
        tipEl.innerHTML = html;
        tipEl.classList.toggle('align-left', alignLeft);
        tipEl.classList.remove('hidden');
        setLinkedKey(key);
      };
      const hide = () => {
        tipEl.classList.add('hidden');
        if (state.activeKey === key) setLinkedKey(null);
      };
      el.addEventListener('mouseenter', show);
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', show);
      el.addEventListener('blur', hide);
      if (canLocate) {
        el.addEventListener('click', () => locateRow(key));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            locateRow(key);
          }
        });
      }
    };

    const halfIdx = Math.floor(slice.length / 2);

    slice.forEach((s, idx) => {
      const col = document.createElement('div');
      const canLocate = state.rowByKey.has(s._key);
      col.tabIndex = 0;
      if (canLocate) col.setAttribute('role', 'button');
      col.dataset.stepKey = s._key;
      const alignLeft = slice.length >= 4 && idx >= halfIdx;

      if (s.kind === 'checkpoint') {
        col.className = `bar-col compact-marker${canLocate ? ' can-locate' : ''}`;
        col.setAttribute('aria-label', `Step ${s.stepIndex}, compacted, summary output ${fmtNum(s.outputTokens)}`);
        const line = document.createElement('div');
        line.className = 'bar-compact-line';
        col.appendChild(line);
        bindInteractions(
          col,
          s._key,
          [
            `<div><strong>Step #${s.stepIndex}</strong> · Compacted</div>`,
            `<div>Previous: ${fmtNum(s.preCompactTokens)} → Reset</div>`,
            `<div>Summary Out: ${fmtNum(s.outputTokens)}</div>`,
          ].join(''),
          alignLeft,
          canLocate,
        );
        barsEl.appendChild(col);
        state.barByKey.set(s._key, col);
        return;
      }

      col.className = `bar-col${s.compacted ? ' compacted' : ''}${canLocate ? ' can-locate' : ''}`;
      const deltaStr = fmtDelta(s.deltaTokens);
      col.setAttribute(
        'aria-label',
        `Step ${s.stepIndex}${s.compacted ? ', compacted' : ''}, context ${fmtNum(s.contextTokens)} tokens, change ${deltaStr}`,
      );

      const totalH = Math.max(2, Math.round((s.contextTokens / maxCtx) * 92));
      const cacheH = s.contextTokens > 0 ? Math.round((s.cacheReadTokens / s.contextTokens) * totalH) : 0;
      const inputH = Math.max(0, totalH - cacheH);

      const stack = document.createElement('div');
      stack.className = 'bar-stack';
      stack.style.height = `${totalH}px`;

      if (cacheH > 0) {
        const segCache = document.createElement('div');
        segCache.className = 'bar-seg-cache';
        segCache.style.height = `${cacheH}px`;
        stack.appendChild(segCache);
      }
      if (inputH > 0) {
        const segInput = document.createElement('div');
        segInput.className = 'bar-seg-input';
        segInput.style.height = `${inputH}px`;
        stack.appendChild(segInput);
      }

      col.appendChild(stack);
      const { compact: actionLabel } = formatTools(s.tools);
      const hitPct = `${(s.cacheHitRate * 100).toFixed(0)}%`;
      const deltaPart = s.deltaTokens !== null ? ` (${deltaStr})` : '';
      bindInteractions(
        col,
        s._key,
        [
          `<div><strong>Step #${s.stepIndex}</strong>${s.compacted ? ' · Compacted' : ''}</div>`,
          `<div class="tip-sub">${esc(actionLabel)}</div>`,
          `<div>Context: ${fmtNum(s.contextTokens)}${deltaPart}</div>`,
          `<div>New: ${fmtCompact(s.inputTokens)} | Cache: ${fmtCompact(s.cacheReadTokens)} (${hitPct})</div>`,
          `<div>Out: ${fmtCompact(s.outputTokens)} · ${fmtElapsed(s.elapsedMs)}</div>`,
        ].join(''),
        alignLeft,
        canLocate,
      );
      barsEl.appendChild(col);
      state.barByKey.set(s._key, col);
    });
  }

  function renderTable(steps) {
    const rows = steps.slice(-MAX_ROWS).reverse();
    $('turns-count').textContent = `${rows.length} of ${steps.length}`;
    const tbody = $('turns-body');
    tbody.innerHTML = rows
      .map((s) => {
        if (s.kind === 'checkpoint') {
          const title = `Compacted from ${fmtNum(s.preCompactTokens)} tokens · Summary out: ${fmtNum(s.outputTokens)}`;
          return `
            <tr class="compact-row" data-step-key="${esc(s._key)}" title="${esc(title)}">
              <td>#${s.stepIndex}<span class="compact-tag">Compact</span></td>
              <td class="action-cell">Context compacted</td>
              <td class="num">Reset</td>
              <td class="num delta-drop">↓</td>
              <td class="num col-hit">—</td>
              <td class="num">${fmtCompact(s.outputTokens)}</td>
              <td class="num col-time">${fmtElapsed(s.elapsedMs)}</td>
            </tr>
          `;
        }
        const { compact: actionLabel, full: actionFull } = formatTools(s.tools);
        const compactTag = s.compacted ? '<span class="compact-tag">Reset</span>' : '';
        const tone = deltaTone(s.deltaTokens);
        const deltaStr = fmtDelta(s.deltaTokens);
        const hitStr = `${(s.cacheHitRate * 100).toFixed(0)}%`;
        const rowTitle = `${actionFull}\nContext: ${fmtNum(s.contextTokens)} (Δ ${deltaStr})\nNew: ${fmtNum(s.inputTokens)} | Cache: ${fmtNum(s.cacheReadTokens)} (${hitStr}) | Out: ${fmtNum(s.outputTokens)} | ${fmtElapsed(s.elapsedMs)}`;
        return `
          <tr data-step-key="${esc(s._key)}" title="${esc(rowTitle)}">
            <td>#${s.stepIndex}${compactTag}</td>
            <td class="action-cell">${esc(actionLabel)}</td>
            <td class="num">${fmtCompact(s.contextTokens)}</td>
            <td class="num delta-${tone}">${deltaStr}</td>
            <td class="num col-hit">${hitStr}</td>
            <td class="num">${fmtCompact(s.outputTokens)}</td>
            <td class="num col-time">${fmtElapsed(s.elapsedMs)}</td>
          </tr>
        `;
      })
      .join('');

    state.rowByKey.clear();
    for (const tr of tbody.querySelectorAll('tr[data-step-key]')) {
      state.rowByKey.set(tr.dataset.stepKey, tr);
    }
  }

  function render() {
    const snap = state.snapshot;
    $('loading-state')?.classList.add('hidden');
    state.activeKey = null;

    if (!snap || !snap.available || (!snap.latest && !snap.pendingCompaction)) {
      state.updatedAtMs = null;
      state.barByKey.clear();
      state.rowByKey.clear();
      $('empty-state').classList.remove('hidden');
      $('content').classList.add('hidden');
      const convMeta = $('conv-meta');
      convMeta.textContent = snap?.conversationId
        ? `${snap.conversationId.slice(0, 8)}…`
        : 'Waiting for session…';
      convMeta.title = snap?.conversationId ? `Session: ${snap.conversationId}` : 'Waiting for active session';
      renderUpdatedMeta();
      return;
    }

    $('empty-state').classList.add('hidden');
    $('content').classList.remove('hidden');

    state.updatedAtMs = snap.updatedAtMs || null;
    const shortId = snap.conversationId ? `${snap.conversationId.slice(0, 8)}` : 'unknown';
    const convMeta = $('conv-meta');
    convMeta.textContent = snap.isFallback ? `${shortId} (fallback)` : shortId;
    convMeta.title = snap.conversationId
      ? `Session: ${snap.conversationId}${snap.isFallback ? ' (fallback)' : ''}`
      : 'Session unknown';
    renderUpdatedMeta();

    const enriched = enrichSteps(snap.steps || []);
    const latestEnriched = [...enriched].reverse().find((s) => s.kind === 'step') || null;

    const budget = state.budget;
    const pctEl = $('pct-badge');
    const deltaEl = $('delta-badge');
    const remEl = $('ctx-remaining');
    const trackEl = $('bar-track');
    const tickEl = $('bar-compact-tick');
    const hintEl = $('compact-hint');
    const hintTextEl = $('compact-hint-text');
    const pillsEl = $('pills-row');

    const showAutoCompactTick = budget > AUTO_COMPACT_TOKENS;
    tickEl.classList.toggle('hidden', !showAutoCompactTick);
    if (showAutoCompactTick) {
      const tickPct = (AUTO_COMPACT_TOKENS / budget) * 100;
      tickEl.style.left = `${tickPct.toFixed(2)}%`;
      trackEl.title = 'Marker indicates ~512K default auto-compact threshold';
    } else {
      trackEl.removeAttribute('title');
    }

    if (snap.pendingCompaction) {
      const pc = snap.pendingCompaction;
      const est = pc.estimatedPostTokens;
      const hasEst = Number.isFinite(est) && est > 0;
      const estPct = hasEst && budget > 0 ? (est / budget) * 100 : 0;
      const savedPct = hasEst && pc.preCompactTokens > 0 && est < pc.preCompactTokens
        ? Math.round(((pc.preCompactTokens - est) / pc.preCompactTokens) * 100)
        : null;

      $('ctx-total').textContent = hasEst ? `~${fmtNum(est)}` : 'Compacted';
      if (hasEst) {
        const savedPart = savedPct !== null ? ` (-${savedPct}% est.)` : '';
        $('ctx-budget').textContent = `/ ${fmtNum(budget)}${savedPart}`;
        const rem = Math.max(0, budget - est);
        remEl.textContent = `~${fmtCompact(rem)} left · exact on next turn`;
        remEl.className = 'hero-remaining';
      } else {
        $('ctx-budget').textContent = pc.preCompactTokens > 0
          ? `was ${fmtCompact(pc.preCompactTokens)}`
          : '';
        remEl.textContent = 'awaiting next turn';
        remEl.className = 'hero-remaining';
      }

      deltaEl.classList.add('hidden');
      pctEl.textContent = hasEst ? `~${estPct.toFixed(1)}% · Reset` : 'Reset';
      pctEl.className = 'pct-badge compacted';

      trackEl.className = `bar-track${hasEst ? ' estimated' : ''}`;
      $('bar-cache').style.width = '0%';
      $('bar-input').style.width = hasEst ? `${Math.min(100, estPct).toFixed(2)}%` : '0%';
      hintEl.classList.add('hidden');

      pillsEl.classList.add('is-compacted');
      $('m-input-label').textContent = 'Pre-Compact';
      $('m-input').textContent = pc.preCompactTokens > 0 ? fmtNum(pc.preCompactTokens) : '—';
      $('m-cache-label').textContent = 'Base Est.';
      $('m-cache').textContent = pc.baseContextTokens > 0 ? fmtNum(pc.baseContextTokens) : '—';
      $('m-cache-rate').textContent = '(next turn exact)';
      $('m-output-label').textContent = 'Summary Out';
      $('m-output').textContent = fmtNum(pc.summaryOutputTokens);
    } else {
      const latest = snap.latest;
      const pct = budget > 0 ? (latest.contextTokens / budget) * 100 : 0;
      const remaining = budget - latest.contextTokens;
      const cachePct = latest.cacheHitRate * 100;
      const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';

      pillsEl.classList.remove('is-compacted');
      $('m-input-label').textContent = 'New Input';
      $('m-cache-label').textContent = 'Cache Read';
      $('m-output-label').textContent = 'Output';

      $('ctx-total').textContent = fmtNum(latest.contextTokens);
      $('ctx-budget').textContent = `/ ${fmtNum(budget)}`;

      remEl.textContent = remaining >= 0
        ? `${fmtCompact(remaining)} left`
        : `Over by ${fmtCompact(-remaining)}`;
      remEl.className = `hero-remaining${level ? ` ${level}` : ''}`;

      const latestDelta = latestEnriched?.deltaTokens ?? null;
      if (latestDelta !== null) {
        const tone = deltaTone(latestDelta);
        deltaEl.textContent = `Δ ${fmtDelta(latestDelta)}`;
        deltaEl.className = `delta-badge${tone !== 'muted' ? ` ${tone}` : ''}`;
      } else {
        deltaEl.classList.add('hidden');
      }

      pctEl.textContent = `${pct.toFixed(1)}%`;
      pctEl.className = `pct-badge${level ? ` ${level}` : ''}`;

      trackEl.className = `bar-track${level ? ` ${level}` : ''}`;
      const cacheWidth = Math.min(100, budget > 0 ? (latest.cacheReadTokens / budget) * 100 : 0);
      const inputWidth = Math.min(100 - cacheWidth, budget > 0 ? (latest.inputTokens / budget) * 100 : 0);
      $('bar-cache').style.width = `${cacheWidth.toFixed(2)}%`;
      $('bar-input').style.width = `${inputWidth.toFixed(2)}%`;

      const approachingAutoCompact = budget > AUTO_COMPACT_TOKENS && latest.contextTokens >= AUTO_COMPACT_WARN_TOKENS;
      if (pct >= 90) {
        hintTextEl.textContent = 'Near limit — run /compact to reclaim context';
        hintEl.className = 'compact-hint danger';
      } else if (pct >= 75) {
        hintTextEl.textContent = 'Context above 75% — consider running /compact';
        hintEl.className = 'compact-hint';
      } else if (approachingAutoCompact) {
        hintTextEl.textContent = 'Approaching ~512K default auto-compact threshold';
        hintEl.className = 'compact-hint';
      } else {
        hintEl.classList.add('hidden');
      }

      $('m-input').textContent = fmtNum(latest.inputTokens);
      $('m-cache').textContent = fmtNum(latest.cacheReadTokens);
      $('m-cache-rate').textContent = `(${cachePct.toFixed(1)}%)`;
      $('m-output').textContent = fmtNum(latest.outputTokens);
    }

    const compactPart = snap.compactionCount ? ` · Compacts: ${snap.compactionCount}` : '';
    $('session-totals').textContent =
      `Turns: ${snap.userTurnCount} · Steps: ${snap.stepCount}${compactPart} · Total Out: ${fmtNum(snap.totals.outputTokens)}`;

    renderTable(enriched);
    renderChart(enriched);
  }

  function updateStatusPill(isError = false) {
    const pill = $('live-pill');
    const liveText = $('live-text');
    if (isError) {
      pill.classList.add('error');
      pill.classList.remove('compacting');
      liveText.textContent = 'Offline';
      return;
    }
    pill.classList.remove('error');
    const compacting = Boolean(state.snapshot?.isCompacting);
    pill.classList.toggle('compacting', compacting);
    liveText.textContent = compacting ? 'Compacting…' : 'Live';
  }

  function scheduleNextPoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (document.visibilityState === 'hidden') return;
    const delay = state.errorStreak > 0
      ? Math.min(MAX_BACKOFF_MS, POLL_MS * Math.pow(2, state.errorStreak - 1))
      : POLL_MS;
    state.pollTimer = setTimeout(poll, delay);
  }

  function startAgeTimer() {
    if (state.ageTimer) clearInterval(state.ageTimer);
    if (document.visibilityState === 'hidden') return;
    state.ageTimer = setInterval(renderUpdatedMeta, AGE_TICK_MS);
  }

  function stopAgeTimer() {
    if (state.ageTimer) {
      clearInterval(state.ageTimer);
      state.ageTimer = null;
    }
  }

  async function poll() {
    if (state.inFlight) return;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    state.inFlight = true;
    try {
      const data = await fetchContext();
      state.errorStreak = 0;
      if (!data.unchanged) {
        state.etag = data.etag || '';
        state.snapshot = data;
        render();
      }
      updateStatusPill(false);
    } catch {
      state.errorStreak += 1;
      updateStatusPill(true);
      if (!state.snapshot) render();
    } finally {
      state.inFlight = false;
      scheduleNextPoll();
    }
  }

  async function copyCompactCommand() {
    const btn = $('copy-compact-btn');
    const text = '/compact';
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (!btn) return;
    if (state.copyTimer) clearTimeout(state.copyTimer);
    btn.textContent = ok ? 'Copied' : 'Type /compact';
    btn.classList.toggle('copied', ok);
    state.copyTimer = setTimeout(() => {
      btn.textContent = 'Copy /compact';
      btn.classList.remove('copied');
    }, 1500);
  }

  const budgetSelect = $('budget-select');
  if ([...budgetSelect.options].some((o) => Number(o.value) === state.budget)) {
    budgetSelect.value = String(state.budget);
  }
  budgetSelect.addEventListener('change', () => {
    state.budget = Number(budgetSelect.value) || 512000;
    localStorage.setItem(BUDGET_STORAGE_KEY, String(state.budget));
    render();
  });

  $('live-pill').addEventListener('click', () => {
    if (!state.inFlight) poll();
  });

  $('copy-compact-btn').addEventListener('click', copyCompactCommand);

  const turnsBody = $('turns-body');
  turnsBody.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-step-key]');
    setLinkedKey(tr ? tr.dataset.stepKey : null);
  });
  turnsBody.addEventListener('mouseleave', () => setLinkedKey(null));

  function wakePoll() {
    if (document.visibilityState === 'hidden') return;
    renderUpdatedMeta();
    startAgeTimer();
    if (!state.inFlight) poll();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      stopAgeTimer();
    } else {
      wakePoll();
    }
  });
  window.addEventListener('focus', wakePoll);
  window.addEventListener('pageshow', wakePoll);

  startAgeTimer();
  poll();
})();
