import assert from 'node:assert/strict';
import { markFirstPublishedAudio } from './audio.js';
import { fakeSid } from './fake-fixtures.js';

const marks: string[] = [];
const markers = { mark: (kind: string) => marks.push(kind) };
const callSid = fakeSid('CA');
let marked = markFirstPublishedAudio('speech_created', false, markers, callSid);
assert.equal(marked, false, 'a created speech handle without a published frame leaves the detector deadline armed');
assert.deepEqual(marks, []);
marked = markFirstPublishedAudio('speaking', marked, markers, callSid);
assert.equal(marked, true);
assert.deepEqual(marks, ['first-audio']);
assert.equal(markFirstPublishedAudio('speaking', marked, markers, callSid), true);
assert.deepEqual(marks, ['first-audio']);
console.log('audio.check OK');
