/**
 * CLI adapter for TextChannel — renders Discord V2 containers + buttons in the terminal.
 * Used in DRY_RUN mode to replace real Discord channels.
 */

import type { TextChannel } from 'discord.js';
import { getLogger } from '../core/logger.js';

// ─── V2 JSON component types ───

const TYPE_ACTION_ROW = 1;
const TYPE_TEXT_DISPLAY = 10;
const TYPE_CONTAINER = 17;

interface ComponentJson {
  type: number;
  content?: string;
  accent_color?: number;
  components?: ComponentJson[];
  label?: string;
  emoji?: string | { name: string };
  custom_id?: string;
  [key: string]: unknown;
}

interface SendOptions {
  readonly components?: ReadonlyArray<ComponentJson | { toJSON(): ComponentJson }>;
  readonly flags?: number;
  readonly content?: string;
}

interface FakeMessage {
  readonly id: string;
  startThread(options: { name: string; autoArchiveDuration?: number }): Promise<FakeThread>;
}

interface FakeThread {
  readonly id: string;
  send(options: SendOptions): Promise<FakeMessage>;
}

let messageCounter = 0;

function nextId(): string {
  messageCounter += 1;
  return `dry-msg-${String(messageCounter)}`;
}

// ─── V2 rendering ───

function resolveJson(component: ComponentJson | { toJSON(): ComponentJson }): ComponentJson {
  if ('toJSON' in component && typeof component.toJSON === 'function') {
    return component.toJSON() as ComponentJson;
  }
  return component as ComponentJson;
}

function renderContainer(container: ComponentJson): string {
  const lines: string[] = [];
  const color = typeof container.accent_color === 'number'
    ? `#${container.accent_color.toString(16).padStart(6, '0')}`
    : '';

  lines.push(`  ┌─${color.length > 0 ? ` [${color}]` : ''}`);

  const children = container.components ?? [];
  const buttons: string[] = [];

  for (const child of children) {
    if (child.type === TYPE_TEXT_DISPLAY && typeof child.content === 'string') {
      for (const textLine of child.content.split('\n')) {
        lines.push(`  │ ${textLine}`);
      }
    } else if (child.type === TYPE_ACTION_ROW) {
      const rowChildren = child.components ?? [];
      for (const btn of rowChildren) {
        const label = btn.label as string | undefined;
        const rawEmoji = btn.emoji as string | { name: string } | undefined;
        const emoji = typeof rawEmoji === 'object' && rawEmoji !== null ? rawEmoji.name : rawEmoji;
        const customId = btn.custom_id as string | undefined;
        const display = [emoji, label].filter(Boolean).join(' ');
        buttons.push(`[${customId ?? '?'}] ${display}`);
      }
    }
    // Separators are visual-only, skip in CLI
  }

  if (buttons.length > 0) {
    lines.push(`  │`);
    lines.push(`  │ Buttons: ${buttons.join('  |  ')}`);
  }

  lines.push('  └─');
  return lines.join('\n');
}

// ─── Terminal output ───

function createFakeMessage(channelName: string): FakeMessage {
  const id = nextId();
  return {
    id,
    async startThread(options) {
      const logger = getLogger();
      logger.info(`  📎 Thread created: "${options.name}"`);

      const thread: FakeThread = {
        id: `dry-thread-${id}`,
        async send(opts: SendOptions) {
          return printToTerminal(channelName, opts);
        },
      };
      return thread;
    },
  };
}

function printToTerminal(channelName: string, options: SendOptions): FakeMessage {
  const logger = getLogger();
  const lines: string[] = [`\n━━━ #${channelName} ━━━`];

  if (options.content !== undefined) {
    lines.push(`  ${options.content}`);
  }

  if (options.components !== undefined) {
    for (const raw of options.components) {
      const component = resolveJson(raw);
      if (component.type === TYPE_CONTAINER) {
        lines.push(renderContainer(component));
      }
    }
  }

  lines.push('');
  logger.info(lines.join('\n'));

  return createFakeMessage(channelName);
}

// ─── Public API ───

export function createCliChannel(name: string): TextChannel {
  const channel = {
    id: `dry-channel-${name}`,
    name,
    messages: {
      async fetch(_messageId: string) {
        return createFakeMessage(name);
      },
    },
    async send(options: SendOptions): Promise<FakeMessage> {
      return printToTerminal(name, options);
    },
  };

  // Cast to TextChannel — handlers only use .send(), .id, and .messages.fetch()
  return channel as unknown as TextChannel;
}
