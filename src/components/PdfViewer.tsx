import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "react";
import { loadPdf } from "../lib/pdfEngine";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

interface Props {
  data: ArrayBuffer | null;
  isActive: boolean;
}

const OVERSCAN = 2; // pages above/below viewport to pre-render

export const PdfViewer: React.FC<Props> = React.memo(({ data, isActive }) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [baseDimensions, setBaseDimensions] = useState<
    { width: number; height: number; userUnit: number }[]
  >([]);
  
  // Load initial scale from localStorage (default to 1.5)
  const [scale, setScale] = useState<number>(() => {
    const saved = localStorage.getItem("pdf_zoom_level");
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 3.0) {
        return parsed;
      }
    }
    return 1.5;
  });

  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  
  // Render scale is debounced to avoid layout thrashing during rapid clicks
  const [renderScale, setRenderScale] = useState(scale);
  const [currentPage, setCurrentPage] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  
  const activeRenderTasksRef = useRef<Map<number, any>>(new Map());
  const activeTextLayersRef = useRef<Map<number, TextLayer>>(new Map());
  const renderingRef = useRef<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scrollTicking = useRef(false);
  const renderedPagesRef = useRef<Map<number, number>>(new Map());
  const visiblePagesRef = useRef<Set<number>>(new Set());
  const scrollTargetRef = useRef<{
    pageIdx: number;
    offsetFromPageTop: number;
    viewportOffsetY: number;
  } | null>(null);

  // Sync and debounce scale -> renderScale (100ms threshold for snappy redraws)
  useEffect(() => {
    const timer = setTimeout(() => {
      setRenderScale(scale);
      localStorage.setItem("pdf_zoom_level", scale.toString());
    }, 100);
    return () => clearTimeout(timer);
  }, [scale]);

  // Load PDF from ArrayBuffer (runs once per document load)
  useEffect(() => {
    if (!data) {
      setPdf((prev) => {
        if (prev) {
          prev.destroy().catch((err) => console.error("Error destroying PDF:", err));
        }
        return null;
      });
      setPageCount(0);
      setBaseDimensions([]);
      setCurrentPage(1);
      renderedPagesRef.current.clear();
      visiblePagesRef.current.clear();
      return;
    }

    let active = true;

    setPdf((prev) => {
      if (prev) {
        prev.destroy().catch((err) => console.error("Error destroying PDF:", err));
      }
      return null;
    });
    setPageCount(0);
    setBaseDimensions([]);
    setCurrentPage(1);
    renderedPagesRef.current.clear();
    visiblePagesRef.current.clear();

    loadPdf(data).then((doc) => {
      if (!active) {
        doc.destroy().catch((err) => console.error("Error destroying PDF:", err));
        return;
      }
      
      setPdf(doc);
      setPageCount(doc.numPages);

      // Fetch base dimensions at scale 1.0 (once on document load)
      Promise.all(
        Array.from({ length: doc.numPages }, (_, i) =>
          doc.getPage(i + 1).then((p) => {
            const vp = p.getViewport({ scale: 1.0 });
            return {
              width: vp.width,
              height: vp.height,
              userUnit: p.userUnit || 1,
            };
          })
        )
      ).then((dims) => {
        if (active) {
          setBaseDimensions(dims);
        }
      });
    }).catch((err) => {
      console.error("Failed to load PDF:", err);
    });

    return () => {
      active = false;
    };
  }, [data]);

  // Clean up PDF on unmount to prevent Wasm memory leaks
  useEffect(() => {
    return () => {
      setPdf((prev) => {
        if (prev) {
          prev.destroy().catch((err) => console.error("Error destroying PDF:", err));
        }
        return null;
      });
    };
  }, []);

  // Clean up resources (observer, canvas contexts, renders) when the tab goes inactive
  useEffect(() => {
    if (!isActive) {
      observerRef.current?.disconnect();

      // Cancel all active text layers
      activeTextLayersRef.current.forEach((layer) => {
        try {
          layer.cancel();
        } catch (e) {}
      });
      activeTextLayersRef.current.clear();

      // Cancel all active page renders
      activeRenderTasksRef.current.forEach((task) => {
        try {
          task.cancel();
        } catch (e) {}
      });
      activeRenderTasksRef.current.clear();
      renderingRef.current.clear();

      // Clear all canvases to free GPU memory immediately
      canvasRefs.current.forEach((canvas) => {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
      });

      // Clear text layers
      textLayerRefs.current.forEach((div) => {
        div.innerHTML = "";
      });

      visiblePagesRef.current.clear();
      renderedPagesRef.current.clear();
    }
  }, [isActive]);

  // Reset scroll container position when document changes
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [pdf]);

  // Calculate page CSS dimensions synchronously when baseDimensions or scale changes
  // This allows instant GPU-accelerated scaling in the browser layout tree
  const pageDimensions = useMemo(() => {
    return baseDimensions.map((dim) => ({
      width: Math.floor(dim.width * scale),
      height: Math.floor(dim.height * scale),
      userUnit: dim.userUnit,
    }));
  }, [baseDimensions, scale]);

  // Precompute page Y-offsets for O(1) scrollToPage and O(log N) handleScroll binary search
  const pageOffsets = useMemo(() => {
    const offsets: number[] = [];
    let accum = 20; // padding-top in viewer.css
    const gap = 14; // gap between page wrappers in viewer.css
    for (let i = 0; i < pageDimensions.length; i++) {
      offsets.push(accum);
      accum += pageDimensions[i].height + gap;
    }
    return offsets;
  }, [pageDimensions]);

  // Unified Zoom Update Helper preserving viewport center or mouse cursor position
  const updateZoom = useCallback((newScale: number, clientY?: number) => {
    if (!containerRef.current || pageDimensions.length === 0) {
      setScale(newScale);
      return;
    }

    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    
    // Relative vertical offset in the container viewport
    const viewportOffsetY = clientY !== undefined 
      ? clientY - containerRect.top 
      : container.clientHeight / 2;

    // Absolute vertical target in scroll content
    const targetY = container.scrollTop + viewportOffsetY;

    // Find page index and relative offset from page top
    let pageIdx = 0;
    let offsetFromPageTop = 0;

    for (let i = 0; i < pageOffsets.length; i++) {
      const top = pageOffsets[i];
      const height = pageDimensions[i].height;
      const bottom = top + height + 14; // height + gap
      if (targetY >= top && targetY <= bottom) {
        pageIdx = i;
        offsetFromPageTop = targetY - top;
        break;
      }
    }

    // Fallback if cursor is beyond last page bounds
    if (pageIdx === 0 && targetY > pageOffsets[pageOffsets.length - 1]) {
      pageIdx = pageOffsets.length - 1;
      offsetFromPageTop = targetY - pageOffsets[pageIdx];
    }

    const ratio = newScale / scale;
    setScale(newScale);

    // Save target for layout sync
    scrollTargetRef.current = {
      pageIdx,
      offsetFromPageTop: offsetFromPageTop * ratio,
      viewportOffsetY,
    };
  }, [scale, pageDimensions, pageOffsets]);

  // Synchronously adjust scroll position when DOM resizes to prevent layout jumpiness
  useLayoutEffect(() => {
    if (scrollTargetRef.current && containerRef.current) {
      const { pageIdx, offsetFromPageTop, viewportOffsetY } = scrollTargetRef.current;
      if (pageOffsets[pageIdx] !== undefined) {
        const newTargetY = pageOffsets[pageIdx] + offsetFromPageTop;
        const newScrollTop = newTargetY - viewportOffsetY;
        containerRef.current.scrollTop = newScrollTop;
      }
      scrollTargetRef.current = null;
    }
  }, [pageDimensions, pageOffsets]);

  // Render a single page to its canvas and text selection layer
  const renderPage = useCallback(
    async (pageNum: number, currentPdf: PDFDocumentProxy) => {
      if (!isActive) return;
      // Prevent redundant rendering during intermediate zoom steps
      if (scaleRef.current !== renderScale) return;
      // Prevent redundant rendering if page is already rendered at target scale
      if (renderedPagesRef.current.get(pageNum) === renderScale) return;
      if (renderingRef.current.has(pageNum)) return;
      const canvas = canvasRefs.current.get(pageNum);
      if (!canvas) return;

      renderingRef.current.add(pageNum);
      try {
        const page: PDFPageProxy = await currentPdf.getPage(pageNum);
        const dpr = window.devicePixelRatio || 1;

        // Compute exact physical viewport scaled up by DPR
        const viewport = page.getViewport({ scale: renderScale * dpr });

        // Set physical canvas size directly to match physical viewport dimensions exactly
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        // Note: CSS display width and height are handled synchronously in React render!

        const ctx = canvas.getContext("2d")!;

        // Cancel previous render task if it is already running
        if (activeRenderTasksRef.current.has(pageNum)) {
          try {
            activeRenderTasksRef.current.get(pageNum)?.cancel();
          } catch (e) {}
          activeRenderTasksRef.current.delete(pageNum);
        }

        // Render Canvas
        const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
        activeRenderTasksRef.current.set(pageNum, renderTask);
        
        try {
          await renderTask.promise;
          // Successfully rendered page! Record the scale
          renderedPagesRef.current.set(pageNum, renderScale);
        } catch (e) {
          console.debug("Page render cancelled/failed:", pageNum, e);
        } finally {
          activeRenderTasksRef.current.delete(pageNum);
        }

        // Render Text Selection Layer
        const textLayerDiv = textLayerRefs.current.get(pageNum);
        if (textLayerDiv) {
          if (activeTextLayersRef.current.has(pageNum)) {
            try {
              activeTextLayersRef.current.get(pageNum)?.cancel();
            } catch (e) {}
            activeTextLayersRef.current.delete(pageNum);
          }

          textLayerDiv.innerHTML = "";
          // Note: CSS size of textLayerDiv is handled synchronously in React render!

          const textViewport = page.getViewport({ scale: renderScale });
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport: textViewport,
          });

          activeTextLayersRef.current.set(pageNum, textLayer);
          try {
            await textLayer.render();
          } catch (e) {
            console.debug("Text layer rendering cancelled/failed:", pageNum, e);
          } finally {
            if (activeTextLayersRef.current.get(pageNum) === textLayer) {
              activeTextLayersRef.current.delete(pageNum);
            }
          }
        }
      } catch (err) {
        console.error("Failed to render page:", pageNum, err);
      } finally {
        renderingRef.current.delete(pageNum);
      }
    },
    [renderScale, isActive]
  );

  const renderPageRef = useRef(renderPage);
  useEffect(() => {
    renderPageRef.current = renderPage;
  }, [renderPage]);

  // Intersection Observer to track which pages are currently visible
  useEffect(() => {
    if (!pdf || baseDimensions.length === 0 || !isActive) {
      observerRef.current?.disconnect();
      return;
    }

    observerRef.current?.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const pageNum = parseInt(
            (entry.target as HTMLElement).dataset.page!,
            10
          );
          if (entry.isIntersecting) {
            visiblePagesRef.current.add(pageNum);
            // Render this page + OVERSCAN neighbours
            for (
              let i = Math.max(1, pageNum - OVERSCAN);
              i <= Math.min(pageCount, pageNum + OVERSCAN);
              i++
            ) {
              renderPageRef.current(i, pdf);
            }
          } else {
            visiblePagesRef.current.delete(pageNum);

            // Cancel active render task
            if (activeRenderTasksRef.current.has(pageNum)) {
              try {
                activeRenderTasksRef.current.get(pageNum)?.cancel();
              } catch (e) {}
              activeRenderTasksRef.current.delete(pageNum);
            }

            // Cancel active text layer render
            if (activeTextLayersRef.current.has(pageNum)) {
              try {
                activeTextLayersRef.current.get(pageNum)?.cancel();
              } catch (e) {}
              activeTextLayersRef.current.delete(pageNum);
            }

            // Clear canvas when scrolled far off-screen to save GPU memory immediately
            const canvas = canvasRefs.current.get(pageNum);
            if (canvas) {
              const ctx = canvas.getContext("2d");
              ctx?.clearRect(0, 0, canvas.width, canvas.height);
              canvas.width = 0;
              canvas.height = 0;
            }

            // Clear text selection layer content
            const textLayerDiv = textLayerRefs.current.get(pageNum);
            if (textLayerDiv) {
              textLayerDiv.innerHTML = "";
            }

            // Evict from rendered scale tracker
            renderedPagesRef.current.delete(pageNum);
          }
        });
      },
      {
        root: containerRef.current,
        rootMargin: "200px 0px",
        threshold: 0,
      }
    );

    const wrappers = containerRef.current?.querySelectorAll("[data-page]");
    wrappers?.forEach((el) => observerRef.current?.observe(el));

    return () => observerRef.current?.disconnect();
  }, [pdf, baseDimensions, pageCount, isActive]);

  // Re-render visible pages and their neighbours immediately when the zoom level settles
  useEffect(() => {
    if (!pdf || !isActive || baseDimensions.length === 0) return;
    
    // Copy the set to avoid modification during iteration
    const visiblePages = Array.from(visiblePagesRef.current);
    visiblePages.forEach((pageNum) => {
      for (
        let i = Math.max(1, pageNum - OVERSCAN);
        i <= Math.min(pageCount, pageNum + OVERSCAN);
        i++
      ) {
        renderPage(i, pdf);
      }
    });
  }, [renderScale, pdf, pageCount, isActive, renderPage, baseDimensions]);

  // Scroll helper to jump directly to page offset in O(1)
  const scrollToPage = useCallback((pageNum: number) => {
    if (!containerRef.current || pageOffsets.length === 0) return;
    const container = containerRef.current;
    const targetPageIdx = Math.min(pageNum - 1, pageOffsets.length - 1);
    const targetScrollTop = pageOffsets[targetPageIdx];
    container.scrollTo({ top: targetScrollTop, behavior: "auto" });
  }, [pageOffsets]);

  // Throttled passive scroll listener for updating active page counter using O(log N) binary search
  const handleScroll = useCallback(() => {
    if (!scrollTicking.current) {
      requestAnimationFrame(() => {
        if (!containerRef.current || pageOffsets.length === 0) {
          scrollTicking.current = false;
          return;
        }

        const container = containerRef.current;
        const containerScrollTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        const midPoint = containerScrollTop + containerHeight / 2;

        // Perform Binary Search to find the active page containing the midPoint
        let low = 0;
        let high = pageOffsets.length - 1;
        let activePageNum = 1;

        while (low <= high) {
          const mid = (low + high) >> 1;
          const top = pageOffsets[mid];
          const height = pageDimensions[mid].height;
          const bottom = top + height + 14; // height + gap

          if (midPoint >= top && midPoint <= bottom) {
            activePageNum = mid + 1;
            break;
          } else if (midPoint < top) {
            high = mid - 1;
          } else {
            low = mid + 1;
          }
        }

        setCurrentPage(activePageNum);
        scrollTicking.current = false;
      });
      scrollTicking.current = true;
    }
  }, [pageOffsets, pageDimensions]);



  // Keyboard Shortcuts for PDF manipulation (zoom and page navigation)
  useEffect(() => {
    if (!isActive || !pdf) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if focus is in an input field (to avoid hijacking normal typing)
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          updateZoom(Math.min(3.0, scale + 0.2));
        } else if (e.key === "-") {
          e.preventDefault();
          updateZoom(Math.max(0.5, scale - 0.2));
        } else if (e.key === "0") {
          e.preventDefault();
          updateZoom(1.5);
        }
      } else {
        // Page Navigation
        switch (e.key) {
          case "PageDown":
            e.preventDefault();
            scrollToPage(Math.min(pageCount, currentPage + 1));
            break;
          case "PageUp":
            e.preventDefault();
            scrollToPage(Math.max(1, currentPage - 1));
            break;
          case "Home":
            e.preventDefault();
            scrollToPage(1);
            break;
          case "End":
            e.preventDefault();
            scrollToPage(pageCount);
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isActive, pdf, pageCount, currentPage, scrollToPage, updateZoom, scale]);

  // Ctrl + Mouse Wheel for Zooming
  useEffect(() => {
    if (!isActive || !pdf) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom in on wheel up, zoom out on wheel down
        if (e.deltaY < 0) {
          updateZoom(Math.min(3.0, scale + 0.1), e.clientY);
        } else if (e.deltaY > 0) {
          updateZoom(Math.max(0.5, scale - 0.1), e.clientY);
        }
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", handleWheel);
    };
  }, [isActive, pdf, updateZoom, scale]);

  if (!pdf)
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10,9 9,9 8,9"/>
          </svg>
        </div>
        <p className="empty-label">Drop a PDF here or click <strong>Open PDF</strong></p>
        <p className="empty-sub">Supports all standard PDF documents</p>
      </div>
    );

  return (
    <div className="pdf-viewer-container">
      <div
        ref={containerRef}
        className="pdf-scroll-container"
        onScroll={handleScroll}
      >
        {pageDimensions.map((dim, i) => {
          const pageNum = i + 1;
          return (
            <div
              key={pageNum}
              data-page={pageNum}
              className="page-wrapper"
              style={{ width: dim.width, height: dim.height, position: "relative" }}
            >
              <canvas
                ref={(el) => {
                  if (el) canvasRefs.current.set(pageNum, el);
                  else canvasRefs.current.delete(pageNum);
                }}
                style={{ width: dim.width, height: dim.height }}
              />
              <div
                className="textLayer"
                style={{
                  width: dim.width,
                  height: dim.height,
                  "--scale-factor": renderScale,
                  "--user-unit": dim.userUnit,
                  "--total-scale-factor": renderScale * dim.userUnit,
                } as React.CSSProperties}
                ref={(el) => {
                  if (el) textLayerRefs.current.set(pageNum, el);
                  else textLayerRefs.current.delete(pageNum);
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Floating Toolbar */}
      <div className="pdf-floating-toolbar">
        <button
          className="pdf-toolbar-btn"
          onClick={() => updateZoom(Math.max(0.5, scale - 0.2))}
          disabled={scale <= 0.5}
          title="Zoom Out"
        >
          －
        </button>
        <span className="pdf-toolbar-text">{Math.round(scale * 100)}%</span>
        <button
          className="pdf-toolbar-btn"
          onClick={() => updateZoom(Math.min(3.0, scale + 0.2))}
          disabled={scale >= 3.0}
          title="Zoom In"
        >
          ＋
        </button>

        <div className="pdf-toolbar-divider" />

        <button
          className="pdf-toolbar-btn"
          onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          title="Previous Page"
        >
          ▲
        </button>
        <span className="pdf-toolbar-text pages">
          {currentPage} / {pageCount}
        </span>
        <button
          className="pdf-toolbar-btn"
          onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
          disabled={currentPage >= pageCount}
          title="Next Page"
        >
          ▼
        </button>
      </div>
    </div>
  );
});
