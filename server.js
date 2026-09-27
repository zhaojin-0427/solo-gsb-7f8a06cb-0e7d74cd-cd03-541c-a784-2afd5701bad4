'use strict';

const path = require('path');
const express = require('express');
const { parseSrt, serializeSrt } = require('./src/srt');
const { parseSegments } = require('./src/segments');
const { remap } = require('./src/remap');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 前端复用与后端完全相同的纯逻辑模块（src/srt.js、src/wrap.js），无需构建
app.use('/src', express.static(path.join(__dirname, 'src')));

/**
 * POST /api/remap
 * body: { srt: string, segments: string }
 * 成功 200：{ srt, mappings, dropped, sourceRows, timeline, stats }
 * 输入有误 400：{ errors: [{ type, ... }] }，并指出对应条目
 */
app.post('/api/remap', (req, res) => {
  const { srt, segments } = req.body || {};

  if (typeof srt !== 'string' || srt.trim() === '') {
    return res.status(400).json({
      errors: [{ type: 'srt', block: 0, lines: [], message: 'SRT 字幕内容为空' }],
    });
  }
  if (typeof segments !== 'string' || segments.trim() === '') {
    return res.status(400).json({
      errors: [{ type: 'segment', line: 0, message: '剪辑段内容为空' }],
    });
  }

  const { cues, errors: srtErrors } = parseSrt(srt);
  const { segments: segs, errors: segErrors } = parseSegments(segments);

  const errors = [
    ...srtErrors.map((e) => ({ type: 'srt', ...e })),
    ...segErrors.map((e) => ({ type: 'segment', ...e })),
  ];
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  if (cues.length === 0) {
    return res.status(400).json({
      errors: [{ type: 'srt', block: 0, lines: [], message: '未解析出任何有效字幕条目' }],
    });
  }

  const result = remap(cues, segs);

  const stats = {
    sourceCount: cues.length,
    segmentCount: segs.length,
    outputCount: result.mappings.length,
    usedCount: result.sourceRows.filter((r) => r.status === 'used').length,
    missedCount: result.sourceRows.filter((r) => r.status === 'missed').length,
    zeroLengthSourceCount: result.sourceRows.filter((r) => r.status === 'zero-length').length,
    droppedFragmentCount: result.dropped.length,
    totalDurationMs: result.totalDurationMs,
    totalDurationExactMs: result.totalDurationExactMs,
  };

  return res.json({
    srt: serializeSrt(result.mappings),
    mappings: result.mappings,
    dropped: result.dropped,
    sourceRows: result.sourceRows,
    timeline: result.timeline,
    stats,
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`字幕剪辑重排服务已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
