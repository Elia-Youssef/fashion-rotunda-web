import { readFileSync, writeFileSync } from 'node:fs';

import { shippedJson } from './manifest.mjs';

/** ASCII's highest code point, used before the JSON writer can escape invalid copy. */
const ASCII_MAX_CODE_POINT = 0x7f;

function isAscii(text) {
  return [...text].every((character) => character.codePointAt(0) <= ASCII_MAX_CODE_POINT);
}

/** Catalogue copy and the historical source for each look, independent of export wording. */
export const LOOK_TEXT = {
  'wallis-dress': {
    description:
      'Wallis Simpson wore this wedding ensemble by the American designer Mainbocher when she married ' +
      'the Duke of Windsor, the former King Edward VIII, at the Chateau de Cande in France on June 3, ' +
      '1937. Edward had abdicated in December 1936 so that he could marry her. Its silk was dyed a ' +
      'color created for her, Wallis blue, but the dye has since faded.',
    sourceUrl: 'https://www.metmuseum.org/perspectives/designer-archives',
  },
  'zoot-suit': {
    description:
      'The zoot suit paired a thigh-length jacket with wide padded shoulders and broad lapels with ' +
      'high-waisted, full-legged trousers that narrowed to tight cuffs. It first caught on among young ' +
      'Black men in Harlem in the 1930s, then spread to Mexican American and Filipino American youth ' +
      'in the West. After 1942 wool limits, many white Americans saw it as unpatriotic, and it became ' +
      'the target of the 1943 Zoot Suit Riots in Los Angeles.',
    sourceUrl: 'https://www.britannica.com/topic/zoot-suit-clothing',
  },
  'new-look-dress': {
    description:
      'Christian Dior showed his first collection in Paris in spring 1947 and introduced the ' +
      'silhouette known as the New Look. Its rounded shoulders, small cinched waist, emphasized hips ' +
      'and very full skirt broke with the uniforms, restrictions and shortages of the war years. Its ' +
      'success helped postwar Paris regain its standing as the capital of fashion.',
    sourceUrl: 'https://www.metmuseum.org/essays/christian-dior-1905-1957',
  },
  'mondrian-dress': {
    description:
      'Yves Saint Laurent showed his Mondrian dresses in his fall/winter 1965-66 collection, after ' +
      'reading a book about the painter Piet Mondrian that year. Each wool jersey shift is pieced ' +
      'from separate blocks of color, and all of its shaping is hidden in the seams of the grid. The ' +
      'dresses brought wide attention to both designer and painter, and mass manufacturers soon copied them.',
    sourceUrl: 'https://www.metmuseum.org/art/collection/search/83442',
  },
  'jumpsuit-dress': {
    description:
      'This evening jumpsuit is cut in light chiffon, with wide palazzo-style legs. Evening jumpsuits ' +
      'of this kind belong to the late 1960s and 1970s, when long, fluid lines replaced the short ' +
      "A-line mini and trousers became a regular part of women's wardrobes. Emilio Pucci's silk " +
      'jersey pyjama dress of about 1968, now in the V&A, is an early example.',
    sourceUrl: 'https://collections.vam.ac.uk/item/O143333/pyjama-dress-pucci-emilio/',
  },
  'blue-silk-dress': {
    description:
      'This royal blue evening gown recalls one from the 1920s made of silk chiffon set with lace, ' +
      'with handkerchief panels over a crepe de chine lining. That gown belonged to Carrie Chapman ' +
      "Catt (1859-1947), who led the American women's suffrage movement to the Nineteenth Amendment " +
      'in 1920, and she owned it during years of travel for suffrage and the League of Nations.',
    sourceUrl: 'https://costumes.unc.edu/costar/view/Costar/garment.jsp?id=4168',
  },
  'geoffrey-beene': {
    description:
      'This evening gown and jacket by the American designer Geoffrey Beene date from the 1980s ' +
      'and come from the private collection of Iris Barrel Apfel. Beene founded his label in 1963. ' +
      'After the structured, architectural dresses of his early years, he turned to softly draped, ' +
      'loosely constructed clothes in lighter fabrics that suggested the body instead of gripping it.',
    sourceUrl: 'https://digimuse.westphal.drexel.edu/ddm/',
  },
};

/** Validate the whole identity set before replacing any text or writing any files. */
export function validateLookText(looks, text = LOOK_TEXT) {
  const ids = new Set();
  for (const look of looks) {
    if (ids.has(look.id)) throw new Error(`Catalogue repeats look "${look.id}"`);
    ids.add(look.id);
    if (!Object.hasOwn(text, look.id)) throw new Error(`Catalogue text missing look "${look.id}"`);
  }
  for (const [id, entry] of Object.entries(text)) {
    if (!ids.has(id)) throw new Error(`Catalogue text names unknown look "${id}"`);
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      throw new Error(`Catalogue text for "${id}" must have a non-empty description`);
    }
    if (!isAscii(entry.description)) {
      throw new Error(`Catalogue text for "${id}" must be ASCII`);
    }
    let url;
    try {
      url = new URL(entry.sourceUrl);
    } catch {
      throw new Error(`Catalogue source for "${id}" must be an HTTPS URL`);
    }
    if (typeof entry.sourceUrl !== 'string' || !entry.sourceUrl.startsWith('https://') ||
        url.protocol !== 'https:') {
      throw new Error(`Catalogue source for "${id}" must be an HTTPS URL`);
    }
    if (!isAscii(entry.sourceUrl)) {
      throw new Error(`Catalogue source for "${id}" must be ASCII`);
    }
  }
}

/** All other look metadata survives unchanged, including future pipeline fields. */
export function applyLookText(looks, text = LOOK_TEXT) {
  validateLookText(looks, text);
  return looks.map((look) => ({ ...look, ...text[look.id] }));
}

/** Refresh catalogue copy without re-encoding geometry, textures, thumbnails or the manifest. */
export function writeCatalogTexts(paths) {
  const outputs = paths.map((path) => {
    const catalog = JSON.parse(readFileSync(path, 'utf8'));
    return { path, contents: shippedJson({ ...catalog, looks: applyLookText(catalog.looks) }) };
  });
  for (const { path, contents } of outputs) writeFileSync(path, contents);
}
