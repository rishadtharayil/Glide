import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { PdfViewer } from "./components/PdfViewer";
import "./styles/viewer.css";

interface Tab {
  id: string;
  name: string;
  data: ArrayBuffer | null;
}

interface RecentFile {
  name: string;
  path: string;
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: "initial", name: "New Tab", data: null }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("initial");
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Persistent Recent Files list from localStorage
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => {
    try {
      const saved = localStorage.getItem("pdf_recent_files");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Helper to update native OS window title
  const updateTitle = useCallback(async (tabName: string) => {
    try {
      const title = tabName === "New Tab" ? "Glide" : `Glide - ${tabName}`;
      await getCurrentWebviewWindow().setTitle(title);
    } catch (err) {
      console.error("Failed to set window title:", err);
    }
  }, []);

  // Custom titlebar drag/maximize handler
  const handleTitlebarMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag on left click
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    // Exclude interactive elements from triggering window drag
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest(".tab") ||
      target.closest(".pdf-floating-toolbar")
    ) {
      return;
    }

    if (e.detail === 2) {
      getCurrentWebviewWindow().toggleMaximize();
    } else {
      getCurrentWebviewWindow().startDragging();
    }
  }, []);

  const minimizeWindow = useCallback(() => {
    getCurrentWebviewWindow().minimize();
  }, []);

  const maximizeWindow = useCallback(() => {
    getCurrentWebviewWindow().toggleMaximize();
  }, []);

  const closeWindow = useCallback(() => {
    getCurrentWebviewWindow().close();
  }, []);

  // Add a file to recent list and save to localStorage
  const addRecentFile = useCallback((name: string, path: string) => {
    setRecentFiles(prev => {
      const filtered = prev.filter(f => f.path !== path);
      const next = [{ name, path }, ...filtered].slice(0, 10); // Limit to 10
      localStorage.setItem("pdf_recent_files", JSON.stringify(next));
      return next;
    });
  }, []);

  // Select a tab and update the window title
  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setTabs(prev => {
      const tab = prev.find(t => t.id === id);
      if (tab) {
        updateTitle(tab.name);
      }
      return prev;
    });
  }, [updateTitle]);

  // Create a new blank tab
  const createTab = useCallback(() => {
    const newId = crypto.randomUUID();
    const newTab: Tab = { id: newId, name: "New Tab", data: null };
    setTabs(prev => {
      const nextTabs = [...prev, newTab];
      setActiveTabId(newId);
      updateTitle("New Tab");
      return nextTabs;
    });
  }, [updateTitle]);

  // Close a specific tab by ID
  const closeTabById = useCallback((id: string) => {
    setTabs(prev => {
      if (prev.length === 1) {
        // If closing the last tab, reset to a single blank tab
        const newId = crypto.randomUUID();
        setActiveTabId(newId);
        updateTitle("New Tab");
        return [{ id: newId, name: "New Tab", data: null }];
      }

      const index = prev.findIndex(t => t.id === id);
      const nextTabs = prev.filter(t => t.id !== id);

      if (id === activeTabId) {
        // Focus adjacent tab (left if possible, else right)
        const nextActiveIndex = index > 0 ? index - 1 : 0;
        const nextActiveTab = nextTabs[nextActiveIndex];
        setActiveTabId(nextActiveTab.id);
        updateTitle(nextActiveTab.name);
      }
      return nextTabs;
    });
  }, [activeTabId, updateTitle]);

  // Close a specific tab
  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Avoid switching to the tab we are closing
    closeTabById(id);
  }, [closeTabById]);

  // Load a PDF file into the active tab (if empty) or a new tab
  const loadPdfIntoActiveTab = useCallback(async (name: string, buffer: ArrayBuffer) => {
    setTabs(prev => {
      const activeIndex = prev.findIndex(t => t.id === activeTabId);
      if (activeIndex !== -1 && prev[activeIndex].data === null) {
        // Active tab is empty, load it here
        const updatedTab = { ...prev[activeIndex], name, data: buffer };
        const next = [...prev];
        next[activeIndex] = updatedTab;
        updateTitle(name);
        return next;
      } else {
        // Active tab has content, open in a new tab
        const newId = crypto.randomUUID();
        const newTab = { id: newId, name, data: buffer };
        setActiveTabId(newId);
        updateTitle(name);
        return [...prev, newTab];
      }
    });
  }, [activeTabId, updateTitle]);

  // Load PDF from filesystem path
  const loadFromPath = useCallback(async (path: string) => {
    setIsLoading(true);
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      const buffer = await invoke<ArrayBuffer>("read_pdf_file", { path });
      await loadPdfIntoActiveTab(name, buffer);
      addRecentFile(name, path);
    } catch (err) {
      console.error("Failed to read PDF:", err);
      alert(`Could not open file: ${name}. It may have been moved or deleted.`);
      // Prune broken file path from history
      setRecentFiles(prev => {
        const next = prev.filter(f => f.path !== path);
        localStorage.setItem("pdf_recent_files", JSON.stringify(next));
        return next;
      });
    } finally {
      setIsLoading(false);
    }
  }, [loadPdfIntoActiveTab, addRecentFile]);

  // Open native file picker dialog
  const openFile = useCallback(async () => {
    const path = await invoke<string | null>("open_file_dialog");
    if (!path) return;
    await loadFromPath(path);
  }, [loadFromPath]);

  // Hook Tauri's native window drag-drop events to receive absolute file paths
  useEffect(() => {
    let active = true;
    let unlistenFns: (() => void)[] = [];

    const setup = async () => {
      const uEnter = await listen("tauri://drag-enter", () => {
        if (active) setIsDragging(true);
      });
      if (active) unlistenFns.push(uEnter);

      const uLeave = await listen("tauri://drag-leave", () => {
        if (active) setIsDragging(false);
      });
      if (active) unlistenFns.push(uLeave);

      const uDrop = await listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
        if (!active) return;
        setIsDragging(false);
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          const path = paths[0];
          if (path.toLowerCase().endsWith(".pdf")) {
            loadFromPath(path);
          }
        }
      });
      if (active) unlistenFns.push(uDrop);
    };

    setup();

    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
    };
  }, [loadFromPath]);

  // Switch tabs relatively (+1 for next, -1 for previous)
  const switchTabRelative = useCallback((direction: number) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      const activeIndex = prev.findIndex(t => t.id === activeTabId);
      if (activeIndex === -1) return prev;
      const nextIndex = (activeIndex + direction + prev.length) % prev.length;
      const targetTab = prev[nextIndex];
      setActiveTabId(targetTab.id);
      updateTitle(targetTab.name);
      return prev;
    });
  }, [activeTabId, updateTitle]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if focus is in an input field (to avoid hijacking normal typing)
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl && e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          switchTabRelative(-1);
        } else {
          switchTabRelative(1);
        }
        return;
      }

      if (isCtrl) {
        switch (e.key.toLowerCase()) {
          case "o":
            e.preventDefault();
            openFile();
            break;
          case "t":
            e.preventDefault();
            createTab();
            break;
          case "w":
            e.preventDefault();
            closeTabById(activeTabId);
            break;
          case "b":
            e.preventDefault();
            setIsSidebarOpen(prev => !prev);
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openFile, createTab, closeTabById, activeTabId, switchTabRelative]);

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <div className={`sidebar ${isSidebarOpen ? "" : "closed"}`}>
        <div className="sidebar-header">
          <div className="app-title">Glide</div>
          <button
            className="btn-open-sidebar"
            onClick={openFile}
            disabled={isLoading}
            title="Open PDF file"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            {isLoading ? "Opening…" : "Open PDF"}
          </button>
        </div>

        <div className="recent-files-section">
          <div className="recent-title">Recent Files</div>
          {recentFiles.length === 0 ? (
            <div className="recent-empty">No recent files</div>
          ) : (
            <div className="recent-list">
              {recentFiles.map((file, idx) => (
                <div key={file.path + idx} className="recent-item" title={file.path}>
                  <div className="recent-item-clickable" onClick={() => loadFromPath(file.path)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="recent-file-icon">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14,2 14,8 20,8"/>
                    </svg>
                    <span className="recent-name">{file.name}</span>
                  </div>
                  <button
                    className="btn-delete-recent"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRecentFiles(prev => {
                        const next = prev.filter(f => f.path !== file.path);
                        localStorage.setItem("pdf_recent_files", JSON.stringify(next));
                        return next;
                      });
                    }}
                    title="Remove from history"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {recentFiles.length > 0 && (
          <button
            className="btn-clear-recent"
            onClick={() => {
              setRecentFiles([]);
              localStorage.removeItem("pdf_recent_files");
            }}
          >
            Clear History
          </button>
        )}
      </div>

      {/* ── Main Content ────────────────────────────────────── */}
      <div className="main-content">
        {/* ── Tab Bar ─────────────────────────────────────────── */}
        <div className="tab-bar" onMouseDown={handleTitlebarMouseDown}>
          <button
            className="btn-toggle-sidebar"
            onClick={() => setIsSidebarOpen(prev => !prev)}
            title={isSidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
            </svg>
          </button>

          <div className="tabs-container">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab${tab.id === activeTabId ? " active" : ""}`}
                onClick={() => selectTab(tab.id)}
                title={tab.name}
              >
                <span className="tab-title">{tab.name}</span>
                <button
                  className="btn-close-tab"
                  onClick={(e) => closeTab(tab.id, e)}
                  title="Close Tab"
                  aria-label="Close Tab"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn-add-tab"
            onClick={createTab}
            title="New Tab"
            aria-label="New Tab"
            onMouseDown={(e) => e.stopPropagation()}
          >
            ＋
          </button>

          {/* Window Controls */}
          <div className="window-controls" onMouseDown={(e) => e.stopPropagation()}>
            <button className="win-btn win-minimize" onClick={minimizeWindow} title="Minimize">
              <svg width="10" height="1" viewBox="0 0 10 1"><line x1="0" y1="0.5" x2="10" y2="0.5" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
            <button className="win-btn win-maximize" onClick={maximizeWindow} title="Maximize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
            <button className="win-btn win-close" onClick={closeWindow} title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1"/></svg>
            </button>
          </div>
        </div>

        {/* ── Drag-and-drop visual overlay ────────────────────── */}
        {isDragging && (
          <div className="drop-overlay" aria-hidden>
            Drop PDF to open
          </div>
        )}

        {/* ── Tab Panels ──────────────────────────────────────── */}
        <div className="tab-panels">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-content-wrapper ${
                tab.id === activeTabId ? "active" : ""
              }`}
            >
              <PdfViewer data={tab.data} isActive={tab.id === activeTabId} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
