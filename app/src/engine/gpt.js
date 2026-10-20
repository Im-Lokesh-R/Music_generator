// Minimal GPT inference engine in plain JavaScript with a KV-cache.
// Runs the weights exported by training/mgtrain.py (pre-LN, tanh-GELU, tied head).
// One token step costs ≈ n_layer · 12 · d_model² multiply-adds (~5M for the default model).

export class GPT {
  constructor(meta, weights) {
    const c = meta.config;
    this.L = c.n_layer;
    this.H = c.n_head;
    this.D = c.d_model;
    this.T = c.block_size;
    this.V = c.vocab_size;
    const get = (name) => {
      const t = meta.tensors[name];
      if (!t) throw new Error(`missing tensor ${name}`);
      const size = t.shape.reduce((a, b) => a * b, 1);
      return weights.subarray(t.offset, t.offset + size);
    };
    this.wte = get('wte.weight');
    this.wpe = get('wpe.weight');
    this.layers = [];
    for (let i = 0; i < this.L; i++) {
      const p = (n) => get(`blocks.${i}.${n}`);
      this.layers.push({
        ln1w: p('ln1.weight'), ln1b: p('ln1.bias'), qkvw: p('qkv.weight'), qkvb: p('qkv.bias'),
        projw: p('proj.weight'), projb: p('proj.bias'), ln2w: p('ln2.weight'), ln2b: p('ln2.bias'),
        fcw: p('fc.weight'), fcb: p('fc.bias'), fc2w: p('fc_proj.weight'), fc2b: p('fc_proj.bias'),
        k: new Float32Array(this.T * this.D), v: new Float32Array(this.T * this.D),
      });
    }
    this.lnfw = get('lnf.weight');
    this.lnfb = get('lnf.bias');
    const D = this.D;
    this.x = new Float32Array(D);
    this.h = new Float32Array(D);
    this.qkv = new Float32Array(3 * D);
    this.att = new Float32Array(D);
    this.tmp = new Float32Array(D);
    this.ff = new Float32Array(4 * D);
    this.scores = new Float32Array(this.T);
    this.logits = new Float32Array(this.V);
    this.t = 0;
  }

  reset() {
    this.t = 0;
  }

  static layerNorm(out, x, w, b) {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (x[i] - mean) ** 2;
    const inv = 1 / Math.sqrt(v / n + 1e-5);
    for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * inv * w[i] + b[i];
  }

  // out[o] = b[o] + Σ_i W[o, i] x[i]   (W is [outDim, inDim], row-major as in PyTorch)
  static linear(out, x, W, b, outDim, inDim) {
    for (let o = 0; o < outDim; o++) {
      let s = b[o];
      const row = o * inDim;
      for (let i = 0; i < inDim; i++) s += W[row + i] * x[i];
      out[o] = s;
    }
  }

  /** Feed one token; returns logits for the next token. */
  step(token) {
    if (this.t >= this.T) throw new Error('context full — call reset()');
    const { D, H } = this;
    const hd = D / H;
    const t = this.t;
    const x = this.x;
    for (let i = 0; i < D; i++) x[i] = this.wte[token * D + i] + this.wpe[t * D + i];
    const scale = 1 / Math.sqrt(hd);
    for (const Ly of this.layers) {
      GPT.layerNorm(this.h, x, Ly.ln1w, Ly.ln1b);
      GPT.linear(this.qkv, this.h, Ly.qkvw, Ly.qkvb, 3 * D, D);
      // store k, v at position t
      Ly.k.set(this.qkv.subarray(D, 2 * D), t * D);
      Ly.v.set(this.qkv.subarray(2 * D, 3 * D), t * D);
      for (let hh = 0; hh < H; hh++) {
        const qo = hh * hd;
        let max = -Infinity;
        for (let j = 0; j <= t; j++) {
          let s = 0;
          const ko = j * D + qo;
          for (let i = 0; i < hd; i++) s += this.qkv[qo + i] * Ly.k[ko + i];
          s *= scale;
          this.scores[j] = s;
          if (s > max) max = s;
        }
        let sum = 0;
        for (let j = 0; j <= t; j++) {
          const e = Math.exp(this.scores[j] - max);
          this.scores[j] = e;
          sum += e;
        }
        for (let i = 0; i < hd; i++) this.att[qo + i] = 0;
        for (let j = 0; j <= t; j++) {
          const p = this.scores[j] / sum;
          const vo = j * D + qo;
          for (let i = 0; i < hd; i++) this.att[qo + i] += p * Ly.v[vo + i];
        }
      }
      GPT.linear(this.tmp, this.att, Ly.projw, Ly.projb, D, D);
      for (let i = 0; i < D; i++) x[i] += this.tmp[i];
      GPT.layerNorm(this.h, x, Ly.ln2w, Ly.ln2b);
      GPT.linear(this.ff, this.h, Ly.fcw, Ly.fcb, 4 * D, D);
      const k0 = Math.sqrt(2 / Math.PI);
      for (let i = 0; i < 4 * D; i++) {
        const u = this.ff[i];
        this.ff[i] = 0.5 * u * (1 + Math.tanh(k0 * (u + 0.044715 * u * u * u)));
      }
      GPT.linear(this.tmp, this.ff, Ly.fc2w, Ly.fc2b, D, 4 * D);
      for (let i = 0; i < D; i++) x[i] += this.tmp[i];
    }
    GPT.layerNorm(this.h, x, this.lnfw, this.lnfb);
    for (let v = 0; v < this.V; v++) {
      let s = 0;
      const row = v * D;
      for (let i = 0; i < D; i++) s += this.wte[row + i] * this.h[i];
      this.logits[v] = s;
    }
    this.t++;
    return this.logits;
  }

  /** Compare against the logits PyTorch computed at export time. */
  selfTest(meta) {
    const st = meta.selftest;
    if (!st) return { ok: true, maxErr: 0 };
    this.reset();
    let logits;
    for (const id of st.ids) logits = this.step(id);
    let maxErr = 0;
    for (let i = 0; i < st.logits.length; i++) maxErr = Math.max(maxErr, Math.abs(logits[i] - st.logits[i]));
    this.reset();
    return { ok: maxErr < 1e-2, maxErr };
  }
}
