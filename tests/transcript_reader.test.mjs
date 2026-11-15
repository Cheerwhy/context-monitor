import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscript,
  readContextSnapshot,
  resolveTranscript,
  transcriptPathFor,
} from '../sidecars/context_monitor/transcript_reader.mjs';

function withTempAppData(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cm-test-'));
  const dataDir = join(root, 'sidecar_data', 'context-monitor', 'context_monitor', 'data');
  mkdirSync(join(root, 'brain'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const prev = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = dataDir;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

function writeTranscript(appData, convId, content) {
  const file = transcriptPathFor(appData, convId);
  mkdirSync(join(appData, 'brain', convId, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  return file;
}

test('parseTranscript computes tokens, cache hit rate, tools, and elapsed time', () => {
  const lines = [
    JSON.stringify({ type: 'USER_INPUT', step_index: 0, created_at: '2026-11-14T10:00:00.000Z' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      created_at: '2026-11-14T10:00:02.500Z',
      input_tokens: 200,
      cache_read_tokens: 800,
      output_tokens: 50,
      tool_calls: [{ name: 'read_file' }, { name: '' }],
    }),
    'not-valid-json',
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 2,
      created_at: '2026-11-14T10:00:04.000Z',
      input_tokens: 100,
      cache_read_tokens: 1100,
      output_tokens: 80,
    }),
  ].join('\n');

  const res = parseTranscript(lines);
  assert.equal(res.userTurnCount, 1);
  assert.equal(res.stepCount, 2);
  assert.equal(res.compactionCount, 0);
  assert.deepEqual(res.totals, { inputTokens: 300, cacheReadTokens: 1900, outputTokens: 130 });
  assert.equal(res.latest.contextTokens, 1200);
  assert.equal(res.latest.elapsedMs, 1500);
  assert.deepEqual(res.steps[0].tools, ['read_file']);
  assert.ok(Math.abs(res.steps[0].cacheHitRate - 0.8) < 1e-9);
});

test('parseTranscript handles CHECKPOINT, compacting state, and sudden context drop compaction', () => {
  const compactPending = parseTranscript(
    [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 100,
      }),
      JSON.stringify({
        type: 'USER_INPUT',
        step_index: 2,
        content: '<USER_REQUEST>\n/compact \n</USER_REQUEST>',
      }),
    ].join('\n'),
  );
  assert.equal(compactPending.isCompacting, true);

  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      input_tokens: 1000,
      cache_read_tokens: 9000,
      output_tokens: 100,
    }),
    JSON.stringify({
      type: 'USER_INPUT',
      step_index: 2,
      content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>',
    }),
    JSON.stringify({
      type: 'CHECKPOINT',
      step_index: 3,
      output_tokens: 300,
    }),
  ].join('\n');

  const mid = parseTranscript(lines);
  assert.equal(mid.isCompacting, false);
  assert.equal(mid.compactionCount, 1);
  assert.ok(mid.pendingCompaction);
  assert.equal(mid.pendingCompaction.preCompactTokens, 10000);
  assert.equal(mid.pendingCompaction.summaryOutputTokens, 300);
  assert.equal(mid.pendingCompaction.baseContextTokens, 10000);
  assert.equal(mid.pendingCompaction.estimatedPostTokens, 10000);

  const scaled = parseTranscript(
    [
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 0, input_tokens: 15000, cache_read_tokens: 0, output_tokens: 50 }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 5000, cache_read_tokens: 95000, output_tokens: 50 }),
      JSON.stringify({ type: 'CHECKPOINT', step_index: 2, output_tokens: 11000, content: 'x'.repeat(3600) }),
    ].join('\n'),
  );
  assert.equal(scaled.pendingCompaction.baseContextTokens, 15000);
  assert.equal(scaled.pendingCompaction.estimatedPostTokens, 19000);

  const after = parseTranscript(
    lines +
      '\n' +
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 4,
        input_tokens: 500,
        cache_read_tokens: 1500,
        output_tokens: 40,
      }),
  );
  assert.equal(after.isCompacting, false);
  assert.equal(after.pendingCompaction, null);
  assert.equal(after.latest.compacted, true);
  assert.equal(after.latest.contextTokens, 2000);

  const dropOnly = parseTranscript(
    [
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 0, input_tokens: 5000, cache_read_tokens: 5000, output_tokens: 10 }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 1000, cache_read_tokens: 1000, output_tokens: 10 }),
    ].join('\n'),
  );
  assert.equal(dropOnly.latest.compacted, true);
});

