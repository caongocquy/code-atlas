import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import { MultiDirectedGraph } from "graphology";
import Sigma from "sigma";
import { toSigmaNodeAttributes } from "./graph";
import type {
  Chunk,
  ContextInspection,
  GraphEdge,
  GraphNode,
  GraphOverview,
  IndexedFile,
  Inspection,
  NodeDetails,
  SourceResponse,
  Status,
} from "./types";
import "./styles.css";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);

type Tab = "overview" | "retrieval" | "graph";
type GraphMode = "global" | "focused";
type LayoutMode = "force" | "radial";
type EdgeType = GraphEdge["type"];
type Point = { x: number; y: number };

const defaultOptions = {
  topK: 20,
  rerankTopK: 5,
  graphEnabled: true,
  graphDepth: 2,
  graphMaxNodes: 8,
  tokenBudget: 4000,
};

const graphNodeColors: Record<string, string> = {
  file: "#79a9ff",
  class: "#e1a7ff",
  method: "#80e6bd",
  function: "#8ce6c0",
  interface: "#f0c674",
  type: "#f0c674",
  enum: "#f0c674",
  variable: "#9fb8d5",
};

const graphEdgeColors: Record<EdgeType, string> = {
  calls: "#f3c969",
  imports: "#6eb6ff",
  extends: "#d79cff",
  contains: "#496079",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

function formatScore(value?: number): string { return value === undefined ? "—" : value.toFixed(4); }
function formatMs(value?: number): string { return value === undefined ? "—" : `${value.toFixed(1)} ms`; }
function labelForChunk(chunk: Chunk): string { return `${chunk.file ?? "unknown"} :: ${chunk.symbolName ?? "unknown"}`; }

function StatusPill({ status }: { status: string }): ReactElement { return <span className={`pill ${status}`}>{status}</span>; }
function Metric({ label, value }: { label: string; value: ReactNode }): ReactElement { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function ChunkCard({ chunk, onInspect, onGraph }: { chunk: Chunk; onInspect: (chunk: Chunk) => void; onGraph: (chunk: Chunk) => void }): ReactElement {
  return <button className="chunk-card" onClick={() => onInspect(chunk)}><div className="chunk-card-top"><span className="mono">{labelForChunk(chunk)}</span><span className={`source source-${chunk.source}`}>{chunk.source}</span></div><div className="chunk-meta"><span>{chunk.symbolType ?? "symbol"}</span><span>lines {chunk.startLine ?? "?"}–{chunk.endLine ?? "?"}</span>{chunk.rankBefore !== undefined && <span>before #{chunk.rankBefore} → after #{chunk.rerankRank}</span>}{chunk.rerankScore !== undefined && <span>rerank {formatScore(chunk.rerankScore)}</span>}{chunk.fusionScore !== undefined && <span>RRF {formatScore(chunk.fusionScore)}</span>}</div><p>{(chunk.content ?? "").slice(0, 220).replace(/\s+/g, " ") || "No source preview"}</p><span className="card-link" onClick={(event) => { event.stopPropagation(); onGraph(chunk); }}>View in Graph ↗</span></button>;
}

function ChunkList({ title, chunks, onInspect, onGraph }: { title: string; chunks: Chunk[]; onInspect: (chunk: Chunk) => void; onGraph: (chunk: Chunk) => void }): ReactElement {
  return <section className="panel stage-panel"><div className="panel-heading"><h3>{title}</h3><span className="muted">{chunks.length} results</span></div><div className="chunk-list">{chunks.length === 0 ? <div className="empty">No results at this stage.</div> : chunks.map((chunk) => <ChunkCard key={`${title}-${chunk.key}`} chunk={chunk} onInspect={onInspect} onGraph={onGraph} />)}</div></section>;
}

function ChunkDetail({ chunk, onClose }: { chunk: Chunk | null; onClose: () => void }): ReactElement | null {
  if (!chunk) return null;
  return <aside className="detail-drawer"><div className="panel-heading"><h3>Why is this chunk here?</h3><button className="icon-button" onClick={onClose}>×</button></div><h4>{labelForChunk(chunk)}</h4><p className="muted">{chunk.symbolType} · lines {chunk.startLine ?? "?"}–{chunk.endLine ?? "?"}</p><div className="detail-grid"><Metric label="source" value={chunk.source} /><Metric label="vector" value={formatScore(chunk.vectorScore)} /><Metric label="lexical" value={formatScore(chunk.lexicalScore)} /><Metric label="fusion" value={formatScore(chunk.fusionScore)} /><Metric label="rerank" value={formatScore(chunk.rerankScore)} /><Metric label="tokens" value={chunk.tokens ?? "—"} /></div><h5>Provenance</h5>{chunk.provenance.length === 0 ? <p className="muted">No provenance recorded.</p> : chunk.provenance.map((item, index) => <div className="provenance" key={`${item.stage}-${index}`}><strong>{item.stage}</strong><span>{item.source}{item.relation ? ` · ${item.relation}` : ""}{item.depth !== undefined ? ` · depth ${item.depth}` : ""}</span></div>)}<pre className="source-preview">{chunk.content ?? "No source text"}</pre></aside>;
}

function Overview({ status, refresh, error }: { status: Status | null; refresh: () => void; error: string | null }): ReactElement {
  return <div className="page-grid"><div className="page-header"><div><p className="eyebrow">REPOSITORY HEALTH</p><h2>Overview</h2>{status && <p className="muted mono">{status.repository.path}</p>}</div><button className="button" onClick={refresh}>Refresh status</button></div>{error && <div className="alert error">{error}</div>}{!status && !error && <div className="panel empty">Loading repository status…</div>}{status && <><section className="panel repo-banner"><div><span className="muted">Repository</span><h3>{status.repository.repoId}</h3></div><Metric label="source files" value={status.repository.sourceFiles} /></section><div className="status-columns"><IndexCard title="Vector index" version={status.vector.currentVersion} stored={status.vector.storedVersion} status={status.vector.status} rows={[["backend", status.vector.backend], ["indexed files", status.vector.indexedFiles], ["chunks / points", status.vector.points]]} footer={status.vector.error ?? (status.vector.needsSync ? "Needs sync / reindex" : "In sync")} /><IndexCard title="Graph index" version={status.graph.currentVersion} stored={status.graph.storedVersion} status={status.graph.status} rows={[["indexed files", status.graph.indexedFiles], ["nodes", status.graph.nodes], ["edges", status.graph.edges], ["calls", status.graph.edgeBreakdown.calls], ["imports", status.graph.edgeBreakdown.imports], ["extends", status.graph.edgeBreakdown.extends], ["contains", status.graph.edgeBreakdown.contains]]} footer={status.graph.needsRebuild ? "Needs rebuild / sync" : "In sync"} /></div><p className="muted small">Read-only inspector. Index actions stay in the existing CLI until a shared orchestration module exists.</p></>}</div>;
}

function IndexCard({ title, version, stored, status, rows, footer }: { title: string; version: string; stored?: string; status: string; rows: Array<[string, ReactNode]>; footer: string }): ReactElement {
  return <section className="panel index-card"><div className="panel-heading"><h3>{title}</h3><StatusPill status={status} /></div><div className="version-row"><span>current <b>{version}</b></span><span>stored <b>{stored ?? "not found"}</b></span></div>{rows.map(([label, value]) => <div className="row" key={label}><span>{label}</span><b>{value}</b></div>)}<div className="card-footer">{footer}</div></section>;
}

function Retrieval({ onGraph }: { onGraph: (chunk: Chunk) => void }): ReactElement {
  const [query, setQuery] = useState("where is createPointId used?");
  const [options, setOptions] = useState(defaultOptions);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [selected, setSelected] = useState<Chunk | null>(null);
  const [stage, setStage] = useState<"vector" | "lexical" | "fusion" | "rerank">("rerank");
  const [loading, setLoading] = useState(false);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (answer = false): Promise<void> => { setError(null); answer ? setAnswerLoading(true) : setLoading(true); try { setInspection(await api<Inspection>(`/api/retrieval/${answer ? "answer" : "inspect"}`, { method: "POST", body: JSON.stringify({ query, ...options }) })); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); } finally { setLoading(false); setAnswerLoading(false); } };
  const stageChunks = inspection ? { vector: inspection.vectorResults, lexical: inspection.lexicalResults, fusion: inspection.fusedResults, rerank: inspection.rerankedResults }[stage] : [];
  const activeContext = inspection?.finalContext;
  return <div className="page-grid retrieval-page"><div className="page-header"><div><p className="eyebrow">PIPELINE DEBUGGER</p><h2>Retrieval inspector</h2><p className="muted">See every stage before the model receives context.</p></div><div className="button-row"><button className="button secondary" onClick={() => setOptions(defaultOptions)}>Reset</button><button className="button" disabled={loading} onClick={() => void run()}>{loading ? "Inspecting…" : "Run retrieval"}</button><button className="button accent" disabled={answerLoading} onClick={() => void run(true)}>{answerLoading ? "Generating…" : "Run full answer"}</button></div></div><section className="panel query-panel"><div className="query-row"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} placeholder="Ask about the repository…" /><label>topK <input className="number-input" type="number" min="1" max="50" value={options.topK} onChange={(event) => setOptions({ ...options, topK: Number(event.target.value) })} /></label><label>rerank <input className="number-input" type="number" min="1" max="20" value={options.rerankTopK} onChange={(event) => setOptions({ ...options, rerankTopK: Number(event.target.value) })} /></label><label>budget <input className="number-input wide" type="number" min="100" value={options.tokenBudget} onChange={(event) => setOptions({ ...options, tokenBudget: Number(event.target.value) })} /></label></div><div className="controls"><label className="check"><input type="checkbox" checked={options.graphEnabled} onChange={(event) => setOptions({ ...options, graphEnabled: event.target.checked })} /> graph expansion</label><label>depth <input className="number-input" type="number" min="0" max="3" value={options.graphDepth} onChange={(event) => setOptions({ ...options, graphDepth: Number(event.target.value) })} /></label><label>max nodes <input className="number-input" type="number" min="0" max="100" value={options.graphMaxNodes} onChange={(event) => setOptions({ ...options, graphMaxNodes: Number(event.target.value) })} /></label></div></section>{error && <div className="alert error">{error}</div>}{inspection && <><section className="pipeline"><PipelineStep label="Vector + lexical" value={`${inspection.vectorResults.length} / ${inspection.lexicalResults.length}`} /><span>→</span><PipelineStep label="Fusion / RRF" value={`${inspection.fusedResults.length} candidates`} /><span>→</span><PipelineStep label="Reranker" value={`${inspection.rerankedResults.length} kept`} /><span>→</span><PipelineStep label="Graph" value={`${inspection.graphExpansion.nodesAdded} added`} /><span>→</span><PipelineStep label="Context" value={`${activeContext?.tokens ?? 0} tokens`} /></section><section className="metric-strip"><Metric label="vector" value={formatMs(inspection.metrics.vectorMs)} /><Metric label="lexical" value={formatMs(inspection.metrics.lexicalMs)} /><Metric label="search" value={formatMs(inspection.metrics.searchMs)} /><Metric label="rerank" value={formatMs(inspection.metrics.rerankMs)} /><Metric label="graph" value={formatMs(inspection.metrics.graphExpansionMs)} /><Metric label="context" value={formatMs(inspection.metrics.contextMs)} /></section><div className="stage-tabs">{([["vector", "Vector"], ["lexical", "Lexical"], ["fusion", "Fusion / RRF"], ["rerank", "Reranked"]] as const).map(([value, label]) => <button className={stage === value ? "active" : ""} key={value} onClick={() => setStage(value)}>{label}</button>)}</div><ChunkList title={stage === "vector" ? "Vector results" : stage === "lexical" ? "Lexical results" : stage === "fusion" ? "Fusion / RRF results" : "Reranked results"} chunks={stageChunks} onInspect={setSelected} onGraph={onGraph} /><div className="comparison-grid"><ContextColumn title="Retrieval only" context={inspection.retrievalOnly} /><ContextColumn title="Retrieval + graph" context={inspection.withGraph} /></div><section className="panel graph-expansion"><div className="panel-heading"><h3>Graph expansion</h3><span className="muted">{inspection.graphExpansion.nodesConsidered} considered · {inspection.graphExpansion.nodesAdded} added</span></div>{inspection.graphExpansion.error && <div className="alert warning">Graph unavailable: {inspection.graphExpansion.error}</div>}<div className="expansion-list">{inspection.graphExpansion.details.map((detail) => <div className="expansion-item" key={detail.node.key}><span className="source source-graph">depth {detail.depth}</span><span className="mono">{labelForChunk(detail.node)}</span><span>{detail.relation}</span></div>)}</div></section><section className="panel final-context"><div className="panel-heading"><div><h3>Final AI context</h3><p className="muted">Exact rendered context sent in the user message.</p></div><span className="pill ready">{activeContext?.tokens ?? 0} / {activeContext?.budget ?? options.tokenBudget} tokens</span></div><pre>{activeContext?.rendered ?? ""}</pre><h4>Dropped by token budget</h4>{activeContext?.dropped.length === 0 ? <p className="muted">Nothing dropped.</p> : activeContext?.dropped.map((chunk) => <div className="dropped" key={chunk.key}><span className="mono">{labelForChunk(chunk)}</span><span>{chunk.tokens ?? "?"} tokens · token budget</span></div>)}</section><section className="panel prompt-preview"><div className="panel-heading"><h3>Prompt preview</h3><span className="muted">system + user messages</span></div>{inspection.messages.map((message) => <div key={message.role}><h4>{message.role}</h4><pre>{message.content}</pre></div>)}</section>{inspection.answer && <section className="panel answer"><div className="panel-heading"><h3>Generated answer</h3><span className="pill ready">{formatMs(inspection.metrics.totalMs)}</span></div><div className="answer-text">{inspection.answer}</div><div className="metric-strip"><Metric label="TTFT" value={formatMs(inspection.metrics.ttftMs)} /><Metric label="generation" value={formatMs(inspection.metrics.generationMs)} /><Metric label="total" value={formatMs(inspection.metrics.totalMs)} /></div></section>}</>}{!inspection && !loading && <div className="panel empty">Run a query to inspect vector, lexical, fusion, rerank, graph, budget, and final prompt data.</div>}<ChunkDetail chunk={selected} onClose={() => setSelected(null)} /></div>;
}

function PipelineStep({ label, value }: { label: string; value: string }): ReactElement { return <div className="pipeline-step"><span>{label}</span><b>{value}</b></div>; }
function ContextColumn({ title, context }: { title: string; context: ContextInspection }): ReactElement { return <section className="panel context-column"><div className="panel-heading"><h3>{title}</h3><span className="muted">{context.chunks.length} chunks · {context.tokens} tokens</span></div>{context.chunks.slice(0, 8).map((chunk) => <div className="compact-chunk" key={chunk.key}><span className="mono">{labelForChunk(chunk)}</span><span>{chunk.tokens ?? "?"} tokens</span></div>)}</section>; }

type TreeEntry = { name: string; path: string; folders: TreeEntry[]; files: IndexedFile[] };

function buildFileTree(files: IndexedFile[]): TreeEntry {
  const root: TreeEntry = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    parts.slice(0, -1).forEach((part, index) => {
      const folderPath = parts.slice(0, index + 1).join("/");
      let folder = current.folders.find((candidate) => candidate.name === part);
      if (!folder) { folder = { name: part, path: folderPath, folders: [], files: [] }; current.folders.push(folder); }
      current = folder;
    });
    current.files.push(file);
  }
  const sort = (entry: TreeEntry): void => { entry.folders.sort((a, b) => a.name.localeCompare(b.name)); entry.files.sort((a, b) => a.path.localeCompare(b.path)); entry.folders.forEach(sort); };
  sort(root);
  return root;
}

