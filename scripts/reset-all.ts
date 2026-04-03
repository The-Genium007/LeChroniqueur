/**
 * Resets ALL bot data to zero — deletes all databases and starts fresh.
 * ⚠️  DESTRUCTIVE — this cannot be undone.
 *
 * Usage: npx tsx scripts/reset-all.ts
 *        npx tsx scripts/reset-all.ts --confirm   (skip confirmation prompt)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dataDir = path.join(process.cwd(), 'data');

async function confirm(): Promise<boolean> {
  if (process.argv.includes('--confirm')) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(
      '\n⚠️  This will DELETE all bot data:\n' +
      '  • Global database (bot.db)\n' +
      '  • All instance databases\n' +
      '  • Wizard sessions\n' +
      '  • All veille articles, suggestions, publications\n' +
      '  • All media references\n' +
      '  • All analytics data\n\n' +
      'Type "RESET" to confirm: ',
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'RESET');
      },
    );
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(dataDir)) {
    console.log('ℹ️  No data directory found — nothing to reset.');
    return;
  }

  const confirmed = await confirm();
  if (!confirmed) {
    console.log('❌ Cancelled.');
    return;
  }

  console.log('\n🗑️  Deleting all data...\n');

  // Find and delete all .db, .db-wal, .db-shm files recursively
  let deletedCount = 0;

  function deleteDbFiles(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        deleteDbFiles(fullPath);
        // Remove empty directories (instance dirs)
        try {
          const remaining = fs.readdirSync(fullPath);
          if (remaining.length === 0) {
            fs.rmdirSync(fullPath);
            console.log(`  📁 Removed empty dir: ${path.relative(process.cwd(), fullPath)}`);
          }
        } catch { /* dir not empty or permission issue */ }
      } else if (entry.name.endsWith('.db') || entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) {
        fs.unlinkSync(fullPath);
        console.log(`  🗑️  Deleted: ${path.relative(process.cwd(), fullPath)}`);
        deletedCount++;
      }
    }
  }

  deleteDbFiles(dataDir);

  // Clean up instances directory if it exists
  const instancesDir = path.join(dataDir, 'instances');
  if (fs.existsSync(instancesDir)) {
    try {
      fs.rmSync(instancesDir, { recursive: true, force: true });
      console.log('  📁 Removed instances directory');
    } catch { /* permission issue */ }
  }

  console.log(`\n✅ Reset complete — ${String(deletedCount)} file(s) deleted.`);
  console.log('   Restart the bot to reinitialize with fresh databases.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
