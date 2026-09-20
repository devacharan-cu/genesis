import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Float, Line, Billboard } from '@react-three/drei';
import { Brain, Activity, Terminal, Shield, CheckCircle, Play, Loader2, XCircle, AlertTriangle } from 'lucide-react';

const API = 'http://127.0.0.1:3001';

type EventView = {
  seq: number;
  type: string;
  timestamp: string;
  lane: string;
  stage: string | null;
  headline: string;
  detail: string | null;
  severity: 'INFO' | 'ACTIVE' | 'SUCCESS' | 'WARN' | 'FAILURE';
  authority: string;
  artifactId: string | null;
};

type Artifact = {
  artifactId: string;
  path: string;
  contentHash: string;
  contents: string | null;
  state: string;
  evidenceCount: number;
  proposedBy: string | null;
};

type Stage = { stage: string; label: string; pass: number; result: string; detail: string | null };

type Snapshot = {
  project: { projectId: string; intent: string; scenario: string; status: string };
  console: {
    events: EventView[];
    stages: Stage[];
    artifacts: Artifact[];
    run: { outcome: string | null; summary: string | null; repairAttempts: number | null } | null;
    goals: { description: string; status: string }[];
    activeLane: string | null;
  };
};

const NODES: { id: string; label: string; color: string; pos: [number, number, number] }[] = [
  { id: 'PLANNER', label: 'Planner', color: '#4ade80', pos: [-4, 4, 0] },
  { id: 'ARCHITECT', label: 'Architect', color: '#60a5fa', pos: [4, 4, 0] },
  { id: 'BUILDER', label: 'Builder', color: '#f472b6', pos: [-4, 0, 0] },
  { id: 'QA', label: 'QA', color: '#facc15', pos: [4, 0, 0] },
  { id: 'SECURITY', label: 'Security', color: '#ef4444', pos: [-4, -4, 0] },
  { id: 'REPAIR', label: 'Repair', color: '#fb923c', pos: [0, -2, 3] },
  { id: 'VERIFIER', label: 'Verifier', color: '#a855f7', pos: [4, -4, 0] },
  { id: 'ARTIFACT', label: 'Artifact', color: '#ffffff', pos: [0, 0, -4] },
];

const SCENARIOS = [
  { name: 'repair', label: 'Failure → repair → verified' },
  { name: 'verified', label: 'Clean build → verified' },
  { name: 'security', label: 'Security block' },
];

function SystemNode({ position, color, label, active, selected, onClick }: {
  position: [number, number, number]; color: string; label: string; active: boolean; selected: boolean; onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const lit = active || hovered || selected;
  return (
    <Float speed={2} rotationIntensity={0.4} floatIntensity={active ? 2 : 0.4}>
      <group
        position={position}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <mesh scale={lit ? 1.25 : 1}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit ? 2 : 0.4} wireframe={!lit} transparent opacity={0.85} />
        </mesh>
        {/* An invisible larger sphere so the whole node is clickable, not just the surface. */}
        <mesh visible={false}><sphereGeometry args={[1.8, 12, 12]} /></mesh>
        <Billboard>
          <Text position={[0, -1.9, 0]} fontSize={0.45} color={selected ? color : 'white'} anchorX="center" anchorY="middle">
            {label}
          </Text>
        </Billboard>
      </group>
    </Float>
  );
}

