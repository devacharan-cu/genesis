import type { ConsoleState, Lane } from '@genesis/console';
import { Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useCallback, useRef, useState } from 'react';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { LANE_STYLES } from '../lib/theme';

/**
 * The pipeline, in space.
 *
 * The layout is a deliberate left-to-right flow rather than a decorative
 * cluster: work enters from the human on the left and leaves as an artifact on
 * the right, so the picture says the same thing as the ribbon above it. The
 * repair lane sits BELOW the main line because it is the path a change takes
 * only when something failed — geometry carrying the same meaning as the colour.
 *
 * Positions are fixed and spaced so labels never collide, and every label is
 * billboarded so none is ever mirrored however the camera is orbited.
 */
interface NodeSpec {
  readonly lane: Lane;
  readonly label: string;
  readonly position: readonly [number, number, number];
}

const NODES: readonly NodeSpec[] = [
  { lane: 'HUMAN', label: 'Intent', position: [-9.5, 0, 0] },
  { lane: 'PLANNER', label: 'Planner', position: [-5.7, 2.1, 0] },
  { lane: 'ARCHITECT', label: 'Architect', position: [-2.2, 2.1, 0] },
  { lane: 'BUILDER', label: 'Builder', position: [1.3, 2.1, 0] },
  { lane: 'QA', label: 'QA', position: [4.6, 0, 0] },
  { lane: 'SECURITY', label: 'Security', position: [7.4, 2.1, 0] },
  { lane: 'VERIFIER', label: 'Verifier', position: [7.4, -2.1, 0] },
  { lane: 'REPAIR', label: 'Repair', position: [1.3, -3.4, 0] },
  { lane: 'ARTIFACT', label: 'Artifact', position: [10.9, 0, 0] },
];

/** The flow. The repair edges are drawn dashed: they are the exception. */
const EDGES: readonly { from: Lane; to: Lane; repair?: boolean }[] = [
  { from: 'HUMAN', to: 'PLANNER' },
  { from: 'PLANNER', to: 'ARCHITECT' },
  { from: 'ARCHITECT', to: 'BUILDER' },
  { from: 'BUILDER', to: 'QA' },
  { from: 'QA', to: 'SECURITY' },
  { from: 'SECURITY', to: 'VERIFIER' },
  { from: 'VERIFIER', to: 'ARTIFACT' },
  { from: 'QA', to: 'REPAIR', repair: true },
  { from: 'REPAIR', to: 'BUILDER', repair: true },
];

const positionOf = (lane: Lane): readonly [number, number, number] =>
  NODES.find((node) => node.lane === lane)?.position ?? [0, 0, 0];

export type LaneStatus = 'idle' | 'active' | 'passed' | 'failed';

/** What each lane's state is, read from the fold rather than from a timer. */
export function laneStatuses(state: ConsoleState): Readonly<Record<string, LaneStatus>> {
  const status: Record<string, LaneStatus> = {};
  for (const stage of state.stages) {
    const current: LaneStatus =
      stage.result === 'RUNNING' ? 'active' : stage.result === 'FAILED' ? 'failed' : 'passed';
    // A lane that failed once and passed later reads as passed; a lane still
    // running outranks both, because that is what is happening now.
    const existing = status[stage.lane];
    if (existing === 'active') continue;
    status[stage.lane] = current === 'passed' && existing === 'failed' ? 'passed' : current;
  }
  if (state.goals.length > 0) status['HUMAN'] = 'passed';
  if (state.artifacts.some((a) => a.verifiedSeq !== null)) status['ARTIFACT'] = 'passed';
  else if (state.artifacts.length > 0) status['ARTIFACT'] = 'active';
  return status;
}

