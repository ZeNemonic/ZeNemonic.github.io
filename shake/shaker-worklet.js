// PhISEM-style percussion idiophone (after Perry Cook)

const REF_SR = 44100;
const V_MIN = 0.08;

// res: [centerHz, poleRadius, gain]
// box: half-width cavity in m.
const PRESETS = {
  maraca: {
    beads: 25,
    sysDecay: 0.999,
    sndDecay: 0.95,
    gain: 1.0,
    box: 0.035,
    rest: 0.4,
    drag: 2,
    scrape: 0.0,
    inject: 0.12,
    jitter: 0,
    res: [[3200, 0.96, 1]],
  },
  cabasa: {
    beads: 512,
    sysDecay: 0.997,
    sndDecay: 0.96,
    gain: 0.12,
    box: 0.02,
    rest: 0.3,
    drag: 4,
    scrape: 0.6,
    inject: 0.1,
    jitter: 0,
    res: [[3000, 0.7, 1]],
  },
  sekere: {
    beads: 64,
    sysDecay: 0.999,
    sndDecay: 0.96,
    gain: 0.22,
    box: 0.05,
    rest: 0.3,
    drag: 3,
    scrape: 0.2,
    inject: 0.1,
    jitter: 0,
    res: [[5500, 0.6, 1]],
  },
  tambourine: {
    beads: 32,
    sysDecay: 0.9985,
    sndDecay: 0.95,
    gain: 3.5,
    box: 0.015,
    rest: 0.5,
    drag: 1,
    scrape: 0.0,
    inject: 0.15,
    jitter: 0.05,
    res: [
      [2300, 0.96, 0.25],
      [5600, 0.995, 1],
      [8100, 0.995, 1],
    ],
  },
  sleighbells: {
    beads: 32,
    sysDecay: 0.9994,
    sndDecay: 0.97,
    gain: 4.0,
    box: 0.01,
    rest: 0.6,
    drag: 1,
    scrape: 0.0,
    inject: 0.15,
    jitter: 0.03,
    res: [
      [2500, 0.999, 1],
      [5300, 0.999, 1],
      [6500, 0.999, 1],
      [8300, 0.999, 1],
      [9800, 0.999, 1],
    ],
  },
};

class ShakerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.f = [0, 9.81, 0];
    this.fTarget = [0, 9.81, 0];
    this.gate = false;
    this.sens = 1;
    this.drive = 1;
    this.energy = 0;
    this.level = 0;
    this.blocks = 0;
    this.impacts = 0;
    this.setPreset("maraca");
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case "accel":
        this.fTarget[0] = m.x;
        this.fTarget[1] = m.y;
        this.fTarget[2] = m.z;
        break;
      case "gate":
        this.gate = !!m.on;
        break;
      case "preset":
        this.setPreset(m.name);
        break;
      case "sens":
        this.sens = m.value;
        break;
      case "drive":
        this.drive = m.value;
        break;
    }
  }

  setPreset(name) {
    const p = PRESETS[name] || PRESETS.maraca;
    this.p = p;
    const k = REF_SR / sampleRate;
    this.sysDecay = Math.pow(p.sysDecay, k);
    this.sndDecay = Math.pow(p.sndDecay, k);
    this.muteDecay = Math.pow(0.996, k);
    const nyq = 0.45 * sampleRate;
    this.res = p.res.map(([freq, r, g]) => {
      const z = {
        base: Math.min(freq, nyq),
        freq: Math.min(freq, nyq),
        r: Math.pow(r, k),
        g,
        a1: 0,
        a2: 0,
        b0: 0,
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0,
      };
      this.tune(z);
      return z;
    });
    // some lumped groups with diff play & bounce
    this.groups = [];
    for (let i = 0; i < 4; i++) {
      const L = p.box * (0.7 + 0.6 * Math.random());
      this.groups.push({
        L,
        x: [0, -L, 0],
        v: [0, 0, 0],
        rest: p.rest * (0.8 + 0.4 * Math.random()),
      });
    }
  }

  // two-pole reso, norm'd for unity peak (as STK BiQuad::setResonance)
  tune(z) {
    const w = (2 * Math.PI * z.freq) / sampleRate;
    z.a1 = -2 * z.r * Math.cos(w);
    z.a2 = z.r * z.r;
    z.b0 = 0.5 - 0.5 * z.a2;
  }

  // impact energy integration
  mechanics(dt) {
    const p = this.p,
      S = 4,
      h = dt / S,
      f = this.f,
      damp = 1 - p.drag * h;
    let inj = 0;
    for (const g of this.groups) {
      for (let s = 0; s < S; s++) {
        for (let k = 0; k < 3; k++) {
          let v = (g.v[k] - f[k] * h) * damp;
          let x = g.x[k] + v * h;
          if (x > g.L) {
            x = g.L;
            if (v > 0) {
              if (v > V_MIN) {
                inj += v * v;
                this.impacts++;
              }
              v = -g.rest * v;
            }
          } else if (x < -g.L) {
            x = -g.L;
            if (v < 0) {
              if (-v > V_MIN) {
                inj += v * v;
                this.impacts++;
              }
              v = -g.rest * v;
            }
          }
          g.x[k] = x;
          g.v[k] = v;
        }
      }
      // cabasa-style:
      if (p.scrape)
        inj += p.scrape * (g.v[0] ** 2 + g.v[1] ** 2 + g.v[2] ** 2) * dt * 20;
    }
    return inj;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    const p = this.p;

    // input smoothing ~60 Hz updates, 344 Hz block rate
    for (let k = 0; k < 3; k++)
      this.f[k] += (this.fTarget[k] * this.sens - this.f[k]) * 0.35;

    const inj = this.mechanics(n / sampleRate);
    if (this.gate) this.energy = Math.min(2, this.energy + p.inject * inj);

    const prob = p.beads / 1024;
    const res = this.res;
    for (let i = 0; i < n; i++) {
      this.energy *= this.gate ? this.sysDecay : this.sysDecay * this.muteDecay;
      // system energy → collision rate & loudness
      if (Math.random() < prob * Math.min(1, this.energy * 8)) {
        this.level += this.energy * p.gain;
        if (p.jitter && res.length > 1) {
          const z = res[1 + Math.floor(Math.random() * (res.length - 1))];
          z.freq = z.base * (1 + p.jitter * (Math.random() * 2 - 1));
          this.tune(z);
        }
      }
      const x = this.level * (Math.random() * 2 - 1);
      this.level *= this.sndDecay;
      let y = 0;
      for (let r = 0; r < res.length; r++) {
        const z = res[r];
        const yo = z.b0 * (x - z.x2) - z.a1 * z.y1 - z.a2 * z.y2;
        z.x2 = z.x1;
        z.x1 = x;
        z.y2 = z.y1;
        z.y1 = yo;
        y += yo * z.g;
      }
      ch0[i] = Math.tanh(y * this.drive);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

    if (++this.blocks % 8 === 0) {
      this.port.postMessage({
        type: "meter",
        energy: this.energy,
        impacts: this.impacts,
      });
      this.impacts = 0;
    }
    return true;
  }
}

registerProcessor("shaker", ShakerProcessor);
