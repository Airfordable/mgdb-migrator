import {
  Logger,
  MigratorOptions,
  Migration,
  Migrator,
  SyslogLevels,
} from './migrator';

const migrator = new Migrator();

if (process.env.MIGRATE) {
  migrator.migrateTo(process.env.MIGRATE);
}

export { Logger, migrator, Migrator, Migration, MigratorOptions, SyslogLevels };
