import { Router } from 'express';
import type { AgentService } from '../agents/service.js';

export function createAgentsRouter(agentService: AgentService): Router {
  const router = Router();

  router.get('/schedules', (req, res) => {
    res.json(agentService.listSchedules({ projectId: req.query.projectId as string | undefined }));
  });

  router.post('/schedules', (req, res) => {
    try {
      res.status(201).json(agentService.createSchedule(req.body));
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/schedules/:id', (req, res) => {
    const schedule = agentService.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json(schedule);
  });

  router.patch('/schedules/:id', (req, res) => {
    const schedule = agentService.updateSchedule(req.params.id, req.body);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json(schedule);
  });

  router.delete('/schedules/:id', (req, res) => {
    if (!agentService.deleteSchedule(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    res.status(204).end();
  });

  router.post('/schedules/:id/run-now', (req, res) => {
    try {
      res.json(agentService.runNow(req.params.id));
    } catch (err: any) {
      res.status(404).json({ error: err.message });
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
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
