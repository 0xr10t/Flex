// Spec §20.2 acceptance suite A-01 … A-60. One file on purpose: vitest runs the tests of a file in definition
// order, so A-60 (log grep) runs after every other row and sees the logs of the whole suite.
import { registerSensitive } from './harness.js';
import { registerPlatform } from './platform.js';
import { registerA01toA16 } from './a01-a16.js';
import { registerA17toA32 } from './a17-a32.js';
import { registerA33toA52 } from './a33-a52.js';
import { registerA55toA59, registerA60 } from './a55-a60.js';

// Names and ENS names typed by the tests (A-60 greps for them).
registerSensitive('name', 'aradhya', 'mihir', 'riya', 'kabir', 'priya', 'diya', 'riyan', 'invoice co', 'carol');
registerSensitive('ens', 'riya.eth', 'iitr.eth', 'iitr.ac.in', 'alice.iitr.eth', 'bob.iitr.eth', 'carol.iitr.eth');

registerPlatform();
registerA01toA16();
registerA17toA32();
registerA33toA52();
registerA55toA59();
registerA60();
