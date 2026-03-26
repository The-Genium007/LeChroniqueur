/**
 * CLI runner for DRY_RUN mode.
 * Provides a REPL that simulates Discord commands and button clicks.
 */

import * as readline from 'node:readline';
import type { SqliteDatabase } from '../core/database.js';
import type { Scheduler } from '../core/scheduler.js';
import { getLogger } from '../core/logger.js';
import { parseButtonCustomId } from '../discord/interactions.js';

interface CliRunnerDeps {
  readonly db: SqliteDatabase;
  readonly channels: Record<string, { id: string }>;
  readonly scheduler: Scheduler;
  readonly commandHandlers: Map<string, (args: string[]) => Promise<void>>;
  readonly buttonHandlers: Map<string, (action: string, targetTable: string, targetId: number) => Promise<void>>;
}

function printHelp(): void {
  const logger = getLogger();
  logger.info(`
╔═══════════════════════════════════════════════════════╗
║  Le Chroniqueur — DRY RUN mode                       ║
╠═══════════════════════════════════════════════════════╣
║                                                       ║
║  Commands:                                            ║
║    /veille          — Run veille pipeline              ║
║    /suggestions     — Run suggestions pipeline         ║
║    /rapport         — Run weekly report                ║
║    /search <query>  — Search the database              ║
║    /budget          — Show budget report                ║
║    /stats           — Show preference profile           ║
║                                                       ║
║  Buttons (simulate click):                            ║
║    !thumbup:veille_articles:1                          ║
║    !thumbdown:veille_articles:1                        ║
║    !transform:veille_articles:1                        ║
║    !archive:veille_articles:1                          ║
║    !go:suggestions:1                                   ║
║    !skip:suggestions:1                                 ║
║                                                       ║
║  System:                                              ║
║    help   — Show this help                             ║
║    quit   — Exit                                       ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
`);
}

export function startCliRunner(deps: CliRunnerDeps): void {
  const logger = getLogger();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n🎲 chroniqueur> ',
  });

  printHelp();
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (input.length === 0) {
      rl.prompt();
      return;
    }

    if (input === 'quit' || input === 'exit') {
      logger.info('Shutting down dry run...');
      rl.close();
      process.exit(0);
    }

    if (input === 'help') {
      printHelp();
      rl.prompt();
      return;
    }

    // Slash commands: /veille, /search foo, etc.
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      if (command === undefined) {
        rl.prompt();
        return;
      }

      const handler = deps.commandHandlers.get(command);
      if (handler === undefined) {
        logger.warn(`Unknown command: /${command}`);
        rl.prompt();
        return;
      }

      void handler(args).then(() => {
        rl.prompt();
      }).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, `Command /${command} failed`);
        rl.prompt();
      });

      return;
    }

    // Button simulation: !action:table:id
    if (input.startsWith('!')) {
      const customId = input.slice(1);
      const parsed = parseButtonCustomId(customId);

      if (parsed === undefined) {
        logger.warn(`Invalid button format. Use: !action:table:id (e.g. !thumbup:veille_articles:1)`);
        rl.prompt();
        return;
      }

      const handler = deps.buttonHandlers.get(parsed.action);
      if (handler === undefined) {
        logger.warn(`Unknown button action: ${parsed.action}`);
        rl.prompt();
        return;
      }

      void handler(parsed.action, parsed.targetTable, parsed.targetId).then(() => {
        rl.prompt();
      }).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, `Button ${parsed.action} failed`);
        rl.prompt();
      });

      return;
    }

    logger.warn(`Unknown input. Type "help" for commands, "/" for slash commands, "!" for buttons.`);
    rl.prompt();
  });

  rl.on('close', () => {
    deps.scheduler.stop();
  });
}
