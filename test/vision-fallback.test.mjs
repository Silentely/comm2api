import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, reloadConfig, VALID_CONFIG_KEYS } from '../lib/config.mjs';
import { modelSupportsVision } from '../lib/models.mjs';
import { setup } from './helpers.mjs';

function sseLines(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── 1. Unit Tests: Config & Model Metadata ────────────────────────────

test('config: visionFallbackModel defaults to empty and is persistable', () => {
  assert.equal(typeof CFG.visionFallbackModel, 'string');
  assert.equal(CFG.visionFallbackModel, '');
  assert.ok(VALID_CONFIG_KEYS.has('visionFallbackModel'));
});

test('models: modelSupportsVision identifies text-only and vision models', () => {
  assert.equal(typeof modelSupportsVision, 'function');
  assert.equal(modelSupportsVision('deepseek/deepseek-v4.1-flash'), false);
  assert.equal(modelSupportsVision('deepseek/deepseek-v4-pro'), false);
  assert.equal(modelSupportsVision('moonshotai/Kimi-K2.6'), false);
  assert.equal(modelSupportsVision('claude-sonnet-4-6'), true);
  assert.equal(modelSupportsVision('gpt-5.5'), true);
  assert.equal(modelSupportsVision('gpt-5.4-mini'), true);
  assert.equal(modelSupportsVision('google/gemini-3.5-flash'), true);
});

// ── 2. E2E: Chat Completions Vision Fallback ──────────────────────────

test('chat/completions: image sent to text model is transcribed and replaced with <image_description>', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // Helper transcription request
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(JSON.stringify({ type: 'text-start' }) + '\n');
          res.write(JSON.stringify({ type: 'text-delta', text: 'A small transparent square.' }) + '\n');
          res.write(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
          res.end();
          return true;
        }
      }
      return false;
    },
  });

  try {
    const res = await s.proxy.post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this image:' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
      stream: false,
    }, { 'Authorization': 'Bearer user_test_key' });

    assert.equal(res.status, 200);

    const generateCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 2, 'Should make helper transcription call then main call');

    // Call 1: Helper transcription call
    const helperBody = JSON.parse(generateCalls[0].raw);
    assert.equal(helperBody.params.model, 'gpt-5.6-luna');
    assert.equal(helperBody.params.messages[0].content.some(c => c.type === 'image'), true);

    // Call 2: Main downstream call
    const mainBody = JSON.parse(generateCalls[1].raw);
    assert.equal(mainBody.params.model, 'deepseek/deepseek-v4.1-flash');
    // Ensure no image blocks remain
    const hasImage = mainBody.params.messages.some(m => m.content.some(c => c.type === 'image'));
    assert.equal(hasImage, false, 'Main call must not contain image blocks');

    const combinedText = mainBody.params.messages
      .flatMap(m => m.content)
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    assert.match(combinedText, /<image_description index="1">/);
    assert.match(combinedText, /A small transparent square\./);
    assert.match(combinedText, /<\/image_description>/);
  } finally {
    await s.close();
  }
});

// ── 3. E2E: Messages Vision Fallback ──────────────────────────────────

test('messages: image sent to text model via /v1/messages is transcribed and replaced', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(JSON.stringify({ type: 'text-start' }) + '\n');
          res.write(JSON.stringify({ type: 'text-delta', text: 'Anthropic test image description.' }) + '\n');
          res.write(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
          res.end();
          return true;
        }
      }
      return false;
    },
  });

  try {
    const res = await s.proxy.post('/v1/messages', {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect:' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            },
          ],
        },
      ],
      max_tokens: 100,
    }, { 'x-api-key': 'user_test_key' });

    assert.equal(res.status, 200);

    const generateCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 2);

    const mainBody = JSON.parse(generateCalls[1].raw);
    assert.equal(mainBody.params.model, 'deepseek/deepseek-v4.1-flash');

    const combinedText = mainBody.params.messages
      .flatMap(m => m.content)
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    assert.match(combinedText, /<image_description index="1">/);
    assert.match(combinedText, /Anthropic test image description\./);
  } finally {
    await s.close();
  }
});

// ── 4. E2E: Vision Model Passthrough ──────────────────────────────────

test('vision model: images pass through directly without fallback transcription', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
  });

  try {
    const res = await s.proxy.post('/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this:' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
      stream: false,
    }, { 'Authorization': 'Bearer user_test_key' });

    assert.equal(res.status, 200);

    const generateCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 1, 'Only 1 generate call should be made');

    const mainBody = JSON.parse(generateCalls[0].raw);
    assert.equal(mainBody.params.model, 'claude-sonnet-4-6');
    assert.equal(mainBody.params.messages[0].content.some(c => c.type === 'image'), true, 'Image must be preserved');
  } finally {
    await s.close();
  }
});

// ── 5. E2E: Transcription Failure Degradation ─────────────────────────

test('fallback error: transcription failure gracefully degrades to placeholder without failing request', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // Simulate upstream failure for transcription
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Vision model internal error' } }));
          return true;
        }
      }
      return false;
    },
  });

  try {
    const res = await s.proxy.post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello image:' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
      stream: false,
    }, { 'Authorization': 'Bearer user_test_key' });

    assert.equal(res.status, 200);

    const generateCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 2);

    const mainBody = JSON.parse(generateCalls[1].raw);
    const combinedText = mainBody.params.messages
      .flatMap(m => m.content)
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    assert.match(combinedText, /\[Image transcription failed: /);
  } finally {
    await s.close();
  }
});

// ── 6. E2E: Recursion Fuse _isVisionHelper ────────────────────────────

test('recursion fuse: _isVisionHelper=true prevents recursive vision fallback', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
  });

  try {
    const res = await s.proxy.post('/v1/chat/completions', {
      _isVisionHelper: true,
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe image:' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
      stream: false,
    }, { 'Authorization': 'Bearer user_test_key' });

    assert.equal(res.status, 200);

    const generateCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 1, 'Should NOT trigger fallback helper call when _isVisionHelper is true');
  } finally {
    await s.close();
  }
});

// ── 7. E2E: Cancellation Propagation ──────────────────────────────────

test('cancellation: client abort during vision fallback aborts the helper request', async () => {
  let helperAborted = false;
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // Hang helper response until aborted
          res.on('close', () => {
            helperAborted = true;
          });
          // Do not reply immediately
          return true;
        }
      }
      return false;
    },
  });

  try {
    const clientAbort = new AbortController();
    const reqPromise = fetch(s.proxy.base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer user_test_key',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this:' },
              { type: 'image_url', image_url: { url: TINY_PNG } },
            ],
          },
        ],
      }),
      signal: clientAbort.signal,
    }).catch(() => {});

    // Wait a brief moment for helper request to start
    await new Promise(r => setTimeout(r, 100));

    // Abort the client request
    clientAbort.abort();
    await reqPromise;

    // Allow time for proxy to abort the helper request
    await new Promise(r => setTimeout(r, 200));

    assert.equal(helperAborted, true, 'Helper request should have been aborted when client disconnected');
  } finally {
    await s.close();
  }
});
