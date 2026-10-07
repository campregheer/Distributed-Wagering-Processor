import { AppDataSource } from './data-source';

async function main(): Promise<void> {
  const action = process.argv[2];

  if (action !== 'up' && action !== 'down') {
    throw new Error('Uso: bun src/database/migrate.ts up|down');
  }

  await AppDataSource.initialize();

  try {
    if (action === 'up') {
      const executed = await AppDataSource.runMigrations();
      console.log(`Migrations aplicadas: ${executed.length}`);
    } else {
      await AppDataSource.undoLastMigration();
      console.log('Última migration revertida.');
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