test('readContextSnapshot incrementally reads appended lines and waits for partial trailing JSON', () => {
  withTempAppData((appData) => {
    const convId = '11111111-1111-1111-1111-111111111111';
    const first = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      input_tokens: 100,
      cache_read_tokens: 400,
      output_tokens: 20,
    });
    const second = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 2,
      input_tokens: 50,
      cache_read_tokens: 550,
      output_tokens: 30,
    });

    const file = writeTranscript(appData, convId, `${first}\n${second.slice(0, 18)}`);
    const snap1 = readContextSnapshot(convId);
    assert.equal(snap1.available, true);
    assert.equal(snap1.stepCount, 1);
    assert.equal(snap1.latest.contextTokens, 500);

    const unchanged = readContextSnapshot(convId, snap1.etag);
    assert.equal(unchanged.unchanged, true);

    appendFileSync(file, `${second.slice(18)}\n`, 'utf-8');
    const snap2 = readContextSnapshot(convId, snap1.etag);
    assert.equal(snap2.stepCount, 2);
    assert.equal(snap2.latest.contextTokens, 600);
    assert.deepEqual(snap2.totals, { inputTokens: 150, cacheReadTokens: 950, outputTokens: 50 });

    // Truncated/rewritten file resets incremental parser cleanly
    writeFileSync(file, `${second}\n`, 'utf-8');
    const snap3 = readContextSnapshot(convId, snap2.etag);
    assert.equal(snap3.stepCount, 1);
    assert.deepEqual(snap3.totals, { inputTokens: 50, cacheReadTokens: 550, outputTokens: 30 });
  });
});

test('readContextSnapshot handles transcripts spanning multiple 64KB chunks', () => {
  withTempAppData((appData) => {
    const convId = '22222222-2222-2222-2222-222222222222';
    const pad = 'x'.repeat(2048);
    const rows = [];
    for (let i = 0; i < 45; i += 1) {
      rows.push(
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: i,
          input_tokens: 10,
          cache_read_tokens: 90,
          output_tokens: 5,
          content: pad,
        }),
      );
    }
    writeTranscript(appData, convId, `${rows.join('\n')}\n`);
    const snap = readContextSnapshot(convId);
    assert.equal(snap.stepCount, 45);
    assert.equal(snap.totals.outputTokens, 225);
  });
});

test('resolveTranscript disables cross-session fallback by default and blocks symlink escapes', () => {
  withTempAppData((appData) => {
    const convId = '33333333-3333-3333-3333-333333333333';
    writeTranscript(
      appData,
      convId,
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 10, cache_read_tokens: 10, output_tokens: 1 }) + '\n',
    );

    const noConvDefault = resolveTranscript('');
    assert.equal(noConvDefault.path, null);
    assert.equal(noConvDefault.isFallback, false);

    const traversal = resolveTranscript('../outside-id');
    assert.equal(traversal.path, null);

    const withFallback = resolveTranscript('', { allowFallback: true });
    assert.equal(withFallback.convId, convId);
    assert.equal(withFallback.isFallback, true);

    const outsideFile = join(appData, 'secret.jsonl');
    writeFileSync(outsideFile, '{"type":"USER_INPUT"}\n', 'utf-8');
    const escapedConv = '44444444-4444-4444-4444-444444444444';
    mkdirSync(join(appData, 'brain', escapedConv, '.system_generated', 'logs'), { recursive: true });
    symlinkSync(outsideFile, transcriptPathFor(appData, escapedConv));
    const escapedRes = resolveTranscript(escapedConv);
    assert.equal(escapedRes.path, null);
  });
});
