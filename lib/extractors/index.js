/**
 * Entry point for site-specific extractors.
 *
 * job-extractor.js calls collectAtsCandidates() first: detect.js decides which
 * ATS/job board the page belongs to and the matching collector pushes
 * high-scoring candidates. The general strategies in job-extractor.js then run
 * regardless and fill whatever the ATS collector missed.
 */

import { detectAts } from './detect.js';
import { collectGreenhouse } from './greenhouse.js';
import { collectWorkday } from './workday.js';
import { collectLever } from './lever.js';
import { collectAshby } from './ashby.js';
import { collectSmartRecruiters } from './smartrecruiters.js';
import { collectLinkedIn } from './linkedin.js';
import { collectIndeed } from './indeed.js';

export { detectAts };

/**
 * Run the matching ATS pipeline (if any). Mutates `candidates`.
 * @returns {{ ats: string }} the detectAts() result (ats === 'general' when none matched)
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
    case 'linkedin':
      collectLinkedIn(document, url, candidates, meta);
      break;
    case 'indeed':
      collectIndeed(document, url, candidates, meta);
      break;
    default:
      break;
  }
  return meta;
}
