import type { ArtifactView, ConsoleState } from '@genesis/console';
import { FileCode2, Fingerprint, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ladderIndex, VERIFICATION_LADDER } from '../lib/theme';

/**
 * What came out, and why anyone should believe it.
 *
 * The question this panel answers is "why is this artifact considered
 * verified?", so it shows the state, the evidence count behind it and the
 * content hash — and it shows an unverified artifact as plainly unverified
 * rather than hiding it. A repaired run leaves both the broken attempt and the
 * fix here, which is the point: the history is not overwritten.
 */
export function ArtifactPanel({ state }: { state: ConsoleState }): React.ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);

  if (state.artifacts.length === 0) {
    return (
      <section className="panel" aria-label="Artifacts">
        <div className="panel-head">
          <FileCode2 className="h-3 w-3" aria-hidden />
          Artifacts
        </div>
        <p className="px-3 py-4 text-[11px] text-zinc-600">
          Nothing built yet. An artifact appears the moment the Builder proposes one — recorded as an assumption, before
          any evidence.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Artifacts">
      <div className="panel-head justify-between">
        <span className="flex items-center gap-2">
          <FileCode2 className="h-3 w-3" aria-hidden />
          Artifacts
        </span>
        <span className="mono text-[10px] normal-case tracking-normal text-zinc-600">{state.artifacts.length}</span>
      </div>

      <ul className="divide-y" style={{ borderColor: 'var(--line)' }}>
        {state.artifacts.map((artifact) => (
          <Artifact
            key={artifact.artifactId}
            artifact={artifact}
            open={openId === artifact.artifactId}
            onToggle={() => setOpenId(openId === artifact.artifactId ? null : artifact.artifactId)}
          />
        ))}
      </ul>

      {state.findings.length > 0 && (
        <div className="border-t p-3" style={{ borderColor: 'var(--line)' }}>
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--lane-security)' }}>
            <ShieldAlert className="h-3 w-3" aria-hidden />
            Security findings
          </p>
          <ul className="space-y-1">
            {state.findings.map((finding, index) => (
              <li key={`${finding.rule}-${index}`} className="flex items-start gap-2 text-[11px]">
                <span
                  className="mono mt-px shrink-0 rounded px-1 text-[9px]"
                  style={{
                    color: finding.blocking ? 'var(--bad)' : 'var(--warn)',
                    background: finding.blocking ? 'rgba(251,113,133,.12)' : 'rgba(251,191,36,.12)',
                  }}
                >
                  {finding.severity}
                </span>
                <span className="min-w-0">
                  <span className="mono text-zinc-300">{finding.rule}</span>
                  {finding.detail !== '' && <span className="block text-zinc-500">{finding.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Artifact({
  artifact,
  open,
  onToggle,
}: {
  artifact: ArtifactView;
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const verified = artifact.verifiedSeq !== null;
  const reached = ladderIndex(artifact.state);

  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="tap w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          {verified ? (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ok)' }} aria-hidden />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--warn)' }} aria-hidden />
          )}
          <span className="mono min-w-0 flex-1 truncate text-[12px] text-zinc-200">{artifact.path}</span>
          <span
            className="mono shrink-0 text-[9px] uppercase tracking-wider"
            style={{ color: verified ? 'var(--ok)' : 'var(--warn)' }}
          >
            {artifact.state}
          </span>
        </div>

        {/* The verification ladder: how far the evidence actually carried it. */}
        <div className="mt-1.5 flex items-center gap-1">
          {VERIFICATION_LADDER.slice(0, 5).map((rung, index) => (
            <span
              key={rung}
              title={rung}
              className="h-1 flex-1 rounded-full"
              style={{
                background: index <= reached ? (verified ? 'var(--ok)' : 'var(--warn)') : 'rgba(255,255,255,.07)',
              }}
            />
          ))}
        </div>

        <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-600">
          <span>{artifact.bytes} bytes</span>
          <span>
            {artifact.evidenceCount} piece{artifact.evidenceCount === 1 ? '' : 's'} of evidence
          </span>
          <span>by {artifact.proposedBy ?? 'unknown'}</span>
        </div>
      </button>

      {open && (
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--line)', background: 'rgba(0,0,0,.35)' }}>
          <p className="mono mb-1.5 flex items-start gap-1.5 break-all text-[10px] text-zinc-500">
            <Fingerprint className="mt-px h-3 w-3 shrink-0 text-zinc-700" aria-hidden />
            {artifact.contentHash}
          </p>
          {!verified && (
            <p className="mb-1.5 text-[10px]" style={{ color: 'var(--warn)' }}>
              Not verified. This is what the model produced, recorded as an assumption — no evidence advanced it.
            </p>
          )}
          {artifact.contents !== null && (
            <pre className="mono max-h-48 overflow-auto rounded border p-2 text-[10px] leading-relaxed text-zinc-400" style={{ borderColor: 'var(--line)' }}>
              {artifact.contents}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
