import type { ConsoleState, Lane } from '@genesis/console';
import { X } from 'lucide-react';
import { LANE_STYLES } from '../lib/theme';

/**
 * What one part of the system is for, and what it did in this run.
 *
 * The mandate line matters as much as the counts: a judge looking at "Verifier"
 * should learn immediately that it is not an agent and that no model can make
 * something verified.
 */
export function LaneDetail({
  lane,
  state,
  onClose,
}: {
  lane: Lane;
  state: ConsoleState;
  onClose: () => void;
}): React.ReactElement {
  const style = LANE_STYLES[lane];
  const view = state.lanes[lane];
  const stages = state.stages.filter((stage) => stage.lane === lane);
  const acted = view !== undefined && view.events > 0;

  return (
    <section
      className="panel overflow-hidden"
      aria-label={`${style.label} detail`}
      style={{ borderColor: 'var(--line-strong)' }}
    >
      <div className="panel-head justify-between" style={{ background: 'var(--surface-2)' }}>
        <span className="flex items-center gap-2" style={{ color: style.colour }}>
          <span className="h-2 w-2 rounded-full" style={{ background: style.colour }} aria-hidden />
          {style.label}
        </span>
        <button type="button" onClick={onClose} aria-label="Close detail" className="tap rounded p-0.5 text-zinc-500">
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>

      <div className="space-y-2 p-3">
        <p className="text-[11px] leading-relaxed text-zinc-400">{style.mandate}</p>

        {acted ? (
          <>
            <div className="flex gap-3 text-[10px] text-zinc-500">
              <span>
                <span className="mono text-zinc-300">{view.events}</span> events
              </span>
              <span>
                <span className="mono text-zinc-300">{view.tasks}</span> task{view.tasks === 1 ? '' : 's'}
              </span>
              {view.failures > 0 && (
                <span style={{ color: 'var(--bad)' }}>
                  <span className="mono">{view.failures}</span> failure{view.failures === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {stages.length > 0 && (
              <ul className="space-y-1">
                {stages.map((stage, index) => (
                  <li key={`${stage.stage}-${stage.pass}-${index}`} className="text-[11px]">
                    <span
                      className="mono mr-1.5 text-[9px] uppercase"
                      style={{
                        color:
                          stage.result === 'PASSED' ? 'var(--ok)' : stage.result === 'FAILED' ? 'var(--bad)' : 'var(--live)',
                      }}
                    >
                      {stage.result}
                    </span>
                    <span className="text-zinc-400">
                      {stage.label}
                      {stage.pass > 1 ? ` · pass ${stage.pass}` : ''}
                    </span>
                    {stage.detail !== null && <span className="block pl-0 text-zinc-600">{stage.detail}</span>}
                  </li>
                ))}
              </ul>
            )}

            {view.lastHeadline !== null && (
              <p className="border-t pt-2 text-[11px] text-zinc-500" style={{ borderColor: 'var(--line)' }}>
                Last: {view.lastHeadline}
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-zinc-600">
            Has not acted in this run. Nothing is hidden here — the ledger records no event for it.
          </p>
        )}
      </div>
    </section>
  );
}
