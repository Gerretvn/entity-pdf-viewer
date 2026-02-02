import React, { useState, useEffect, useRef } from 'react';
import { FileText, Database, FolderOpen, StopCircle, RefreshCw, ZoomIn, ZoomOut, Eye, Trash2 } from 'lucide-react';

// --- Database Logic (Embedded for Single File Compatibility) ---
// Wir nutzen hier eine lokale Implementierung, damit keine externe Datei importiert werden muss.

const DB_NAME = 'entity-viewer-db';
const STORE_NAME = 'matches';

class LocalDB {
  db: IDBDatabase | null = null;

  async init() {
    if (this.db) return;
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject("DB Error");
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('entity', 'entity', { unique: false });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  async addMatch(match: any) {
    if (!this.db) await this.init();
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.add(match);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear() {
    if (!this.db) await this.init();
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getMatchesGrouped(): Promise<Record<string, number>> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const counts: Record<string, number> = {};
        request.result.forEach((m: any) => {
          counts[m.entity] = (counts[m.entity] || 0) + 1;
        });
        resolve(counts);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getMatchesForEntity(entity: string): Promise<any[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('entity');
      const request = index.getAll(entity);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

const db = new LocalDB();

// --- PDF.js Setup ---
const pdfjsVersion = '3.11.174';
const pdfjsSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsVersion}/pdf.min.js`;
const pdfjsWorkerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsVersion}/pdf.worker.min.js`;

const EntityViewer = () => {
  // --- State ---
  const [csvContent, setCsvContent] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Status Stats
  const [stats, setStats] = useState({ filesProcessed: 0, matchesFound: 0, currentFile: '' });
  
  // UI Data
  const [entityCounts, setEntityCounts] = useState<Record<string, number>>({});
  const [activeEntity, setActiveEntity] = useState<string | null>(null);
  const [activeMatches, setActiveMatches] = useState<any[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<any | null>(null);
  
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [pdfLibReady, setPdfLibReady] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<boolean>(false);

  // Init
  useEffect(() => {
    const script = document.createElement('script');
    script.src = pdfjsSrc;
    script.onload = () => {
      // @ts-ignore
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc;
      setPdfLibReady(true);
    };
    document.body.appendChild(script);
    
    // Load initial DB stats
    db.init().then(refreshStats);
  }, []);

  const refreshStats = async () => {
    const counts = await db.getMatchesGrouped();
    setEntityCounts(counts);
  };

  // --- Regex Logic ---
  function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function createExactMatchRegex(entity: string, global = true) {
    const escaped = escapeRegExp(entity);
    const startBoundary = /^\w/.test(entity) ? "\\b" : "";
    const endBoundary = /\w$/.test(entity) ? "\\b" : "";
    return new RegExp(`${startBoundary}${escaped}${endBoundary}`, global ? 'gi' : 'i');
  }

  // --- THE TRICK: Directory Handling ---

  const handleFolderSelect = async () => {
    if (!('showDirectoryPicker' in window)) {
      alert("Ihr Browser unterstützt diese Funktion nicht. Bitte nutzen Sie Chrome, Edge oder Opera.");
      return;
    }

    try {
      // @ts-ignore
      const dirHandle = await window.showDirectoryPicker();
      await processDirectory(dirHandle);
    } catch (err) {
      console.error("Zugriff verweigert oder Fehler:", err);
    }
  };

  const processDirectory = async (dirHandle: any) => {
    if (csvContent.length === 0) {
      alert("Bitte erst Entities (CSV) laden!");
      return;
    }

    setIsProcessing(true);
    abortControllerRef.current = false;
    
    // Auto-Clear DB if it's a fresh run request
    if (Object.keys(entityCounts).length > 0) {
       if (confirm("Sollen alte Ergebnisse vorher gelöscht werden?")) {
        await db.clear();
        setEntityCounts({});
        setActiveEntity(null);
        setSelectedMatch(null);
      }
    }

    let fileCount = 0;
    let matchCount = 0;

    async function* getFilesRecursively(entry: any): AsyncGenerator<any> {
      if (entry.kind === 'file') {
        if (entry.name.toLowerCase().endsWith('.pdf')) {
          yield entry;
        }
      } else if (entry.kind === 'directory') {
        for await (const handle of entry.values()) {
          yield* getFilesRecursively(handle);
        }
      }
    }

    try {
      // @ts-ignore
      const pdfjs = window.pdfjsLib;

      for await (const fileHandle of getFilesRecursively(dirHandle)) {
        if (abortControllerRef.current) break;

        fileCount++;
        setStats(prev => ({ ...prev, filesProcessed: fileCount, currentFile: fileHandle.name }));

        const file = await fileHandle.getFile();
        const arrayBuffer = await file.arrayBuffer();

        try {
          const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
          const pdf = await loadingTask.promise;

          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageTextItems = textContent.items;
            const fullPageString = pageTextItems.map((item: any) => item.str).join(' ');

            for (const entity of csvContent) {
              const regex = createExactMatchRegex(entity, true);
              let match;
              while ((match = regex.exec(fullPageString)) !== null) {
                const start = Math.max(0, match.index - 30);
                const end = Math.min(fullPageString.length, match.index + entity.length + 30);
                const snippet = "..." + fullPageString.substring(start, end) + "...";

                await db.addMatch({
                  entity,
                  fileName: fileHandle.name,
                  pageNumber: pageNum,
                  textSnippet: snippet,
                  fileHandle: fileHandle,
                  timestamp: Date.now()
                });
                matchCount++;
              }
            }
            page.cleanup();
          }
          pdf.destroy();
        } catch (e) {
          console.error(`Fehler bei ${fileHandle.name}:`, e);
        }

        setStats(prev => ({ ...prev, matchesFound: matchCount }));
        if (fileCount % 5 === 0) {
          await new Promise(r => setTimeout(r, 0));
          await refreshStats();
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
      await refreshStats();
    }
  };

  const stopProcessing = () => {
    abortControllerRef.current = true;
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const entities = text.split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 0);
      setCsvContent(entities);
    };
    reader.readAsText(file);
  };

  const handleSelectEntity = async (entity: string) => {
    if (activeEntity === entity) {
      setActiveEntity(null);
      setActiveMatches([]);
    } else {
      setActiveEntity(entity);
      const matches = await db.getMatchesForEntity(entity);
      setActiveMatches(matches);
    }
  };

  const loadAndRenderMatch = async (match: any) => {
    setSelectedMatch(match);
    if (!pdfLibReady || !canvasRef.current) return;

    try {
      // Permission nochmal checken
      const permission = await match.fileHandle.queryPermission({ mode: 'read' });
      if (permission !== 'granted') {
        const request = await match.fileHandle.requestPermission({ mode: 'read' });
        if (request !== 'granted') return;
      }

      const file = await match.fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();

      // @ts-ignore
      const pdfjs = window.pdfjsLib;
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(match.pageNumber);

      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      const scrollContainer = scrollContainerRef.current;
      const availableWidth = scrollContainer ? scrollContainer.clientWidth : 800;
      
      const viewportUnscaled = page.getViewport({ scale: 1 });
      const fitWidthScale = (availableWidth - 80) / viewportUnscaled.width;
      const finalScale = fitWidthScale * zoomLevel;
      const viewport = page.getViewport({ scale: finalScale });

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
      };
      await page.render(renderContext).promise;

      const textContent = await page.getTextContent();
      if (context) {
        context.fillStyle = 'rgba(255, 255, 0, 0.4)'; 
        const highlightRegex = createExactMatchRegex(match.entity, false);

        textContent.items.forEach((item: any) => {
          if (highlightRegex.test(item.str)) {
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
            const x = tx[4];
            const y = tx[5] - fontHeight; 
            const w = item.width * finalScale;
            const h = item.height * finalScale; 
            context.fillRect(x, y, w, h * 1.4); 
          }
        });
      }

    } catch (err) {
      console.error("Fehler beim Laden der Datei:", err);
      alert("Datei konnte nicht geladen werden. Wurde sie verschoben?");
    }
  };

  const handleDeleteDb = async () => {
    if(confirm("Datenbank wirklich leeren?")){
        await db.clear();
        setEntityCounts({});
        setActiveEntity(null);
        setSelectedMatch(null);
    }
  }

  useEffect(() => {
    if (selectedMatch) loadAndRenderMatch(selectedMatch);
  }, [zoomLevel]);

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-indigo-900 text-white p-4 shadow-md flex justify-between items-center z-20">
        <div className="flex items-center gap-2">
          <Database className="h-6 w-6 text-indigo-300" />
          <h1 className="text-xl font-bold">Entity Indexer <span className="text-xs font-normal text-indigo-300 ml-2">Lokale Version (All-in-One)</span></h1>
        </div>
        {!pdfLibReady && <span className="text-xs animate-pulse">Lade Engine...</span>}
      </header>

      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar */}
        <div className="w-1/3 min-w-[350px] bg-white border-r border-slate-200 flex flex-col h-full shadow-xl z-10">
          
          <div className="p-4 bg-slate-100 border-b border-slate-200 space-y-4">
            
            {/* 1. CSV */}
            <div className="flex items-center gap-2">
               <div className="relative group flex-1">
                <input type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="absolute inset-0 w-full opacity-0 cursor-pointer" />
                <button className={`w-full py-2 px-3 border rounded text-sm font-medium flex items-center justify-center gap-2 ${csvContent.length > 0 ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-slate-300'}`}>
                  <FileText size={16} />
                  {csvContent.length > 0 ? `${csvContent.length} Entities geladen` : 'Entities laden (.csv)'}
                </button>
              </div>
            </div>

            {/* 2. Folder Indexer */}
            <div className="bg-white p-3 rounded border border-slate-300 shadow-sm">
              <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Lokaler Indexer</label>
              
              {!isProcessing ? (
                <button 
                  onClick={handleFolderSelect}
                  disabled={csvContent.length === 0}
                  className={`w-full py-3 rounded flex items-center justify-center gap-2 font-bold text-white transition-all ${csvContent.length === 0 ? 'bg-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                >
                  <FolderOpen size={18} />
                  Ordner wählen & Starten
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-mono text-slate-600">
                    <span>File: {stats.currentFile.substring(0,20)}...</span>
                    <span>{stats.filesProcessed} Files</span>
                  </div>
                  <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 animate-pulse w-full"></div>
                  </div>
                  <button onClick={stopProcessing} className="w-full py-1 text-xs text-red-600 border border-red-200 bg-red-50 rounded hover:bg-red-100 flex items-center justify-center gap-1">
                    <StopCircle size={12} /> Stop
                  </button>
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="flex justify-between text-xs text-slate-500 px-1">
              <span>DB Einträge: {Object.values(entityCounts).reduce((a,b)=>a+b, 0)}</span>
              <div className="flex gap-2">
                <button onClick={handleDeleteDb} className="flex items-center gap-1 hover:text-red-600 text-slate-400" title="DB Leeren"><Trash2 size={12} /></button>
                <button onClick={refreshStats} className="flex items-center gap-1 hover:text-indigo-600"><RefreshCw size={10} /> Refresh</button>
              </div>
            </div>
          </div>

          {/* Results List */}
          <div className="flex-1 overflow-y-auto bg-white">
            {Object.keys(entityCounts).length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <Database className="mx-auto h-12 w-12 mb-2 opacity-20" />
                <p>Keine Daten im Index.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {Object.entries(entityCounts)
                  .sort(([,a], [,b]) => b - a)
                  .map(([entity, count]) => (
                  <div key={entity}>
                    <button 
                      onClick={() => handleSelectEntity(entity)}
                      className={`w-full flex items-center justify-between p-3 hover:bg-slate-50 transition-colors text-left text-sm ${activeEntity === entity ? 'bg-indigo-50 border-l-4 border-indigo-500' : ''}`}
                    >
                      <span className="font-medium text-slate-700">{entity}</span>
                      <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs font-bold">{count}</span>
                    </button>
                    
                    {activeEntity === entity && (
                      <div className="bg-slate-50 pl-4 border-b border-slate-100">
                        {activeMatches.map((m, idx) => (
                          <button
                            key={idx}
                            onClick={() => loadAndRenderMatch(m)}
                            className={`w-full text-left p-2 text-xs border-l-2 border-slate-200 hover:bg-white hover:border-indigo-300 transition-all mb-1 ${selectedMatch === m ? 'bg-white border-indigo-500 shadow-sm' : ''}`}
                          >
                            <div className="font-bold text-slate-700 truncate">{m.fileName} <span className="font-normal text-slate-400">P. {m.pageNumber}</span></div>
                            <div className="text-slate-500 italic truncate opacity-80">{m.textSnippet}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Viewer */}
        <div ref={scrollContainerRef} className="flex-1 bg-slate-200 relative overflow-auto">
          {selectedMatch ? (
            <div className="min-w-full w-fit flex flex-col items-center p-6 min-h-full mx-auto">
              <div className="w-full max-w-5xl sticky top-0 z-20 space-y-2 mb-4">
                 <div className="bg-slate-800 text-white p-2 rounded-lg shadow-lg flex justify-center items-center gap-4 mx-auto w-fit">
                    <button onClick={() => setZoomLevel(p => Math.max(0.5, p - 0.25))}><ZoomOut size={18} /></button>
                    <span className="text-xs font-mono w-12 text-center">{Math.round(zoomLevel * 100)}%</span>
                    <button onClick={() => setZoomLevel(p => Math.min(3.0, p + 0.25))}><ZoomIn size={18} /></button>
                </div>
              </div>
              <div className="bg-white shadow-2xl rounded-sm overflow-hidden relative">
                 <canvas ref={canvasRef} className="block" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Eye size={48} className="text-slate-300 mb-2" />
              <p>Wähle einen Treffer links aus.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EntityViewer;