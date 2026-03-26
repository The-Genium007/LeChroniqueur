/**
 * CLI adapter for TextChannel — renders Discord embeds + buttons in the terminal.
 * Used in DRY_RUN mode to replace real Discord channels.
 */

import type { TextChannel } from 'discord.js';
import { getLogger } from '../core/logger.js';

interface SendOptions {
  readonly embeds?: ReadonlyArray<{ toJSON(): Record<string, unknown> }>;
  readonly components?: ReadonlyArray<{ toJSON(): { components: ReadonlyArray<Record<string, unknown>> } }>;
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

function renderEmbed(embed: Record<string, unknown>): string {
  const lines: string[] = [];
  const color = typeof embed['color'] === 'number'
    ? `#${embed['color'].toString(16).padStart(6, '0')}`
    : '';

  const title = embed['title'] as string | undefined;
  const description = embed['description'] as string | undefined;
  const url = embed['url'] as string | undefined;
  const fields = embed['fields'] as Array<{ name: string; value: string }> | undefined;
  const footer = embed['footer'] as { text: string } | undefined;

  lines.push(`  ┌─ ${color ? `[${color}] ` : ''}${title ?? '(no title)'}${url !== undefined ? ` — ${url}` : ''}`);

  if (description !== undefined) {
    lines.push(`  │ ${description}`);
  }

  if (fields !== undefined) {
    for (const field of fields) {
      lines.push(`  │`);
      lines.push(`  │ ${field.name}`);
      for (const line of field.value.split('\n')) {
        lines.push(`  │   ${line}`);
      }
    }
  }

  if (footer !== undefined) {
    lines.push(`  │`);
    lines.push(`  │ ${footer.text}`);
  }

  lines.push('  └─');
  return lines.join('\n');
}

function renderButtons(components: ReadonlyArray<{ toJSON(): { components: ReadonlyArray<Record<string, unknown>> } }>): string {
  const buttons: string[] = [];

  for (const row of components) {
    const rowData = row.toJSON();
    for (const btn of rowData.components) {
      const label = btn['label'] as string | undefined;
      const rawEmoji = btn['emoji'] as string | { name: string } | undefined;
      const emoji = typeof rawEmoji === 'object' && rawEmoji !== null ? rawEmoji.name : rawEmoji;
      const customId = btn['custom_id'] as string | undefined;
      const display = [emoji, label].filter(Boolean).join(' ');
      buttons.push(`[${customId ?? '?'}] ${display}`);
    }
  }

  if (buttons.length === 0) return '';
  return `  Buttons: ${buttons.join('  |  ')}`;
}

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

  if (options.embeds !== undefined) {
    for (const embed of options.embeds) {
      lines.push(renderEmbed(embed.toJSON()));
    }
  }

  if (options.components !== undefined && options.components.length > 0) {
    lines.push(renderButtons(options.components));
  }

  lines.push('');
  logger.info(lines.join('\n'));

  return createFakeMessage(channelName);
}

export function createCliChannel(name: string): TextChannel {
  const channel = {
    id: `dry-channel-${name}`,
    name,
    async send(options: SendOptions): Promise<FakeMessage> {
      return printToTerminal(name, options);
    },
  };

  // Cast to TextChannel — handlers only use .send() and .id
  return channel as unknown as TextChannel;
}