function Node({
  spec,
  status,
  selected,
  onSelect,
}: {
  spec: NodeSpec;
  status: LaneStatus;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const mesh = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const style = LANE_STYLES[spec.lane];
  const lit = status !== 'idle' || hovered || selected;
  const colour = status === 'failed' ? '#fb7185' : style.colour.startsWith('var') ? laneHex(spec.lane) : style.colour;

  useFrame((frameState) => {
    const t = frameState.clock.elapsedTime;
    const target = selected ? 1.3 : hovered ? 1.2 : status === 'active' ? 1.14 : 1;
    if (mesh.current !== null) {
      // Eased towards the target rather than snapped: motion that tracks state
      // reads as the system responding, not as decoration.
      mesh.current.scale.lerp({ x: target, y: target, z: target } as never, 0.12);
      const material = mesh.current.material as MeshStandardMaterial;
      const wanted = status === 'active' ? 1.6 + Math.sin(t * 3.2) * 0.5 : lit ? 0.85 : 0.14;
      material.emissiveIntensity += (wanted - material.emissiveIntensity) * 0.12;
    }
    if (halo.current !== null) {
      const on = status === 'active' ? 1 : 0;
      const wanted = 1.5 + (status === 'active' ? Math.sin(t * 3.2) * 0.22 : 0);
      halo.current.scale.lerp({ x: wanted, y: wanted, z: wanted } as never, 0.1);
      (halo.current.material as MeshStandardMaterial).opacity += (on * 0.16 - (halo.current.material as MeshStandardMaterial).opacity) * 0.1;
    }
  });

  return (
    <group position={spec.position as [number, number, number]}>
      {/* The hit target is a generous invisible sphere, so the whole node is
          clickable rather than only the visible surface. */}
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[1.25, 16, 16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh ref={halo}>
        <sphereGeometry args={[0.62, 24, 24]} />
        <meshStandardMaterial color={colour} emissive={colour} transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh ref={mesh}>
        <icosahedronGeometry args={[0.52, 1]} />
        <meshStandardMaterial
          color={colour}
          emissive={colour}
          emissiveIntensity={0.14}
          roughness={0.35}
          metalness={0.1}
          wireframe={status === 'idle' && !hovered && !selected}
          transparent
          opacity={status === 'idle' && !selected ? 0.55 : 0.95}
        />
      </mesh>

      {selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.95, 0.018, 8, 64]} />
          <meshBasicMaterial color={colour} />
        </mesh>
      )}

      {/*
        Labels are DOM, not SDF text.

        `drei`'s `Text` resolves fonts over the network at runtime, which makes
        a label a CDN dependency — it fails offline and leaks a request. DOM
        labels use the page's own typeface, stay crisp at any zoom, are never
        mirrored, and can be read by a screen reader. They are also cheaper.
      */}
      <Html center distanceFactor={11} position={[0, -1.15, 0]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div className="select-none whitespace-nowrap text-center">
          <span
            className="text-[13px] font-medium tracking-wide transition-colors duration-300"
            style={{ color: lit ? '#e4e4e7' : '#52525b' }}
          >
            {spec.label}
          </span>
          {status === 'failed' && (
            <span className="block text-[11px]" style={{ color: '#fb7185' }}>
              failed
            </span>
          )}
          {status === 'active' && (
            <span className="block text-[11px]" style={{ color: '#38bdf8' }}>
              running
            </span>
          )}
        </div>
      </Html>
    </group>
  );
}

/**
 * What the panel shows when the browser cannot draw.
 *
 * Two ways that happens: no WebGL at all, or a context that was granted and
 * then lost — which a software renderer does under load. Either way the panel
 * says so in words instead of going blank, because a white rectangle in the
 * middle of a console reads as a broken product.
 */