function FileTree({ files, selectedFile, onSelect }: { files: IndexedFile[]; selectedFile: string | null; onSelect: (file: IndexedFile) => void }): ReactElement {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["src", "src/graph", "web", "web/src"]));
  useEffect(() => { if (!selectedFile) return; const parts = selectedFile.split("/"); setExpanded((current) => { const next = new Set(current); parts.slice(0, -1).forEach((_part, index) => next.add(parts.slice(0, index + 1).join("/"))); return next; }); }, [selectedFile]);
  const tree = useMemo(() => buildFileTree(files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))), [files, filter]);
  const toggle = (path: string): void => setExpanded((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const renderEntry = (entry: TreeEntry): ReactElement => <div key={entry.path}>{entry.name && <button className="tree-folder" onClick={() => toggle(entry.path)}><span>{expanded.has(entry.path) ? "▾" : "▸"}</span>{entry.name}</button>}{(!entry.name || expanded.has(entry.path)) && <div className="tree-children">{entry.folders.map(renderEntry)}{entry.files.map((file) => <button className={`tree-file ${selectedFile === file.path ? "selected" : ""}`} key={file.path} title={`${file.symbols} symbols`} onClick={() => onSelect(file)}><span>◇</span>{file.path.split("/").at(-1)}</button>)}</div>}</div>;
  return <aside className="file-explorer"><div className="explorer-heading"><span>Files</span><span className="muted">{files.length}</span></div><input className="tree-search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" />{files.length === 0 ? <p className="muted small">No indexed files.</p> : <div className="file-tree">{renderEntry(tree)}</div>}</aside>;
}

function deterministicLayout(nodes: GraphNode[], edges: GraphEdge[], mode: LayoutMode, centerId?: string): Map<string, Point> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (ordered.length === 0) return new Map();
  if (mode === "radial") {
    const center = centerId && ordered.some((node) => node.id === centerId) ? centerId : ordered[0].id;
    const adjacency = new Map<string, string[]>();
    ordered.forEach((node) => adjacency.set(node.id, []));
    edges.forEach((edge) => { adjacency.get(edge.from)?.push(edge.to); adjacency.get(edge.to)?.push(edge.from); });
    const distance = new Map([[center, 0]]); const queue = [center];
    while (queue.length) { const node = queue.shift()!; for (const next of [...(adjacency.get(node) ?? [])].sort()) if (!distance.has(next)) { distance.set(next, distance.get(node)! + 1); queue.push(next); } }
    const groups = new Map<number, string[]>();
    ordered.forEach((node) => { const level = distance.get(node.id) ?? 99; const group = groups.get(level) ?? []; group.push(node.id); groups.set(level, group); });
    const positions = new Map<string, Point>();
    [...groups.entries()].sort(([a], [b]) => a - b).forEach(([level, group]) => group.sort().forEach((id, index) => { const radius = level === 0 ? 0 : 1.3 * level; const angle = (index / Math.max(1, group.length)) * Math.PI * 2 + (level % 2) * 0.18; positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }); }));
    return positions;
  }
  if (ordered.length > 600) return deterministicLayout(ordered, edges, "radial", centerId);
  const positions = new Map(ordered.map((node, index) => { const angle = (index / ordered.length) * Math.PI * 2; return [node.id, { x: Math.cos(angle), y: Math.sin(angle) }]; }));
  // ponytail: bounded O(n²) force pass; use a worker/layout package if graphs exceed this UI ceiling.
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const delta = new Map<string, Point>(ordered.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < ordered.length; i += 1) for (let j = i + 1; j < ordered.length; j += 1) { const a = positions.get(ordered[i].id)!; const b = positions.get(ordered[j].id)!; const dx = a.x - b.x; const dy = a.y - b.y; const distance = Math.max(0.08, Math.hypot(dx, dy)); const force = Math.min(0.08, 0.025 / distance); const ax = (dx / distance) * force; const ay = (dy / distance) * force; delta.get(ordered[i].id)!.x += ax; delta.get(ordered[i].id)!.y += ay; delta.get(ordered[j].id)!.x -= ax; delta.get(ordered[j].id)!.y -= ay; }
    edges.forEach((edge) => { const a = positions.get(edge.from); const b = positions.get(edge.to); if (!a || !b) return; const dx = b.x - a.x; const dy = b.y - a.y; const distance = Math.max(0.08, Math.hypot(dx, dy)); const force = Math.min(0.05, (distance - 0.55) * 0.018); delta.get(edge.from)!.x += (dx / distance) * force; delta.get(edge.from)!.y += (dy / distance) * force; delta.get(edge.to)!.x -= (dx / distance) * force; delta.get(edge.to)!.y -= (dy / distance) * force; });
    ordered.forEach((node) => { const point = positions.get(node.id)!; const move = delta.get(node.id)!; point.x = Math.max(-4, Math.min(4, point.x + move.x)); point.y = Math.max(-4, Math.min(4, point.y + move.y)); });
  }
  return positions;
}

