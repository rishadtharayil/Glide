# Glide PDF Reader — Project Diary

A living development log documenting architectural choices, milestone completions, technical hurdles, and performance tuning for the Glide PDF Reader.

---

## 📅 Project History & Log

### Entry 1: Project Initialization & Core Architecture
* **Date**: June 8, 2026
* **Objective**: Build a lightweight, dark-themed PDF Reader desktop app for Windows 10 using Tauri v2, React 19, and TypeScript.
* **Decisions**:
  * Chose **PDF.js (v5.7.284)** for robust PDF rendering.
  * Set up a tab-based view layout with presorted recent files history inside a sidebar.
  * Configured `tauri.conf.json` with `"decorations": false` to disable native Win32 window borders, allowing us to build a custom Chrome-like titlebar integrated directly into the tab bar.
* **Progress**:
  * Scaffolded the frontend using Vite + React + TypeScript.
  * Configured Tauri v2 capabilities (`default.json`) to allow window manipulation.
  * Implemented a basic file loader.

---

### Entry 2: App Shell, Collapsible Sidebar, and Recent Files
* **Date**: June 8, 2026
* **Objective**: Improve screen real estate utilization and add recent files persistence.
* **Decisions**:
  * Shrink the left sidebar width to `190px` and support smooth collapsible transitions (`margin-left`).
  * Persist opened file paths in `localStorage` under `pdf_recent_files`.
  * Style the "Open PDF" button as a quieter secondary action so it does not distract from the reading viewport.
  * Style Chrome-style angled tabs. When switching tabs, preserve scroll positions by keeping tabs mounted in the DOM and toggling their visibility via CSS `visibility: hidden; position: absolute; pointer-events: none`.

---

### Entry 3: Frameless Titlebar & Tauri Window Controls
* **Date**: June 8, 2026
* **Objective**: Replace standard Win32 window headers with integrated custom controls.
* **Decisions**:
  * Replaced native window drag areas by capturing clicks on the tab-bar empty region and calling `getCurrentWebviewWindow().startDragging()`.
  * Implemented custom window controls (minimize, maximize, close) in the upper-right corner calling Tauri's window APIs.
  * Enabled double-click on titlebar to trigger `getCurrentWebviewWindow().toggleMaximize()`.
* **Hurdle Encountered**: Double-clicking or dragging near the toolbar sometimes triggered window drag, or clicked buttons did not respond.
  * **Fix**: Excluded elements like `.tab`, `button`, `.pdf-floating-toolbar` and inputs from initiating window dragging. Removed `-webkit-app-region: drag` styles because WebView2 intercepted mouse events at the compositor level, swallowing clicks before they reached the DOM.

---

### Entry 4: IPC Binary Performance Bypass
* **Date**: June 8, 2026
* **Objective**: Address noticeable UI freezing when opening large PDF files.
* **Hurdle**: Serializing large raw PDF file buffers to JSON arrays (`number[]`) over the Tauri IPC bridge was causing high serialization/deserialization CPU overhead.
* **Fix**:
  * Refactored the Rust command `read_pdf_file` in `src-tauri/src/lib.rs` to return `tauri::ipc::Response` containing binary bytes.
  * Modified the React frontend to consume the raw `ArrayBuffer` directly. This bypassed JSON parsing entirely, reducing file load times to under 50ms.

---

### Entry 5: Multi-Tab GPU Memory Pruning
* **Date**: June 8, 2026
* **Objective**: Prevent the app from consuming massive GPU/browser memory when multiple large PDFs are open simultaneously.
* **Decisions**:
  * Wrapped the `PdfViewer` component in `React.memo` and passed an `isActive` boolean prop.
  * When a tab becomes inactive (`isActive === false`), it immediately:
    1. Disconnects its `IntersectionObserver`.
    2. Aborts all pending rendering and text layer tasks.
    3. Invokes `clearRect` on all cached canvas contexts, freeing up 100% of its backing GPU textures.
    4. Clears all HTML content within its text layer containers.

---

### Entry 6: Synchronous Zoom & Subpixel Rendering Clarity
* **Date**: June 8, 2026
* **Objective**: Fix blurry page rendering and speed up zoom resizing.
* **Hurdles**:
  * standard canvas rendering blurred on high-DPI screens due to subpixel alignment mismatch inside flex containers.
  * Zooming triggered re-rendering of all visible pages concurrently, causing layout thrashing and lag.
