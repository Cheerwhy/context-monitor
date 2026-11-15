(() => {
  const POLL_MS = 1500;
  const REQUEST_TIMEOUT_MS = 4000;
  const MAX_BACKOFF_MS = 10000;
  const MAX_BARS = 36;
  const MAX_ROWS = 20;
  const BUDGET_STORAGE_KEY = 'context_monitor_budget';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    etag: '',
    snapshot: null,
    budget: Number(localStorage.getItem(BUDGET_STORAGE_KEY)) || 1000000,
    inFlight: false,
    pollTimer: null,
    errorStreak: 0,
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
    if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  };
  const fmtElapsed = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

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

  function renderChart(steps) {
    const barsEl = $('chart-bars');
    const tipEl = $('chart-tooltip');
    const slice = steps.slice(-MAX_BARS);
    const maxCtx = Math.max(1, ...slice.map((s) => s.contextTokens));
    const hasCompact = slice.some((s) => s.compacted);

    $('chart-range').textContent = slice.length
      ? `Step ${slice[0].stepIndex} – ${slice[slice.length - 1].stepIndex} (Peak ${fmtCompact(maxCtx)})`
      : '';
    $('compact-legend').classList.toggle('hidden', !hasCompact);

    tipEl.classList.add('hidden');
    barsEl.innerHTML = '';
    const bindTip = (el, html) => {
      const show = () => {
        tipEl.innerHTML = html;
        tipEl.classList.remove('hidden');
      };
      const hide = () => tipEl.classList.add('hidden');
      el.addEventListener('mouseenter', show);
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', show);
      el.addEventListener('blur', hide);
    };

    for (const s of slice) {
      const col = document.createElement('div');
      col.tabIndex = 0;
      col.setAttribute('role', 'button');

      if (s.kind === 'checkpoint') {
        col.className = 'bar-col compact-marker';
        col.setAttribute('aria-label', `Step ${s.stepIndex}, compacted, summary output ${fmtNum(s.outputTokens)}`);
        const line = document.createElement('div');
        line.className = 'bar-compact-line';
        col.appendChild(line);
        bindTip(
          col,
          [
            `<div><strong>Step ${s.stepIndex}</strong> · Compacted</div>`,
            `<div>Previous: ${fmtNum(s.preCompactTokens)} → Reset</div>`,
            `<div>Summary Out: ${fmtNum(s.outputTokens)}</div>`,
          ].join(''),
        );
        barsEl.appendChild(col);
        continue;
      }

      col.className = `bar-col${s.compacted ? ' compacted' : ''}`;
      col.setAttribute(
        'aria-label',
        `Step ${s.stepIndex}${s.compacted ? ', compacted' : ''}, context ${fmtNum(s.contextTokens)} tokens`,
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
      bindTip(
        col,
        [
          `<div><strong>Step ${s.stepIndex}</strong>${s.compacted ? ' (Compacted)' : ''}</div>`,
          `<div>Context: ${fmtNum(s.contextTokens)}</div>`,
          `<div>New: ${fmtNum(s.inputTokens)} | Cache: ${fmtNum(s.cacheReadTokens)}</div>`,
          `<div>Out: ${fmtNum(s.outputTokens)}</div>`,
        ].join(''),
      );
      barsEl.appendChild(col);
    }
  }

  function renderTable(steps) {
    const rows = steps.slice(-MAX_ROWS).reverse();
    $('turns-count').textContent = `${rows.length} of ${steps.length} steps`;
    $('turns-body').innerHTML = rows
      .map((s) => {
        if (s.kind === 'checkpoint') {
          return `
            <tr class="compact-row">
              <td>#${s.stepIndex}<span class="compact-tag">Compact</span></td>
              <td class="action-cell" title="Context compacted">Context compacted</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num">${fmtCompact(s.outputTokens)}</td>
              <td class="num">${fmtElapsed(s.elapsedMs)}</td>
            </tr>
          `;
        }
        const action = s.tools.length ? s.tools.join(', ') : 'Reply';
        const compactTag = s.compacted ? '<span class="compact-tag">Compacted</span>' : '';
        return `
          <tr>
            <td>#${s.stepIndex}${compactTag}</td>
            <td class="action-cell" title="${esc(action)}">${esc(action)}</td>
            <td class="num">${fmtCompact(s.inputTokens)}</td>
            <td class="num">${fmtCompact(s.cacheReadTokens)}</td>
            <td class="num">${fmtCompact(s.outputTokens)}</td>
            <td class="num">${fmtElapsed(s.elapsedMs)}</td>
          </tr>
        `;
      })
      .join('');
  }

  function render() {
    const snap = state.snapshot;
    $('loading-state')?.classList.add('hidden');
    if (!snap || !snap.available || (!snap.latest && !snap.pendingCompaction)) {
      $('empty-state').classList.remove('hidden');
      $('content').classList.add('hidden');
      $('conv-meta').textContent = snap?.conversationId
        ? `Session: ${snap.conversationId.slice(0, 8)}…`
        : 'Waiting for active session…';
      return;
    }

    $('empty-state').classList.add('hidden');
    $('content').classList.remove('hidden');

    const shortId = snap.conversationId ? `${snap.conversationId.slice(0, 8)}…` : 'unknown';
    $('conv-meta').textContent = snap.isFallback
      ? `Latest session: ${shortId} (fallback)`
      : `Session: ${shortId}`;

    const budget = state.budget;
    const pctEl = $('pct-badge');
    const trackEl = $('bar-track');

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
        const wasPart = pc.preCompactTokens > 0 ? ` · was ${fmtCompact(pc.preCompactTokens)}` : '';
        const savedPart = savedPct !== null ? ` (-${savedPct}% est.)` : '';
        $('ctx-budget').textContent = `/ ${fmtNum(budget)} tokens${wasPart}${savedPart} · exact on next turn`;
      } else {
        $('ctx-budget').textContent = pc.preCompactTokens > 0
          ? `· was ${fmtNum(pc.preCompactTokens)} · awaiting next turn`
          : '· awaiting next turn';
      }
      pctEl.textContent = hasEst ? `~${estPct.toFixed(1)}% · Reset` : 'Reset';
      pctEl.className = 'pct-badge compacted';

      trackEl.classList.toggle('estimated', hasEst);
      $('bar-cache').style.width = '0%';
      $('bar-input').style.width = hasEst ? `${Math.min(100, estPct).toFixed(2)}%` : '0%';

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
      const cachePct = latest.cacheHitRate * 100;

      trackEl.classList.remove('estimated');
      $('m-input-label').textContent = 'New Input';
      $('m-cache-label').textContent = 'Cache Read';
      $('m-output-label').textContent = 'Output';

      $('ctx-total').textContent = fmtNum(latest.contextTokens);
      $('ctx-budget').textContent = `/ ${fmtNum(budget)} tokens`;

      pctEl.textContent = `${pct.toFixed(1)}%`;
      pctEl.className = `pct-badge${pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : ''}`;

      const cacheWidth = Math.min(100, budget > 0 ? (latest.cacheReadTokens / budget) * 100 : 0);
      const inputWidth = Math.min(100 - cacheWidth, budget > 0 ? (latest.inputTokens / budget) * 100 : 0);
      $('bar-cache').style.width = `${cacheWidth.toFixed(2)}%`;
      $('bar-input').style.width = `${inputWidth.toFixed(2)}%`;

      $('m-input').textContent = fmtNum(latest.inputTokens);
      $('m-cache').textContent = fmtNum(latest.cacheReadTokens);
      $('m-cache-rate').textContent = `(${cachePct.toFixed(1)}%)`;
      $('m-output').textContent = fmtNum(latest.outputTokens);
    }

    const compactPart = snap.compactionCount ? ` · Compacts: ${snap.compactionCount}` : '';
    $('session-totals').textContent =
      `Turns: ${snap.userTurnCount} · Steps: ${snap.stepCount}${compactPart} · Total Output: ${fmtNum(snap.totals.outputTokens)} tokens`;

    renderChart(snap.steps);
    renderTable(snap.steps);
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

  const budgetSelect = $('budget-select');
  if ([...budgetSelect.options].some((o) => Number(o.value) === state.budget)) {
    budgetSelect.value = String(state.budget);
  }
  budgetSelect.addEventListener('change', () => {
    state.budget = Number(budgetSelect.value) || 1000000;
    localStorage.setItem(BUDGET_STORAGE_KEY, String(state.budget));
    render();
  });

  $('live-pill').addEventListener('click', () => {
    if (!state.inFlight) poll();
  });

  function wakePoll() {
    if (document.visibilityState === 'hidden') return;
    if (!state.inFlight) poll();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
    } else {
      wakePoll();
    }
  });
  window.addEventListener('focus', wakePoll);
  window.addEventListener('pageshow', wakePoll);

  poll();
})();
