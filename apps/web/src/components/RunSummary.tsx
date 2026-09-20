import type { ConsoleState, Lane } from '@genesis/console';
import { CheckCircle2, CircleSlash, Loader2, RotateCcw, Target, XCircle } from 'lucide-react';
import type { ProjectMeta } from '../lib/api';
import { LANE_STYLES } from '../lib/theme';

/**
 * The answer to "what happened?", in one card.
 *
 * The outcome word is the factory's own, and the sentence under it is the
 * factory's summary — not a rephrasing. A blocked run says what blocked it.
 */
export function RunSummary({
  state,
  project,
  live,
}: {
  state: ConsoleState;
  project: ProjectMeta | null;
  live: boolean;
}): React.ReactElement {
  const run = state.run;
  const goal = state.goals[0];
  const outcome = run?.outcome ?? null;
  const running = live && outcome === null && run !== null;

  const tone =
    outcome === 'VERIFIED'
      ? { colour: 'var(--ok)', icon: <CheckCircle2 className="h-4 w-4" aria-hidden />, word: 'Verified' }
      : outcome === 'BLOCKED'
        ? { colour: 'var(--bad)', icon: <CircleSlash className="h-4 w-4" aria-hidden />, word: 'Blocked' }
        : outcome !== null
          ? { colour: 'var(--bad)', icon: <XCircle className="h-4 w-4" aria-hidden />, word: outcome }
          : running
            ? { colour: 'var(--live)', icon: <Loader2 className="h-4 w-4 animate-spin" aria-hidden />, word: 'Running' }
            : { colour: 'var(--lane-system)', icon: <Target className="h-4 w-4" aria-hidden />, word: 'Idle' };

  return (
    <section className="panel" aria-label="Run status">
      <div className="panel-head">
        <Target className="h-3 w-3" aria-hidden />
        Run
      </div>

      <div className="space-y-2.5 p-3">
        <div className="flex items-center gap-2">
          <span style={{ color: tone.colour }}>{tone.icon}</span>
          <span className="text-[14px] font-semibold tracking-wide" style={{ color: tone.colour }}>
            {tone.word}
          </span>
          {run !== null && run.repairAttempts !== null && run.repairAttempts > 0 && (
            <span className="chip ml-auto" style={{ color: 'var(--lane-repair)' }}>
              <RotateCcw className="h-2.5 w-2.5" aria-hidden />
              {run.repairAttempts} repair{run.repairAttempts === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {run?.summary != null && <p className="text-[11px] leading-relaxed text-zinc-400">{run.summary}</p>}
        {run?.blockedReason != null && (
          <p className="rounded border p-2 text-[11px] leading-relaxed" style={{ borderColor: 'rgba(251,113,133,.25)', color: 'var(--bad)' }}>
            {run.blockedReason}
          </p>
        )}
        {run === null && project !== null && (
          <p className="text-[11px] text-zinc-600">Project created. The factory has not started yet.</p>
        )}
        {project === null && (
          <p className="text-[11px] text-zinc-600">No project yet. State an intent to create one.</p>
        )}

        {goal !== undefined && (
          <div className="rounded-lg border p-2" style={{ borderColor: 'var(--line)' }}>
            <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Goal</p>
            <p className="text-[12px] leading-snug text-zinc-300">{goal.description}</p>
            <p className="mt-1 flex items-center gap-2 text-[10px] text-zinc-600">
              <span style={{ color: goal.status === 'ACTIVE' ? 'var(--ok)' : undefined }}>{goal.status}</span>
              <span>priority {goal.priority}</span>
            </p>
          </div>
        )}

        {run !== null && (
          <dl className="grid grid-cols-3 gap-1.5 text-center">
            <Stat label="stages" value={String(run.stagesRun ?? state.stages.length)} />
            <Stat label="events" value={String(state.lastSeq)} />
            <Stat label="reached" value={run.highestState ?? '—'} small />
          </dl>
        )}

        <LaneStrip state={state} />
      </div>
    </section>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }): React.ReactElement {
  return (
    <div className="rounded-lg border py-1.5" style={{ borderColor: 'var(--line)' }}>
      <dd className={`mono ${small === true ? 'text-[10px]' : 'text-[13px]'} text-zinc-200`}>{value}</dd>
      <dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt>
    </div>
  );
}

/** How much each part of the system did. An agent that acted is never blank. */
function LaneStrip({ state }: { state: ConsoleState }): React.ReactElement | null {
  const lanes = (['PLANNER', 'ARCHITECT', 'BUILDER', 'QA', 'SECURITY', 'REPAIR', 'VERIFIER'] as Lane[])
    .map((lane) => ({ lane, view: state.lanes[lane] }))
    .filter((entry) => entry.view !== undefined);
  if (lanes.length === 0) return null;

  const busiest = Math.max(...lanes.map((entry) => entry.view?.events ?? 0), 1);

  return (
    <div>
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Agent activity</p>
      <ul className="space-y-1">
        {lanes.map(({ lane, view }) => (
          <li key={lane} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[10px]" style={{ color: LANE_STYLES[lane].colour }}>
              {LANE_STYLES[lane].label}
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,.05)' }}>
              <span
                className="block h-full rounded-full transition-all duration-500"
                style={{ width: `${((view?.events ?? 0) / busiest) * 100}%`, background: LANE_STYLES[lane].colour, opacity: 0.75 }}
              />
            </span>
            <span className="mono w-6 shrink-0 text-right text-[10px] text-zinc-600">{view?.events ?? 0}</span>
            {(view?.failures ?? 0) > 0 && (
              <span className="mono text-[9px]" style={{ color: 'var(--bad)' }} title={`${view?.failures} failure(s)`}>
                ✕{view?.failures}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
