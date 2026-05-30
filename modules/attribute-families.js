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

  // dropy.in carries broader retail categories beyond supplements / beauty.
  // The auto-derived raw-token discriminator (in checkSiblingAmbiguity)
  // handles the bulk of distinctions universally — these families are the
  // precision overlay where one exists.
  food: {
    flavor: [
      'chocolate', 'vanilla', 'strawberry', 'mango', 'apple', 'orange',
      'lemon', 'mint', 'caramel', 'coffee', 'matcha', 'unflavored',
      'unflavoured', 'plain',
    ],
    diet: [
      'sugar free', 'sugar-free', 'gluten free', 'gluten-free',
      'vegan', 'keto', 'high protein', 'low carb', 'low-carb',
    ],
  },

  electronics: {
    connectivity: [
      'wired', 'wireless', 'bluetooth', 'wifi', 'wi-fi',
      'usb-c', 'usb c', 'lightning', 'micro usb', 'micro-usb',
    ],
    series: [
      'pro', 'plus', 'ultra', 'max', 'mini', 'lite', 'air',
      'fe', 'se', 'a-series', 'm-series', 'rog', 'thinkpad',
    ],
    refresh: [
      '60hz', '90hz', '120hz', '144hz', '165hz', '240hz',
    ],
    chip: [
      // example: Apple chips by generation, Snapdragon tiers, Intel cores
      'm1', 'm2', 'm3', 'm4', 'a15', 'a16', 'a17 pro',
      'snapdragon 8 gen 2', 'snapdragon 8 gen 3',
      'intel i5', 'intel i7', 'intel i9', 'ryzen 5', 'ryzen 7', 'ryzen 9',
    ],
  },

  baby: {
    stage: [
      'newborn', 'infant', 'toddler', 'preschool',
      'stage 1', 'stage 2', 'stage 3', 'stage 4',
      '0-3 months', '3-6 months', '6-9 months', '6-12 months', '9-12 months',
      '12-18 months', '12-24 months', '18-24 months', '2-3 years',
    ],
    size: [
      'newborn', 'nb', 'preemie',
      'small', 'medium', 'large', 'xl', 'xxl', 'xs',
      'size 1', 'size 2', 'size 3', 'size 4', 'size 5', 'size 6', 'size 7',
    ],
    formula_type: [
      'whey', 'casein', 'soy', 'goat milk', 'hypoallergenic',
      'sensitive', 'gentle', 'anti-reflux', 'thickened',
    ],
  },

  toys: {
    age_range: [
      '0-2', '0-3', '3+', '3-5', '5+', '6+', '8+', '10+', '12+', '14+',
      '0-2 years', '3-5 years', '6-8 years', '9-12 years',
      'infant', 'toddler', 'preschool', 'school age', 'teen',
    ],
    type: [
      'plush', 'doll', 'figure', 'action figure', 'vehicle', 'puzzle',
      'board game', 'card game', 'building', 'building blocks', 'lego',
      'remote control', 'rc', 'educational', 'musical', 'electronic',
      'wooden', 'plastic',
    ],
  },

  household: {
    scent: [
      'fragrance free', 'fragrance-free', 'unscented',
      'lavender', 'rose', 'citrus', 'lemon', 'pine', 'fresh',
      'ocean', 'spring', 'eucalyptus',
    ],
    form: [
      'liquid', 'powder', 'pods', 'tablet', 'tablets', 'spray', 'wipes',
      'capsules', 'bar', 'foam', 'gel', 'cream', 'concentrate',
    ],
    surface: [
      'glass', 'wood', 'stone', 'marble', 'leather', 'fabric',
      'carpet', 'tile', 'stainless steel', 'oven', 'bathroom', 'kitchen',
    ],
  },

  automotive: {
    fluid_grade: [
      // common engine-oil / fluid grades
      '0w-20', '5w-20', '5w-30', '5w-40', '10w-30', '10w-40', '15w-40',
      '20w-50', '75w-90', '80w-90', '85w-140', 'atf', 'dexron',
    ],
    fuel_type: [
      'gasoline', 'petrol', 'diesel', 'electric', 'hybrid',
    ],
    fitment: [
      // universal, OEM-style, aftermarket — broad fitment language
      'universal', 'oem', 'aftermarket',
    ],
  },

  videogames: {
    platform: [
      'pc', 'ps5', 'ps4', 'playstation 5', 'playstation 4',
      'xbox series x', 'xbox series s', 'xbox one',
      'nintendo switch', 'switch', 'switch oled',
      'steam', 'epic', 'cloud',
    ],
    edition: [
      'standard', 'deluxe', 'collector', "collector's", 'gold',
      'ultimate', 'gold edition', 'goty', 'game of the year',
      'legendary', 'royal',
    ],
  },

  books: {
    format: [
      'paperback', 'hardcover', 'hardback', 'mass market',
      'kindle', 'ebook', 'e-book', 'audiobook', 'large print',
    ],
    edition: [
      'first edition', '1st edition', 'second edition', 'revised',
      'updated', 'annotated', 'illustrated', "collector's",
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
