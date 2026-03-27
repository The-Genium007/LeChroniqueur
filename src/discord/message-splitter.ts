/**
 * Message splitter for Discord Components V2.
 *
 * Discord V2 messages have a 4 000-char text limit per message.
 * This module splits oversized V2MessagePayloads into multiple payloads,
 * keeping buttons only on the last one.
 */

import { MessageFlags } from 'discord.js';
import type { V2MessagePayload } from './component-builder-v2.js';
import { getLogger } from '../core/logger.js';

// ─── Discord V2 limits ───

/** Safe text budget per message (leave margin for JSON overhead). */
const MAX_TEXT_CHARS = 3_800;

/** Maximum top-level containers per V2 message. */
const MAX_CONTAINERS = 10;

// ─── Internal types for parsed container JSON ───

interface ContainerJson {
  accent_color?: number;
  components: ComponentJson[];
  type: number;
}

interface ComponentJson {
  type: number;
  content?: string;       // TextDisplay (type 10)
  components?: ComponentJson[]; // ActionRow (type 1)
  [key: string]: unknown;
}

// Discord component types
const TYPE_ACTION_ROW = 1;
const TYPE_TEXT_DISPLAY = 10;
const TYPE_CONTAINER = 17;
// ─── Char counting ───

function countTextChars(component: ComponentJson): number {
  if (component.type === TYPE_TEXT_DISPLAY && typeof component.content === 'string') {
    return component.content.length;
  }
  return 0;
}

// ─── Text splitting ───

/**
 * Split a long text at the nearest `\n` before `maxLen`.
 * Falls back to space, then hard-cut if no breakpoint found.
 */
function splitText(text: string, maxLen: number): [string, string] {
  if (text.length <= maxLen) return [text, ''];

  // Try newline
  const nlIdx = text.lastIndexOf('\n', maxLen);
  if (nlIdx > 0) return [text.slice(0, nlIdx), text.slice(nlIdx + 1)];

  // Try space
  const spIdx = text.lastIndexOf(' ', maxLen);
  if (spIdx > 0) return [text.slice(0, spIdx), text.slice(spIdx + 1)];

  // Hard cut
  return [text.slice(0, maxLen), text.slice(maxLen)];
}

// ─── Core split logic ───

/**
 * Split a V2MessagePayload into 1+ payloads that each fit within Discord limits.
 * ActionRows (buttons) are placed only on the LAST payload.
 *
 * If the payload is within limits, returns it unchanged (zero overhead).
 */
export function splitV2(payload: V2MessagePayload): V2MessagePayload[] {
  const containers = payload.components as ContainerJson[];

  if (containers.length === 0) return [payload];

  // Collect all children from all containers, preserving accent_color
  const allChildren: { child: ComponentJson; color: number }[] = [];
  const actionRows: { row: ComponentJson; color: number }[] = [];

  for (const container of containers) {
    const color = container.accent_color ?? 0;
    for (const child of container.components) {
      if (child.type === TYPE_ACTION_ROW) {
        actionRows.push({ row: child, color });
      } else {
        allChildren.push({ child, color });
      }
    }
  }

  // Fast path: if total text fits in one message, return as-is
  let totalChars = 0;
  for (const { child } of allChildren) {
    totalChars += countTextChars(child);
  }
  if (totalChars <= MAX_TEXT_CHARS && containers.length <= MAX_CONTAINERS) {
    return [payload];
  }

  // Split children into groups that fit within MAX_TEXT_CHARS
  const groups: { children: ComponentJson[]; color: number }[] = [];
  let currentGroup: ComponentJson[] = [];
  let currentChars = 0;
  let currentColor = allChildren[0]?.color ?? 0;

  for (const { child, color } of allChildren) {
    const childChars = countTextChars(child);

    // If a single TextDisplay exceeds the limit, split its text
    if (child.type === TYPE_TEXT_DISPLAY && childChars > MAX_TEXT_CHARS) {
      // Flush current group first
      if (currentGroup.length > 0) {
        groups.push({ children: currentGroup, color: currentColor });
        currentGroup = [];
        currentChars = 0;
      }

      let remaining = child.content ?? '';
      while (remaining.length > 0) {
        const [chunk, rest] = splitText(remaining, MAX_TEXT_CHARS);
        groups.push({
          children: [{ type: TYPE_TEXT_DISPLAY, content: chunk }],
          color,
        });
        remaining = rest;
      }
      currentColor = color;
      continue;
    }

    // Would adding this child exceed the limit?
    if (currentChars + childChars > MAX_TEXT_CHARS && currentGroup.length > 0) {
      groups.push({ children: currentGroup, color: currentColor });
      currentGroup = [];
      currentChars = 0;
    }

    currentGroup.push(child);
    currentChars += childChars;
    currentColor = color;
  }

  // Flush remaining
  if (currentGroup.length > 0) {
    groups.push({ children: currentGroup, color: currentColor });
  }

  // Edge case: no groups (only action rows, no text)
  if (groups.length === 0) {
    return [payload];
  }

  // Build payloads: action rows go on the LAST group only
  const payloads: V2MessagePayload[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group === undefined) continue;
    const isLast = i === groups.length - 1;

    const containerJson: ContainerJson = {
      accent_color: group.color,
      components: [...group.children],
      type: TYPE_CONTAINER,
    };

    // Append action rows to the last container
    if (isLast) {
      // Limit to 5 action rows max per container
      const rowsToAdd = actionRows.slice(0, 5);
      for (const { row } of rowsToAdd) {
        containerJson.components.push(row);
      }
    }

    payloads.push({
      components: [containerJson] as V2MessagePayload['components'],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return payloads;
}

// ─── Send helpers ───

interface Sendable {
  send(options: Record<string, unknown>): Promise<{ id: string }>;
}

interface InteractionLike {
  editReply(options: Record<string, unknown>): Promise<unknown>;
  followUp(options: Record<string, unknown>): Promise<unknown>;
  replied: boolean;
  deferred: boolean;
}

/**
 * Split a V2 payload and send each part sequentially to a channel or thread.
 * Returns the IDs of all sent messages.
 */
export async function sendSplit(
  target: Sendable,
  payload: V2MessagePayload,
): Promise<string[]> {
  const parts = splitV2(payload);
  const ids: string[] = [];

  for (const part of parts) {
    const msg = await target.send({
      components: part.components as never[],
      flags: part.flags,
    });
    ids.push(msg.id);
  }

  return ids;
}

/**
 * Split a V2 payload for an interaction response.
 * First part → editReply, subsequent parts → followUp.
 * Buttons end up on the last message.
 */
export async function replySplit(
  interaction: InteractionLike,
  payload: V2MessagePayload,
): Promise<void> {
  const logger = getLogger();
  const parts = splitV2(payload);

  const first = parts[0];
  if (first === undefined) return;

  await interaction.editReply({
    components: first.components as never[],
    flags: first.flags,
  });

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    try {
      await interaction.followUp({
        components: part.components as never[],
        flags: part.flags,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ error: msg, part: i + 1, total: parts.length }, 'followUp failed during split send');
    }
  }
}
