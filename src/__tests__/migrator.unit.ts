import { Migrator } from '../index.js';

describe('Migrator', () => {
  describe('#setControl', () => {
    it('should throw if the argument is not an object', async () => {
      const migrator = new Migrator();

      const promise = migrator['setControl'](
        // @ts-expect-error -- intentionally passing the wrong type
        ''
      );
      await expect(promise).rejects.toThrow();
      await expect(promise).rejects.not.toThrow('updateOne');
    });

    it('should throw if control.version is not a number', () => {
      const migrator = new Migrator();

      const promise = migrator['setControl'](
        // @ts-expect-error -- intentionally passing the wrong type
        { version: '1' }
      );
      expect(promise).rejects.toThrow();
      expect(promise).rejects.not.toThrow('updateOne');
    });

    it('should throw if control.locked is not a boolean', () => {
      const migrator = new Migrator();

      const promise = migrator['setControl'](
        // @ts-expect-error -- intentionally passing the wrong type
        { locked: 'true' }
      );
      expect(promise).rejects.toThrow();
      expect(promise).rejects.not.toThrow('updateOne');
    });
  });
});
