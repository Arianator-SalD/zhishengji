class PCMRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; this.chunk = []; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.samples.push(...input);
    const ratio = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position), f = this.position - i;
      const v = this.samples[i] * (1 - f) + this.samples[i + 1] * f;
      this.chunk.push(Math.round(Math.max(-1, Math.min(1, v)) * 32767));
      this.position += ratio;
      if (this.chunk.length === 1600) {
        const buffer = new ArrayBuffer(3200), view = new DataView(buffer);
        let energy = 0;
        this.chunk.forEach((v, j) => { view.setInt16(j * 2, v, true); energy += v * v; });
        this.port.postMessage({buffer, rms: Math.sqrt(energy / 1600) / 32768}, [buffer]);
        this.chunk = [];
      }
    }
    const used = Math.min(this.samples.length, Math.floor(this.position));
    this.samples.splice(0, used); this.position -= used;
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
