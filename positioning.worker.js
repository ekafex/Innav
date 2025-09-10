// positioning.worker.js
let enabled = false;

// Pose state (meters; arbitrary origin aligned with your SVG graph)
let x = 0, y = 0, headingDeg = 0;
let conf = 0.3;

// PDR params
let lastAccel = { x: 0, y: 0, z: 0 };
let stepAccum = 0;
let stepLength = 0.7; // avg adult step ~0.6–0.8 m; make user-tunable
let lastEmit = 0;

// Complementary filter for heading
let yaw = 0; // deg

// Receive sensor samples from main thread
self.onmessage = (e) => {
  const { type, data } = e.data || {};
  if (type === "enable") { enabled = true; return; }
  if (type === "disable") { enabled = false; return; }
  if (!enabled) return;

  if (type === "motion") {
    // Acc magnitude for crude step detection
    const { ax, ay, az, dt } = data; // m/s^2, seconds
    const g = Math.sqrt(ax*ax + ay*ay + az*az);
    // High-pass via simple diff
    const lg = Math.sqrt(lastAccel.x**2 + lastAccel.y**2 + lastAccel.z**2);
    const hp = g - lg;
    lastAccel = { x: ax, y: ay, z: az };
    // Accumulate and threshold for steps
    stepAccum = Math.max(0, stepAccum + Math.abs(hp) - 0.8); // tweak threshold
    if (stepAccum > 3.0) {
      stepAccum = 0;
      // Advance along current yaw
      const rad = yaw * Math.PI / 180;
      x += stepLength * Math.cos(rad);
      y += stepLength * Math.sin(rad);
      conf = Math.min(1.0, conf + 0.05);
    }
  } else if (type === "orientation") {
    // data.alpha: compass-ish (deg), data.gyroZ: deg/s
    const { alphaDeg, gyroZ, dt } = data;
    // Complementary: 97% gyro integrate, 3% compass correction
    yaw = (yaw + gyroZ * dt);
    yaw = yaw - 360 * Math.floor((yaw + 180) / 360);
    if (Number.isFinite(alphaDeg)) {
      const err = (((alphaDeg - yaw + 540) % 360) - 180);
      yaw += 0.03 * err;
    }
    headingDeg = yaw;
  } else if (type === "anchor") {
    // Snap to known coordinate (e.g., from QR/NFC/POI)
    const { x_m, y_m, heading } = data;
    if (Number.isFinite(x_m)) x = x_m;
    if (Number.isFinite(y_m)) y = y_m;
    if (Number.isFinite(heading)) yaw = heading;
    conf = 0.9;
  }

  // Emit at ~15 Hz
  const now = Date.now();
  if (now - lastEmit > 66) {
    lastEmit = now;
    self.postMessage({ x, y, heading: headingDeg, conf });
  }
};

