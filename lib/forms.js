/**
 * lib/forms.js
 *
 * Smart form filler + listing-URL discovery. Verbatim move from the monolith.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fillForm(page, formFields) {
  for (const [selector, value] of Object.entries(formFields)) {
    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          if (tag === 'select') {
            await el.selectOption({ label: value }).catch(() => el.selectOption(value));
          } else if (type === 'checkbox' || type === 'radio') {
            await el.check();
          } else {
            await el.fill(value);
          }
          filled = true;
          break;
        }
      } catch(_) {}
    }
    if (!filled) {
      const kw = selector.match(/\*="([^"]+)"/)?.[1];
      if (kw) {
        await page.getByLabel(new RegExp(kw, 'i')).first().fill(value).catch(() => {});
      }
    }
  }
}

async function findListingUrl(page, broker) {
  await page.goto(broker.searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(2000);
  const links = await page.evaluate(src => {
    const re = new RegExp(src);
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => re.test(h));
  }, broker.listingPattern.source);
  return links[0] || null;
}

module.exports = { fillForm, findListingUrl };
