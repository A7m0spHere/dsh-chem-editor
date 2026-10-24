import type { CommandReply } from '../contracts/bridge';

// Transport bookkeeping only. Epoch/source checks stay in the iframe carrier.
export class EditorCommandBridge {
  private requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private send: (value: unknown) => void) {}
  command(method: string, payload: unknown) {
    const requestId = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error('批注通信超时，请查看聊天和当前批注状态。'));
      }, 45000);
      this.requests.set(requestId, { resolve, reject, timer });
      this.send({ type: 'command', method, payload, requestId });
    });
  }
  receive(reply: CommandReply) {
    const request = this.requests.get(reply.requestId);
    if (!request) return;
    clearTimeout(request.timer); this.requests.delete(reply.requestId);
    if (reply.error) request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    else request.resolve(reply.value);
  }
  dispose() {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer); request.reject(new Error('编辑器已关闭。'));
    }
    this.requests.clear();
  }
}
