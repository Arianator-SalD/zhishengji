const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
for (const rate of [48000, 44100, 16000]) {
  test(`PCM resampler retains phase at ${rate} Hz`, () => {
    let Recorder, count = 0;
    const env = {
      sampleRate: rate,
      AudioWorkletProcessor: class { constructor() { this.port = {postMessage() {}}; } },
      registerProcessor: (_, C) => { Recorder = C; }
    };
    vm.createContext(env);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/audio-worklet.js'),'utf8'),env);
    const recorder = new Recorder();
    recorder.port.postMessage = ({buffer}) => { count += buffer.byteLength / 2; };
    for (let n = 0; n < rate; n += 128) recorder.process([[new Float32Array(Math.min(128,rate-n))]]);
    assert.ok(Math.abs(count + recorder.chunk.length - 16000) <= 1);
  });
}
