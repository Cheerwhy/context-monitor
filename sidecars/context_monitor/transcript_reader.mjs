/**
 * Read-only local transcript reader and token telemetry parser for Antigravity.
 *
 * Reads: <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;
const COMPACT_DROP_RATIO = 0.8;
const COMPACT_CMD_RE = /(?:<USER_REQUEST>\s*|^)\/compact(?:\s|<\/USER_REQUEST>|$)/i;
const MAX_SUMMARY_EST_TOKENS = 6000;
const MAX_CACHE_ENTRIES = 16;
const CHUNK_SIZE = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const parseCache = new Map(); // path -> { etag, parsedBytes, state, parsed }

function touchCache(key, entry) {
  parseCache.delete(key);
  parseCache.set(key, entry);
  while (parseCache.size > MAX_CACHE_ENTRIES) {
    const oldest = parseCache.keys().next().value;
    parseCache.delete(oldest);
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statOf(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { mtimeMs: 0, size: -1 };
  }
}

/**
 * Discover Antigravity appData roots containing a `brain/` directory.
 */
export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, 'brain')));
}

export function transcriptPathFor(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function isInsideBrain(targetPath, appDataDir) {
  try {
    const brainRoot = realpathSync(join(appDataDir, 'brain'));
    const resolved = realpathSync(targetPath);
    const prefix = brainRoot.endsWith(sep) ? brainRoot : brainRoot + sep;
    return resolved.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * Resolve transcript path for a specific conversation ID.
 * Cross-session fallback to the newest transcript is disabled by default so
 * parallel/fresh panes never leak another conversation's context; pass
 * `{ allowFallback: true }` for explicit standalone debugging.
 */
export function resolveTranscript(requestedConvId = '', { allowFallback = false } = {}) {
  const appDataDirs = findAppDataDirs();
  const cleanId = typeof requestedConvId === 'string' ? requestedConvId.trim() : '';

  if (cleanId && ID_RE.test(cleanId)) {
    for (const appData of appDataDirs) {
      const p = transcriptPathFor(appData, cleanId);
      const st = statOf(p);
      if (st.size >= 0 && isInsideBrain(p, appData)) {
        return { convId: cleanId, path: p, isFallback: false, ...st };
      }
    }
    return { convId: cleanId, path: null, isFallback: false, mtimeMs: 0, size: -1 };
  }

  if (!allowFallback) {
    return { convId: cleanId || null, path: null, isFallback: false, mtimeMs: 0, size: -1 };
  }

  let newest = null;
  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const entry of safeReaddir(brainDir)) {
      if (!ID_RE.test(entry)) continue;
      const p = transcriptPathFor(appData, entry);
      const st = statOf(p);
      if (st.size < 0 || !isInsideBrain(p, appData)) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { convId: entry, path: p, isFallback: true, ...st };
      }
    }
  }
  return newest || { convId: cleanId || null, path: null, isFallback: !cleanId, mtimeMs: 0, size: -1 };
}

function createParserState() {
  return {
    steps: [],
    prevStepMs: null,
    prevContextTokens: 0,
    baseContextTokens: null,
    totalUserTurns: 0,
    modelStepCount: 0,
    compactionCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    latestModelStep: null,
    pendingCompaction: null,
    sawCheckpointSincePlanner: false,
    isCompacting: false,
  };
}

function estimateCheckpointSummaryTokens(obj, summaryOutputTokens) {
  if (summaryOutputTokens > 0 && summaryOutputTokens <= MAX_SUMMARY_EST_TOKENS) {
    return summaryOutputTokens;
  }
  const contentLen = typeof obj.content === 'string' ? obj.content.length : 0;
  if (contentLen > 0) {
    return Math.max(Math.ceil(contentLen / 3), 4000);
  }
  return summaryOutputTokens > 0 ? MAX_SUMMARY_EST_TOKENS : 0;
}

