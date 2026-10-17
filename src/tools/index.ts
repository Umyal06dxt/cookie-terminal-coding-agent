import { bashTool } from './bash.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { readTool } from './read.ts';
import { ToolRegistry } from './registry.ts';
import { writeTool } from './write.ts';

/** The five basic tools. The full read tool and the repair layer replace these in Phase 2. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry().register(
    readTool,
    globTool,
    editTool,
    writeTool,
    bashTool,
  );
}
