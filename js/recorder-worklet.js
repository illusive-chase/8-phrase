// AudioWorkletProcessor：300ms 预录环形缓冲 + 采集 + 每 50ms 上报一次音量。
// 主线程 → { type: 'start', id } | { type: 'stop', id, tailMs } | { type: 'cancel', id }
// 本线程 → { type: 'level', rms, peak } | { type: 'done', id, samples }（samples 以 transfer 方式传回）

const PRE_ROLL_MS = 300;
const LEVEL_MS = 50;
const MAX_TAKE_MS = 17000; // 15 秒上限 + 预录 + 补录，再留一点余量

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(Math.round((PRE_ROLL_MS / 1000) * sampleRate));
    this.ringPos = 0;
    this.ringFilled = 0;
    this.take = null; // { id, chunks, length, tailLeft }
    this.levelLen = Math.round((LEVEL_MS / 1000) * sampleRate);
    this.levelSum = 0;
    this.levelPeak = 0;
    this.levelCount = 0;
    this.maxLen = Math.round((MAX_TAKE_MS / 1000) * sampleRate);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg.type === 'start') {
      // 把环形缓冲里最近 300ms 按时间顺序取出来，作为录音开头
      const pre = new Float32Array(this.ringFilled);
      const start = (this.ringPos - this.ringFilled + this.ring.length) % this.ring.length;
      for (let i = 0; i < this.ringFilled; i++) pre[i] = this.ring[(start + i) % this.ring.length];
      this.take = { id: msg.id, chunks: [pre], length: pre.length, tailLeft: -1 };
      this.levelSum = 0;
      this.levelPeak = 0;
      this.levelCount = 0;
    } else if (msg.type === 'stop') {
      if (!this.take || this.take.id !== msg.id) return;
      this.take.tailLeft = Math.round(((msg.tailMs || 0) / 1000) * sampleRate);
      if (this.take.tailLeft <= 0) this.finish();
    } else if (msg.type === 'cancel') {
      if (this.take && this.take.id === msg.id) this.take = null;
    }
  }

  finish() {
    const take = this.take;
    this.take = null;
    const samples = new Float32Array(take.length);
    let offset = 0;
    for (const chunk of take.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.port.postMessage({ type: 'done', id: take.id, samples, sampleRate }, [samples.buffer]);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const frames = channel ? channel.length : 128;

    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.ring[this.ringPos] = channel[i];
        this.ringPos = (this.ringPos + 1) % this.ring.length;
      }
      this.ringFilled = Math.min(this.ring.length, this.ringFilled + channel.length);
    }

    const take = this.take;
    if (take) {
      if (channel && take.length < this.maxLen) {
        take.chunks.push(channel.slice(0));
        take.length += channel.length;
      }
      if (channel && take.tailLeft < 0) {
        for (let i = 0; i < channel.length; i++) {
          const v = channel[i];
          this.levelSum += v * v;
          const a = Math.abs(v);
          if (a > this.levelPeak) this.levelPeak = a;
        }
        this.levelCount += channel.length;
        if (this.levelCount >= this.levelLen) {
          this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / this.levelCount), peak: this.levelPeak });
          this.levelSum = 0;
          this.levelPeak = 0;
          this.levelCount = 0;
        }
      }
      // 补录阶段：没有输入（例如麦克风被系统停掉）也按时间计数，保证一定会结束
      if (take.tailLeft >= 0) {
        take.tailLeft -= frames;
        if (take.tailLeft <= 0) this.finish();
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