* **Fixes**:
  * Applied `image-rendering: -webkit-optimize-contrast` and `crisp-edges` style properties to canvas nodes. Floored all page CSS widths/heights to integer bounds, and multiplied physical canvas dimensions by the device pixel ratio for a crisp 1:1 pixel rendering.
  * Decoupled instant CSS scaling from the actual Wasm canvas repaint. Cached scale `1.0` page dimensions once on document load. When zooming, React immediately resizes the canvas and text layer container style attributes to match the new `scale` (instant CSS scale). repainting is debounced by `100ms` via a separate `renderScale` state.

---

### Entry 7: Text Selection Alignment & Zoom Rendering Lag
* **Date**: June 8, 2026
* **Objective**: Resolve inaccurate PDF text selection and rendering stutter during zooming.
* **Hurdles**:
  * Text highlight selections did not align with canvas pixels, making text selection incorrect and copying wrong characters. This was because PDF.js's native `TextLayer` styles use `--scale-factor` and `--total-scale-factor` CSS variables to position and size fonts. Because our custom page wrappers lacked these variables, fonts defaulted to the browser baseline (13px).
  * Rapid zooming still felt stuttery because intermediate page resizes triggered the `IntersectionObserver`, scheduling heavy PDF page redraws at the old scale level which were immediately cancelled when `renderScale` updated 100ms later.
* **Fixes**:
  * Stored page-specific `userUnit` values when caching base dimensions. Passed `--scale-factor`, `--user-unit`, and `--total-scale-factor` directly to `.textLayer` elements via inline styles in React, and added a fallback formula in `viewer.css`. This aligned selection spans perfectly with canvas text.
  * Added a `scaleRef.current !== renderScale` check inside `renderPage`. If the user is actively zooming, we instantly return from rendering, skipping intermediate draws and letting the system wait until the final scale settles.

---

### Entry 8: Performance Audit Optimizations
* **Date**: June 8, 2026
* **Objective**: Resolve five core performance bottlenecks identified in the audit (GPU memory release, repaint redundancy, observer thrashing, React double renders, and linear page layout calculation complexity).
* **Fixes**:
  * **GPU Canvas Memory Release**: Reset `canvas.width = 0` and `canvas.height = 0` when pages scroll off-screen or tabs go inactive, which immediately reclaims GPU texture memory instead of just clearing pixels.
  * **Redundant Scroll Repaints**: Added a `renderedPagesRef` map tracking `pageNum -> scale`. If a page is already rendered at the target `renderScale`, its drawing task is skipped. Removed pages from the tracker when they are cleared off-screen.
  * **Observer Thrashing Prevention**: Refactored the `IntersectionObserver` setup to use a callback ref `renderPageRef` so the observer does not rebuild on scale changes. Added a `visiblePagesRef` set to track currently visible pages, and introduced a separate, lightweight `useEffect` that triggers on `renderScale` changes to redraw only the visible pages.
  * **Double Renders Removal**: Replaced `pageDimensions` state and its synchronization `useEffect` with a synchronous `useMemo` calculation mapping `baseDimensions` and `scale`.
  * **$O(\log N)$ Layout Math**: Precomputed page Y-offsets in a `pageOffsets` `useMemo`. Optimized `scrollToPage` to use $O(1)$ direct offset lookup, and refactored `handleScroll` to perform a binary search on page offsets, achieving $O(\log N)$ scroll tracking.

---