export default function App() {
  const [events, setEvents] = useState<EventView[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState('Build a small tutoring centre management app');
  const [scenario, setScenario] = useState('repair');
  const [status, setStatus] = useState('Idle');
  const [busy, setBusy] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  useEffect(() => () => sseRef.current?.close(), []);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setEvents([]);
    setSnapshot(null);
    setStatus('Creating project…');
    try {
      const created = await fetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, scenario }),
      });
      if (!created.ok) throw new Error((await created.json()).error ?? 'could not create the project');
      const snap = (await created.json()) as Snapshot;
      setSnapshot(snap);
      const id = snap.project.projectId;

      sseRef.current?.close();
      const sse = new EventSource(`${API}/api/projects/${id}/stream`);
      sseRef.current = sse;
      sse.addEventListener('snapshot', (e) => {
        const s = JSON.parse((e as MessageEvent).data) as Snapshot;
        setSnapshot(s);
        setEvents(s.console.events);
      });
      sse.addEventListener('append', (e) => {
        const view = JSON.parse((e as MessageEvent).data) as EventView;
        setEvents((prev) => (prev.some((p) => p.seq === view.seq) ? prev : [...prev, view]));
      });
      sse.addEventListener('status', (e) => {
        const s = JSON.parse((e as MessageEvent).data) as { status: string };
        setStatus(s.status);
        if (s.status === 'FINISHED' || s.status === 'ERRORED') {
          setBusy(false);
          fetch(`${API}/api/projects/${id}`).then((r) => r.json()).then(setSnapshot).catch(() => undefined);
        }
      });
      sse.onerror = () => setStatus('Stream error');

      setStatus('Running');
      const run = await fetch(`${API}/api/projects/${id}/runs`, { method: 'POST' });
      if (!run.ok) throw new Error('could not start the run');
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const activeLane = events.length > 0 ? events[events.length - 1].lane : null;
  const shown = selected ? events.filter((e) => e.lane === selected) : events;
  const run = snapshot?.console.run ?? null;
  const artifacts = snapshot?.console.artifacts ?? [];
  const stages = snapshot?.console.stages ?? [];

  const tone = (s: EventView['severity']) =>
    s === 'FAILURE' ? 'text-red-400 border-red-500/30' :
    s === 'SUCCESS' ? 'text-green-400 border-green-500/30' :
    s === 'WARN' ? 'text-amber-400 border-amber-500/30' :
    s === 'ACTIVE' ? 'text-blue-300 border-blue-500/30' : 'text-gray-300 border-gray-800';

  return (
    <div className="w-full h-screen bg-black text-white flex overflow-hidden font-mono">
      <div className="w-[46%] h-full border-r border-gray-800 bg-black/95 p-5 flex flex-col z-10">
        <div className="flex items-center gap-3 mb-1">
          <Brain className="w-7 h-7 text-green-400" />
          <div>
            <h1 className="text-xl font-bold tracking-widest text-green-400">GENESIS</h1>
            <p className="text-[11px] text-gray-500 tracking-wide">Self-questioning software intelligence</p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <label className="text-[11px] uppercase tracking-widest text-gray-500">Human intent</label>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm text-gray-200 focus:border-green-500/60 outline-none resize-none"
          />
          <div className="flex gap-2">
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              className="flex-1 bg-gray-950 border border-gray-800 rounded px-2 py-2 text-xs text-gray-300 outline-none"
            >
              {SCENARIOS.map((s) => <option key={s.name} value={s.name}>{s.label}</option>)}
            </select>
            <button
              onClick={start}
              disabled={busy || intent.trim().length === 0}
              className="flex items-center gap-2 bg-green-500/20 hover:bg-green-500/40 disabled:opacity-40 text-green-300 px-4 py-2 rounded border border-green-500/30 text-xs font-bold tracking-wider"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {busy ? 'RUNNING' : 'RUN FACTORY'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
          <div className="bg-gray-950 border border-gray-800 rounded p-2">
            <div className="text-gray-500">Status</div>
            <div className="text-gray-200">{status}</div>
          </div>
          <div className="bg-gray-950 border border-gray-800 rounded p-2">
            <div className="text-gray-500">Events</div>
            <div className="text-gray-200">{events.length}</div>
          </div>
          <div className="bg-gray-950 border border-gray-800 rounded p-2">
            <div className="text-gray-500">Outcome</div>
            <div className={run?.outcome === 'VERIFIED' ? 'text-green-400' : run?.outcome ? 'text-red-400' : 'text-gray-400'}>
              {run?.outcome ?? '—'}
            </div>
          </div>
        </div>

        {stages.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {stages.map((s, i) => (
              <span key={i} className={`text-[10px] px-2 py-1 rounded border ${
                s.result === 'PASSED' ? 'border-green-600/40 text-green-400' :
                s.result === 'FAILED' ? 'border-red-600/40 text-red-400' : 'border-gray-700 text-gray-400'}`}>
                {s.label}{s.pass > 1 ? ` ·${s.pass}` : ''}
              </span>
            ))}
          </div>
        )}

        {artifacts.length > 0 && (
          <div className="mt-3 bg-gray-950 border border-gray-800 rounded p-2 text-[11px]">
            <div className="text-gray-500 uppercase tracking-widest mb-1">Artifacts</div>
            {artifacts.map((a) => (
              <div key={a.artifactId} className="flex justify-between gap-2 py-0.5">
                <span className="text-gray-300 truncate">{a.path}</span>
                <span className={a.state === 'GENERATED' ? 'text-amber-400' : 'text-green-400'}>
                  {a.state} · {a.evidenceCount} ev
                </span>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div className="mt-3 flex items-center justify-between bg-blue-900/20 border border-blue-500/30 px-3 py-2 rounded">
            <span className="text-blue-300 text-xs uppercase tracking-wider">{selected} · {shown.length} events</span>
            <button onClick={() => setSelected(null)} className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-300">CLEAR</button>
          </div>
        )}

        <h2 className="text-[11px] text-gray-500 uppercase tracking-widest mt-4 mb-2 flex items-center gap-2">
          <Activity className="w-3 h-3" /> Ledger event stream
        </h2>
        <div ref={logRef} className="flex-1 overflow-y-auto space-y-1 pr-1">
          {shown.map((ev) => (
            <div key={ev.seq} className={`px-2 py-1.5 border-l-2 bg-gray-950/60 ${tone(ev.severity)}`}>
              <div className="flex items-center gap-2 text-[10px] opacity-70">
                <span className="font-bold">{ev.lane}</span>
                <span>#{ev.seq}</span>
                <span className="truncate">{ev.type}</span>
              </div>
              <div className="text-xs">{ev.headline}</div>
              {ev.detail && <div className="text-[11px] text-gray-500">{ev.detail}</div>}
            </div>
          ))}
          {events.length === 0 && <p className="text-gray-600 text-xs italic">No run yet. Enter an intent and run the factory.</p>}
        </div>
      </div>

      <div className="flex-1 h-full relative">
        {!webglFailed ? (
          <Canvas camera={{ position: [0, 0, 16], fov: 60 }} onCreated={() => undefined} fallback={<div />}>
            <color attach="background" args={['#000000']} />
            <ambientLight intensity={0.25} />
            <pointLight position={[10, 10, 10]} intensity={1} />
            <Stars radius={100} depth={50} count={3000} factor={4} fade speed={1} />
            {NODES.map((n) => (
              <SystemNode
                key={n.id}
                position={n.pos}
                color={n.color}
                label={n.label}
                active={activeLane === n.id}
                selected={selected === n.id}
                onClick={() => setSelected(selected === n.id ? null : n.id)}
              />
            ))}
            <Line points={[NODES[0].pos, NODES[1].pos]} color="#333" lineWidth={1} />
            <Line points={[NODES[1].pos, NODES[2].pos]} color="#333" lineWidth={1} />
            <Line points={[NODES[2].pos, NODES[3].pos]} color="#333" lineWidth={1} />
            <Line points={[NODES[3].pos, NODES[4].pos]} color="#333" lineWidth={1} />
            <Line points={[NODES[4].pos, NODES[6].pos]} color="#333" lineWidth={1} />
            <Line points={[NODES[6].pos, NODES[7].pos]} color="#333" lineWidth={1} />
            <OrbitControls enableZoom autoRotate autoRotateSpeed={0.4} makeDefault />
          </Canvas>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">3D view unavailable</div>
        )}

        <div className="absolute top-5 right-5 flex gap-2">
          {NODES.slice(0, 7).map((n) => (
            <button
              key={n.id}
              onClick={() => setSelected(selected === n.id ? null : n.id)}
              className={`text-[10px] px-2 py-1 rounded border backdrop-blur ${
                selected === n.id ? 'border-white text-white' : activeLane === n.id ? 'border-green-500 text-green-400' : 'border-gray-700 text-gray-400'
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>

        {run?.outcome && (
          <div className="absolute bottom-5 left-5 right-5 bg-black/85 border rounded p-3 backdrop-blur"
               style={{ borderColor: run.outcome === 'VERIFIED' ? 'rgba(74,222,128,.4)' : 'rgba(239,68,68,.4)' }}>
            <div className="flex items-center gap-2">
              {run.outcome === 'VERIFIED'
                ? <CheckCircle className="w-4 h-4 text-green-400" />
                : run.outcome === 'BLOCKED' ? <Shield className="w-4 h-4 text-red-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
              <span className={`text-sm font-bold tracking-wider ${run.outcome === 'VERIFIED' ? 'text-green-400' : 'text-red-400'}`}>
                {run.outcome}
              </span>
              {run.repairAttempts ? (
                <span className="text-[11px] text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {run.repairAttempts} repair attempt(s)
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-gray-400 mt-1">{run.summary}</p>
          </div>
        )}

        <div className="absolute top-5 left-5 flex items-center gap-2 text-[10px] text-gray-500">
          <Terminal className="w-3 h-3" /> intent → plan → architect → build → test → security → verify
        </div>
        {webglFailed && <span className="hidden">{String(setWebglFailed)}</span>}
      </div>
    </div>
  );
}
