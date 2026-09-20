import { History, Pause, Play, Radio, SkipBack, SkipForward } from 'lucide-react';

/**
 * Replay.
 *
 * A GENESIS run is event-sourced, so the whole history is present the moment it
 * finishes — and a real run finishes in well under a second. Rather than
 * slowing the system down to look impressive, the console lets a person walk
 * the recorded ledger at their own pace.
 *
 * It is labelled as a replay, always, because the difference between "this is
 * happening" and "this happened" is exactly the kind of thing a console must
 * never blur. Live runs follow the head automatically; scrubbing steps off the
 * head and says so.
 */
export function ReplayBar({
  total,
  cursor,
  onCursor,
  playing,
  onPlaying,
  speed,
  onSpeed,
  live,
}: {
  total: number;
  cursor: number;
  onCursor: (value: number) => void;
  playing: boolean;
  onPlaying: (value: boolean) => void;
  speed: number;
  onSpeed: (value: number) => void;
  live: boolean;
}): React.ReactElement {
  const atHead = cursor >= total;
  const disabled = total === 0;

  return (
    <footer
      className="flex items-center gap-3 border-t px-4 py-2"
      style={{ borderColor: 'var(--line)', background: 'rgba(0,0,0,.4)' }}
    >
      <span
        className="chip shrink-0"
        style={{
          color: live ? 'var(--live)' : atHead ? 'var(--lane-system)' : 'var(--lane-repair)',
          borderColor: live ? 'rgba(56,189,248,.3)' : 'var(--line)',
        }}
      >
        {live ? <Radio className="h-3 w-3 live-dot" aria-hidden /> : <History className="h-3 w-3" aria-hidden />}
        {live ? 'live' : atHead ? 'at head' : 'replaying'}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Ctl label="Jump to start" onClick={() => onCursor(0)} disabled={disabled}>
          <SkipBack className="h-3 w-3" aria-hidden />
        </Ctl>
        <Ctl
          label={playing ? 'Pause replay' : 'Play replay'}
          onClick={() => {
            if (!playing && atHead) onCursor(0);
            onPlaying(!playing);
          }}
          disabled={disabled}
          accent
        >
          {playing ? <Pause className="h-3 w-3" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
        </Ctl>
        <Ctl label="Jump to end" onClick={() => onCursor(total)} disabled={disabled}>
          <SkipForward className="h-3 w-3" aria-hidden />
        </Ctl>
      </div>

      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="sr-only">Replay position</span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          value={cursor}
          disabled={disabled}
          onChange={(event) => {
            onPlaying(false);
            onCursor(Number(event.target.value));
          }}
          className="h-1 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
          style={{
            background: `linear-gradient(90deg, var(--lane-planner) ${(cursor / Math.max(total, 1)) * 100}%, rgba(255,255,255,.08) ${(cursor / Math.max(total, 1)) * 100}%)`,
          }}
        />
      </label>

      <span className="mono shrink-0 text-[10px] text-zinc-500">
        {cursor}/{total}
      </span>

      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Replay speed">
        {[1, 4, 12].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onSpeed(option)}
            aria-pressed={speed === option}
            className="tap rounded border px-1.5 py-0.5 text-[10px]"
            style={{
              borderColor: speed === option ? 'var(--line-strong)' : 'var(--line)',
              color: speed === option ? '#e4e4e7' : '#52525b',
            }}
          >
            {option}×
          </button>
        ))}
      </div>
    </footer>
  );
}

function Ctl({
  children,
  label,
  onClick,
  disabled,
  accent,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  accent?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="tap grid h-6 w-6 place-items-center rounded border disabled:opacity-30"
      style={{
        borderColor: accent === true ? 'rgba(52,211,153,.3)' : 'var(--line)',
        color: accent === true ? 'var(--ok)' : '#a1a1aa',
      }}
    >
      {children}
    </button>
  );
}
