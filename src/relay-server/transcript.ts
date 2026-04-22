import {
  RELAY_PROMPT_MARKER_PREFIX,
  type ShellTranscriptState,
} from './types';

type SocketEmitter = {
  emit(eventName: string, payload: Record<string, unknown>): void;
};

export function createShellTranscriptState(workspace: string): ShellTranscriptState {
  return {
    activeCommand: null,
    currentCwd: workspace,
    inputBuffer: '',
    markerBuffer: '',
    nextCommandNumber: 1,
  };
}

function emitCommandOutput(
  socket: SocketEmitter,
  state: ShellTranscriptState,
  chunk: string
): void {
  if (!state.activeCommand || chunk.length === 0) {
    return;
  }

  socket.emit('shell_event', {
    type: 'command_output',
    commandId: state.activeCommand.commandId,
    stream: 'stdout',
    chunk,
  });
}

function finishActiveCommand(
  socket: SocketEmitter,
  state: ShellTranscriptState,
  exitCode: number
): void {
  if (!state.activeCommand) {
    return;
  }

  const finishedAt = Date.now();
  socket.emit('shell_event', {
    type: 'command_finished',
    commandId: state.activeCommand.commandId,
    exitCode,
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - state.activeCommand.startedAt,
  });
  state.activeCommand = null;
}

export function handleTerminalInput(
  socket: SocketEmitter,
  state: ShellTranscriptState,
  data: string
): void {
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      const command = state.inputBuffer.trim();
      state.inputBuffer = '';

      if (command.length > 0) {
        const commandId = `cmd-${state.nextCommandNumber++}`;
        state.activeCommand = {
          command,
          commandId,
          startedAt: Date.now(),
        };
        socket.emit('shell_event', {
          type: 'command_started',
          commandId,
          command,
          cwd: state.currentCwd,
          source: 'terminal',
          startedAt: new Date(state.activeCommand.startedAt).toISOString(),
        });
      }
      continue;
    }

    if (char === '\u0003') {
      state.inputBuffer = '';
      continue;
    }

    if (char === '\u007f' || char === '\b') {
      state.inputBuffer = state.inputBuffer.slice(0, -1);
      continue;
    }

    if (char >= ' ' && char !== '\u007f') {
      state.inputBuffer += char;
    }
  }
}

export function handleShellOutput(
  socket: SocketEmitter,
  state: ShellTranscriptState,
  data: string
): void {
  state.markerBuffer += data;

  while (state.markerBuffer.length > 0) {
    const markerIndex = state.markerBuffer.indexOf(RELAY_PROMPT_MARKER_PREFIX);
    if (markerIndex === -1) {
      const keepLength = Math.max(0, RELAY_PROMPT_MARKER_PREFIX.length - 1);
      const flushLength = Math.max(0, state.markerBuffer.length - keepLength);
      if (flushLength > 0) {
        emitCommandOutput(socket, state, state.markerBuffer.slice(0, flushLength));
        state.markerBuffer = state.markerBuffer.slice(flushLength);
      }
      break;
    }

    if (markerIndex > 0) {
      emitCommandOutput(socket, state, state.markerBuffer.slice(0, markerIndex));
      state.markerBuffer = state.markerBuffer.slice(markerIndex);
    }

    const markerEndIndex = state.markerBuffer.indexOf('\u0007');
    if (markerEndIndex === -1) {
      break;
    }

    const markerPayload = state.markerBuffer.slice(
      RELAY_PROMPT_MARKER_PREFIX.length,
      markerEndIndex
    );
    state.markerBuffer = state.markerBuffer.slice(markerEndIndex + 1);

    const separatorIndex = markerPayload.lastIndexOf('|');
    const cwd = separatorIndex >= 0
      ? markerPayload.slice(0, separatorIndex)
      : state.currentCwd;
    const exitCodeRaw = separatorIndex >= 0
      ? markerPayload.slice(separatorIndex + 1)
      : '0';
    const exitCode = Number.parseInt(exitCodeRaw, 10);

    finishActiveCommand(socket, state, Number.isNaN(exitCode) ? 0 : exitCode);

    if (cwd && cwd !== state.currentCwd) {
      state.currentCwd = cwd;
      socket.emit('shell_event', {
        type: 'cwd_changed',
        cwd,
      });
    }

    socket.emit('shell_event', {
      type: 'prompt',
      cwd: state.currentCwd,
      prompt: '',
    });
  }
}
