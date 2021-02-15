declare var ungit: {
  config: typeof import('../../source/config');
  userHash: string;
  version: string;
  platform: string;
  pluginApiVersion: string;
};

type GraphEdge = import('./edge');
type GitGraph = import('./graph');
type GraphNode = import('./git-node');
type GraphRef = import('./git-ref');
