import express from 'express';
import cors from 'cors';
import { ulid } from '@genesis/core-types';
import { DefaultOrchestrator } from '@genesis/core';
import { SqliteEventLedger } from '@genesis/adapters-sqlite';
import { LocalSandboxProvider } from '@genesis/adapters-sandbox-local';
import { EventEngine } from '@genesis/cognition';
import { SingleProjectGraph } from '@genesis/graph';
import { VerificationEngine } from '@genesis/verification';
import { Pipeline } from '@genesis/factory';
import { DefaultEventStream } from '@genesis/cloud';

const app = express();
app.use(cors());

// A real EventStream from @genesis/cloud (or just polling the ledger)
// Wait, we can just observe the SQLite Event Ledger!

app.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const projectId = ulid();
  const db = new SqliteEventLedger(':memory:');
  
  // Send a message
  const send = (node: string, msg: string) => {
    res.write(`data: ${JSON.stringify({ node, msg })}\n\n`);
  };

  send('system', 'Initializing GENESIS environment...');
  
  try {
    const sandbox = new LocalSandboxProvider();
    const verifier = new VerificationEngine(sandbox);
    const engine = new EventEngine(verifier);
    const graph = new SingleProjectGraph(projectId, db);
    const pipeline = new Pipeline(db, sandbox);
    
    const orchestrator = new DefaultOrchestrator(db, engine, pipeline, graph);

    // Initial state
    send('planner', 'Starting goal: Build a Tic Tac Toe web application');

    // Subscribe to ledger appends
    const stream = new DefaultEventStream(db, {
      subscribe: async (listener) => {
        // Not a real subscription, we just poll for simplicity in this demo server
        let lastSeq = 0;
        const interval = setInterval(async () => {
          const events = await db.read(projectId, { after: lastSeq });
          for (const ev of events) {
            lastSeq = ev.seq;
            listener(ev);
            
            // Map event to UI node
            if (ev.kind === 'AgentAssigned') send('planner', `Assigned ${ev.role} to task ${ev.taskId}`);
            if (ev.kind === 'ProposalRaised') send('architect', `Proposal raised: ${ev.type}`);
            if (ev.kind === 'ArtifactGenerated') send('builder', `Generated artifact ${ev.path}`);
            if (ev.kind === 'VerificationRunCompleted') send(ev.failed ? 'qa' : 'verifier', `Verification ${ev.failed ? 'failed' : 'passed'}`);
            if (ev.kind === 'ExperimentCompleted') send('qa', `Experiment completed with ${ev.evidence.length} evidence items`);
            if (ev.kind === 'ArtifactVerified') send('verifier', `Artifact ${ev.path} has been VERIFIED.`);
          }
        }, 500);
        return () => clearInterval(interval);
      }
    });

    stream.subscribe(async () => {});

    // Trigger the flow
    await orchestrator.execute({
      kind: 'UserMessage',
      id: ulid(),
      timestamp: Date.now(),
      text: 'Build a secure tic tac toe web app. It must be accessible.',
      attachments: []
    }, projectId);

    send('system', 'Execution loop finished. Waiting for async tasks...');

  } catch (err: any) {
    send('system', `Error: ${err.message}`);
  }
  
  req.on('close', () => {
    res.end();
  });
});

app.listen(3001, () => {
  console.log('API Server running on port 3001');
});
