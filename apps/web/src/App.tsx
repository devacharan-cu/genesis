import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Text, Float, Line } from '@react-three/drei';
import { Brain, Activity, Terminal, Shield, CheckCircle, Play } from 'lucide-react';

// 3D Nodes representing the system components
function SystemNode({ position, color, label, active, onClick }: { position: [number, number, number], color: string, label: string, active: boolean, onClick?: () => void }) {
  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={active ? 2 : 0.5}>
      <mesh position={position} onClick={onClick}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial 
          color={color} 
          emissive={color} 
          emissiveIntensity={active ? 2 : 0.5} 
          wireframe={!active}
          transparent
          opacity={0.8}
        />
        <Text position={[0, -1.5, 0]} fontSize={0.4} color="white" anchorX="center" anchorY="middle">
          {label}
        </Text>
      </mesh>
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

  useEffect(() => {
    const sse = new EventSource('http://localhost:3001/stream');
    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { node: string; msg: string; kind?: string };
        setEvents(prev => [...prev, data]);
        if (data.node !== 'system') setActiveNode(data.node);
      } catch {
        // ignore
      }
    };
    return () => sse.close();
  }, []);

  const startDemo = async () => {
    setEvents([]);
    await fetch('http://localhost:3001/start', { method: 'POST' });
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
          <button onClick={startDemo} className="flex items-center gap-2 bg-green-500/20 hover:bg-green-500/40 text-green-400 px-4 py-2 rounded-lg transition-colors border border-green-500/30">
            <Play className="w-4 h-4" /> START DEMO
          </button>
        </div>

        {selectedNode && (
          <div className="mb-4 flex items-center justify-between bg-blue-900/30 border border-blue-500/30 p-3 rounded-lg">
            <span className="text-blue-400 uppercase font-bold tracking-wider">{selectedNode} PANEL</span>
            <button onClick={() => setSelectedNode(null)} className="text-xs text-gray-400 hover:text-white">CLEAR FILTER</button>
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto space-y-4">
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
          <SystemNode position={[4, 0, 0]} color="#facc15" label="QA / Test" active={activeNode === 'qa'} onClick={() => setSelectedNode('qa')} />
          <SystemNode position={[-4, -4, 0]} color="#ef4444" label="Security" active={activeNode === 'security'} onClick={() => setSelectedNode('security')} />
          <SystemNode position={[4, -4, 0]} color="#a855f7" label="Verifier" active={activeNode === 'verifier'} onClick={() => setSelectedNode('verifier')} />
          <SystemNode position={[0, 0, -4]} color="#ffffff" label="Artifact" active={activeNode === 'artifact'} onClick={() => setSelectedNode('artifact')} />

          <ConnectionLine start={[-4, 4, 0]} end={[4, 4, 0]} active={activeNode === 'planner' || activeNode === 'architect'} />
          <ConnectionLine start={[4, 4, 0]} end={[-4, 0, 0]} active={activeNode === 'architect' || activeNode === 'builder'} />
          <ConnectionLine start={[-4, 0, 0]} end={[4, 0, 0]} active={activeNode === 'builder' || activeNode === 'qa'} />
          <ConnectionLine start={[4, 0, 0]} end={[-4, -4, 0]} active={activeNode === 'qa' || activeNode === 'security'} />
          <ConnectionLine start={[-4, -4, 0]} end={[4, -4, 0]} active={activeNode === 'security' || activeNode === 'verifier'} />
          <ConnectionLine start={[4, -4, 0]} end={[0, 0, -4]} active={activeNode === 'verifier'} />

          <OrbitControls enableZoom={true} autoRotate autoRotateSpeed={0.5} />
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
