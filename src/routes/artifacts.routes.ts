/**
 * /api/artifacts/:id — read a large tool result the runtime stored by
 * reference. The model reads these through its read_artifact tool; the
 * chat UI reads them here to draw a result in full (a page layout, a
 * describe, a stats table) instead of the preview the model was shown.
 * Session-guarded: Apex proxies it for the signed-in user.
 */
import { Router } from 'express';
import { sessionAuth } from '../auth/session';
import { readArtifact } from '../lc/artifact-store';

export const artifactsRouter = Router();

artifactsRouter.get('/api/artifacts/:id', sessionAuth, (req, res) => {
  const id = String(req.params.id ?? '');
  if (!/^art_[0-9a-f]{10}$/.test(id)) {
    res.status(400).json({ error: 'invalid_artifact_id' });
    return;
  }
  const entry = readArtifact(id);
  if (!entry) {
    res.status(404).json({ error: 'artifact_expired', message: 'This result has expired — re-run the tool to regenerate it.' });
    return;
  }
  res.json(entry);
});
