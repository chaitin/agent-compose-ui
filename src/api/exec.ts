import {
  AttachResize,
  AttachStdin,
  AttachStdinEOF,
  AttachTerminalSize,
  AttachExecRequest,
  AttachExecResponse,
  AttachExecStart,
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

const TERMINAL_CONNECT_TIMEOUT_MS = 8_000;

export function openInteractiveTerminal(
  sandboxId: string,
  handlers: {
    onData: (data: string) => void;
    onState: (state: string) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
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
  let connected = false;
  let closeNotified = false;
  const notifyClose = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    handlers.onClose?.();
  };
  const connectTimer = window.setTimeout(() => {
    if (connected || ended) return;
    ended = true;
    handlers.onError('终端连接超时，后端未响应');
    socket.close();
    notifyClose();
  }, TERMINAL_CONNECT_TIMEOUT_MS);

  const enqueue = (request: AttachExecRequest): void => {
    request.clientFrameId = `ui-${++frame}`;
    const payload = request.toBinary();
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(payload);
  };
  enqueue(
    new AttachExecRequest({
      frame: {
        case: 'start',
        value: new AttachExecStart({
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
      const response = AttachExecResponse.fromBinary(new Uint8Array(event.data as ArrayBuffer));
      if (response.frame.case === 'started') {
        connected = true;
        window.clearTimeout(connectTimer);
        handlers.onState('已连接');
      } else if (response.frame.case === 'output')
        handlers.onData(decoder.decode(response.frame.value.data, { stream: true }));
      else if (response.frame.case === 'error') handlers.onError(response.frame.value.message);
      else if (response.frame.case === 'result') {
        ended = true;
        window.clearTimeout(connectTimer);
        handlers.onState(`已结束 · exit ${response.frame.value.exitCode}`);
        notifyClose();
      }
    } catch (cause) {
      handlers.onError(cause instanceof Error ? cause.message : '无法解析交互终端响应');
    }
  };
  socket.onerror = () => {
    window.clearTimeout(connectTimer);
    handlers.onError('交互终端 WebSocket 连接失败');
  };
  socket.onclose = () => {
    window.clearTimeout(connectTimer);
    if (!ended) handlers.onState('已断开');
    notifyClose();
  };

  return {
    send(data) {
      enqueue(
        new AttachExecRequest({ frame: { case: 'stdin', value: new AttachStdin({ data: encoder.encode(data) }) } }),
      );
    },
    resize(cols, rows) {
      enqueue(
        new AttachExecRequest({
          frame: { case: 'resize', value: new AttachResize({ terminalSize: new AttachTerminalSize({ cols, rows }) }) },
        }),
      );
    },
    eof() {
      enqueue(new AttachExecRequest({ frame: { case: 'stdinEof', value: new AttachStdinEOF() } }));
    },
    close() {
      ended = true;
      window.clearTimeout(connectTimer);
      socket.close();
    },
  };
}
