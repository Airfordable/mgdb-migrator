/*
 * Copyright (C) Airfordable, Inc. - All Rights Reserved.
 * Unauthorized copying of this file via any medium is strictly prohibited.
 * Proprietary and confidential.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.{int,unit}.{js,ts,jsx,tsx}'],
  },
});
