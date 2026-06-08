# Glide PDF Reader

A lightweight, dark-themed PDF reader for Windows built with Tauri v2, React, TypeScript, and PDF.js.

## Features

- **Multi-Document Tabs**: Open and switch between multiple PDF files.
- **Frameless Window**: Custom titlebar with draggable window area, minimize, maximize, and close controls.
- **Sidebar**: Collapsible sidebar with recent files history.
- **Interactive Viewer**: Zoom support (via UI controls, keyboard, or Ctrl + mouse wheel) and text selection.
- **DPR Canvas Scaling**: Renders PDF pages using the system device pixel ratio (DPR) for clear text.
- **Binary IPC Loader**: Custom Rust command to load files directly into the frontend as binary data.

## Getting Started

### Prerequisites

Ensure you have the following installed:
1. **Node.js** and **pnpm**
2. **Rust** and **Cargo**
3. **Tauri Prerequisites** (see the [Tauri Setup Guide](https://v2.tauri.app/start/prerequisites/))

### Installation

Clone the repository and install the dependencies:

```bash
pnpm install
```

### Running in Development

To start the Tauri development server:

```bash
pnpm tauri dev
```

### Building for Production

To build the release package:

```bash
pnpm tauri build
```

## Architecture

- **`src/`** (Frontend)
  - `App.tsx`: Main app shell, tabs, sidebar, and custom titlebar.
  - `components/PdfViewer.tsx`: PDF viewer handling zoom, canvas rendering, and text layers.
  - `lib/pdfEngine.ts`: PDF.js setup with Web Worker config.
- **`src-tauri/`** (Backend)
  - `src/lib.rs`: Rust backend containing IPC commands for loading files as binary data.
  - `tauri.conf.json`: Tauri configuration (frameless settings, permissions).
