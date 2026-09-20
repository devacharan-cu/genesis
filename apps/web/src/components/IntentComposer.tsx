import { AlertCircle, Loader2, Play, Sparkles } from 'lucide-react';
import type { Scenario } from '../lib/api';

/**
 * Where a person states what they want built.
 *
 * The scenario picker is not a demo cheat: it selects what the model answers,
 * and nothing else. Every stage, verdict and piece of evidence after that is
 * the real factory reacting to those answers — which is why the labels describe
 * what the builder does, not what the UI will show.
 */
export function IntentComposer({
  intent,
  onIntent,
  scenario,
  onScenario,
  scenarios,
  onRun,
  busy,
  disabled,
  error,
}: {
  intent: string;
  onIntent: (value: string) => void;
  scenario: string;
  onScenario: (value: string) => void;
  scenarios: readonly Scenario[];
  onRun: () => void;
  busy: boolean;
  disabled: boolean;
  error: string | null;
}): React.ReactElement {
  const chosen = scenarios.find((s) => s.name === scenario);
  const tooLong = intent.length > 400;
  const empty = intent.trim().length === 0;

  return (
    <section className="panel" aria-labelledby="intent-heading">
      <div className="panel-head">
        <Sparkles className="h-3 w-3" aria-hidden />
        <h2 id="intent-heading">Human intent</h2>
      </div>

      <div className="space-y-3 p-3">
        <div>
          <label htmlFor="intent" className="sr-only">
            What should GENESIS build?
          </label>
          <textarea
            id="intent"
            value={intent}
            onChange={(event) => onIntent(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !disabled) onRun();
            }}
            rows={3}
            placeholder="Build a small tutoring centre management app"
            aria-invalid={tooLong}
            className="w-full resize-none rounded-lg border bg-black/40 p-2.5 text-[13px] leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:outline-none"
            style={{ borderColor: tooLong ? 'var(--bad)' : 'var(--line)' }}
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-600">
            <span>⌘/Ctrl + Enter to run</span>
            <span style={{ color: tooLong ? 'var(--bad)' : undefined }}>{intent.length}/400</span>
          </div>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            What the builder produces
          </legend>
          <div className="grid gap-1.5">
            {scenarios.map((option) => {
              const active = option.name === scenario;
              return (
                <button
                  key={option.name}
                  type="button"
                  onClick={() => onScenario(option.name)}
                  aria-pressed={active}
                  className="tap rounded-lg border px-2.5 py-2 text-left"
                  style={{
                    borderColor: active ? 'var(--line-strong)' : 'var(--line)',
                    background: active ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={`text-[12px] ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>{option.label}</span>
                    <span
                      className="mono text-[9px] uppercase tracking-wider"
                      style={{ color: option.expected === 'VERIFIED' ? 'var(--ok)' : 'var(--bad)' }}
                    >
                      {option.expected}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {chosen !== undefined && <p className="text-[11px] leading-relaxed text-zinc-500">{chosen.description}</p>}

        <button
          type="button"
          onClick={onRun}
          disabled={disabled}
          className="tap flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 text-[12px] font-semibold tracking-wider disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            borderColor: 'rgba(52,211,153,.35)',
            background: 'rgba(52,211,153,.12)',
            color: 'var(--ok)',
          }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          {busy ? 'RUNNING THE FACTORY' : 'RUN THE FACTORY'}
        </button>

        {empty && !busy && <p className="text-[11px] text-zinc-600">State an intent to begin.</p>}

        {error !== null && (
          <p
            className="flex items-start gap-1.5 rounded-lg border p-2 text-[11px]"
            role="alert"
            style={{ borderColor: 'rgba(251,113,133,.3)', background: 'rgba(251,113,133,.08)', color: 'var(--bad)' }}
          >
            <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
