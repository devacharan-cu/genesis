import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Float, Line, Billboard } from '@react-three/drei';
import { Brain, Activity, Terminal, Shield, CheckCircle, Play, Loader2 } from 'lucide-react';

// 3D Nodes representing the system components
function SystemNode({ position, color, label, active, onClick }: { position: [number, number, number], color: string, label: string, active: boolean, onClick?: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={active ? 2 : 0.5}>
      <group position={position} onClick={(e) => { e.stopPropagation(); onClick?.(); }} onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
        <mesh scale={hovered || active ? 1.2 : 1}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial 
            color={color} 
            emissive={color} 
            emissiveIntensity={active || hovered ? 2 : 0.5} 
            wireframe={!active && !hovered}
            transparent
            opacity={0.8}
          />
        </mesh>
        <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
          <Text position={[0, -1.8, 0]} fontSize={0.5} color="white" anchorX="center" anchorY="middle">
            {label}
          </Text>
        </Billboard>
      </group>
    </Float>
  );
}

function ConnectionLine({ start, end, active }: { start: [number, number, number], end: [number, number, number], active: boolean }) {
  return (
    <Line points={[start, end]} color={active ? "#00ff00" : "#333333"} lineWidth={active ? 3 : 1} dashed={!active} dashScale={active ? 0 : 50} />
  );
}

