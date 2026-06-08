import * as pdfjsLib from "pdfjs-dist";

// Vite resolves this import at build time and outputs a correctly hashed asset.
// No manual copy step needed — always in sync with the installed pdfjs-dist version.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

export { pdfjsLib };

export async function loadPdf(data: ArrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/cmaps/",
    cMapPacked: true,
    enableXfa: false, // disable XFA for perf
    disableFontFace: false,
  });
  return loadingTask.promise;
}
