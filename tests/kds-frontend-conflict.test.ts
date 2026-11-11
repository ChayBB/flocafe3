import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'frontend/src/hooks/useKdsConnection.ts'),
  'utf8',
);
const conflictBranch = source.match(/if \(statusCode === 409\) \{[\s\S]*?\n\s*return;/)?.[0] || '';

assert.match(
  conflictBranch,
  /await fetchOrdersRest\(\);/,
  'KDS conflicts refresh REST state even with an active WebSocket',
);
assert.doesNotMatch(
  conflictBranch,
  /wsRef\.current === null/,
  'KDS conflict refresh is not gated on WebSocket absence',
);

// After a socket drops, wsRef keeps the closed socket for the reconnect timer. Gating the
// post-success refresh on `wsRef.current === null` left the board stale, so a re-tap hit 409.
const updateItemStatus =
  source.match(/const updateItemStatus = useCallback\([\s\S]*?\n\s*\} catch/)?.[0] || '';
const successBranch = updateItemStatus.slice(updateItemStatus.indexOf('await api.patch('));
assert.ok(successBranch.length > 0, 'updateItemStatus success branch is present');
assert.match(
  successBranch,
  /wsRef\.current\?\.readyState !== WebSocket\.OPEN[\s\S]*?await fetchOrdersRest\(\);[\s\S]*?toast\.success/,
  'KDS refreshes REST state before the success toast whenever the WebSocket is not open',
);
assert.doesNotMatch(
  successBranch,
  /wsRef\.current === null/,
  'KDS success refresh is not gated on WebSocket absence',
);
console.log('✅ KDS frontend conflict refresh regression test passed');
