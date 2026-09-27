// Step 3 of /sync: group changes bump `mine` for every member (and `me` for
// the member whose own group list changed), plus bumpSyncMany() itself.
// Models are replaced by in-memory stubs, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SyncState = require('../models/SyncState');
const Group = require('../models/Group');
const User = require('../models/User');
const { bumpSyncMany } = require('../utils/sync');
const { createGroup, joinGroup, updateGroupName, leaveGroup } = require('../controllers/groupController');

const A = '507f1f77bcf86cd7994390a1';
const B = '507f1f77bcf86cd7994390b2';
const C = '507f1f77bcf86cd7994390c3';

let bumps; // Set of 'userId:key'
let group; // the one group in the store

function record(user, update) {
  for (const path of Object.keys(update.$inc)) bumps.add(`${String(user)}:${path.slice(2)}`);
}

beforeEach(() => {
  bumps = new Set();
  SyncState.updateOne = async (filter, update) => { record(filter.user, update); return {}; };
  SyncState.bulkWrite = async (ops) => { for (const { updateOne: op } of ops) record(op.filter.user, op.update); return {}; };
  User.findByIdAndUpdate = async () => ({});

  group = null;
  const withSave = (g) => Object.assign(g, { save: async () => g });
  Group.exists = async () => null;
  Group.create = async (doc) => (group = withSave({ _id: 'g1', ...doc, members: [...doc.members] }));
  Group.findOne = async ({ inviteCode }) => (group && group.inviteCode === inviteCode ? group : null);
  Group.findById = async (id) => (group && group._id === id ? group : null);
});

const seed = (owner, members, name = 'Friends') => {
  group = Object.assign({ _id: 'g1', name, inviteCode: 'ABCD1234', owner, members: [...members] }, { save: async () => group });
};

function call(handler, { body = {}, params = {}, userId }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ body, params, userId, query: {} }, res)).catch(reject);
  });
}

const got = () => [...bumps].sort();

// --- controllers ------------------------------------------------------------

test('create: the creator gets mine and me', async () => {
  const res = await call(createGroup, { body: { name: 'Friends' }, userId: A });
  assert.equal(res.status, 201);
  assert.deepEqual(got(), [`${A}:me`, `${A}:mine`]);
});

test('join: every member (old and new) gets mine; only the joiner gets me', async () => {
  seed(A, [A, B]);
  const res = await call(joinGroup, { params: { code: 'abcd1234' }, userId: C });
  assert.equal(res.status, 200);
  assert.deepEqual(got(), [`${A}:mine`, `${B}:mine`, `${C}:me`, `${C}:mine`]);
});

test('join: already a member (409) or a bad code (404) bumps nothing', async () => {
  seed(A, [A, B]);
  assert.equal((await call(joinGroup, { params: { code: 'ABCD1234' }, userId: B })).status, 409);
  assert.equal((await call(joinGroup, { params: { code: 'NOPE0000' }, userId: C })).status, 404);
  assert.deepEqual(got(), []);
});

test('rename: every member gets mine, nobody gets me', async () => {
  seed(A, [A, B, C]);
  const res = await call(updateGroupName, { params: { id: 'g1' }, body: { name: 'Family' }, userId: A });
  assert.equal(res.status, 200);
  assert.deepEqual(got(), [`${A}:mine`, `${B}:mine`, `${C}:mine`]);
});

test('rename: to the same name, by a non-owner (403), or blank (400) bumps nothing', async () => {
  seed(A, [A, B]);
  assert.equal((await call(updateGroupName, { params: { id: 'g1' }, body: { name: ' Friends ' }, userId: A })).status, 200);
  assert.equal((await call(updateGroupName, { params: { id: 'g1' }, body: { name: 'Mine now' }, userId: B })).status, 403);
  assert.equal((await call(updateGroupName, { params: { id: 'g1' }, body: { name: '  ' }, userId: A })).status, 400);
  assert.deepEqual(got(), []);
});

test('leave: remaining members and the leaver get mine; the leaver also gets me', async () => {
  seed(A, [A, B, C]);
  const res = await call(leaveGroup, { params: { id: 'g1' }, userId: B });
  assert.equal(res.status, 200);
  assert.deepEqual(got(), [`${A}:mine`, `${B}:me`, `${B}:mine`, `${C}:mine`]);
});

test('leave: a non-member leaving, or an unknown group (404), bumps nothing', async () => {
  seed(A, [A, B]);
  await call(leaveGroup, { params: { id: 'g1' }, userId: C });
  assert.equal((await call(leaveGroup, { params: { id: 'nope' }, userId: A })).status, 404);
  assert.deepEqual(got(), []);
});

// --- bumpSyncMany -------------------------------------------------------------

test('bumpSyncMany: one round trip, de-duplicated users, only per-user keys', async () => {
  let calls = 0;
  let ops;
  SyncState.bulkWrite = async (o) => { calls += 1; ops = o; return {}; };
  await bumpSyncMany([A, B, A, null, B], ['mine', 'daily']);
  assert.equal(calls, 1);
  assert.deepEqual(ops.map((o) => o.updateOne.filter.user), [A, B]);
  assert.deepEqual(ops[0].updateOne.update, { $inc: { 'v.mine': 1 } });
  assert.ok(ops.every((o) => o.updateOne.upsert === true));
});

test('bumpSyncMany: nothing to do makes no call', async () => {
  let calls = 0;
  SyncState.bulkWrite = async () => { calls += 1; return {}; };
  await bumpSyncMany([], 'mine');
  await bumpSyncMany([A], ['daily']);
  assert.equal(calls, 0);
});

test('bumpSyncMany: users whose upsert raced another first bump are retried without upsert', async () => {
  const applied = [];
  let call = 0;
  SyncState.bulkWrite = async (ops) => {
    call += 1;
    if (call === 1) {
      applied.push(A, C); // index 1 (B) lost the upsert race
      const err = new Error('bulk');
      err.writeErrors = [{ index: 1, code: 11000 }];
      throw err;
    }
    assert.ok(ops.every((o) => !o.updateOne.upsert));
    applied.push(...ops.map((o) => o.updateOne.filter.user));
    return {};
  };
  await bumpSyncMany([A, B, C], 'mine');
  assert.deepEqual(applied.sort(), [A, B, C].sort()); // each user bumped exactly once
});

test('bumpSyncMany: never throws, logs a real failure', async () => {
  SyncState.bulkWrite = async () => { throw new Error('db down'); };
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.doesNotReject(bumpSyncMany([A, B], 'mine'));
  } finally {
    console.error = orig;
  }
  assert.match(logged[0], /bumpSyncMany\(2 users, mine\) failed/);
});
