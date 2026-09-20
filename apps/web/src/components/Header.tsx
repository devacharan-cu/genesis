import { Activity, Boxes, Cpu, Database, ShieldCheck } from 'lucide-react';
import type { Health } from '../lib/api';

/**
 * The top bar.
 *
 * It names the product, then states plainly what is answering: which reasoning
 * provider, which ledger, which sandbox. A console for a system whose whole
 * claim is provenance should not be vague about its own.
 */
export function Header({ health, connected }: { health: Health | null; connected: boolean }): React.ReactElement {
  return (
    <header
      className="flex items-center justify-between gap-6 border-b px-5 py-3"
      style={{ borderColor: 'var(--line)' }}
    >
      <div className="flex items-baseline gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-7 w-7 place-items-center rounded-md"
            style={{ background: 'linear-gradient(135deg, rgba(52,211,153,.22), rgba(167,139,250,.22))', border: '1px solid var(--line-strong)' }}
          >
            <Boxes className="h-4 w-4" style={{ color: 'var(--lane-planner)' }} aria-hidden />
          </span>
          <h1 className="text-[15px] font-semibold tracking-[0.2em] text-zinc-100">GENESIS</h1>
        </div>
        <p className="hidden text-[11px] text-zinc-500 sm:block">Self-questioning software intelligence</p>
      </div>

      <div className="flex items-center gap-2">
        <Pill icon={<Cpu className="h-3 w-3" />} label="reasoning" value={health?.reasoning ?? '—'} />
        <Pill icon={<Database className="h-3 w-3" />} label="ledger" value={health?.ledger ?? '—'} />
        <Pill icon={<ShieldCheck className="h-3 w-3" />} label="sandbox" value={health?.sandbox ?? '—'} />
        <span
          className="chip"
          style={{ color: connected ? 'var(--ok)' : 'var(--bad)', borderColor: connected ? 'rgba(52,211,153,.3)' : 'rgba(251,113,133,.3)' }}
          title={connected ? 'The API is reachable' : 'The API is not reachable'}
        >
          <Activity className={`h-3 w-3 ${connected ? 'live-dot' : ''}`} aria-hidden />
          {connected ? 'online' : 'offline'}
        </span>
      </div>
    </header>
  );
}

function Pill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.ReactElement {
  return (
    <span className="chip hidden text-zinc-400 lg:inline-flex" title={`${label}: ${value}`}>
      <span className="text-zinc-600" aria-hidden>
        {icon}
      </span>
      <span className="text-zinc-600">{label}</span>
      <span className="mono text-zinc-300">{value}</span>
    </span>
  );
}
