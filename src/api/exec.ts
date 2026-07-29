import {
  AttachResize,
  AttachStdin,
  AttachStdinEOF,
  AttachTerminalSize,
  ExecAttachRequest,
  ExecAttachResponse,
  ExecAttachStart,
  ExecCommand,
  ExecRequest,
} from '../gen/agentcompose/v2/agentcompose_pb.js';

import { apiPath } from '../paths';

export type InteractiveTerminal = {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  eof(): void;
  close(): void;
};

export function openInteractiveTerminal(
  sandboxId: string,
  handlers: { onData: (data: string) => void; onState: (state: string) => void; onError: (message: string) => void },
): InteractiveTerminal {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const socketURL = new URL(apiPath('/api/terminal/attach'), window.location.href);
  socketURL.searchParams.set('sandboxId', sandboxId);
  socketURL.protocol = socketURL.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketURL);
  socket.binaryType = 'arraybuffer';
  const pending: Uint8Array[] = [];
  let frame = 0;
  let ended = false;

  const enqueue = (request: ExecAttachRequest): void => {
    request.clientFrameId = `ui-${++frame}`;
    const payload = request.toBinary();
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(payload);
  };
  enqueue(
    new ExecAttachRequest({
      frame: {
        case: 'start',
        value: new ExecAttachStart({
          request: new ExecRequest({
            target: { case: 'sandboxId', value: sandboxId },
            command: new ExecCommand({ command: 'sh', args: ['-l'] }),
          }),
          attachStdin: true,
          tty: true,
          terminalSize: new AttachTerminalSize({ cols: 80, rows: 24 }),
        }),
      },
    }),
  );

  handlers.onState('连接中');
  socket.onopen = () => {
    for (const payload of pending.splice(0)) socket.send(payload);
  };
  socket.onmessage = (event) => {
    try {
      if (typeof event.data === 'string') {
        handlers.onError(event.data);
        return;
      }
      const response = ExecAttachResponse.fromBinary(new Uint8Array(event.data as ArrayBuffer));
      if (response.frame.case === 'started') handlers.onState('已连接');
      else if (response.frame.case === 'output')
        handlers.onData(decoder.decode(response.frame.value.data, { stream: true }));
      else if (response.frame.case === 'error') handlers.onError(response.frame.value.message);
      else if (response.frame.case === 'result') {
        ended = true;
        handlers.onState(`已结束 · exit ${response.frame.value.exitCode}`);
      }
    } catch (cause) {
      handlers.onError(cause instanceof Error ? cause.message : '无法解析交互终端响应');
    }
  };
  socket.onerror = () => handlers.onError('交互终端 WebSocket 连接失败');
  socket.onclose = () => {
    if (!ended) handlers.onState('已断开');
  };

  return {
    send(data) {
      enqueue(
        new ExecAttachRequest({ frame: { case: 'stdin', value: new AttachStdin({ data: encoder.encode(data) }) } }),
      );
    },
    resize(cols, rows) {
      enqueue(
        new ExecAttachRequest({
          frame: { case: 'resize', value: new AttachResize({ terminalSize: new AttachTerminalSize({ cols, rows }) }) },
        }),
      );
    },
    eof() {
      enqueue(new ExecAttachRequest({ frame: { case: 'stdinEof', value: new AttachStdinEOF() } }));
    },
    close() {
      ended = true;
      socket.close();
    },
  };
}
