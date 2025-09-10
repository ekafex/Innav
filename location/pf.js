// pf.js — Particle Filter for (x, y, theta). Lightweight & tuned for pedestrians.

export class ParticleFilter {
  constructor({
    N = 800,
    init = { x: 0, y: 0, theta: 0 },
    std  = { x: 2, y: 2, theta: Math.PI / 6 }
  } = {}) {
    this.N = N;

    // Motion noise (in your map units / radians)
    this.noiseStep    = 0.05;              // step jitter (units)
    this.noiseHeading = (5 * Math.PI) / 180; // heading jitter (rad)

    // Resampling threshold (effective sample size)
    this.resampleNeffThr = 0.6 * N;

    // Particle set
    this.parts = Array.from({ length: N }, () => ({
      x: init.x + std.x * randn(),
      y: init.y + std.y * randn(),
      theta: wrap(init.theta + std.theta * randn()),
      w: 1 / N
    }));
  }

  // Predict via Pedestrian Dead Reckoning (already scaled to map units)
  predictPDR({ step_m, heading_rad }) {
    const s = Math.max(0, step_m + this.noiseStep * randn());
    const h = wrap(heading_rad + this.noiseHeading * randn());
    for (const p of this.parts) {
      p.theta = h;
      p.x += s * Math.cos(p.theta);
      p.y += s * Math.sin(p.theta);
    }
  }

  // Optional absolute updates (e.g., Wi-Fi RTT / UWB range)
  updateRange({ anchorX, anchorY, range_m, sigma_m }) {
    const inv2s2 = 1 / (2 * sigma_m * sigma_m + 1e-12);
    for (const p of this.parts) {
      const dr = Math.hypot(p.x - anchorX, p.y - anchorY) - range_m;
      p.w *= Math.exp(-dr * dr * inv2s2);
    }
    this._normalizeResampleIfNeeded();
  }

  // Optional bearing updates (e.g., BLE AoA)
  updateBearing({ anchorX, anchorY, bearing_deg, sigma_deg }) {
    const b = (bearing_deg * Math.PI) / 180;
    const s = (sigma_deg * Math.PI) / 180;
    const inv2s2 = 1 / (2 * s * s + 1e-12);
    for (const p of this.parts) {
      const pred = Math.atan2(p.y - anchorY, p.x - anchorX);
      const d = wrap(b - pred);
      p.w *= Math.exp(-(d * d) * inv2s2);
    }
    this._normalizeResampleIfNeeded();
  }

  // Corridor constraint (HARD walls): drastically down-weight outside particles
  applyConstraint(isInside) {
    for (const p of this.parts) {
      if (!isInside(p.x, p.y)) p.w *= 1e-6; // was 0.05; make walls effectively impassable
    }
    this._normalizeResampleIfNeeded();
  }

  // Weighted mean & covariance estimate
  estimate() {
    let sum = 0, mx = 0, my = 0, c = 0, s = 0;
    for (const p of this.parts) {
      sum += p.w;
      mx += p.w * p.x;
      my += p.w * p.y;
      c  += p.w * Math.cos(p.theta);
      s  += p.w * Math.sin(p.theta);
    }

    // Degenerate case: all weights ~0 → use uniform
    if (sum === 0) {
      const u = 1 / this.parts.length;
      mx = my = c = s = 0;
      for (const p of this.parts) {
        mx += u * p.x;
        my += u * p.y;
        c  += u * Math.cos(p.theta);
        s  += u * Math.sin(p.theta);
      }
      sum = 1;
    }

    mx /= sum; my /= sum;
    const th = Math.atan2(s / sum, c / sum);

    let vxx = 0, vyy = 0, vtt = 0;
    for (const p of this.parts) {
      const w = p.w / sum;
      vxx += w * (p.x - mx) ** 2;
      vyy += w * (p.y - my) ** 2;
      vtt += w * wrap(p.theta - th) ** 2;
    }

    return { mean: { x: mx, y: my, theta: th }, cov: { xx: vxx, yy: vyy, tt: vtt } };
  }

  _normalizeResampleIfNeeded() {
    // Normalize
    let sum = 0;
    for (const p of this.parts) sum += p.w;

    if (sum === 0) {
      const u = 1 / this.parts.length;
      for (const p of this.parts) p.w = u;
      return;
    }
    for (const p of this.parts) p.w /= sum;

    // Effective sample size
    let neffInv = 0;
    for (const p of this.parts) neffInv += p.w * p.w;
    const neff = 1 / neffInv;

    if (neff < this.resampleNeffThr) this._systematicResample();
  }

  _systematicResample() {
    const N = this.parts.length;
    const cdf = new Array(N);
    let c = 0;
    for (let i = 0; i < N; i++) { c += this.parts[i].w; cdf[i] = c; }

    const out = [];
    let i = 0;
    const u0 = Math.random() / N;

    for (let j = 0; j < N; j++) {
      const u = u0 + j / N;
      while (u > cdf[i]) i++;
      const p = this.parts[i];
      out.push({ x: p.x, y: p.y, theta: p.theta, w: 1 / N });
    }
    this.parts = out;
  }
}

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

