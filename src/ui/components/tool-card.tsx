import type { Item } from '../state.ts';
import { toolCard } from '../tool-card.ts';
import { Lines } from './line-view.tsx';

/** A single tool card (and its diff), for places outside the transcript. */
export function ToolCard({
  item,
  width,
}: {
  item: Extract<Item, { kind: 'tool' }>;
  width: number;
}) {
  return <Lines lines={toolCard(item, width)} />;
}
