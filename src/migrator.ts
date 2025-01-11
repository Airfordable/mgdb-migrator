/*
  Adds migration capabilities. Migrations are defined like:

  Migrator.add({
    up: function() {}, //*required* code to run to migrate upwards
    version: 1, //*required* number to identify migration order
    down: function() {}, //*optional* code to run to migrate downwards
    name: 'Something' //*optional* display name for the migration
  });

  The ordering of migrations is determined by the version you set.

  To run the migrations, set the MIGRATE environment variable to either
  'latest' or the version number you want to migrate to.

  e.g:
  MIGRATE="latest"  # ensure we'll be at the latest version and run the app
  MIGRATE="2,rerun"  # re-run the migration at that version

  Note: Migrations will lock ensuring only 1 app can be migrating at once. If
  a migration crashes, the control record in the migrations collection will
  remain locked and at the version it was at previously, however the db could
  be in an inconsistent state.
*/

import assert from 'node:assert';

import * as _ from 'lodash';
import {
  Collection,
  Db,
  MongoClient,
  MongoClientOptions,
  ObjectId,
} from 'mongodb';

export type SyslogLevels =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'crit'
  | 'alert';

export type Logger = (level: SyslogLevels, ...args: unknown[]) => void;

export interface DbProperties {
  connectionUrl: string;
  name?: string;
  options?: MongoClientOptions;
}

interface MigrationControl {
  locked: boolean;
  lockedAt?: Date;
  version: number;
}

export interface MigratorOptions {
  log?: boolean;
  logger?: Logger;
  logIfLatest?: boolean;
  collectionName?: string;
  db: DbProperties | Db;
}
export interface Migration {
  version: number;
  name: string;
  up: (db: Db, logger?: Logger) => Promise<void> | void;
  down: (db: Db, logger?: Logger) => Promise<void> | void;
}

const basicLogger = (level: string, ...args: unknown[]) =>
  // eslint-disable-next-line no-console
  console.log(level, ...args);

export class Migrator {
  private migratorKey = 'control' as unknown as ObjectId;
  private defaultMigration = {
    down: (_db: Db) => Promise.reject(`Can't go down from default`),
    name: 'default',
    up: (_db: Db) => Promise.resolve(),
    version: 0,
  };
  private list: Migration[];

  private dbOrProperties: Db | DbProperties;
  private logger: Logger;
  private logIfLatest: boolean;
  private collectionName: string;

  private _db: Db | undefined;
  private _collection: Collection<MigrationControl> | undefined;

  /**
   * Creates an instance of Migration.
   */
  constructor(opts: MigratorOptions) {
    // Since we'll be at version 0 by default, we should have a migration set for it.
    this.list = [this.defaultMigration];

    this.logIfLatest = opts?.logIfLatest ?? true;
    this.collectionName = opts.collectionName ?? 'migrations';

    this.dbOrProperties = opts.db;
    if (!this.dbOrProperties) {
      throw new ReferenceError('db option must be defined');
    }

    if (opts?.log === false) {
      this.logger = (_level: string, ..._args) => {
        //No-op
        return;
      };
    } else {
      this.logger = opts?.logger ?? basicLogger;
    }
  }

  /**
   * Add a new migration
   */
  public add(migration: Migration): void {
    if (typeof migration.up !== 'function') {
      throw new Error('Migration must supply an up function.');
    }

    if (typeof migration.down !== 'function') {
      throw new Error('Migration must supply a down function.');
    }

    if (typeof migration.version !== 'number') {
      throw new Error('Migration must supply a version number.');
    }

    if (migration.version <= 0) {
      throw new Error('Migration version must be greater than 0');
    }

    // Freeze the migration object to make it hereafter immutable
    Object.freeze(migration);

    this.list.push(migration);
    this.list = _.sortBy(this.list, (m) => m.version);
  }

  /**
   * Run the migrations using command in the form of:
   * @example 'latest' - migrate to latest, 2, '2,rerun'
   * @example 2 - migrate to version 2
   * @example '2,rerun' - if at version 2, re-run up migration
   */
  public async migrateTo(command: string | number): Promise<void> {
    if (_.isUndefined(command) || command === '' || this.list.length === 0) {
      throw new Error('Cannot migrate using invalid command: ' + command);
    }

    let version: string | number;
    let subcommand: string | undefined;
    if (typeof command === 'number') {
      version = command;
    } else {
      version = command.split(',')[0];
      subcommand = command.split(',')[1];
    }

    try {
      if (version === 'latest') {
        // This non-null assertion is safe because we have already checked that
        // list is not empty above.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.execute(_.last(this.list)!.version);
      } else {
        await this.execute(parseInt(version as string), subcommand === 'rerun');
      }
    } catch (e) {
      this.logger(
        'info',
        `Encountered an error while migrating. Migration failed.`
      );
      throw e;
    }
  }

  /**
   * Returns the number of migrations
   */
  public getNumberOfMigrations(): number {
    // Exclude default/base migration v0 since its not a configured migration
    return this.list.length - 1;
  }

  /**
   * Returns the current version
   *
   * @returns {Promise<number>}
   * @memberof Migration
   */
  public async getVersion(): Promise<number> {
    const control = await this.getControl();
    return control.version;
  }

  /**
   * Unlock control
   */
  public async unlock(): Promise<void> {
    const collection = await this.getCollection();
    await collection.updateOne(
      { _id: this.migratorKey },
      { $set: { locked: false } }
    );
  }

  /**
   * Reset migration configuration. This is intended for dev and test mode only. Use wisely
   */
  public async reset(): Promise<void> {
    this.list = [this.defaultMigration];
    const collection = await this.getCollection();
    await collection.deleteMany({});
  }

