import type { ConsoleState, EventView, Lane } from '@genesis/console';
import { AlertTriangle, ArrowDownToLine, Filter, ListTree, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { LANE_STYLES, SEVERITY_COLOUR } from '../lib/theme';

/**
 * The timeline.
 *
 * One row per ledger event, in ledger order, showing the lane that produced it,
 * what it says and the authority it carries. Authority is on every row on
 * purpose: it is the difference between a model's claim and a verified fact,
 * and hiding it would make the two look alike.
 */
export function EventStream({
  state,
  laneFilter,
  stageFilter,
  onLane,
  onStage,
  selectedSeq,
  onSelect,
  follow,
  onFollow,
}: {
  state: ConsoleState;
  laneFilter: Lane | null;
  stageFilter: string | null;
  onLane: (lane: Lane | null) => void;
  onStage: (stage: string | null) => void;
  selectedSeq: number | null;
  onSelect: (seq: number | null) => void;
  follow: boolean;
  onFollow: (value: boolean) => void;
}): React.ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(
    () =>
      state.events.filter(
        (event) => (laneFilter === null || event.lane === laneFilter) && (stageFilter === null || event.stage === stageFilter),
      ),
    [state.events, laneFilter, stageFilter],
  );

  useEffect(() => {
    if (!follow) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [shown.length, follow]);

  const filtered = laneFilter !== null || stageFilter !== null;

  return (
    <section className="panel flex min-h-0 flex-1 flex-col" aria-label="Event timeline">
      <div className="panel-head justify-between">
        <span className="flex items-center gap-2">
          <ListTree className="h-3 w-3" aria-hidden />
          Ledger timeline
        </span>
        <span className="flex items-center gap-2 normal-case tracking-normal">
          <span className="mono text-[10px] text-zinc-600">
            {shown.length}
            {filtered ? ` of ${state.events.length}` : ''}
          </span>
          <button
            type="button"
            onClick={() => onFollow(!follow)}
            aria-pressed={follow}
            title={follow ? 'Following the newest event' : 'Scroll is free'}
            className="tap rounded border p-1"
            style={{ borderColor: follow ? 'var(--line-strong)' : 'var(--line)', color: follow ? 'var(--live)' : 'var(--lane-system)' }}
          >
            <ArrowDownToLine className="h-3 w-3" aria-hidden />
          </button>
        </span>
      </div>

      {filtered && (
        <div className="flex items-center gap-1.5 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          <Filter className="h-3 w-3 text-zinc-600" aria-hidden />
          {laneFilter !== null && (
            <Tag colour={LANE_STYLES[laneFilter].colour} label={LANE_STYLES[laneFilter].label} onClear={() => onLane(null)} />
          )}
          {stageFilter !== null && <Tag colour="var(--lane-system)" label={stageFilter} onClear={() => onStage(null)} />}
          <button
            type="button"
            onClick={() => {
              onLane(null);
              onStage(null);
            }}
            className="tap ml-auto rounded border px-1.5 py-0.5 text-[10px] text-zinc-400"
            style={{ borderColor: 'var(--line)' }}
          >
            Clear all
          </button>
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <Empty filtered={filtered} hasEvents={state.events.length > 0} />
        ) : (
          <ol className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {shown.map((event) => (
              <EventRow
                key={event.seq}
                event={event}
                selected={selectedSeq === event.seq}
                onSelect={() => onSelect(selectedSeq === event.seq ? null : event.seq)}
                onLane={() => onLane(event.lane)}
              />
            ))}
          </ol>
        )}
      </div>

      {state.anomalies.length > 0 && (
        <div
          className="flex items-center gap-1.5 border-t px-3 py-1.5 text-[10px]"
          style={{ borderColor: 'var(--line)', color: 'var(--warn)' }}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {state.anomalies.length} event type(s) this console has no reading for: {state.anomalies.join(', ')}
        </div>
      )}
    </section>
  );
}

function EventRow({
  event,
  selected,
  onSelect,
  onLane,
}: {
  event: EventView;
  selected: boolean;
  onSelect: () => void;
  onLane: () => void;
}): React.ReactElement {
  const lane = LANE_STYLES[event.lane];
  const severity = SEVERITY_COLOUR[event.severity] ?? 'var(--lane-system)';
  const time = event.timestamp.slice(11, 23);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        aria-expanded={selected}
        className="tap w-full cursor-pointer px-3 py-2 text-left"
        style={{
          background: selected ? 'var(--surface-2)' : 'transparent',
          borderLeft: `2px solid ${event.severity === 'INFO' ? 'transparent' : severity}`,
        }}
      >
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLane();
            }}
            title={`Show only ${lane.label}`}
            className="mono shrink-0 text-[9px] font-semibold uppercase tracking-wider hover:underline"
            style={{ color: lane.colour }}
          >
            {lane.label}
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{event.headline}</span>
          <span className="mono shrink-0 text-[9px] text-zinc-700">#{event.seq}</span>
        </div>
        {event.detail !== null && (
          <p className="mt-0.5 line-clamp-2 pl-0 text-[11px] leading-snug text-zinc-500">{event.detail}</p>
        )}
      </div>

      {selected && (
        <dl
          className="mono space-y-1 border-t px-3 py-2 text-[10px]"
          style={{ borderColor: 'var(--line)', background: 'rgba(0,0,0,.35)' }}
        >
          <Field label="type" value={event.type} />
          <Field label="time" value={time} />
          <Field label="actor" value={event.actorKind} />
          <Field
            label="authority"
            value={event.authority}
            colour={event.authority === 'AI_ASSUMPTION' ? 'var(--warn)' : event.authority === 'HUMAN_DECISION' ? 'var(--lane-human)' : 'var(--ok)'}
          />
          {event.stage !== null && <Field label="stage" value={`${event.stage}${event.pass !== null ? ` pass ${event.pass}` : ''}`} />}
          {event.taskId !== null && <Field label="task" value={event.taskId} />}
          {event.artifactId !== null && <Field label="artifact" value={event.artifactId} />}
        </dl>
      )}
    </li>
  );
}

function Field({ label, value, colour }: { label: string; value: string; colour?: string }): React.ReactElement {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-zinc-700">{label}</dt>
      <dd className="min-w-0 flex-1 break-all" style={{ color: colour ?? '#a1a1aa' }}>
        {value}
      </dd>
    </div>
  );
}

function Tag({ colour, label, onClear }: { colour: string; label: string; onClear: () => void }): React.ReactElement {
  return (
    <span className="chip" style={{ color: colour, borderColor: 'var(--line-strong)' }}>
      {label}
      <button type="button" onClick={onClear} aria-label={`Clear ${label} filter`} className="hover:text-zinc-100">
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
    </span>
  );
}

function Empty({ filtered, hasEvents }: { filtered: boolean; hasEvents: boolean }): React.ReactElement {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-[220px] space-y-1.5">
        <ListTree className="mx-auto h-5 w-5 text-zinc-800" aria-hidden />
        <p className="text-[12px] text-zinc-500">
          {filtered ? 'Nothing matches this filter' : hasEvents ? 'No events at this point in the replay' : 'No run yet'}
        </p>
        <p className="text-[11px] text-zinc-700">
          {filtered
            ? 'That part of the system has not acted yet in this run.'
            : hasEvents
              ? 'Scrub the replay forward to see what happened.'
              : 'State an intent and run the factory. Every event here comes from the ledger.'}
        </p>
      </div>
    </div>
  );
}
