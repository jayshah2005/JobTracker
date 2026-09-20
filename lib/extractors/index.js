/**
 * Route to ATS-specific collectors, then fall through to general strategies.
 */

import { detectAts } from './detect.js';
import { collectGreenhouse } from './greenhouse.js';
import { collectWorkday } from './workday.js';
import { collectLever } from './lever.js';
import { collectAshby } from './ashby.js';
import { collectSmartRecruiters } from './smartrecruiters.js';

export { detectAts };

/**
 * Run the matching ATS pipeline (if any). Mutates `candidates`.
 * @returns {{ ats: string }}
 */
export function collectAtsCandidates(document, url, candidates) {
  const meta = detectAts(url, document);
  switch (meta.ats) {
    case 'greenhouse':
      collectGreenhouse(document, url, candidates, meta);
      break;
    case 'workday':
      collectWorkday(document, url, candidates, meta);
      break;
    case 'lever':
      collectLever(document, url, candidates, meta);
      break;
    case 'ashby':
      collectAshby(document, url, candidates, meta);
      break;
    case 'smartrecruiters':
      collectSmartRecruiters(document, url, candidates, meta);
      break;
    default:
      break;
  }
  return meta;
}
