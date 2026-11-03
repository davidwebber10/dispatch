import type { Router } from 'express';
import { keyRoute, policyRouter } from '../auth/route-policy.js';
import { allowRule } from '../auth/key-rules.js';
import { creatorOf } from '../auth/creator.js';
import type { AgentService } from '../agents/service.js';
import { clientMessage } from '../http/client-message.js';

export function createAgentsRouter(agentService: AgentService): Router {
  const router = policyRouter();

  // Cross-project agent overview (status + all-time spend) for the Agents tab.
  router.get('/overview', (_req, res) => {
    res.json(agentService.overview());
  });

  router.get('/schedules', (req, res) => {
    res.json(agentService.listSchedules({ projectId: req.query.projectId as string | undefined }));
  });

  // SEC-20: a thread with its own key may create this (never blocked); the route records the thread as the creator.
  // Only `thread` has a rule, so a role run, a shell and Chat stay owner only and a scheduled run cannot add the next schedule.
  router.post('/schedules', keyRoute({ thread: allowRule }), (req, res) => {
    try {
      res.status(201).json(agentService.createSchedule(req.body, creatorOf(req)));
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
    }
  });

  router.get('/schedules/:id', (req, res) => {
    const schedule = agentService.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json(schedule);
  });

  router.patch('/schedules/:id', (req, res) => {
    try {
      const schedule = agentService.updateSchedule(req.params.id, req.body);
      if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
      res.json(schedule);
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
    }
  });

  router.delete('/schedules/:id', (req, res) => {
    if (!agentService.deleteSchedule(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    res.status(204).end();
  });

  router.post('/schedules/:id/run-now', (req, res) => {
    try {
      res.json(agentService.runNow(req.params.id));
    } catch (err: any) {
      res.status(404).json({ error: clientMessage(err) });
    }
  });

  router.get('/runs', (req, res) => {
    res.json(agentService.listRuns({
      projectId: req.query.projectId as string | undefined,
      scheduleId: req.query.scheduleId as string | undefined,
    }));
  });

  router.get('/runs/:id', (req, res) => {
    const run = agentService.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  router.get('/runs/:id/events', (req, res) => {
    const run = agentService.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ steps: agentService.getRunSteps(req.params.id) });
  });

  router.post('/runs/:id/opened', (req, res) => {
    const run = agentService.markRunOpened(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  router.post('/runs/:id/cancel', (req, res) => {
    try {
      res.json(agentService.cancelRun(req.params.id));
    } catch (err: any) {
      res.status(404).json({ error: clientMessage(err) });
    }
  });

  return router;
}
