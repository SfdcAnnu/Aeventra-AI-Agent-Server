import http from 'node:http';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './logger';
import { agentRouter } from './routes/agent.routes';
import { healthRouter } from './routes/health.routes';
import { connectorsRouter } from './routes/connectors.routes';
import { setupRouter } from './routes/setup.routes';
import { chatRouter } from './routes/chat.routes';
import { engineRouter } from './routes/engine.routes';
import { kbRouter } from './routes/kb.routes';
import { runsRouter } from './routes/runs.routes';
import { agentGeneratorRouter } from './routes/agent-generator.routes';
import { copilotRouter } from './routes/copilot.routes';
import { wsRouter } from './routes/ws.routes';
import { attach as attachWsGateway } from './ws/gateway';
import { startRunPoller } from './scheduler/run-poller';

function buildApp(): express.Express {
  const app = express();

  // 10mb: requirement-document uploads (base64 PDFs) ride inside JSON
  // bodies on /api/agent/analyze|generate — 2mb rejected real-world PDFs,
  // and the rejection surfaced as an opaque 500 (see the error handler's
  // status passthrough below).
  app.use(express.json({ limit: '10mb' }));
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(setupRouter);      // app-level OAuth setup (no session yet)
  app.use(agentRouter);      // /api/agent/execute — sessionAuth-guarded (autonomous runs)
  app.use(connectorsRouter); // sessionAuth-guarded
  app.use(chatRouter);       // /api/chat/* — sessionAuth-guarded
  app.use(engineRouter);     // /api/engine/test — sessionAuth-guarded
  app.use(kbRouter);         // /api/kb/* — sessionAuth-guarded
  app.use(runsRouter);       // /api/agent/runs/resume — sessionAuth-guarded
  app.use(agentGeneratorRouter); // /api/agent/generate — sessionAuth-guarded
  app.use(copilotRouter);    // /api/agent/copilot — sessionAuth-guarded
  app.use(wsRouter);         // /api/ws/ticket — sessionAuth-guarded (Apex-only)

  // Final error handler. body-parser/http errors carry a real statusCode
  // (413 too-large, 400 bad JSON, …) — pass it through instead of masking
  // everything as a bare 500, so clients see an actionable message.
  app.use((err: Error & { statusCode?: number; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'unhandled_error');
    const status = err.statusCode ?? err.status ?? 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'request_error', message: err.message });
  });

  return app;
}

const app = buildApp();
// http.createServer(app) instead of app.listen() — the WS gateway needs
// the raw http.Server to hook 'upgrade' on. Same Express app, same port,
// one Render service; nothing about the plain HTTP routes changes.
const server = http.createServer(app);
attachWsGateway(server);
server.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'archon_ai_server_started');
  startRunPoller();
});
