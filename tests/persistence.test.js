import test from 'node:test';
import assert from 'node:assert/strict';
import { store, serializeStore, hydrateStore, createStore } from '../src/platform.js';

test('serializeStore -> hydrateStore round-trip preserves Map-based data exactly (users/orders/instances/notices/kv/tables/objects/audit)', () => {
  const original = createStore();
  original.users.set('admin@test.com', { id: 'user_1', email: 'admin@test.com', name: '관리자', roles: ['admin'] });
  original.orders.set('bill_1', { id: 'bill_1', userId: 'user_1', amountUsd: 14 });
  original.instances.set('inst_1', { id: 'inst_1', userId: 'user_1', type: 'wordpress' });
  original.notices.set('notice_1', { id: 'notice_1', title: '공지', body: '내용' });
  original.kv.set('user_1:wp:option:siteurl', { value: 'https://example.com', updatedAt: '2026-01-01T00:00:00.000Z' });
  const postsTable = [{ id: '1', title: '첫 글' }];
  original.tables.set('user_1', new Map([['posts', postsTable]]));
  original.objects.set('user_1:hello.txt', { name: 'hello.txt', size: 5, sha256: 'deadbeef', payload: 'hello', createdAt: '2026-01-01T00:00:00.000Z' });
  original.audit.push({ id: 'audit_1', actor: 'user_1', action: 'user.signup', meta: {}, at: '2026-01-01T00:00:00.000Z' });

  const snapshot = serializeStore(original);
  // GitHub에 실제로 올라가는 형태이므로 JSON 직렬화 가능해야 한다 (Map은 JSON.stringify로 깨지므로 변환이 꼭 필요).
  const roundTripped = JSON.parse(JSON.stringify(snapshot));

  const restored = createStore();
  hydrateStore(roundTripped, restored);

  assert.deepEqual(restored.users.get('admin@test.com'), original.users.get('admin@test.com'));
  assert.deepEqual(restored.orders.get('bill_1'), original.orders.get('bill_1'));
  assert.deepEqual(restored.instances.get('inst_1'), original.instances.get('inst_1'));
  assert.deepEqual(restored.notices.get('notice_1'), original.notices.get('notice_1'));
  assert.deepEqual(restored.kv.get('user_1:wp:option:siteurl'), original.kv.get('user_1:wp:option:siteurl'));
  assert.deepEqual(restored.tables.get('user_1').get('posts'), postsTable);
  assert.deepEqual(restored.objects.get('user_1:hello.txt'), original.objects.get('user_1:hello.txt'));
  assert.deepEqual(restored.audit, original.audit);
});

test('hydrateStore is a no-op when snapshot is null/undefined (fresh repo, nothing to restore)', () => {
  const s = createStore();
  s.users.set('keep@me.com', { id: 'user_keep' });
  hydrateStore(null, s);
  assert.ok(s.users.has('keep@me.com')); // 기존 메모리 데이터가 지워지지 않아야 한다
});

test('serializeStore output is always a plain JSON-serializable object (no Map/Set leaking through)', () => {
  const snapshot = serializeStore(store);
  const text = JSON.stringify(snapshot);
  assert.ok(text.length > 0);
  const reparsed = JSON.parse(text);
  assert.ok(Array.isArray(reparsed.users));
  assert.ok(Array.isArray(reparsed.tables));
});
