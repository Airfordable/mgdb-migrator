import { Migrator } from '../index.js';

const dbURL =
  process.env.DBURL || 'mongodb://localhost:27017/mgdb-migrator-test-db';
const mockLogger = jest.fn();

describe('Migration', () => {
  let migrator: Migrator;

  beforeAll(async () => {
    migrator = new Migrator({
      collectionName: '_migration',
      db: { connectionUrl: dbURL },
      log: true,
      logIfLatest: true,
      logger: mockLogger,
    });
    await migrator.config();
  });

  beforeEach(() => {
    migrator.add({
      /* eslint-disable sort-keys */
      version: 1,
      name: 'Version 1',
      up: async (_db) => {
        return;
      },
      down: async (_db) => {
        return;
      },
      /* eslint-enable sort-keys */
    });

    migrator.add({
      /* eslint-disable sort-keys */
      version: 2,
      name: 'Version 2',
      up: async (_db) => {
        return;
      },
      down: async (_db) => {
        return;
      },
      /* eslint-enable sort-keys */
    });
  });

  afterEach(async () => {
    await migrator.reset();
  });

  describe('#migrateTo', () => {
    test('1 from 0, should migrate to v1', async () => {
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);
      await migrator.migrateTo(1);
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(1);
    });

    test('2 from 0, should migrate to v2', async () => {
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);
      await migrator.migrateTo(2);
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(2);
    });

    test(`'latest' from 0, should migrate to v2`, async () => {
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);
      await migrator.migrateTo('latest');
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(2);
    });

    test('from 2 to 1, should migrate to v1', async () => {
      await migrator.migrateTo('2');
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(2);

      await migrator.migrateTo(1);
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(1);
    });

    test('from 2 to 0, should migrate to v0', async () => {
      await migrator.migrateTo('2');
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(2);

      await migrator.migrateTo(0);
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);
    });

    test('rerun 0 to 0, should migrate to v0', async () => {
      let currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);

      await migrator.migrateTo('0,rerun');
      currentVersion = await migrator.getVersion();
      expect(currentVersion).toBe(0);
    });

    describe('Executes async up() & down() as expected', () => {
      beforeEach(() => {
        migrator.add({
          /* eslint-disable sort-keys */
          version: 3,
          name: 'Version 3.',
          up: async (_db) => {
            return;
          },
          down: async (_db) => {
            return;
          },
          /* eslint-enable sort-keys */
        });

        migrator.add({
          /* eslint-disable sort-keys */
          version: 4,
          name: 'Version 4',
          up: async (_db) => {
            return;
          },
          down: async (_db) => {
            return;
          },
          /* eslint-enable sort-keys */
        });
      });

      test('from 0 to 3, should migrate to v3', async () => {
        let currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(0);
        await migrator.migrateTo(3);
        currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(3);
      });

      test('from 0 to 4, should migrate to v4', async () => {
        let currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(0);
        await migrator.migrateTo(4);
        currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(4);
      });
    });

    describe('Throws an Error when expected', () => {
      beforeEach(() => {
        migrator.add({
          /* eslint-disable sort-keys */
          version: 3,
          name: 'Version 3.',
          up: async (_db) => {
            return;
          },
          down: async (_db) => {
            return;
          },
          /* eslint-enable sort-keys */
        });

        migrator.add({
          /* eslint-disable sort-keys */
          version: 4,
          name: 'Version 4.',
          up: async (_db) => {
            return;
          },
          down: async (_db) => {
            throw new Error('Something went wrong');
          },
          /* eslint-enable sort-keys */
        });

        migrator.add({
          /* eslint-disable sort-keys */
          version: 5,
          name: 'Version 5.',
          up: async (_db) => {
            throw new Error('Something went wrong');
          },
          down: async (_db) => {
            return;
          },
          /* eslint-enable sort-keys */
        });
      });

      test('from 0 to 5, should stop migration at v4 due to error from v4 to v5', async () => {
        let currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(0);
        try {
          await migrator.migrateTo(5);
        } catch (e) {
          expect(e).toBeTruthy();
          expect(e).toBeInstanceOf(Error);
        }
        currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(4);
      });

      test('from 4 to 3, should stop migration at 4 due to error from v4 to v3', async () => {
        await migrator.migrateTo(4);
        let currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(4);
        try {
          await migrator.migrateTo(3);
        } catch (e) {
          expect(e).toBeTruthy();
          expect(e).toBeInstanceOf(Error);
        }
        currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(4);
      });
    });

    describe('Executes migrations with right callback params', () => {
      let mockedUpFunc;
      let mockedDownFunc;
      beforeEach(() => {
        mockedUpFunc = jest.fn();
        mockedDownFunc = jest.fn();
        migrator.add({
          /* eslint-disable sort-keys */
          version: 3,
          name: 'Version 3.',
          up: mockedUpFunc,
          down: mockedDownFunc,
          /* eslint-enable sort-keys */
        });
      });

      test('up() on v3 is executed with the right params', async () => {
        // eslint-disable-next-line no-debugger
        debugger;
        await migrator.migrateTo(3);
        const currentVersion = await migrator.getVersion();
        // eslint-disable-next-line no-debugger
        debugger;
        expect(currentVersion).toBe(3);
        expect(mockedUpFunc.mock.calls.length).toEqual(1);
        expect(mockedUpFunc.mock.calls[0].length).toEqual(2);
        expect(mockedUpFunc.mock.calls[0][1]).toStrictEqual(mockLogger);
      });

      test('down() on v3 is executed with the right params', async () => {
        await migrator.migrateTo(3);
        let currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(3);
        await migrator.migrateTo(2);
        currentVersion = await migrator.getVersion();
        expect(currentVersion).toBe(2);
        expect(mockedDownFunc.mock.calls.length).toEqual(1);
        expect(mockedDownFunc.mock.calls[0].length).toEqual(2);
        expect(mockedDownFunc.mock.calls[0][1]).toStrictEqual(mockLogger);
      });
    });
  });
});
