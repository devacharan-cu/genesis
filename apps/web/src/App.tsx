import { foldConsole, type ConsoleState, type Lane } from '@genesis/console';
import type { GenesisEvent } from '@genesis/core-types';
import { AlertTriangle } from 'lucide-react';
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArtifactPanel } from './components/ArtifactPanel';
import { EventStream } from './components/EventStream';
import { Header } from './components/Header';
import { IntentComposer } from './components/IntentComposer';
import { LaneDetail } from './components/LaneDetail';
import { PipelineRibbon } from './components/PipelineRibbon';
import { ReplayBar } from './components/ReplayBar';
import { RunSummary } from './components/RunSummary';
import {
  ApiError,
  createProject,
  getHealth,
  getScenarios,
  startRun,
  streamProject,
  type Health,
  type ProjectMeta,
  type RunStatus,
  type Scenario,
} from './lib/api';

/**
 * The map is loaded on its own.
 *
 * Three.js is most of the bundle, and the console is useful without it: the
 * pipeline, the timeline and the artifacts all render while the scene is still
 * arriving, so first paint does not wait on a renderer.
 */
const NetworkScene = lazy(async () => ({ default: (await import('./components/NetworkScene')).NetworkScene }));

/**
 * The GENESIS console.
 *
 * One rule shapes this whole component: the UI holds RAW ledger events and
 * derives everything else with `foldConsole`, the same function the API uses.
 * There is no second model of what happened here — no counters, no timers, no
 * stage list maintained by hand — so the screen cannot drift from the ledger.
 *
 * Replay falls out of that for free: showing the run as it stood at event N is
 * folding the first N events.
 */