export default function App() {
  const [events, setEvents] = useState<Array<{ node: string; msg: string; kind?: string }>>([]);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let sse: EventSource;
    try {
      sse = new EventSource('http://127.0.0.1:3001/stream');
      sse.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as { node: string; msg: string; kind?: string };
          setEvents(prev => [...prev, data]);
          if (data.node !== 'system') setActiveNode(data.node);
          
          if (data.msg === 'Demo flow completed successfully.' || data.msg.startsWith('Error:')) {
            setIsRunning(false);
          }
        } catch {
          // ignore
        }
      };
      sse.onopen = () => {
        setStatus('Connected');
      };
      sse.onerror = () => {
        setStatus('Connection Error');
      };
    } catch (e) {
      console.error(e);
    }
    return () => sse?.close();
  }, []);

  const startDemo = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setEvents([]);
    setStatus('Starting...');
    try {
      const res = await fetch('http://127.0.0.1:3001/start', { method: 'POST' });
      if (!res.ok) throw new Error('API Error');
      setStatus('Running Demo');
    } catch (err) {
      console.error(err);
      setStatus('Failed to Start');
      setIsRunning(false);
    }
  };

  const filteredEvents = selectedNode 
    ? events.filter(e => e.node === selectedNode || e.node === selectedNode.toLowerCase())
    : events;

  return (
    <div className="w-full h-screen bg-black text-white flex overflow-hidden font-mono">
      {/* Left sidebar - Logs & Events */}
      <div className="w-1/3 h-full border-r border-gray-800 bg-black/90 p-6 flex flex-col z-10 backdrop-blur-md">
        <div className="flex items-center justify-between mb-8">
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
        </div>

        <div className="mb-4 text-xs font-mono text-gray-500 flex justify-between">
          <span>Backend Status: {status || 'Connecting...'}</span>
          <span>{events.length} events</span>
        </div>

        {selectedNode && (
          <div className="mb-4 flex items-center justify-between bg-blue-900/30 border border-blue-500/30 p-3 rounded-lg">
            <span className="text-blue-400 uppercase font-bold tracking-wider">{selectedNode} PANEL</span>
            <button onClick={() => setSelectedNode(null)} className="text-xs bg-black/50 px-2 py-1 rounded text-gray-300 hover:text-white border border-gray-700">CLEAR FILTER</button>
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto space-y-4 pr-2">
          <h2 className="text-sm text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4" /> Live Event Stream {selectedNode ? `(Filtered)` : ''}
          </h2>
          {filteredEvents.map((ev, i) => (
            <div key={i} className="p-3 border border-gray-800 rounded-lg bg-gray-900/50 flex gap-3 items-start animate-in fade-in slide-in-from-left-4">
              <Terminal className="w-4 h-4 mt-1 text-green-500 shrink-0" />
              <div>
                <span className="text-xs text-green-500 uppercase font-bold">{ev.node}</span>
                <p className="text-sm text-gray-300 mt-1">{ev.msg}</p>
              </div>
            </div>
          ))}
          {filteredEvents.length === 0 && <p className="text-gray-500 text-sm italic">No events yet...</p>}
        </div>
      </div>

      {/* Right area - 3D Visualization */}
      <div className="w-2/3 h-full relative cursor-crosshair">
        <Canvas camera={{ position: [0, 0, 15], fov: 60 }}>
          <color attach="background" args={['#000000']} />
          <ambientLight intensity={0.2} />
          <pointLight position={[10, 10, 10]} intensity={1} />
          <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
          
          <SystemNode position={[-4, 4, 0]} color="#4ade80" label="Planner" active={activeNode === 'planner'} onClick={() => setSelectedNode('planner')} />
          <SystemNode position={[4, 4, 0]} color="#60a5fa" label="Architect" active={activeNode === 'architect'} onClick={() => setSelectedNode('architect')} />
          <SystemNode position={[-4, 0, 0]} color="#f472b6" label="Builder" active={activeNode === 'builder'} onClick={() => setSelectedNode('builder')} />
          <SystemNode position={[4, 0, 0]} color="#facc15" label="QA" active={activeNode === 'qa'} onClick={() => setSelectedNode('qa')} />
          <SystemNode position={[-4, -4, 0]} color="#ef4444" label="Security" active={activeNode === 'security'} onClick={() => setSelectedNode('security')} />
          <SystemNode position={[4, -4, 0]} color="#a855f7" label="Verifier" active={activeNode === 'verifier'} onClick={() => setSelectedNode('verifier')} />
          <SystemNode position={[0, 0, -4]} color="#ffffff" label="Artifact" active={activeNode === 'artifact'} onClick={() => setSelectedNode('artifact')} />

          <ConnectionLine start={[-4, 4, 0]} end={[4, 4, 0]} active={activeNode === 'planner' || activeNode === 'architect'} />
          <ConnectionLine start={[4, 4, 0]} end={[-4, 0, 0]} active={activeNode === 'architect' || activeNode === 'builder'} />
          <ConnectionLine start={[-4, 0, 0]} end={[4, 0, 0]} active={activeNode === 'builder' || activeNode === 'qa'} />
          <ConnectionLine start={[4, 0, 0]} end={[-4, -4, 0]} active={activeNode === 'qa' || activeNode === 'security'} />
          <ConnectionLine start={[-4, -4, 0]} end={[4, -4, 0]} active={activeNode === 'security' || activeNode === 'verifier'} />
          <ConnectionLine start={[4, -4, 0]} end={[0, 0, -4]} active={activeNode === 'verifier'} />

          <OrbitControls enableZoom={true} autoRotate autoRotateSpeed={0.5} makeDefault />
        </Canvas>

        {/* Overlay UI */}
        <div className="absolute top-6 right-6 flex gap-4 pointer-events-none">
          <div className="bg-black/80 border border-green-500/30 px-4 py-2 rounded-full flex items-center gap-2 backdrop-blur-md">
            <CheckCircle className="w-4 h-4 text-green-500" />
            <span className="text-xs text-green-500 tracking-wider">SYSTEM SECURE</span>
          </div>
          <div className="bg-black/80 border border-blue-500/30 px-4 py-2 rounded-full flex items-center gap-2 backdrop-blur-md">
            <Shield className="w-4 h-4 text-blue-500" />
            <span className="text-xs text-blue-500 tracking-wider">SAIF ENFORCED</span>
          </div>
        </div>
      </div>
    </div>
  );
}
