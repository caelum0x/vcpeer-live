'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../src/lib/rateLimit');

test('createRateLimiter allows up to max requests within the window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  const now = 0;
  assert.equal(limiter.check('a', now).limited, false);
  assert.equal(limiter.check('a', now).limited, false);
  assert.equal(limiter.check('a', now).limited, false);
  const fourth = limiter.check('a', now);
  assert.equal(fourth.limited, true);
  assert.ok(fourth.retryAfterMs > 0);
});

test('createRateLimiter resets after the window elapses', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('a', 0).limited, false);
  assert.equal(limiter.check('a', 500).limited, true);
  assert.equal(limiter.check('a', 1000).limited, false);
});

test('createRateLimiter tracks keys independently', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('a', 0).limited, false);
  assert.equal(limiter.check('b', 0).limited, false);
  assert.equal(limiter.check('a', 0).limited, true);
  assert.equal(limiter.check('b', 0).limited, true);
});

test('createRateLimiter rejects a non-positive windowMs or max', () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }));
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }));
});
