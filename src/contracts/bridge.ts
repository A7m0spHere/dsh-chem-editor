export const editorChannel = 'dsh-chem-editor';
export const hostMethods = [
  'chem-editor/bootstrap', 'chem-editor/snapshot', 'chem-editor/save',
  'chem-editor/annotate', 'chem-editor/continue-annotation', 'chem-editor/annotations',
  'chem-editor/annotation-detail', 'chem-editor/preview', 'chem-editor/apply',
  'chem-editor/cancel', 'chem-editor/detach',
];
export type CommandReply = { requestId: string; value?: unknown; error?: { code?: string; message: string } };
