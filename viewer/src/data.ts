/**
 * The inlined dataset. `data.json` is produced by `scripts/build-data.ts`, which has
 * already validated every trace event against the harness's Zod schema — so by the time
 * the UI sees it, the shape is guaranteed and nothing here re-parses.
 */

import raw from './generated/data.json';
import type { ViewerData } from './derive/model.js';

export const data = raw as unknown as ViewerData;
