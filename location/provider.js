// provider.js — GPS-like provider with PDR + Particle Filter + map constraint.
// Emits {x,y,heading,accuracy_m,confidence} in LOCAL MAP UNITS for x/y/heading,
// while accuracy_m is reported in meters (converted back via unitsPerMeter).

import { ParticleFilter } from './pf.js';
import { MapMatcher } from './map.js';

export class IndoorLocationProvider {
  constructor({
    particleCount = 800,
    initXY = { x: 0, y: 0 },
    initHeadingDeg = 0,
    mapMatcher,
    unitsPerMeter = 1,          // NEW: scale meters → map units for motion/accuracy
  } = {}) {
    this.pf = new ParticleFilter({
      N: particleCount,
      init: { x: initXY.x, y: initXY.y, theta: deg2rad(initHeadingDeg) },
      std:  { x: 2.0, y: 2.0, theta: deg2rad(30) }
    });
    this.mapMatcher = mapMatcher || new MapMatcher();
    this.uPerM = unitsPerMeter || 1;

    this.enabled = false;
    this.listeners = new Set();
    this._statusCb = null;
    this.lastEmit = 0;
    this._lastInside = null;    // sticky "last known inside" pose

    // PDR state
    this.haveCompass = false;
    this.yaw = 0; // rad

    // Filters / thresholds (more sensitive but still robust)
    this.accAvg = 0;
    this.accHP = 0;
    this.lpAlpha = 0.98;   // slow baseline of |a| (gravity-removed magnitude)
    this.hpAlpha = 0.80;   // stronger high-pass
    this.thresh  = 0.28;   // step detection threshold (was 0.8)
    this._sVar   = 0;      // EW variance for adaptive assist
    this.minStepInterval = 0.22; // s (allow ~2–3 steps/sec)
    this.kWeinberg = 0.37; // step-length scale

    // Peak/valley detector state
    this.lastPeak = 0;
    this.lastValley = 0;
    this.lookingForPeak = true;
    this.stepCooldown = 0;
    this.lastT = performance.now() / 1000;

    // binders
    this._onMotion = this._onMotion.bind(this);
    this._onOrient = this._onOrient.bind(this);
    this._tick = this._tick.bind(this);
  }

  async start() {
    if (this.enabled) return;
    this.enabled = true;
    await this._requestPermissions();
    window.addEventListener('devicemotion', this._onMotion, { passive: true });
    window.addEventListener('deviceorientation', this._onOrient, { passive: true });
    requestAnimationFrame(this._tick);
    this._emitStatus({ type: 'started' });
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientation', this._onOrient);
    this._emitStatus({ type: 'stopped' });
  }

  onPosition(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onStatus(cb)   { this._statusCb = cb; return () => { if (this._statusCb === cb) this._statusCb = null; }; }
  _emitStatus(s) { this._statusCb && this._statusCb(s); }

  // External absolute fixes (future: Wi-Fi RTT / UWB / BLE AoA)
  ingestRange({ anchorX, anchorY, range_m, sigma_m }) {
    this.pf.updateRange({ anchorX, anchorY, range_m: range_m * this.uPerM, sigma_m: sigma_m * this.uPerM });
    this.pf.applyConstraint(this.mapMatcher.isInside);
  }
  ingestBearing({ anchorX, anchorY, bearing_deg, sigma_deg }) {
    this.pf.updateBearing({ anchorX, anchorY, bearing_deg, sigma_deg });
    this.pf.applyConstraint(this.mapMatcher.isInside);
  }
  anchor({ x, y, headingDeg }) {
    // Recenter PF around a known pose (x,y in map units)
    this.pf = new ParticleFilter({
      N: this.pf.N ?? 800,
      init: { x, y, theta: deg2rad(headingDeg ?? rad2deg(this.yaw)) },
      std:  { x: 0.8, y: 0.8, theta: deg2rad(10) }
    });
    this.pf.applyConstraint(this.mapMatcher.isInside);
    this._lastInside = { x, y, theta: deg2rad(headingDeg ?? rad2deg(this.yaw)) };
  }

  // ---- Sensors ----
  async _requestPermissions() {
    try {
      const DM = window.DeviceMotionEvent, DO = window.DeviceOrientationEvent;
      if (DM && typeof DM.requestPermission === 'function') await DM.requestPermission();
      if (DO && typeof DO.requestPermission === 'function') await DO.requestPermission();
      this._emitStatus({ type: 'permission', detail: 'granted' });
    } catch {
      this._emitStatus({ type: 'permission', detail: 'denied' });
    }
  }

  _onOrient(e) {
    const alphaDeg = (e && (e.webkitCompassHeading ?? e.alpha));
    if (alphaDeg == null) return;
    /*
    this.haveCompass = true;
    const headingRad = compassDegToRad(alphaDeg);
    this.yaw = headingRad; // snap to compass
    */
    const screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) || 0;
    // tweak this once to match your map's "north" to device north:
    const MAP_HEADING_OFFSET_DEG = 180;   // try 90, 180, or -90 if movement feels rotated

    const corrected = alphaDeg - screenAngle + MAP_HEADING_OFFSET_DEG;
    const headingRad = compassDegToRad(corrected);
    this.yaw = headingRad;
    }

