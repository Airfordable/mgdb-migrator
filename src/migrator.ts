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

export class Migrator {
  private migratorKey = 'control' as unknown as ObjectId;
  private defaultMigration = {
    down: (_db: Db) => Promise.reject(`Can't go down from default`),
    name: 'default',
    up: (_db: Db) => Promise.resolve(),
    version: 0,
  };
  private list: Migration[];
  private collection: Collection<MigrationControl>;
  private db: Db;
  private options: MigratorOptions;

  /**
   * Creates an instance of Migration.
   * @param {MigratorOptions} [opts]
   * @memberof Migration
   */
  constructor(opts?: MigratorOptions) {
    // Since we'll be at version 0 by default, we should have a migration set for it.
    this.list = [this.defaultMigration];
    this.options =
      opts ? opts : (
        {
          // Migrations collection name
          collectionName: 'migrations',
          // Mongdb url or mongo Db instance
          db: null,
          // False disables logging
          log: true,
          // Enable/disable info log "already at latest."
          logIfLatest: true,
          // Null or a function
          logger: null,
        }
      );
  }

  /**
   * Configure migration
   *
   * @param {MigratorOptions} [opts]
   * @returns {Promise<void>}
   * @memberof Migration
   */
  public async config(opts?: MigratorOptions): Promise<void> {
    this.options = Object.assign({}, this.options, opts);

    if (!this.options.logger && this.options.log) {
      this.options.logger = (level: string, ...args) =>
        // eslint-disable-next-line no-console
        console.log(level, ...args);
    }

    if (this.options.log === false) {
      this.options.logger = (_level: string, ..._args) => {
        //No-op
        return;
      };
    }

    let db: DbProperties | Db = this.options.db || this.db;
    if (!db) {
      throw new ReferenceError('db option must be defined');
    }

    // Check if connectionUrl exists. If it does, assume its IDbProperties object
    if ((db as DbProperties).connectionUrl) {
      const dbProps = db as DbProperties;
      const options = { ...dbProps.options };
      const client = await MongoClient.connect(dbProps.connectionUrl, options);
      // XXX: This never gets disconnected.
      db = client.db(dbProps.name);
    }
    this.collection = (db as Db).collection<MigrationControl>(
      this.options.collectionName
    );
    this.db = db as Db;
  }

  /**
   * Add a new migration
   *
   * @param {Migration} migration
   * @memberof Migrator
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
    if (!this.db) {
      throw new Error(
        'Migration instance has not be configured/initialized.' +
          ' Call <instance>.config(..) to initialize this instance'
      );
    }

    if (_.isUndefined(command) || command === '' || this.list.length === 0) {
      throw new Error('Cannot migrate using invalid command: ' + command);
    }

    let version: string | number;
    let subcommand: string;
    if (typeof command === 'number') {
      version = command;
    } else {
      version = command.split(',')[0];
      subcommand = command.split(',')[1];
    }

    try {
      if (version === 'latest') {
        await this.execute(_.last(this.list).version);
      } else {
        await this.execute(
          parseInt(version as string, null),
          subcommand === 'rerun'
        );
      }
    } catch (e) {
      this.options.logger(
        'info',
        `Encountered an error while migrating. Migration failed.`
      );
      throw e;
    }
  }

  /**
   * Returns the number of migrations
   *
   * @returns {number}
   * @memberof Migration
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
   *
   * @memberof Migration
   */
  public unlock(): void {
    this.collection.updateOne(
      { _id: this.migratorKey },
      { $set: { locked: false } }
    );
  }

  /**
   * Reset migration configuration. This is intended for dev and test mode only. Use wisely
   *
   * @returns {Promise<void>}
   * @memberof Migration
   */
  public async reset(): Promise<void> {
    this.list = [this.defaultMigration];
    await this.collection.deleteMany({});
  }

  /**
   * Migrate to the specific version passed in
   *
   * @private
   * @param {*} version
   * @param {*} [rerun]
   * @returns {Promise<void>}
   * @memberof Migration
   */
  private async execute(version: number, rerun?: boolean): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const control = await this.getControl(); // Side effect: upserts control document.
    let currentVersion = control.version;

    // Returns true if lock was acquired.
    const lock = async () => {
      /*
       * This is an atomic op. The op ensures only one caller at a time will match the control
       * object and thus be able to update it.  All other simultaneous callers will not match the
       * object and thus will have null return values in the result of the operation.
       */
      const updateResult = await self.collection.findOneAndUpdate(
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
    const migrate = async (direction, idx) => {
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

      this.options.logger(
        'info',
        'Running ' +
          direction +
          '() on version ' +
          migration.version +
          maybeName()
      );

      await migration[direction](self.db, this.options.logger);
    };

    if ((await lock()) === false) {
      this.options.logger('info', 'Not migrating, control is locked.');
      return;
    }

    if (rerun) {
      this.options.logger('info', 'Rerunning version ' + version);
      migrate('up', version);
      this.options.logger('info', 'Finished migrating.');
      await unlock();
      return;
    }

    if (currentVersion === version) {
      if (this.options.logIfLatest) {
        this.options.logger(
          'info',
          'Not migrating, already at version ' + version
        );
      }
      await unlock();
      return;
    }

    const startIdx = this.findIndexByVersion(currentVersion);
    const endIdx = this.findIndexByVersion(version);

    // Log.info('startIdx:' + startIdx + ' endIdx:' + endIdx);
    this.options.logger(
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
          this.options.logger(
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
          this.options.logger(
            'error',
            `Encountered an error while migrating from ${prevVersion} to ${destVersion}`
          );
          throw e;
        }
      }
    }

    await unlock();
    this.options.logger('info', 'Finished migrating.');
  }

  /**
   * Gets the current control record, optionally creating it if non-existant
   *
   * @private
   * @returns {Promise<{ version: number, locked: boolean }>}
   * @memberof Migration
   */
  private async getControl(): Promise<MigrationControl> {
    const con = await this.collection.findOne({ _id: this.migratorKey });
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
   *
   * @private
   * @param {{ version: number, locked: boolean }} control
   * @returns {(Promise<{ version: number, locked: boolean } | null>)}
   * @memberof Migration
   */
  private async setControl(control: {
    version: number;
    locked: boolean;
  }): Promise<{ version: number; locked: boolean } | null> {
    // Be quite strict
    assert(control && typeof control === 'object');
    assert(typeof control.version === 'number');
    assert(typeof control.locked === 'boolean');

    const updateResult = await this.collection.updateOne(
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
      return null;
    }
  }

  /**
   * Returns the migration index in _list or throws if not found
   *
   * @private
   * @param {any} version
   * @returns {number}
   * @memberof Migration
   */
  private findIndexByVersion(version): number {
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].version === version) {
        return i;
      }
    }

    throw new Error("Can't find migration version " + version);
  }
}
