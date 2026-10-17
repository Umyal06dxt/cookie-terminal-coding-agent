import { Box } from 'ink';
import type { EditorState } from '../editor.ts';
import { inputRows, pickerRows } from '../input-view.ts';
import type { Picker } from '../picker.ts';
import { useTheme } from '../theme.ts';
import { Lines } from './line-view.tsx';

export interface InputBoxProps {
  editor: EditorState;
  picker: Picker;
  selected: number;
  width: number;
  placeholder: string;
}

/** The rounded input box, with the "/" or "@" picker listed under it when one is open. */
export function InputBox({
  editor,
  picker,
  selected,
  width,
  placeholder,
}: InputBoxProps) {
  const theme = useTheme();
  const inner = width - 4;
  const border = theme.color('butter');
  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="round"
        {...(border !== undefined && { borderColor: border })}
        paddingX={1}
        width={width}
      >
        <Lines lines={inputRows(editor, inner, placeholder)} />
      </Box>
      <Lines lines={pickerRows(picker, selected, width)} />
    </Box>
  );
}