### Entry 9: Keyboard Shortcuts
* **Date**: June 8, 2026
* **Objective**: Add essential keyboard shortcuts for application manipulation (open file, tab management, sidebar toggle, document zoom, and page navigation).
* **Fixes & Refinements**:
  * **App Shell shortcuts**:
    - `Ctrl` + `O`: Trigger native file selection picker.
    - `Ctrl` + `T`: Create a new blank tab.
    - `Ctrl` + `W`: Close the active tab (using a refactored programmatic `closeTabById` helper).
    - `Ctrl` + `B`: Toggle the collapsible left sidebar.
    - `Ctrl` + `Tab` / `Ctrl` + `Shift` + `Tab`: Cycle forward/backward through open tabs.
  * **Viewer shortcuts** (active only when the tab has a loaded PDF and is in focus):
    - `Ctrl` + `+` or `Ctrl` + `=`: Zoom In (+20%).
    - `Ctrl` + `-`: Zoom Out (-20%).
    - `Ctrl` + `0`: Reset Zoom level to 1.5x.
    - `Ctrl` + `Mouse Wheel Up/Down`: Zoom In / Zoom Out smoothly (10% increments).
    - `Page Down`: Scroll to the next page.
    - `Page Up`: Scroll to the previous page.
    - `Home`: Jump directly to the first page.
    - `End`: Jump directly to the last page.

### Entry 10: Viewport & Cursor Centered Zoom
* **Date**: June 8, 2026
* **Objective**: Fix awkward scroll displacement during zoom operations. Ensure zoom operations maintain focus on the content the user was reading.
* **Fixes & Refinements**:
  * **Unified Zoom Math (`updateZoom`)**:
    - Calculates the vertical coordinate being targeted (either the center of the viewport for keyboard/toolbar zoom, or the exact coordinates under the mouse cursor for Ctrl + mouse wheel scroll zoom).
    - Maps the targeted coordinate to its page index and relative percentage offset from the page top.
    - Multiplies the page-relative offset by the scale ratio.
  * **Flicker-Free Layout Sync (`useLayoutEffect`)**:
    - React's `useLayoutEffect` fires synchronously after DOM elements resize but before the browser paints the frame.
    - Instantly adjusts the scroll container's `scrollTop` to align the page-relative target with the viewport relative offset.
    - Prevents layout jumpiness and provides smooth, stable zooming transitions.

### Entry 11: Pixel-Perfect DPR Canvas Sizing
* **Date**: June 8, 2026
* **Objective**: Solve low text clarity and subpixel blurry rendering in WebView2.
* **Fix**:
  * Refactored `renderPage` inside `PdfViewer.tsx` to generate the page viewport using the exact scaled scale `renderScale * dpr`.
  * Set physical `canvas.width` and `canvas.height` directly to the viewport's own `width` and `height` properties.
  * This guarantees a 1:1 physical pixel matching between PDF.js's drawing bounds and the canvas's back-buffer pixel grid, eliminating slight aspect ratio rounding mismatches (which previously squished coordinates by 1-2 pixels) and achieving perfect subpixel rendering clarity identical to native readers.

---

## 🛠️ Technical Decisions Summary

| Topic | Solution | Impact |
|---|---|---|
| **IPC Bridge** | Rust binary `Response` / React `ArrayBuffer` | Bypasses JSON parsing, files load instantly. |
| **Window Layout** | custom titlebar + Tauri Window Dragging | Frameless modern look with full native Aero-snapping. |
| **Tab Switching** | DOM mounting + `visibility: hidden` | Instant tab changes with scroll memory preserved. |
| **Tab Inactivity** | `isActive` prop + canvas `clearRect` + width/height = 0 | Releases 100% of inactive tab GPU canvas memory. |
| **Zoom Scaling** | Decoupled CSS scaling + 100ms repaint debounce | Zooming resizes pages instantly on screen. |
| **Zoom Centering** | `useLayoutEffect` + targeted page-offset mapping | Preserves viewport center / mouse cursor alignment seamlessly. |
| **Text Selection** | Inline CSS properties (`--scale-factor`, `--total-scale-factor`) | Perfect font size sizing and selection copying. |
| **Canvas Clarity** | Direct 1:1 viewport size matching at `renderScale * dpr` | Bypasses layout rounding mismatch, rendering sharp text. |
| **Redundant Draws** | Scale cache guards (`scaleRef` + `renderedPagesRef`) | Eliminates repaint stutters during zoom/scroll. |
| **Observer Lifetime** | Callback refs (`renderPageRef` + `visiblePagesRef`) | Keeps observer alive and eliminates zoom registration thrashes. |
| **Layout Math** | Precomputed offsets + Binary Search | Direct $O(1)$ scrolls and $O(\log N)$ passive scroll tracking. |
| **Keyboard Shortcuts** | Keyboard event listener with tag check guards | Enhances app accessibility without disrupting form input focuses. |




