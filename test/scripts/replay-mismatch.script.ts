/**
 * Run by replay.test.ts in a child process: a replay whose request doesn't match must end the
 * process with an error, even though runAgent catches the stream's error itself.
 */

import type { RecordingRecord } from '../../scripts/lib/recording.ts';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/agent/session.ts';
import { replayModel } from '../replay-model.ts';

const records: RecordingRecord[] = [
  {
    t: 'request',
    n: 1,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: [],
    body: {
      model: 'm',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'recorded task' },
      ],
    },
  },
  { t: 'response', n: 1, status: 200, headers: [] },
];

await runAgent({
  session: new Session([
    { role: 'system', content: 's' },
    { role: 'user', content: 'a different task' },
  ]),
  tools: [],
  model: 'm',
  stream: replayModel(records),
});
