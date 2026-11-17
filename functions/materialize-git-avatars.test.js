'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchImage } = require('./materialize-git-avatars');
const url = 'https://avatars.githubusercontent.com/u/123?v=4';
const png = Buffer.from('89504e470d0a1a0a0102', 'hex');
const response = (bytes, type) => ({ ok: true, headers: { get: key => key === 'content-type' ? type : null },
  body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
test('fetches bounded signature-checked image from allowed host', async () => {
  const data = await fetchImage(url, async (target, options) => {
    assert.equal(new URL(target).searchParams.get('s'), '96');
    assert.equal(options.redirect, 'error');
    return response(png, 'image/png');
  });
  assert.equal(data, `data:image/png;base64,${png.toString('base64')}`);
});
test('rejects unsafe URLs, misleading MIME and oversized bodies', async () => {
  await assert.rejects(fetchImage('https://example.com/u/1', async () => { throw new Error('must not fetch'); }));
  await assert.rejects(fetchImage(url, async () => response(png, 'image/svg+xml')));
  await assert.rejects(fetchImage(url, async () => response(Buffer.from('wrong'), 'image/png')));
  await assert.rejects(fetchImage(url, async () => response(Buffer.alloc(128001), 'image/png')));
});