  /**
   * Migrate to the specific version passed in
   */
  private async execute(version: number, rerun?: boolean): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const control = await this.getControl(); // Side effect: upserts control document.
    let currentVersion = control.version;

    // Returns true if lock was acquired.
    const lock = async () => {
      const collection = await self.getCollection();
      /*
       * This is an atomic op. The op ensures only one caller at a time will match the control
       * object and thus be able to update it.  All other simultaneous callers will not match the
       * object and thus will have null return values in the result of the operation.
       */
      const updateResult = await collection.findOneAndUpdate(
        {
          _id: this.migratorKey,
          locked: false,
        },
        {
          $set: {
            locked: true,
            lockedAt: new Date(),
          },
        },
        { includeResultMetadata: true }
      );

      return null != updateResult.value && 1 === updateResult.ok;
    };

    // Side effect: saves version.
    const unlock = () =>
      self.setControl({
        locked: false,
        version: currentVersion,
      });

    // Side effect: saves version.
    const updateVersion = async () =>
      await self.setControl({
        locked: true,
        version: currentVersion,
      });

    // Run the actual migration
    const migrate = async (direction: 'up' | 'down', idx: number) => {
      const migration = self.list[idx];

      if (typeof migration[direction] !== 'function') {
        unlock();
        throw new Error(
          'Cannot migrate ' + direction + ' on version ' + migration.version
        );
      }

      function maybeName() {
        return migration.name ? ' (' + migration.name + ')' : '';
      }

      this.logger(
        'info',
        'Running ' +
          direction +
          '() on version ' +
          migration.version +
          maybeName()
      );

      const db = await self.getDb();
      await migration[direction](db, this.logger);
    };

    if ((await lock()) === false) {
      this.logger('info', 'Not migrating, control is locked.');
      return;
    }

    if (rerun) {
      this.logger('info', 'Rerunning version ' + version);
      migrate('up', version);
      this.logger('info', 'Finished migrating.');
      await unlock();
      return;
    }

    if (currentVersion === version) {
      if (this.logIfLatest) {
        this.logger('info', 'Not migrating, already at version ' + version);
      }
      await unlock();
      return;
    }

    const startIdx = this.findIndexByVersion(currentVersion);
    const endIdx = this.findIndexByVersion(version);

    // Log.info('startIdx:' + startIdx + ' endIdx:' + endIdx);
    this.logger(
      'info',
      'Migrating from version ' +
        this.list[startIdx].version +
        ' -> ' +
        this.list[endIdx].version
    );

    if (currentVersion < version) {
      for (let i = startIdx; i < endIdx; i++) {
        try {
          await migrate('up', i + 1);
          currentVersion = self.list[i + 1].version;
          await updateVersion();
        } catch (e) {
          const prevVersion = self.list[i].version;
          const destVersion = self.list[i + 1].version;
          this.logger(
            'error',
            `Encountered an error while migrating from ${prevVersion} to ${destVersion}`
          );
          throw e;
        }
      }
    } else {
      for (let i = startIdx; i > endIdx; i--) {
        try {
          await migrate('down', i);
          currentVersion = self.list[i - 1].version;
          await updateVersion();
        } catch (e) {
          const prevVersion = self.list[i].version;
          const destVersion = self.list[i - 1].version;
          this.logger(
            'error',
            `Encountered an error while migrating from ${prevVersion} to ${destVersion}`
          );
          throw e;
        }
      }
    }

    await unlock();
    this.logger('info', 'Finished migrating.');
  }

  /**
   * Gets the current control record, optionally creating it if non-existent
   */
  private async getControl(): Promise<MigrationControl> {
    const collection = await this.getCollection();
    const con = await collection.findOne({ _id: this.migratorKey });
    return (
      con ||
      (await this.setControl({
        locked: false,
        version: 0,
      }))
    );
  }

  /**
   * Set the control record
   */
  private async setControl(
    control: Omit<MigrationControl, 'lockedAt'>
  ): Promise<MigrationControl> {
    // Be quite strict
    assert(control && typeof control === 'object');
    assert(typeof control.version === 'number');
    assert(typeof control.locked === 'boolean');

    const collection = await this.getCollection();
    const updateResult = await collection.updateOne(
      {
        _id: this.migratorKey,
      },
      {
        $set: {
          locked: control.locked,
          version: control.version,
        },
      },
      {
        upsert: true,
      }
    );

    if (updateResult && updateResult.acknowledged) {
      return control;
    } else {
      throw new Error('Failed to set control record');
    }
  }

  /**
   * Returns the migration index in _list or throws if not found
   */
  private findIndexByVersion(version: number): number {
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].version === version) {
        return i;
      }
    }

    throw new Error("Can't find migration version " + version);
  }

  private async getDb(): Promise<Db> {
    if (!this._db) {
      const dbOrProperties = this.dbOrProperties;

      // Check if connectionUrl exists. If it does, assume its IDbProperties object
      if ('connectionUrl' in dbOrProperties) {
        const options = { ...dbOrProperties.options };
        const client = await MongoClient.connect(
          dbOrProperties.connectionUrl,
          options
        );
        // XXX: This never gets disconnected.
        this._db = client.db(dbOrProperties.name);
      } else {
        this._db = dbOrProperties;
      }
    }

    return this._db;
  }

  private async getCollection(): Promise<Collection<MigrationControl>> {
    if (!this._collection) {
      const db = await this.getDb();
      this._collection = db.collection<MigrationControl>(this.collectionName);
    }

    return this._collection;
  }
}