function NoScene({ reason, onRetry }: { reason: 'unsupported' | 'lost'; onRetry?: () => void }): React.ReactElement {
  return (
    <div className="grid h-full place-items-center p-6 text-center" style={{ background: '#06080c' }}>
      <div className="max-w-[280px] space-y-2">
        <p className="text-[12px] text-zinc-500">
          {reason === 'unsupported'
            ? 'This browser did not provide WebGL, so the system map cannot draw.'
            : 'The graphics context was lost, so the system map stopped drawing.'}
        </p>
        <p className="text-[11px] text-zinc-700">
          Nothing else is affected: the pipeline above and the timeline beside it are the same view of the same ledger.
        </p>
        {onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="tap rounded-md border px-2.5 py-1 text-[11px] text-zinc-300"
            style={{ borderColor: 'var(--line-strong)' }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** Lane colours as literals, since a shader cannot read a CSS variable. */
function laneHex(lane: Lane): string {
  const map: Record<Lane, string> = {
    HUMAN: '#38bdf8',
    PLANNER: '#34d399',
    ARCHITECT: '#22d3ee',
    RESEARCHER: '#71717a',
    BUILDER: '#e879f9',
    QA: '#fbbf24',
    SECURITY: '#fb7185',
    REPAIR: '#fb923c',
    VERIFIER: '#a78bfa',
    ARTIFACT: '#e4e4e7',
    SYSTEM: '#71717a',
  };
  return map[lane];
}

function Flow({ statuses }: { statuses: Readonly<Record<string, LaneStatus>> }): React.ReactElement {
  return (
    <>
      {EDGES.map((edge) => {
        const from = positionOf(edge.from);
        const to = positionOf(edge.to);
        const travelled = statuses[edge.from] !== undefined && statuses[edge.from] !== 'idle';
        const colour = edge.repair === true ? '#fb923c' : travelled ? '#34d399' : '#27272a';
        return (
          <Line
            key={`${edge.from}-${edge.to}`}
            points={[from as [number, number, number], to as [number, number, number]]}
            color={colour}
            lineWidth={travelled ? 1.6 : 1}
            transparent
            opacity={travelled ? 0.7 : 0.28}
            dashed={edge.repair === true}
            dashSize={0.25}
            gapSize={0.18}
          />
        );
      })}
    </>
  );
}

/** Keeps the camera drifting gently, and stops while a person is interacting. */
function Drift({ enabled }: { enabled: boolean }): React.ReactElement {
  const group = useRef<Group>(null);
  useFrame((state) => {
    if (group.current === null) return;
    const wanted = enabled ? Math.sin(state.clock.elapsedTime * 0.12) * 0.09 : 0;
    group.current.rotation.y += (wanted - group.current.rotation.y) * 0.02;
  });
  return <group ref={group} />;
}

/**
 * Whether this browser can actually draw the scene.
 *
 * Asked before mounting rather than discovered afterwards: a `Canvas` on a
 * machine without WebGL renders an empty white rectangle and throws nothing, so
 * an error boundary never fires and the operator is left with a blank panel
 * where the map should be.
 */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

export function NetworkScene({
  state,
  selected,
  onSelect,
}: {
  state: ConsoleState;
  selected: Lane | null;
  onSelect: (lane: Lane | null) => void;
}): React.ReactElement {
  const statuses = laneStatuses(state);
  const [interacting, setInteracting] = useState(false);
  const [supported] = useState(hasWebGL);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /** A lost context is reported once, on the canvas the renderer actually uses. */
  const attach = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvas === null) return;
    canvas.addEventListener('webglcontextlost', () => setLost(true), { once: true });
  }, []);

  if (!supported) return <NoScene reason="unsupported" />;
  if (lost) {
    return (
      <NoScene
        reason="lost"
        onRetry={() => {
          setAttempt((n) => n + 1);
          setLost(false);
        }}
      />
    );
  }

  return (
    <Canvas
      // Remounted on retry, so a recovered context gets a fresh renderer.
      key={attempt}
      ref={attach}
      camera={{ position: [0, 1.2, 15.5], fov: 46 }}
      dpr={[1, 1.75]}
      // `powerPreference` and no stencil/depth extras: the scene is a dozen
      // meshes, and asking for less makes a software renderer far less likely
      // to drop the context.
      gl={{ antialias: true, powerPreference: 'high-performance', stencil: false }}
      style={{ background: '#06080c' }}
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={['#06080c']} />
      <fog attach="fog" args={['#06080c', 20, 42]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 8, 10]} intensity={0.7} />
      <pointLight position={[-8, -4, 6]} intensity={0.35} color="#a78bfa" />

      <Drift enabled={!interacting} />
      <Flow statuses={statuses} />
      {NODES.map((node) => (
        <Node
          key={node.lane}
          spec={node}
          status={statuses[node.lane] ?? 'idle'}
          selected={selected === node.lane}
          onSelect={() => onSelect(selected === node.lane ? null : node.lane)}
        />
      ))}

      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom
        minDistance={9}
        maxDistance={26}
        minPolarAngle={Math.PI / 3.4}
        maxPolarAngle={Math.PI / 1.7}
        onStart={() => setInteracting(true)}
        onEnd={() => setInteracting(false)}
      />
    </Canvas>
  );
}