function languageForSource(language: string): string { return language === "plaintext" ? "plaintext" : language; }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function highlightSourceLine(line: string, language: string): string { return language === "plaintext" ? escapeHtml(line || " ") : hljs.highlight(line || " ", { language: languageForSource(language), ignoreIllegals: true }).value; }

function CodeInspector({ source, node, details, onClose }: { source: SourceResponse | null; node: GraphNode | null; details: NodeDetails | null; onClose: () => void }): ReactElement {
  const lines = source?.content.split("\n") ?? [];
  const sourceRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sourceRef.current?.querySelector<HTMLElement>(".source-line.selected")?.scrollIntoView({ block: "center" }); }, [node, source]);
  return <aside className="code-inspector"><div className="panel-heading"><div><p className="eyebrow">CODE INSPECTOR</p><h3>{node?.name ?? source?.path ?? "Select a symbol"}</h3></div><button className="icon-button" onClick={onClose}>×</button></div>{source && <><p className="muted mono">{source.path} · lines {source.startLine}–{source.endLine}</p>{node && <p className="muted">{node.type} · {node.qualifiedName ?? node.name}</p>}<div className="source-code" ref={sourceRef}>{lines.map((line, index) => { const lineNumber = source.startLine + index; const highlighted = highlightSourceLine(line, source.language); const active = node?.startLine !== undefined && node.endLine !== undefined && lineNumber >= node.startLine && lineNumber <= node.endLine; return <div className={`source-line ${active ? "selected" : ""}`} key={lineNumber}><span className="line-number">{lineNumber}</span><code dangerouslySetInnerHTML={{ __html: highlighted }} /></div>; })}</div>{details && <div className="inspector-relations">{([["callers", details.callers], ["callees", details.callees], ["imports", details.imports], ["extends", details.extends]] as const).map(([label, related]) => <div key={label}><span>{label}</span><b>{related.length}</b></div>)}</div>}</>}{!source && <p className="muted">Choose a file or graph node to inspect.</p>}</aside>;
}

