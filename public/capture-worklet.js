// Passes microphone audio from the audio thread to the page, in blocks of 512 samples.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(512);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.block[this.filled++] = channel[i];
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(512);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
