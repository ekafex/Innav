# Indoor Navigation App – Project Documentation

## 📂 Project Structure

```
project-root/
│
├── index.html              # Main entrypoint, UI layout, and script loader
├── styles.css              # Styling (HUD, map, panorama, cues, PiP, etc.)
├── app.js                  # Main logic: routing, UI, overlays, live positioning
├── sw.js                   # Service Worker (PWA: offline caching)
├── positioning.worker.js   # Web Worker for motion/orientation (optional older mode)
│
├── location/
│   ├── map.js              # MapMatcher: walkable area constraints
│   ├── pf.js               # Particle filter engine for pose estimation
│   └── provider.js         # IndoorLocationProvider (PDR + PF + Map constraints)
│
├── data/                   # Static data
│   ├── floor.svg           # Floor plan (SVG)
│   ├── graph.json          # Graph of nodes (POIs) and edges (paths)
│   ├── media_map.json      # Maps node IDs → 360° panorama file names
│   ├── aliases.json        # Synonyms/aliases for nodes
│   └── walkable.json       # Polygon constraints for corridors/walkable space
│
├── media/                  # 360° panorama images, one per node
│   └── *.jpg / *.png
│
└── audio/                  # Pre-recorded voice cues
    ├── en/                 # English
    │   ├── start.mp3
    │   ├── arrive.mp3
    │   ├── left.mp3
    │   └── …  
    └── sq/                 # Albanian, etc.
```

---

## 📄 File-by-File Roles

### `index.html`

* Defines the **UI layout**:

  * Floor plan (`<svg>`), Panorama (`<a-scene>` with `a-sky`), HUD controls, draggable navigation cue, PiP mini-map, and live-positioning sheet.
* Loads `styles.css` and `app.js` (as ES module).
* Provides `<input>` for **route search**, `<button>` for **route**, **toggle**, **voice**, and **sensor** controls.

### `styles.css`

* Defines **visual styles**:

  * HUD elements (inputs, buttons, datalist).
  * Draggable **big nav cue** (large arrow + text).
  * **PiP minimap** card.
  * Panorama/map layers toggle.

### `app.js`

* Central app logic:

  * Loads data files (`graph.json`, `aliases.json`, `floor.svg`, `media_map.json`, `walkable.json`).
  * Builds graph, alias index, and suggestions.
  * Implements **routing** (`shortestPath` using Dijkstra).
  * Computes **maneuvers** (turn left, right, straight, U-turn).
  * Handles **UI wiring**: buttons, datalist, popup suggestions.
  * Renders:

    * **Mini-map** (`drawMinimap`)
    * **Floor SVG overlay** (`drawSvgOverlay`)
    * **Panorama textures** (`setSkyTexture`)
    * **Big nav cue** (turn arrows + text, voice).
  * Integrates **IndoorLocationProvider** for live positioning.
  * Supports **long-press anchoring** to nearest node.
  * Includes **voice guidance** (clips from `/audio` or browser TTS).

### `sw.js`

* Service Worker for PWA:

  * **Cache-first** strategy for app shell (`index.html`, CSS, JS, data).
  * **Network-first** for `media/` (panorama images).
  * Enables **offline usage** after first load.

### `positioning.worker.js`

* Early/optional Web Worker for PDR:

  * Detects **steps** from accelerometer magnitude.
  * Tracks **heading** using gyro + compass fusion.
  * Emits `{x,y,heading,conf}` at \~15 Hz.
* Largely replaced by `provider.js`, but can serve as fallback.

### `location/map.js`

* `MapMatcher`: checks if `(x,y)` is inside **walkable polygons**.
* Falls back to bounding box if polygons not available.

### `location/pf.js`

* `ParticleFilter`: maintains `N` weighted particles `(x,y,θ)`.
* Updates via:

  * `predictPDR`: step motion.
  * `updateRange`, `updateBearing`: external fixes (future WiFi/BLE).
  * `applyConstraint`: enforces walkable area.
* `estimate`: returns mean pose and covariance.

### `location/provider.js`

* `IndoorLocationProvider`:

  * Wraps sensors + particle filter.
  * Listens to `devicemotion` + `deviceorientation`.
  * Implements **Weinberg step length model**.
  * Applies constraints via `MapMatcher`.
  * Exposes events:

    * `onPosition(cb)` → receives `{x,y,heading,accuracy,confidence}`.
    * `onStatus(cb)` → lifecycle events.
  * Supports `anchor()` to reset at known position.

---

## 🔧 Main Functions & Responsibilities

### Routing & Navigation

* `shortestPath(start,end)` → Dijkstra shortest path.
* `computeManeuvers(route)` → turns into human-friendly steps.
* `getCueForStep(i)` → retrieve maneuver for a given step.
* `stepRoute(delta)` → move forward/backward in route.
* `renderStep()` → show current panorama + text step.

### Rendering

* `drawMinimap()` → canvas minimap with edges, route, nodes, and live dot.
* `drawSvgOverlay()` → floor plan overlay with edges, route path, nodes, live user dot.
* `setSkyTexture(url)` → panorama image.

### Voice Guidance

* `speakCue(cue)` → plays mp3 clip if available, else TTS.

### Live Positioning

* `setupLivePositioningUI()` →

  * Binds Enable/Disable buttons.
  * Starts/stops `IndoorLocationProvider`.
  * Anchors on “From” node or via long-press.
  * Smoothly interpolates pose for rendering.

---

## ▶️ Running the App

### 1. Serve Locally

Use HTTPS (required for motion/orientation sensors):

```bash
npx http-server -S -C localhost.pem -K localhost-key.pem
```

(where `localhost.pem` and `localhost-key.pem` are self-signed certs).

### 2. Open in Browser

* Visit: `https://localhost:8080` (or whichever port your server prints).
* On **desktop**: you can test route planning, panorama toggle, voice, PiP.
* On **mobile (Android/iOS)**:

  * Grant **motion/orientation sensor permissions** when prompted.
  * Tap **Enable** under “Live positioning” to start step detection + heading.
  * Optionally, **install as PWA** (Add to Home Screen).

### 3. Workflow

1. Enter start & destination.
2. Press **Route** → graph-based shortest path computed.
3. View in **Map** or **Panorama** mode.
4. Follow **turn-by-turn cues** (visual, voice).
5. Enable **Live positioning** to see your “blue dot” update as you walk.



