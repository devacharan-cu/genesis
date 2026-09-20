import type { ConsoleState, StageView } from '@genesis/console';
import { Check, ChevronRight, CircleDashed, RotateCcw, X } from 'lucide-react';
import { LANE_STYLES } from '../lib/theme';

/** The canonical pipeline, in order. A stage is drawn whether or not it ran. */
const PIPELINE = ['PLAN', 'ARCHITECT', 'BUILD', 'TEST', 'SECURITY_REVIEW', 'VERIFY'] as const;
const LABELS: Record<string, string> = {
  PLAN: 'Plan',
  ARCHITECT: 'Architect',
  BUILD: 'Build',
  TEST: 'QA',
  SECURITY_REVIEW: 'Security',
  VERIFY: 'Verify',
};

/**
 * The shape of the whole run, at a glance.
 *
 * The six stages every change goes through are always visible, so a reader sees
 * the process before anything has happened. Diagnose and Repair appear only
 * when a failure actually routed there — they are not part of the happy path,
 * and drawing them always would suggest every change needs repairing.
 */
export function PipelineRibbon({
  state,
  onSelectStage,
  selected,
}: {
  state: ConsoleState;
  onSelectStage: (stage: string | null) => void;
  selected: string | null;
}): React.ReactElement {
  const byStage = new Map<string, StageView[]>();
  for (const stage of state.stages) {
    byStage.set(stage.stage, [...(byStage.get(stage.stage) ?? []), stage]);
  }
  const repairs = [...(byStage.get('DIAGNOSE') ?? []), ...(byStage.get('REPAIR') ?? [])];
  const repaired = repairs.length > 0;

  return (
    <section className="panel px-3 py-2.5" aria-label="Pipeline">
      <div className="flex items-center gap-1 overflow-x-auto">
        <Node label="Intent" done={state.goals.length > 0} colour="var(--lane-human)" />
        {PIPELINE.map((stage) => {
          const passes = byStage.get(stage) ?? [];
          const latest = passes[passes.length - 1];
          return (
            <PipeStep
              key={stage}
              stage={stage}
              label={LABELS[stage] ?? stage}
              passes={passes}
              latest={latest}
              selected={selected === stage}
              onSelect={() => onSelectStage(selected === stage ? null : stage)}
            />
          );
        })}
        <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" aria-hidden />
        <Node
          label="Verified artifact"
          done={state.run?.outcome === 'VERIFIED'}
          failed={state.run?.outcome !== null && state.run?.outcome !== undefined && state.run.outcome !== 'VERIFIED'}
          colour="var(--lane-artifact)"
        />
      </div>

      {repaired && (
        <div className="mt-2 flex items-center gap-1.5 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
          <RotateCcw className="h-3 w-3" style={{ color: 'var(--lane-repair)' }} aria-hidden />
          <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--lane-repair)' }}>
            Repair loop
          </span>
          {repairs.map((stage, index) => (
            <span
              key={`${stage.stage}-${stage.pass}-${index}`}
              className="chip"
              style={{ color: tone(stage.result), borderColor: 'var(--line)' }}
            >
              {stage.label}
              {stage.pass > 1 ? ` ·${stage.pass}` : ''}
            </span>
          ))}
          <span className="ml-auto text-[10px] text-zinc-600">
            a repair re-enters at QA — it never reaches Verify unchecked
          </span>
        </div>
      )}
    </section>
  );
}

const tone = (result: string): string =>
  result === 'PASSED' ? 'var(--ok)' : result === 'FAILED' ? 'var(--bad)' : result === 'RUNNING' ? 'var(--live)' : 'var(--lane-system)';

function PipeStep({
  stage,
  label,
  passes,
  latest,
  selected,
  onSelect,
}: {
  stage: string;
  label: string;
  passes: readonly StageView[];
  latest: StageView | undefined;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const lane = LANE_STYLES[(latest?.lane ?? 'SYSTEM') as keyof typeof LANE_STYLES];
  const result = latest?.result ?? 'IDLE';
  const running = result === 'RUNNING';
  const failedOnce = passes.some((p) => p.result === 'FAILED');
  const colour = latest === undefined ? 'var(--lane-system)' : tone(result);

  return (
    <>
      <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" aria-hidden />
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={latest?.detail ?? `${label}: not yet run`}
        className="tap relative shrink-0 overflow-hidden rounded-lg border px-2.5 py-1.5 text-left"
        style={{
          borderColor: selected ? colour : latest === undefined ? 'var(--line)' : 'var(--line-strong)',
          background: selected ? 'var(--surface-2)' : latest === undefined ? 'transparent' : 'var(--surface)',
          opacity: latest === undefined ? 0.5 : 1,
        }}
      >
        {running && <span className="sweep pointer-events-none absolute inset-0" aria-hidden />}
        <span className="flex items-center gap-1.5">
          <StageIcon result={result} colour={colour} />
          <span className="text-[11px]" style={{ color: latest === undefined ? 'var(--lane-system)' : lane?.colour }}>
            {label}
          </span>
          {passes.length > 1 && (
            <span className="mono rounded px-1 text-[9px]" style={{ background: 'rgba(251,146,60,.16)', color: 'var(--lane-repair)' }}>
              ×{passes.length}
            </span>
          )}
        </span>
        {failedOnce && result === 'PASSED' && (
          <span className="mt-0.5 block text-[9px]" style={{ color: 'var(--lane-repair)' }}>
            passed after repair
          </span>
        )}
      </button>
      <span className="sr-only">{stage}</span>
    </>
  );
}

function StageIcon({ result, colour }: { result: string; colour: string }): React.ReactElement {
  if (result === 'PASSED') return <Check className="h-3 w-3" style={{ color: colour }} aria-hidden />;
  if (result === 'FAILED') return <X className="h-3 w-3" style={{ color: colour }} aria-hidden />;
  if (result === 'RUNNING') return <span className="live-dot h-2 w-2 rounded-full" style={{ background: colour }} aria-hidden />;
  return <CircleDashed className="h-3 w-3 text-zinc-700" aria-hidden />;
}

function Node({
  label,
  done,
  failed,
  colour,
}: {
  label: string;
  done: boolean;
  failed?: boolean;
  colour: string;
}): React.ReactElement {
  const active = done || failed === true;
  return (
    <span
      className="shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px]"
      style={{
        borderColor: active ? 'var(--line-strong)' : 'var(--line)',
        background: active ? 'var(--surface)' : 'transparent',
        color: failed === true ? 'var(--bad)' : done ? colour : 'var(--lane-system)',
        opacity: active ? 1 : 0.5,
      }}
    >
      {label}
    </span>
  );
}