export default function App(): React.ReactElement {
  const [health, setHealth] = useState<Health | null>(null);
  const [scenarios, setScenarios] = useState<readonly Scenario[]>([]);
  const [intent, setIntent] = useState('Build a small tutoring centre management app');
  const [scenario, setScenario] = useState('repair');

  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [events, setEvents] = useState<readonly GenesisEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [laneFilter, setLaneFilter] = useState<Lane | null>(null);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);

  const [cursor, setCursor] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);

  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    void getHealth()
      .then((value) => alive && setHealth(value))
      .catch(() => alive && setHealth(null));
    void getScenarios()
      .then((value) => alive && setScenarios(value.scenarios))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => closeStream.current?.(), []);

  // While the run is live and nobody has scrubbed, the cursor rides the head.
  useEffect(() => {
    if (!pinned) setCursor(events.length);
  }, [events.length, pinned]);

  // Replay advances the cursor over recorded history. It moves the cursor and
  // nothing else: the events themselves are already on the ledger.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        if (current >= events.length) {
          setPlaying(false);
          return events.length;
        }
        return current + 1;
      });
    }, Math.max(1000 / (speed * 6), 16));
    return () => window.clearInterval(timer);
  }, [playing, speed, events.length]);

  const visible = useMemo(() => events.slice(0, cursor), [events, cursor]);
  const state: ConsoleState = useMemo(() => foldConsole(visible), [visible]);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    setCursor(0);
    setPinned(false);
    setPlaying(false);
    setSelectedSeq(null);
    setLaneFilter(null);
    setStageFilter(null);
    setStatus('IDLE');
    closeStream.current?.();

    try {
      const created = await createProject(intent, scenario);
      setProject(created.project);

      closeStream.current = streamProject(created.project.projectId, {
        onSnapshot: (history, meta) => {
          setEvents(history);
          setProject(meta);
        },
        // Appended rather than replaced, and guarded on sequence: a duplicate
        // delivery must never become a duplicate row.
        onAppend: (event) =>
          setEvents((previous) => (previous.some((e) => e.seq === event.seq) ? previous : [...previous, event])),
        onStatus: (next, failure) => {
          setStatus(next);
          setError(failure);
          if (next === 'FINISHED' || next === 'ERRORED') setBusy(false);
        },
        onError: (message) => setError(message),
      });

      await startRun(created.project.projectId);
      setStatus('RUNNING');
    } catch (thrown) {
      setError(thrown instanceof ApiError ? thrown.message : String(thrown));
      setBusy(false);
      setStatus('ERRORED');
    }
  }, [busy, intent, scenario]);

  const live = status === 'RUNNING';
  const atHead = cursor >= events.length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header health={health} connected={health !== null} />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[330px_minmax(0,1fr)_400px]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <IntentComposer
            intent={intent}
            onIntent={setIntent}
            scenario={scenario}
            onScenario={setScenario}
            scenarios={scenarios}
            onRun={() => void run()}
            busy={busy}
            disabled={busy || intent.trim().length === 0 || intent.length > 400 || health === null}
            error={error}
          />
          <RunSummary state={state} project={project} live={live} />
          {laneFilter !== null && <LaneDetail lane={laneFilter} state={state} onClose={() => setLaneFilter(null)} />}
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <PipelineRibbon state={state} selected={stageFilter} onSelectStage={setStageFilter} />

          <section
            className="panel relative min-h-[260px] flex-1 overflow-hidden"
            aria-label="System map"
            style={{ background: '#06080c' }}
          >
            <SceneBoundary>
              <Suspense fallback={<SceneLoading />}>
                <NetworkScene state={state} selected={laneFilter} onSelect={setLaneFilter} />
              </Suspense>
            </SceneBoundary>
            <div className="flex items-center gap-3">
              <Brain className="w-8 h-8 text-green-400" />
              <h1 className="text-2xl font-bold tracking-widest text-green-400">GENESIS</h1>
            </div>
            <button 
              onClick={startDemo} 
              disabled={isRunning || status === 'Connection Error'}
              className="flex items-center gap-2 bg-green-500/20 hover:bg-green-500/40 disabled:opacity-50 disabled:cursor-not-allowed text-green-400 px-4 py-2 rounded-lg transition-colors border border-green-500/30"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {isRunning ? 'RUNNING...' : 'START DEMO'}
            </button>
          </section>

          <div className="mb-6 flex flex-col gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-widest">Project Intent</label>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              disabled={isRunning}
              className="w-full bg-black/50 border border-gray-700 rounded p-2 text-sm text-gray-300 focus:outline-none focus:border-green-500/50 resize-none"
              rows={2}
            />
          </div>

          <div className="xl:hidden">
            <ArtifactPanel state={state} />
          </div>
        </div>

        <div className="hidden min-h-0 flex-col gap-3 xl:flex">
          <EventStream
            state={state}
            laneFilter={laneFilter}
            stageFilter={stageFilter}
            onLane={setLaneFilter}
            onStage={setStageFilter}
            selectedSeq={selectedSeq}
            onSelect={setSelectedSeq}
            follow={follow && atHead}
            onFollow={setFollow}
          />
          <ArtifactPanel state={state} />
        </div>
      </main>

      {/* Below xl the timeline moves under the map rather than disappearing. */}
      <div className="min-h-0 px-3 pb-3 xl:hidden" style={{ height: '32vh' }}>
        <EventStream
          state={state}
          laneFilter={laneFilter}
          stageFilter={stageFilter}
          onLane={setLaneFilter}
          onStage={setStageFilter}
          selectedSeq={selectedSeq}
          onSelect={setSelectedSeq}
          follow={follow && atHead}
          onFollow={setFollow}
        />
      </div>

      <ReplayBar
        total={events.length}
        cursor={cursor}
        onCursor={(value) => {
          setPinned(value < events.length);
          setCursor(value);
        }}
        playing={playing}
        onPlaying={(value) => {
          setPlaying(value);
          if (value) setPinned(true);
        }}
        speed={speed}
        onSpeed={setSpeed}
        live={live && atHead}
      />
    </div>
  );
}

function SceneLoading(): React.ReactElement {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-2 text-[11px] text-zinc-700">
        <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--lane-planner)' }} aria-hidden />
        loading the system map
      </div>
    </div>
  );
}

/**
 * The console must work without WebGL.
 *
 * If the canvas cannot start — a headless browser, a blocked GPU, a driver the
 * machine does not have — the map is replaced by a plain note and every other
 * panel keeps working. The 3D view supports the product; it is not the product.
 */
class SceneBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    console.warn('[genesis] the system map could not render:', error.message);
  }

  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="grid h-full place-items-center p-6 text-center">
          <div className="space-y-1.5">
            <AlertTriangle className="mx-auto h-5 w-5 text-zinc-700" aria-hidden />
            <p className="text-[12px] text-zinc-500">The system map needs WebGL, which this browser did not provide.</p>
            <p className="text-[11px] text-zinc-700">
              Everything else still works — the pipeline, the timeline and the artifacts are all above and beside this.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
