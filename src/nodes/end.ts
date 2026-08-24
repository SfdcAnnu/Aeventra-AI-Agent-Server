import { register } from './registry';

register('end', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'end',
  success: true,
  output: { ended: true },
}));
