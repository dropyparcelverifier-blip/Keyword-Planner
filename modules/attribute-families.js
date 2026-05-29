// Category-keyed product attribute families.
//
// Each FAMILY is a set of MUTUALLY-EXCLUSIVE value tokens (the values within
// a family describe positions on the same product axis). When the PRODUCT
// asserts one value of a family (its title / type contains the token) and a
// SERP / Amazon row asserts a DIFFERENT value of the same family, that row
// is a different product → hard veto.
//
// Safety property: the gate fires ONLY when the product positively declares
// a family value. If the product is silent on an axis, nothing is vetoed —
// no false positives on generic / informational keywords.
//
// Lookup priority (resolved in keyword-filter.js familiesFor):
//   1. ATTRIBUTE_FAMILIES._global          — applied to every product
//   2. ATTRIBUTE_FAMILIES[product.category] — overlaid by detected category
//   3. BRAND_FAMILY_OVERRIDES[product.brand] — final overlay for brand-specific axes
//
// Tokens may contain spaces ("molecularly distilled", "color treated"). The
// resolver treats them as fixed phrases with word-boundary matching;
// longest match wins so "color-treated" beats "color".
//
// Categories used here must match what `detectCategory` in keyword-filter.js
// returns: supplement / skincare / haircare / bodycare / food / general.
// New categories can be added without code changes — just add a key here.

export const ATTRIBUTE_FAMILIES = {
  // Cross-category axes (none yet). Reserve for SKU dimensions that
  // genuinely cut across categories — e.g. "for adults / for kids" once
  // tuned to not collide with the variant-slot pair.
  _global: {},

  supplement: {
    formulation: [
      'fish oil', 'krill oil', 'cod liver oil', 'salmon oil',
      'algae', 'algal', 'algae oil',
      'vegan', 'plant based', 'plant-based',
    ],
    process: [
      'molecularly distilled', 'concentrated',
      'enteric coated', 'enteric-coated',
      'triple strength', 'double strength', 'extra strength',
      'high potency', 'time release', 'sustained release', 'slow release',
    ],
    flavor: [
      'lemon', 'orange', 'mint', 'unflavored', 'unflavoured',
      'natural flavor', 'natural flavour', 'berry', 'vanilla',
    ],
    form_line: [
      // Product-line modifiers — overlap with the hardcoded
      // _PRODUCT_LINE_MODIFIERS in keyword-filter.js. Kept here too for
      // declarative configurability; either layer firing is fine.
      'ultra', 'super', 'mini', 'kids', 'prenatal', 'sport',
    ],
  },

  skincare: {
    retinoid: [
      'retinol', 'retinal', 'retinaldehyde', 'retinyl', 'bakuchiol',
    ],
    vitc_form: [
      'l-ascorbic acid', 'ascorbic acid',
      'sodium ascorbyl phosphate', 'magnesium ascorbyl phosphate',
      'ethyl ascorbic acid', 'tetrahexyldecyl ascorbate',
    ],
    spf: [
      'spf 15', 'spf 30', 'spf 50', 'spf 50+', 'spf 70', 'spf 100',
    ],
    scent: [
      'fragrance free', 'fragrance-free', 'unscented', 'scented', 'fragranced',
    ],
    skin_type: [
      'oily', 'dry', 'sensitive', 'combination', 'normal',
    ],
  },

  haircare: {
    scent: [
      'fragrance free', 'fragrance-free', 'unscented',
      'lavender', 'rose', 'citrus', 'coconut', 'mint',
    ],
    sulfate: [
      'sulfate free', 'sulphate free', 'sulfate-free', 'sulphate-free',
    ],
    hair_type: [
      'curly', 'straight', 'wavy', 'kinky', 'coily',
      'color treated', 'color-treated', 'colour treated', 'colour-treated',
    ],
  },

  bodycare: {
    scent: [
      'fragrance free', 'fragrance-free', 'unscented',
      'lavender', 'rose', 'citrus', 'sandalwood', 'vanilla',
    ],
  },
};

// Optional per-brand overlays. Merged AFTER the category map, so brand
// overrides win on key collision. Lowercase brand keys.
//
//   'now foods': { formulation: ['fish oil', 'krill oil', ...] }
//
// Use sparingly — the category defaults should cover most cases.
export const BRAND_FAMILY_OVERRIDES = {
  // example placeholder; uncomment / extend as real brand cases arise.
  // 'now foods': {
  //   formulation: ['fish oil', 'krill oil', 'cod liver oil', 'algae'],
  // },
};