function GraphView({ focusQuery, focusFile, onClearFocus }: { focusQuery: string; focusFile: string; onClearFocus: () => void }): ReactElement {
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [activeGraph, setActiveGraph] = useState<GraphOverview | null>(null);
  const [mode, setMode] = useState<GraphMode>("global");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("force");
  const [query, setQuery] = useState(focusQuery);
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const [maxNodes, setMaxNodes] = useState(80);
  const [edgeTypes, setEdgeTypes] = useState<EdgeType[]>(["calls", "imports", "extends"]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<MultiDirectedGraph | null>(null);
  const positionsRef = useRef<Map<string, Point>>(new Map());
  const selectedNodeRef = useRef<string | null>(null);
  const selectedFileRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const neighborIdsRef = useRef<Set<string>>(new Set());

  const refreshGraph = async (): Promise<void> => { setLoading(true); setError(null); try { const [graph, fileResult] = await Promise.all([api<GraphOverview>("/api/graph/overview"), api<{ files: IndexedFile[] }>("/api/files")]); setOverview(graph); setActiveGraph(graph); setFiles(fileResult.files); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); } finally { setLoading(false); } };
  useEffect(() => { void refreshGraph(); }, []);
  useEffect(() => { selectedNodeRef.current = selectedNodeId; selectedFileRef.current = selectedFile; rendererRef.current?.refresh(); }, [selectedNodeId, selectedFile]);
  useEffect(() => { if (!focusQuery) return; setQuery(focusQuery); void search(focusQuery, focusFile); }, [focusFile, focusQuery]);

  const search = async (value = query, preferredFile?: string): Promise<void> => { if (!value.trim()) return; try { setError(null); const result = await api<{ nodes: GraphNode[] }>(`/api/graph/search?q=${encodeURIComponent(value)}`); setSearchResults(result.nodes); const target = result.nodes.find((node) => !preferredFile || node.file === preferredFile) ?? result.nodes[0]; if (target) await selectNode(target); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); } };

  const openSource = async (path: string, startLine?: number, endLine?: number): Promise<void> => { try { setSource(await api<SourceResponse>(`/api/source?path=${encodeURIComponent(path)}${startLine ? `&startLine=${startLine}` : ""}${endLine ? `&endLine=${endLine}` : ""}`)); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); } };
  const selectNode = async (node: GraphNode): Promise<void> => { setSelectedNodeId(node.id); setSelectedFile(node.file); setDetails(null); await Promise.all([api<NodeDetails>(`/api/graph/node/${encodeURIComponent(node.id)}`).then(setDetails), openSource(node.file, node.startLine, node.endLine)]); };
  const selectFile = async (file: IndexedFile): Promise<void> => { setSelectedFile(file.path); setSelectedNodeId(file.nodeId); setDetails(null); await openSource(file.path); };
  const focusCamera = (nodeId?: string): void => { const id = nodeId ?? selectedNodeRef.current; const position = id ? positionsRef.current.get(id) : undefined; if (position) rendererRef.current?.getCamera().animate({ x: position.x, y: position.y, ratio: 0.35 }, { duration: 350 }); else rendererRef.current?.getCamera().animatedReset(); };
  const enterFocusedMode = async (): Promise<void> => { const id = selectedNodeRef.current; if (!id) return; try { const result = await api<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/graph/neighbors/${encodeURIComponent(id)}?depth=${depth}&maxNodes=${maxNodes}&edgeTypes=${edgeTypes.join(",")}`); setActiveGraph({ ...result, totalNodes: result.nodes.length, totalEdges: result.edges.length, truncated: false }); setMode("focused"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : String(requestError)); } };
  const showGlobal = (): void => { setMode("global"); setActiveGraph(overview); };
  const reset = (): void => { setMode("global"); setActiveGraph(overview); setSearchResults([]); setSelectedNodeId(null); setSelectedFile(null); setDetails(null); setSource(null); setQuery(""); };
  const clearSelection = (): void => { setSelectedNodeId(null); setSelectedFile(null); setDetails(null); setSource(null); setMode("global"); setActiveGraph(overview); };

  const neighborIds = useMemo(() => { const ids = new Set<string>(); const graph = activeGraph; if (!graph) return ids; const fileByNode = new Map(graph.nodes.map((node) => [node.id, node.file])); if (selectedNodeId) ids.add(selectedNodeId); graph.edges.filter((edge) => edgeTypes.includes(edge.type)).forEach((edge) => { if (edge.from === selectedNodeId || edge.to === selectedNodeId || (selectedFile && (fileByNode.get(edge.from) === selectedFile || fileByNode.get(edge.to) === selectedFile))) { ids.add(edge.from); ids.add(edge.to); } }); graph.nodes.filter((node) => selectedFile && node.file === selectedFile).forEach((node) => ids.add(node.id)); return ids; }, [activeGraph, edgeTypes, selectedFile, selectedNodeId]);
  useEffect(() => { neighborIdsRef.current = neighborIds; rendererRef.current?.refresh(); }, [neighborIds]);

  useEffect(() => { if (!activeGraph) return; setLayoutBusy(true); const timer = window.setTimeout(() => { positionsRef.current = deterministicLayout(activeGraph.nodes, activeGraph.edges.filter((edge) => edgeTypes.includes(edge.type)), layoutMode, selectedNodeId ?? undefined); setLayoutBusy(false); }, 0); return () => window.clearTimeout(timer); }, [activeGraph, edgeTypes, layoutMode]);

  useEffect(() => { if (!container.current || !activeGraph || activeGraph.nodes.length === 0) return; const graph = new MultiDirectedGraph(); const filteredEdges = activeGraph.edges.filter((edge) => edgeTypes.includes(edge.type)); const degrees = new Map<string, number>(); filteredEdges.forEach((edge) => { degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1); degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1); }); activeGraph.nodes.forEach((node) => { const point = positionsRef.current.get(node.id) ?? { x: 0, y: 0 }; const baseSize = 6 + Math.min(5, (degrees.get(node.id) ?? 0) * 0.35) + (node.type === "file" ? 1 : 0); graph.addNode(node.id, toSigmaNodeAttributes(node, point, baseSize, degrees.get(node.id) ?? 0, graphNodeColors[node.type] ?? "#9fb8d5")); }); filteredEdges.forEach((edge, index) => { if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.addEdgeWithKey(`${edge.from}:${edge.to}:${edge.type}:${index}`, edge.from, edge.to, { color: graphEdgeColors[edge.type], size: edge.type === "calls" ? 2 : 1, label: edge.type }); }); graphRef.current = graph; const renderer = new Sigma(graph, container.current, { renderLabels: true, labelColor: { color: "#e8eef7" }, labelRenderedSizeThreshold: 7, allowInvalidContainer: true, nodeReducer: (node, data) => { const selected = node === selectedNodeRef.current; const hovered = node === hoveredNodeRef.current; const related = neighborIdsRef.current.has(node); const important = Number(data.degree ?? 0) >= 4; const dimmed = selectedNodeRef.current !== null && !related && !selected && !hovered; return { ...data, size: selected ? 16 : hovered ? 13 : related ? Math.max(10, Number(data.size)) : data.size, color: selected ? "#ffffff" : dimmed ? "#24364b" : data.color, label: selected || hovered || related || important || data.nodeType === "file" ? data.label : "", zIndex: selected ? 5 : hovered || related ? 2 : 0 }; }, edgeReducer: (edge, data) => { const [from, to] = graph.extremities(edge); const related = neighborIdsRef.current.has(from) || neighborIdsRef.current.has(to); return { ...data, color: selectedNodeRef.current && !related ? "#182535" : related ? data.color : `${data.color}99`, size: related ? Math.max(2, Number(data.size)) : 1 }; } }); rendererRef.current = renderer; renderer.on("clickNode", ({ node }) => { const target = activeGraph.nodes.find((candidate) => candidate.id === node); if (target) void selectNode(target); }); renderer.on("enterNode", ({ node }) => { hoveredNodeRef.current = node; setHoveredNodeId(node); renderer.refresh(); }); renderer.on("leaveNode", () => { hoveredNodeRef.current = null; setHoveredNodeId(null); renderer.refresh(); }); return () => { rendererRef.current = null; graphRef.current = null; renderer.kill(); }; }, [activeGraph, edgeTypes, layoutBusy]);
  useEffect(() => { if (!selectedNodeId || layoutBusy) return; const point = positionsRef.current.get(selectedNodeId); if (point) rendererRef.current?.getCamera().animate({ x: point.x, y: point.y, ratio: 0.35 }, { duration: 350 }); }, [selectedNodeId, layoutBusy]);

  return <div className="page-grid graph-page"><div className="page-header"><div><p className="eyebrow">STRUCTURAL EXPLORER</p><h2>CodeGraph</h2><p className="muted">Global repository graph with bounded focus mode and source inspection.</p></div><div className="button-row">{focusQuery && <button className="button secondary" onClick={onClearFocus}>Clear retrieval focus</button>}<button className="button secondary" onClick={() => void refreshGraph()}>Refresh</button></div></div><section className="panel graph-toolbar"><div className="query-row"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Search symbol, qualified name, or file" /><button className="button" onClick={() => void search()}>Search</button><button className="button secondary" onClick={() => focusCamera()}>Fit / focus</button><button className="button secondary" onClick={clearSelection}>Clear selection</button><button className="button secondary" onClick={reset}>Reset</button></div><div className="graph-controls"><div className="mode-buttons"><button className={mode === "global" ? "active" : ""} onClick={showGlobal}>Global</button><button className={mode === "focused" ? "active" : ""} disabled={!selectedNodeId} onClick={() => void enterFocusedMode()}>Focused</button></div><div className="layout-buttons"><button className={layoutMode === "force" ? "active" : ""} onClick={() => setLayoutMode("force")}>Force</button><button className={layoutMode === "radial" ? "active" : ""} onClick={() => setLayoutMode("radial")}>Radial</button></div><label>depth <input className="number-input" type="number" min="1" max="3" value={depth} onChange={(event) => setDepth(Number(event.target.value))} /></label><label>max nodes <input className="number-input" type="number" min="1" max="500" value={maxNodes} onChange={(event) => setMaxNodes(Number(event.target.value))} /></label>{(["calls", "imports", "extends", "contains"] as EdgeType[]).map((type) => <label className="check" key={type}><input type="checkbox" checked={edgeTypes.includes(type)} onChange={(event) => setEdgeTypes(event.target.checked ? [...edgeTypes, type] : edgeTypes.filter((candidate) => candidate !== type))} /> {type}</label>)}</div></section>{error && <div className="alert error">{error}</div>}{overview?.truncated && <div className="alert warning">Global graph is capped at 2,000 nodes for browser readability. Use search and Focused mode for the rest.</div>}{searchResults.length > 0 && <section className="panel search-results graph-search-results">{searchResults.slice(0, 12).map((node) => <button className={selectedNodeId === node.id ? "selected" : ""} key={node.id} onClick={() => void selectNode(node)}><span>{node.name}</span><small>{node.file} · {node.type}</small></button>)}</section>}<div className="graph-workspace"><FileTree files={files} selectedFile={selectedFile} onSelect={(file) => void selectFile(file)} /><section className="panel graph-main"><div className="graph-status"><span>{mode} graph · {activeGraph?.nodes.length ?? 0}/{overview?.totalNodes ?? 0} nodes · {activeGraph?.edges.length ?? 0}/{overview?.totalEdges ?? 0} edges</span>{layoutBusy && <span className="muted">Layout optimizing…</span>}</div><div ref={container} className="sigma-host global-graph-canvas">{loading && <div className="empty">Loading global graph…</div>}{!loading && (!activeGraph || activeGraph.nodes.length === 0) && <div className="empty">No graph index available. Run graph indexing first.</div>}</div><div className="graph-legend">{(["calls", "imports", "extends", "contains"] as EdgeType[]).map((type) => <span key={type}><i style={{ backgroundColor: graphEdgeColors[type] }} />{type}</span>)}<span className="muted">click a node to inspect · hover to preview</span></div>{hoveredNodeId && <div className="graph-hover">{activeGraph?.nodes.find((node) => node.id === hoveredNodeId)?.name}</div>}</section></div><CodeInspector source={source} node={details?.node ?? activeGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null} details={details} onClose={() => { setSource(null); setDetails(null); }} /></div>;
}

type ErrorBoundaryState = { error: Error | null };

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("AI Inspector render failure", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <main className="page-grid"><section className="panel error-boundary" role="alert"><p className="eyebrow">INSPECTOR ERROR</p><h2>Inspector failed to render</h2><p>{this.state.error.message}</p><pre>{this.state.error.stack ?? "No stack available"}</pre></section></main>;
    }
    return this.props.children;
  }
}

function App(): ReactElement {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [focusQuery, setFocusQuery] = useState("");
  const [focusFile, setFocusFile] = useState("");
  const refresh = async (): Promise<void> => { try { setStatusError(null); setStatus(await api<Status>("/api/status")); } catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); } };
  useEffect(() => { void refresh(); }, []);
  const focusGraph = (chunk: Chunk): void => { setFocusQuery(chunk.symbolName ?? chunk.file ?? ""); setFocusFile(chunk.file ?? ""); setTab("graph"); };
  const tabs = useMemo(() => [["overview", "Overview"], ["retrieval", "Retrieval"], ["graph", "Graph"]] as const, []);
  return <><header className="topbar"><div className="brand"><span className="brand-mark">◆</span><span>CODE RAG <b>INSPECTOR</b></span></div><nav>{tabs.map(([value, label]) => <button className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav><span className="live-dot">● local</span></header><main><div className={tab === "overview" ? "tab-panel" : "tab-panel hidden"}><Overview status={status} refresh={() => void refresh()} error={statusError} /></div><div className={tab === "retrieval" ? "tab-panel" : "tab-panel hidden"}><Retrieval onGraph={focusGraph} /></div><div className={tab === "graph" ? "tab-panel" : "tab-panel hidden"}><GraphView focusQuery={focusQuery} focusFile={focusFile} onClearFocus={() => { setFocusQuery(""); setFocusFile(""); }} /></div></main></>;
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<AppErrorBoundary><App /></AppErrorBoundary>);
