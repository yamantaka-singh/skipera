// Run: node extension/background/test_context.mjs
import assert from 'node:assert';
import { vttToText } from './courseraApi.js';

const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Git is a version control system.

2
00:00:04.000 --> 00:00:07.500
It tracks changes to your files.`;

const out = vttToText(vtt);
assert.equal(out, "Git is a version control system. It tracks changes to your files.");

// plain text passes through untouched (bar whitespace collapse)
assert.equal(vttToText("just  plain\ntext"), "just plain text");
assert.equal(vttToText(""), "");
assert.equal(vttToText(null), "");

console.log("vttToText: OK");
