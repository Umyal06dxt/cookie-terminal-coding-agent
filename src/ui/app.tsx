import { Box, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { OvenMode } from '../safety/permissions.ts';
import { InputBox } from './components/input-box.tsx';
import { LineRow } from './components/line-view.tsx';
import { Spinner } from './components/spinner.tsx';
import { StatusBar } from './components/status-bar.tsx';
import { Transcript } from './components/transcript.tsx';
import { Welcome } from './components/welcome.tsx';
import { type BackendResult, ChatController } from './controller.ts';
import {
  type EditorState,
  editorReduce,
  emptyEditor,
  submitEditor,
} from './editor.ts';
import { inputRows, pickerRows } from './input-view.ts';
import { intentFor } from './keymap.ts';
import { createCtrlC, footerHints } from './keys.ts';
import { applyPick, COMMANDS, pickerFor } from './picker.ts';
import {
  initialState,
  reduce,
  type StatusInfo,
  spinnerVisible,
} from './state.ts';

export interface AppProps {
  status: StatusInfo;
  /** Resolves once the provider is ready (or with why it isn't). */
  ready: Promise<BackendResult>;
  /** Files for the @ picker. */
  listFiles: () => Promise<string[]>;
  /** The gate reads this, so shift+tab takes effect on the next tool call. */
  oven: { get(): OvenMode; set(mode: OvenMode): void };
  version: string;
  /** Fixed size for tests; the terminal's size otherwise. */
  size?: { columns: number; rows: number };
  now?: () => number;
}

const HELP = [
  'enter sends · shift+enter, alt+enter or a trailing \\ adds a line · up/down browse history',
  '/ lists commands · @ picks a file · pgup/pgdn scroll',
  'shift+tab toggles read-only / full oven · esc interrupts · ctrl+c twice exits',
  `Commands: ${COMMANDS.map((c) => c.name).join(', ')}`,
].join('\n');

export function App(props: AppProps) {
  const app = useApp();
  const terminal = useWindowSize();
  const columns = props.size?.columns ?? terminal.columns;
  // One row short of the terminal: drawing the last row scrolls some terminals and flickers.
  const rows = props.size?.rows ?? Math.max(12, terminal.rows - 1);
  const now = props.now ?? Date.now;

  const [state, dispatch] = useReducer(reduce, props.status, initialState);
  const controller = useMemo(
    () => new ChatController(props.ready, dispatch),
    [props.ready],
  );
  const ctrlC = useMemo(() => createCtrlC(now), [now]);
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [scroll, setScroll] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [oven, setOven] = useState<OvenMode>(() => props.oven.get());
  const [armed, setArmed] = useState(false);
  const loading = useRef(false);
  // Keys can arrive faster than React re-renders; the handler reads the live editor from here.
  const editorRef = useRef(editor);
  const updateEditor = (change: (e: EditorState) => EditorState) => {
    editorRef.current = change(editorRef.current);
    setEditor(editorRef.current);
  };

  const picker = useMemo(() => {
    if (dismissed === editor.text) return { kind: 'none' as const };
    return pickerFor(editor.text, editor.cursor, files ?? []);
  }, [editor, files, dismissed]);

  // Startup facts that need the provider: the context window, or why it isn't available.
  useEffect(() => {
    let live = true;
    props.ready.then((result) => {
      if (!live) return;
      if (result.ok)
        dispatch({
          type: 'status',
          patch: { contextWindow: result.backend.contextWindow },
        });
      else dispatch({ type: 'notice', tone: 'error', text: result.message });
    });
    return () => {
      live = false;
    };
  }, [props.ready]);

  // Load the file list the first time "@" is typed.
  useEffect(() => {
    if (picker.kind !== 'file' || files !== null || loading.current) return;
    loading.current = true;
    props.listFiles().then(setFiles, () => setFiles([]));
  }, [picker.kind, files, props.listFiles]);

  // The "press again" hint fades when the window closes.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(ctrlC.armed()), 2100);
    return () => clearTimeout(timer);
  }, [armed, ctrlC]);

  // Stop any running turn first, so its stream doesn't keep the process alive.
  const exit = () => {
    controller.interrupt();
    app.exit();
  };

  const run = (text: string) => {
    if (text === '/exit') return exit();
    if (text === '/clear') return controller.clear();
    if (text === '/help')
      return dispatch({ type: 'notice', tone: 'info', text: HELP });
    setStartedAt(now());
    setScroll(0);
    void controller.submit(text);
  };

  const inputHeight = inputRows(editor, columns - 4, '').length + 2;
  const pickerHeight = pickerRows(picker, selected, columns).length;
  const showSpinner = spinnerVisible(state);
  const transcriptHeight = Math.max(
    3,
    rows - 2 - inputHeight - pickerHeight - 1 - (showSpinner ? 1 : 0),
  );

  useInput((input, key) => {
    // Only presses count; Cookie doesn't ask for kitty release events, but never act on one.
    if (key.eventType === 'release') return;
    const current = editorRef.current;
    const busy = controller.busy || state.busy;
    const livePicker =
      dismissed === current.text
        ? ({ kind: 'none' } as const)
        : pickerFor(current.text, current.cursor, files ?? []);
    const intent = intentFor(input, key, {
      editor: current,
      pickerOpen: livePicker.kind !== 'none',
      busy,
      page: Math.max(1, transcriptHeight - 2),
    });
    if (intent.type !== 'ctrl-c' && armed) {
      ctrlC.reset();
      setArmed(false);
    }
    switch (intent.type) {
      case 'ctrl-c': {
        const outcome = ctrlC.press({
          busy,
          hasText: current.text !== '',
        });
        if (outcome === 'exit') return exit();
        if (outcome === 'interrupt') controller.interrupt();
        if (outcome === 'clear')
          updateEditor((e) => editorReduce(e, { type: 'clear' }));
        setArmed(true);
        return;
      }
      case 'interrupt':
        controller.interrupt();
        return;
      case 'close-picker':
        setDismissed(current.text);
        return;
      case 'toggle-oven': {
        const next: OvenMode = oven === 'read-only' ? 'full-oven' : 'read-only';
        props.oven.set(next);
        setOven(next);
        return;
      }
      case 'picker-move': {
        const count =
          livePicker.kind === 'none' ? 0 : livePicker.matches.length;
        if (count > 0) setSelected((s) => (s + intent.by + count) % count);
        return;
      }
      case 'pick': {
        const picked = applyPick(
          livePicker,
          selected,
          current.text,
          current.cursor,
        );
        setSelected(0);
        if (!picked) return setDismissed(current.text);
        if (livePicker.kind === 'command' && key.return) {
          if (busy) return;
          updateEditor((e) => submitEditor({ ...e, text: picked.text }).next);
          return run(picked.text);
        }
        updateEditor((e) => editorReduce(e, { type: 'set', ...picked }));
        return;
      }
      case 'submit': {
        if (busy) return;
        const { text, next } = submitEditor(current);
        if (text === '') return;
        updateEditor(() => next);
        return run(text);
      }
      case 'scroll':
        setScroll((s) => Math.max(0, s + intent.by));
        return;
      case 'edit':
        setSelected(0);
        updateEditor((e) => editorReduce(e, intent.action));
        return;
      case 'edits':
        setSelected(0);
        updateEditor((e) => intent.actions.reduce(editorReduce, e));
        return;
      case 'none':
        return;
    }
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <StatusBar state={state} width={columns} />
      {state.items.length === 0 ? (
        <Box height={transcriptHeight} flexDirection="column">
          <Welcome version={props.version} folder={state.status.folder} />
        </Box>
      ) : (
        <Transcript
          items={state.items}
          width={columns}
          height={transcriptHeight}
          scroll={scroll}
        />
      )}
      {showSpinner && <Spinner startedAt={startedAt} now={now} />}
      <InputBox
        editor={editor}
        picker={picker}
        selected={selected}
        width={columns}
        placeholder={
          state.busy
            ? 'Cookie is baking… esc to interrupt'
            : 'Ask cookie anything'
        }
      />
      <LineRow
        line={[
          {
            text: ` ${footerHints({ busy: state.busy, armed, readOnly: oven === 'read-only' })}`,
            fg: armed ? 'crust' : 'chip',
          },
        ]}
      />
    </Box>
  );
}