function applyTranscriptObject(state, obj) {
  if (!obj || typeof obj !== 'object') return;

  const tsMs = obj.created_at ? Date.parse(obj.created_at) : NaN;
  const elapsedMs =
    Number.isFinite(tsMs) && state.prevStepMs !== null && tsMs >= state.prevStepMs
      ? tsMs - state.prevStepMs
      : null;
  const rawStep = obj.step_index;
  const stepIndex = rawStep !== undefined && rawStep !== null && Number.isFinite(Number(rawStep))
    ? Number(rawStep)
    : state.steps.length;

  if (obj.type === 'USER_INPUT') {
    state.totalUserTurns += 1;
    state.isCompacting = typeof obj.content === 'string' && COMPACT_CMD_RE.test(obj.content);
  }

  if (obj.type === 'CHECKPOINT') {
    const summaryOutputTokens = Number(obj.output_tokens) || 0;
    const summaryEst = estimateCheckpointSummaryTokens(obj, summaryOutputTokens);
    const base = state.baseContextTokens || 0;
    const rawEst = base + summaryEst;
    const estimatedPostTokens = rawEst > 0
      ? (state.prevContextTokens > 0 ? Math.min(rawEst, state.prevContextTokens) : rawEst)
      : null;

    state.compactionCount += 1;
    state.totalOutputTokens += summaryOutputTokens;
    state.sawCheckpointSincePlanner = true;
    state.isCompacting = false;
    state.pendingCompaction = {
      stepIndex,
      createdAt: obj.created_at || null,
      preCompactTokens: state.prevContextTokens,
      summaryOutputTokens,
      baseContextTokens: state.baseContextTokens,
      estimatedPostTokens,
    };
    state.steps.push({
      kind: 'checkpoint',
      stepIndex,
      createdAt: obj.created_at || null,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: summaryOutputTokens,
      contextTokens: 0,
      cacheHitRate: 0,
      elapsedMs,
      compacted: true,
      preCompactTokens: state.prevContextTokens,
      tools: ['Compact'],
      status: obj.status || 'DONE',
    });
  }

  if (obj.type === 'PLANNER_RESPONSE') {
    const inputTokens = Number(obj.input_tokens) || 0;
    const cacheReadTokens = Number(obj.cache_read_tokens) || 0;
    const outputTokens = Number(obj.output_tokens) || 0;
    const contextTokens = inputTokens + cacheReadTokens;
    const cacheHitRate = contextTokens > 0 ? cacheReadTokens / contextTokens : 0;
    const compacted =
      state.sawCheckpointSincePlanner ||
      (state.prevContextTokens > 0 && contextTokens < state.prevContextTokens * COMPACT_DROP_RATIO);
    const tools = Array.isArray(obj.tool_calls)
      ? obj.tool_calls.map((tc) => tc?.name).filter((n) => typeof n === 'string' && n)
      : [];

    if (state.baseContextTokens === null && contextTokens > 0) {
      state.baseContextTokens = contextTokens;
    }

    state.modelStepCount += 1;
    state.totalInputTokens += inputTokens;
    state.totalCacheReadTokens += cacheReadTokens;
    state.totalOutputTokens += outputTokens;
    state.sawCheckpointSincePlanner = false;
    state.pendingCompaction = null;
    state.isCompacting = false;

    const step = {
      kind: 'step',
      stepIndex,
      createdAt: obj.created_at || null,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      contextTokens,
      cacheHitRate,
      elapsedMs,
      compacted,
      tools,
      status: obj.status || 'DONE',
    };
    state.steps.push(step);
    state.latestModelStep = step;
    state.prevContextTokens = contextTokens;
  }

  if (Number.isFinite(tsMs)) state.prevStepMs = tsMs;
}

function buildParsedResult(state) {
  return {
    stepCount: state.modelStepCount,
    compactionCount: state.compactionCount,
    userTurnCount: state.totalUserTurns,
    isCompacting: state.isCompacting,
    latest: state.latestModelStep,
    pendingCompaction: state.pendingCompaction,
    totals: {
      inputTokens: state.totalInputTokens,
      cacheReadTokens: state.totalCacheReadTokens,
      outputTokens: state.totalOutputTokens,
    },
    steps: state.steps,
  };
}

function parseJsonLine(state, rawBuf) {
  const line = rawBuf.toString('utf-8').trim();
  if (!line) return true;
  try {
    applyTranscriptObject(state, JSON.parse(line));
    return true;
  } catch {
    return false;
  }
}

/**
 * Incrementally read and parse JSONL lines in bounded 64KB chunks from `startOffset`,
 * avoiding large whole-file allocations on cold starts while stopping before partial
 * trailing lines that do not yet end with a newline.
 */
