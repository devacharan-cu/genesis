/**
 * The console's HTTP surface.
 *
 * Small on purpose. It creates a project, starts a run, and streams what the
 * ledger records; it decides nothing, stores nothing of its own, and every
 * value it returns is derived from the ledger by `@genesis/console`, which is a
 * pure fold. There is no second event system here and no counter that could
 * disagree with history.
 *
 * The stream is a signal-and-read: the watched ledger says "history moved", the
 * stream reads the events after the sequence it last sent, folds them, and
 * sends what came out. A client that reconnects gets a snapshot rebuilt from
 * the ledger, so a dropped connection loses nothing.
 */

import { foldConsole } from '@genesis/console';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { createProject, type Project, runFactory } from './project.js';
import { SCENARIO_INFO, SCENARIOS, type ScenarioName } from './scenarios.js';

const MAX_INTENT = 400;

export interface ServerOptions {
  /** Cap on projects held in memory, oldest evicted. Keeps a long demo bounded. */
  readonly maxProjects?: number;
}

export function createServer(options: ServerOptions = {}): express.Express {
  const maxProjects = options.maxProjects ?? 25;
  const projects = new Map<string, Project>();
  const startedAt = new Date().toISOString();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  const find = (req: Request, res: Response): Project | null => {
    const project = projects.get(req.params['projectId'] as string);
    if (project === undefined) {
      res.status(404).json({ error: 'no such project' });
      return null;
    }
    return project;
  };

  /** Everything the console shows about a project, folded from its ledger. */
  const stateOf = async (project: Project): Promise<Record<string, unknown>> => ({
    project: describeProject(project),
    console: foldConsole(await project.ledger.read(project.scope)),
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'genesis-console-api',
      startedAt,
      projects: projects.size,
      // Named plainly: the demo reasons deterministically and locally. The AWS
      // adapters exist and are tested; they are not what is answering here.
      reasoning: 'deterministic-local',
      ledger: 'in-memory, hash-chained',
      sandbox: 'local process sandbox',
    });
  });

  app.get('/api/scenarios', (_req, res) => {
    res.json({ scenarios: SCENARIO_INFO });
  });

  app.post('/api/projects', (req, res) => {
    void (async (): Promise<void> => {
      const body = (req.body ?? {}) as { intent?: unknown; scenario?: unknown };
      const intent = typeof body.intent === 'string' ? body.intent.trim() : '';
      const scenario = typeof body.scenario === 'string' ? body.scenario : 'repair';

      if (intent.length === 0) {
        res.status(400).json({ error: 'an intent is required', field: 'intent' });
        return;
      }
      if (intent.length > MAX_INTENT) {
        res.status(400).json({ error: `an intent must be at most ${MAX_INTENT} characters`, field: 'intent' });
        return;
      }
      if (!(SCENARIOS as readonly string[]).includes(scenario)) {
        res.status(400).json({ error: `unknown scenario "${scenario}"`, field: 'scenario' });
        return;
      }

      try {
        const project = await createProject(intent, scenario as ScenarioName);
        projects.set(project.projectId, project);
        while (projects.size > maxProjects) {
          const oldest = projects.keys().next().value as string;
          projects.delete(oldest);
        }
        res.status(201).json(await stateOf(project));
      } catch (error) {
        report('create project', error);
        res.status(500).json({ error: messageOf(error) });
      }
    })();
  });

  app.get('/api/projects/:projectId', (req, res) => {
    void (async (): Promise<void> => {
      const project = find(req, res);
      if (project === null) return;
      res.json(await stateOf(project));
    })();
  });

  /** The raw ledger, unfolded, for anyone who wants to check the console. */
  app.get('/api/projects/:projectId/events', (req, res) => {
    void (async (): Promise<void> => {
      const project = find(req, res);
      if (project === null) return;
      const events = await project.ledger.read(project.scope);
      const report = await project.ledger.verify(project.scope);
      res.json({ events, chain: report });
    })();
  });

  app.post('/api/projects/:projectId/runs', (req, res) => {
    const project = find(req, res);
    if (project === null) return;
    if (project.status === 'RUNNING') {
      res.status(409).json({ error: 'this project already has a run in flight' });
      return;
    }

    project.status = 'RUNNING';
    project.error = null;
    res.status(202).json({ projectId: project.projectId, status: project.status });

    // The run outlives the request. Its progress is the ledger's, and the
    // stream is how a client follows it.
    void runFactory(project)
      .then((outcome) => {
        project.outcome = outcome;
        project.status = 'FINISHED';
      })
      .catch((error: unknown) => {
        report(`run for ${project.projectId}`, error);
        project.status = 'ERRORED';
        project.error = messageOf(error);
      })
      // A status settles after the last event has landed, so the stream is
      // told directly; otherwise a client would see the whole run and never
      // learn that it ended.
      .finally(() => project.changes.announce());
  });

  app.get('/api/projects/:projectId/stream', (req, res) => {
    const project = find(req, res);
    if (project === null) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let sentSeq = 0;
    let pumping = false;
    let again = false;
    let closed = false;
    /** The last status sent, so an unchanged status is not repeated per event. */
    let sentStatus: string | null = null;

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /**
     * Reads what has landed since the last send and emits it.
     *
     * Serialised against itself: two overlapping pumps could read the same
     * events twice and send a duplicate, which is the one thing a timeline must
     * never do.
     */
    const pump = async (): Promise<void> => {
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      try {
        do {
          again = false;
          const fresh = await project.ledger.read(project.scope, { fromSeq: sentSeq + 1 });
          for (const event of fresh) {
            sentSeq = event.seq;
            // The raw event, not a reading of it: the browser folds with the
            // same function this server does, so the two cannot disagree.
            send('append', { event });
          }
          const signature = `${project.status}:${project.error ?? ''}`;
          if (signature !== sentStatus) {
            sentStatus = signature;
            send('status', { status: project.status, error: project.error, lastSeq: sentSeq });
          }
        } while (again && !closed);
      } catch (error) {
        report('stream pump', error);
        send('error', { error: messageOf(error) });
      } finally {
        pumping = false;
      }
    };

    // A snapshot first, so a client that connects late or reconnects sees the
    // whole run rather than only what happens next.
    void (async (): Promise<void> => {
      try {
        const events = await project.ledger.read(project.scope);
        sentSeq = events[events.length - 1]?.seq ?? 0;
        send('snapshot', { events, project: describeProject(project), lastSeq: sentSeq });
      } catch (error) {
        report('stream snapshot', error);
        send('error', { error: messageOf(error) });
      }
    })();

    const unwatchLedger = project.ledger.watch(() => void pump());
    const unwatchStatus = project.changes.watch(() => void pump());
    // A comment line keeps a proxy from closing an idle stream, and costs one
    // line every fifteen seconds.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 15_000);

    req.on('close', () => {
      closed = true;
      unwatchLedger();
      unwatchStatus();
      clearInterval(heartbeat);
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'no such route' });
  });

  return app;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One place that writes to the log, so a failure is never silent. */
function report(what: string, error: unknown): void {
  const detail = error as { details?: unknown };
  console.error(`[genesis-api] ${what}: ${messageOf(error)}`);
  if (detail.details !== undefined) console.error('[genesis-api] details:', JSON.stringify(detail.details));
}

/** The project's own metadata. Everything else a client needs is the fold's. */
function describeProject(project: Project): Record<string, unknown> {
  return {
    projectId: project.projectId,
    intent: project.intent,
    scenario: project.scenario,
    goalId: project.goalId,
    createdAt: project.createdAt,
    status: project.status,
    error: project.error,
  };
}
