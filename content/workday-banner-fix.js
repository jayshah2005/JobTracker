/**
 * Content script — Workday host-page layout fix only (top frame).
 *
 * Workday career sites render a hero banner `<img data-automation-id="banner">`
 * inside a container whose height is recomputed on every window resize. When
 * the tenant's banner asset is missing (the image 404s), that container is
 * sized to the full viewport width, leaving a huge blank block above the job.
 * Opening the side panel narrows the viewport, so it triggers this every time.
 *
 * Only containers whose banner image actually failed to load are collapsed;
 * working banners are left alone.
 */

(() => {
  if (window !== window.top) return;

  const BANNER_SELECTOR = 'img[data-automation-id="banner"]';
  const COLLAPSED_ATTR = 'data-job-tracker-collapsed-banner';
  let scheduled = false;

  function isBroken(img) {
    return img.complete && img.naturalWidth === 0;
  }

  function collapseBrokenBanners() {
    scheduled = false;
    for (const img of document.querySelectorAll(BANNER_SELECTOR)) {
      const container = img.parentElement;
      if (!container || container === document.body) continue;
      if (isBroken(img)) {
        container.style.setProperty('display', 'none', 'important');
        container.setAttribute(COLLAPSED_ATTR, '1');
      } else if (container.hasAttribute(COLLAPSED_ATTR)) {
        // Image was swapped for one that loads (e.g. SPA navigation).
        container.style.removeProperty('display');
        container.removeAttribute(COLLAPSED_ATTR);
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(collapseBrokenBanners);
  }

  // `error`/`load` don't bubble, but capture-phase listeners on document see them.
  document.addEventListener(
    'error',
    (e) => {
      if (e.target instanceof HTMLImageElement && e.target.matches(BANNER_SELECTOR)) schedule();
    },
    true
  );
  document.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement && e.target.matches(BANNER_SELECTOR)) schedule();
    },
    true
  );

  // React re-renders the banner on navigation and resize; re-check cheaply.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('resize', schedule);
  schedule();
})();
