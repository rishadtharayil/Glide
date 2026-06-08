# 📄 Glide — High-Performance Tauri PDF Reader

Glide is a lightweight, dark-themed PDF Reader for Windows 10/11 built using **Tauri v2**, **React 19**, **TypeScript**, and **PDF.js**. It features a modern, frameless window design, Chrome-style multi-document tabs, and aggressive GPU memory optimizations for butter-smooth navigation.

![Dark Mode App Shell Mockup](https://raw.githubusercontent.com/tauri-apps/tauri/dev/app-icon.png)

---

## ✨ Features

*   **Integrated Chrome-like Tabs**: Angled Chrome-style tabs built directly into the custom titlebar. Switching tabs is instantaneous and preserves scroll position and memory per document.
*   **Custom Frameless Window**: Clean, borderless layout matching a premium dark theme. Includes custom minimize/maximize/close window controls with native Win32 dragging and snap assistants.
*   **Collapsible Sidebar & History**: Narrow sidebar containing persistent recent files history (saved in `localStorage`), with drag-and-drop loading and collapsible animation toggles.
*   **Instant GPU Zoom**: Synchronous zoom mapping. DOM element wrapper sizes adjust instantly, while heavy PDF repaints are debounced by 100ms. Intermediate redraws during zooming are suppressed for zero stutter.
*   **Precise Text Selection**: Select, drag, highlight, and copy text from the PDF. Custom inline scale property bounds ensure select boxes align pixel-for-pixel with the canvas text.
*   **GPU Subpixel Centering Clarity**: Canvas buffers automatically scale using the device pixel ratio to ensure ultra-sharp vector rendering and prevent subpixel text blurriness.
*   **Wasm & GPU Memory Pruning**: Inactive tabs release 100% of their canvas contexts and GPU memory back to the system. WebAssembly heap resources are destroyed on unmount.

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your Windows machine:
1.  **Node.js** (LTS) & **pnpm** (`npm install -g pnpm`)
2.  **Rust & Cargo** (via [rustup.rs](https://rustup.rs/))
3.  **Tauri Prerequisites** (C++ Build Tools, etc. - see [Tauri Windows Setup Guide](https://v2.tauri.app/start/prerequisites/))

### Installation

Clone the repository and install the dependencies:
```bash
pnpm install
```

### Running in Development

To start the Tauri development server (hot-reloads the React frontend and automatically rebuilds the Rust backend on changes):
```bash
pnpm tauri dev
```

### Building for Production

To compile the production release and generate the Windows `.msi` / `.exe` installer packages:
```bash
pnpm tauri build
```
The compiled bundles will be output to: `src-tauri/target/release/bundle/msi/`.

---

## 🛠️ Architecture & Tech Stack

```
Glide/
├── src/                          # React 19 Frontend
│   ├── App.tsx                   # App shell, titlebar, drag-drop, window controls
│   ├── components/
│   │   └── PdfViewer.tsx         # Virtual scroll viewer (IntersectionObserver)
│   ├── lib/
│   │   └── pdfEngine.ts          # PDF.js engine setup with inline Web Worker URL
│   └── styles/
│       └── viewer.css            # Custom CSS styling (dark theme, variables)
└── src-tauri/                    # Tauri v2 Backend (Rust)
    ├── tauri.conf.json           # App permissions, frameless config
    ├── capabilities/
    │   └── default.json          # Allow-list permissions (Fs, Dialog, Maximize)
    └── src/
        └── lib.rs                # Optimized binary IPC file reader
```

---

## ⚡ Performance Optimizations

1.  **Zero-Serialization Binary IPC**: Standard Tauri IPC serializes buffers into JSON arrays (`number[]`). Glide uses `tauri::ipc::Response` to write raw bytes directly to a frontend `ArrayBuffer`, bypassing JSON overhead entirely.
2.  **Intersection Observer Virtualization**: Only loads and renders canvas buffers for pages that are currently approaching or in the viewport, saving system memory.
3.  **Active Task Aborts**: When pages scroll out of view or the scale changes mid-render, Glide calls `.cancel()` on active PDF.js paint promises to stop CPU/GPU layout thrashing.
4.  **Tab Inactivity Release**: Hidden tabs call `clearRect()` on their canvases to instantly free memory and disconnect event observers.