function consumeFileFromOffset(filePath, startOffset, state) {
  const fd = openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  let fileOffset = startOffset;
  let consumedBytes = startOffset;
  let pendingChunks = [];
  let pendingBytes = 0;
  let skippingOversize = false;

  try {
    while (true) {
      const n = readSync(fd, chunk, 0, CHUNK_SIZE, fileOffset);
      if (n <= 0) break;
      fileOffset += n;
      const slice = chunk.subarray(0, n);
      let start = 0;

      while (start < slice.length) {
        const nl = slice.indexOf(0x0a, start);
        if (nl < 0) break;
        const part = slice.subarray(start, nl);
        const lineLen = nl - start + 1;

        if (skippingOversize) {
          skippingOversize = false;
          consumedBytes += lineLen;
        } else if (pendingBytes > 0) {
          pendingChunks.push(part);
          const fullLine = Buffer.concat(pendingChunks, pendingBytes + part.length);
          parseJsonLine(state, fullLine);
          consumedBytes += pendingBytes + lineLen;
          pendingChunks = [];
          pendingBytes = 0;
        } else {
          parseJsonLine(state, part);
          consumedBytes += lineLen;
        }
        start = nl + 1;
      }

      if (start < slice.length) {
        const rem = slice.subarray(start);
        if (skippingOversize) {
          consumedBytes += rem.length;
        } else if (pendingBytes + rem.length > MAX_LINE_BYTES) {
          consumedBytes += pendingBytes + rem.length;
          pendingChunks = [];
          pendingBytes = 0;
          skippingOversize = true;
        } else {
          pendingChunks.push(Buffer.from(rem));
          pendingBytes += rem.length;
        }
      }
    }

    if (pendingBytes > 0 && !skippingOversize) {
      // Only advance past a trailing line without '\n' if it parses as valid JSON;
      // otherwise wait for the writer to finish flushing the line.
      const tail = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks, pendingBytes);
      if (parseJsonLine(state, tail)) {
        consumedBytes += pendingBytes;
      }
    }
  } finally {
    closeSync(fd);
  }

  return consumedBytes;
}

/**
 * Parse raw transcript.jsonl text into per-step and cumulative token metrics.
 */
export function parseTranscript(text) {
  const state = createParserState();
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      applyTranscriptObject(state, JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return buildParsedResult(state);
}

/**
 * Return cached or freshly/incrementally parsed snapshot for the requested conversation.
 */
export function readContextSnapshot(requestedConvId = '', clientEtag = '', options = {}) {
  const target = resolveTranscript(requestedConvId, options);
  if (!target.path) {
    const etag = `empty:${target.convId || ''}`;
    if (clientEtag && clientEtag === etag) {
      return { conversationId: target.convId, unchanged: true, etag };
    }
    return {
      conversationId: target.convId,
      isFallback: target.isFallback,
      available: false,
      stepCount: 0,
      compactionCount: 0,
      userTurnCount: 0,
      isCompacting: false,
      latest: null,
      pendingCompaction: null,
      totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      steps: [],
      etag,
    };
  }

  const etag = `${target.convId}:${target.mtimeMs}:${target.size}`;
  const hit = parseCache.get(target.path);
  if (clientEtag && clientEtag === etag) {
    if (hit) touchCache(target.path, hit);
    return { conversationId: target.convId, unchanged: true, etag };
  }

  let entry;
  if (hit && hit.etag === etag) {
    entry = hit;
  } else if (hit && target.size >= hit.parsedBytes && hit.parsedBytes > 0) {
    const parsedBytes = target.size > hit.parsedBytes
      ? consumeFileFromOffset(target.path, hit.parsedBytes, hit.state)
      : hit.parsedBytes;
    entry = { etag, parsedBytes, state: hit.state, parsed: buildParsedResult(hit.state) };
  } else {
    const state = createParserState();
    const parsedBytes = consumeFileFromOffset(target.path, 0, state);
    entry = { etag, parsedBytes, state, parsed: buildParsedResult(state) };
  }
  touchCache(target.path, entry);

  return {
    conversationId: target.convId,
    isFallback: target.isFallback,
    available: true,
    updatedAtMs: target.mtimeMs,
    ...entry.parsed,
    etag,
  };
}