  _onMotion(e) {
    const t = performance.now() / 1000;
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    this.stepCooldown += dt;

    // Prefer gravity-removed acceleration when available
    const ax = (e.acceleration?.x ?? e.accelerationIncludingGravity?.x ?? 0);
    const ay = (e.acceleration?.y ?? e.accelerationIncludingGravity?.y ?? 0);
    const az = (e.acceleration?.z ?? e.accelerationIncludingGravity?.z ?? 0);
    const a = Math.sqrt(ax * ax + ay * ay + az * az);

    // Low-pass baseline of |a|, then high-pass residual
    this.accAvg = this.lpAlpha * this.accAvg + (1 - this.lpAlpha) * a;
    const detr = a - this.accAvg;
    this.accHP = this.hpAlpha * this.accHP + (1 - this.hpAlpha) * detr;

    // Track variance of the high-passed signal (EW variance for adaptivity)
    const s = this.accHP;
    this._sVar = 0.98 * this._sVar + 0.02 * (s * s);
    const sRms = Math.sqrt(this._sVar + 1e-6);

    // Small adaptive assist: lower threshold slightly when motion is weak
    const adapt = Math.max(0, 0.12 - 0.25 * sRms); // 0..~0.12
    const sEff = this.accHP;

    // Very small gyro assist if present (alpha = z deg/s)
    const gz_dps = e.rotationRate?.alpha ?? 0;
    if (!this.haveCompass) {
      this.yaw = wrap(this.yaw + (gz_dps * Math.PI / 180) * dt);
    }

    // Step detection (peak/valley on high-passed norm)
    if (this.lookingForPeak) {
      this.lastPeak = Math.max(this.lastPeak, sEff);
      if ((this.lastPeak - this.lastValley) > (this.thresh - adapt) && this.stepCooldown > this.minStepInterval) {
        // Weinberg step length (meters), then convert to map units
        const L_m = this.kWeinberg * Math.pow(Math.max(0.001, this.lastPeak - this.lastValley), 0.25);
        const step_units = this.uPerM * L_m;
        const heading = this.yaw;

        this.pf.predictPDR({ step_m: step_units, heading_rad: heading });
        // Make walls "hard": downweight outside particles heavily
        this.pf.applyConstraint(this.mapMatcher.isInside);

        this.stepCooldown = 0;
        this.lastValley = sEff;
        this.lastPeak = sEff;
        this.lookingForPeak = false;
      }
    } else {
      this.lastValley = Math.min(this.lastValley, sEff);
      if (sEff > this.lastValley + 0.06) this.lookingForPeak = true;
    }
  }

  _tick() {
    if (!this.enabled) return;

    const now = performance.now();
    if (now - this.lastEmit > 66) { // ~15 Hz
      // Optional extra constraint pass before estimate (cheap, increases stickiness)
      this.pf.applyConstraint(this.mapMatcher.isInside);

      const { mean, cov } = this.pf.estimate();

      // Enforce inside for the emitted pose (sticky last-inside pose)
      if (!this._lastInside) this._lastInside = { x: mean.x, y: mean.y, theta: mean.theta };
      if (this.mapMatcher && !this.mapMatcher.isInside(mean.x, mean.y)) {
        mean.x = this._lastInside.x;
        mean.y = this._lastInside.y;
        mean.theta = this._lastInside.theta;
        cov.xx *= 1.5; cov.yy *= 1.5; // lower confidence if we had to snap
      } else {
        this._lastInside = { x: mean.x, y: mean.y, theta: mean.theta };
      }

      // Confidence buckets from stddev in map units; accuracy back in meters
      const sigmaXY_units = Math.sqrt(Math.max(0.01, cov.xx + cov.yy));
      const conf = sigmaToConf(Math.sqrt(sigmaXY_units));
      const payload = {
        x: mean.x,
        y: mean.y,
        heading: rad2deg(mean.theta),
        accuracy_m: (3 * Math.sqrt(sigmaXY_units)) / Math.max(1e-6, this.uPerM), // ~3σ, converted to meters
        confidence: conf
      };

      for (const cb of this.listeners) cb(payload);
      this.lastEmit = now;
    }

    requestAnimationFrame(this._tick);
  }
}

/* -------------------- helpers -------------------- */
function deg2rad(d) { return (d * Math.PI) / 180; }
function rad2deg(r) { return (r * 180) / Math.PI; }
function wrap(a)    { return Math.atan2(Math.sin(a), Math.cos(a)); }
function sigmaToConf(s_units) { return s_units < 0.5 ? 3 : s_units < 1.5 ? 2 : s_units < 3 ? 1 : 0; }

// alphaDeg: 0°=North, 90°=East → 0 rad = +x (East)
function compassDegToRad(alphaDeg) {
  const east = 90 - alphaDeg;
  const r = (east * Math.PI) / 180;
  return Math.atan2(Math.sin(r), Math.cos(r));
}

