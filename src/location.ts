// Heuristic UK-location detection for GitHub's free-text `location` field.
// Rule: keep a user if their location is EMPTY or looks like the UK; drop
// clearly-foreign locations.
//
// Matching order matters. It runs in three tiers, strongest evidence first:
//   1. DEFINITIVE UK — a country name, a UK postcode, or a multi-word county.
//      Nothing outside the UK is called "County Durham" or sits in "DH1 3LE".
//   2. FOREIGN — an explicit country, US state (name or abbreviation), or
//      Canadian province. Wins over tier 3.
//   3. AMBIGUOUS UK — a bare county or city name. These are homonym-prone
//      (Durham, Boston, Kent, Surrey, Manchester all exist in North America),
//      so they only count once tier 2 has ruled out a foreign qualifier.
//
// Tiers 1 and 2 must stay ahead of tier 3: a bare "Durham" is UK, but
// "Durham, NC" is not, and the county name alone cannot tell them apart.
//   "Durham"               -> UK (county)     "Durham, NC"      -> foreign (US state)
//   "Boston, Lincolnshire" -> UK (county)     "Boston, MA"      -> foreign (US state)
//   "Birmingham, UK"       -> UK (country)    "Birmingham, AL"  -> foreign (US state)
//   "County Durham"        -> UK (county)     "London, Ontario" -> foreign (CA province)

import { readFileSync, existsSync } from 'node:fs';

// The four nations + the common shorthands people type.
const NATION_SINGLE = new Set([
  'uk', 'u.k.', 'gb', 'britain', 'england', 'scotland', 'wales', 'cymru',
  'english', 'scottish', 'welsh', 'british',
]);

const NATION_MULTIWORD = [
  'united kingdom', 'great britain', 'northern ireland', 'u. k.',
  'england, uk', 'the uk',
];

// Counties / regions — a strong UK signal on their own.
const COUNTY_SINGLE = new Set([
  'bedfordshire', 'berkshire', 'buckinghamshire', 'cambridgeshire', 'cheshire',
  'cornwall', 'cumbria', 'derbyshire', 'devon', 'dorset', 'durham', 'essex',
  'gloucestershire', 'hampshire', 'herefordshire', 'hertfordshire', 'kent',
  'lancashire', 'leicestershire', 'lincolnshire', 'merseyside', 'norfolk',
  'northamptonshire', 'northumberland', 'nottinghamshire', 'oxfordshire',
  'rutland', 'shropshire', 'somerset', 'staffordshire', 'suffolk', 'surrey',
  'warwickshire', 'wiltshire', 'worcestershire', 'yorkshire', 'midlands',
  'anglesey', 'ceredigion', 'conwy', 'denbighshire', 'flintshire', 'gwynedd',
  'monmouthshire', 'pembrokeshire', 'powys', 'wrexham', 'clwyd', 'dyfed',
  'gwent', 'glamorgan', 'aberdeenshire', 'angus', 'argyll', 'ayrshire',
  'clackmannanshire', 'dumfriesshire', 'fife', 'inverness-shire', 'lanarkshire',
  'lothian', 'midlothian', 'moray', 'perthshire', 'renfrewshire',
  'stirlingshire', 'antrim', 'armagh', 'fermanagh', 'londonderry', 'tyrone',
]);

const COUNTY_MULTIWORD = [
  'east sussex', 'west sussex', 'north yorkshire', 'south yorkshire',
  'west yorkshire', 'east yorkshire', 'west midlands', 'east midlands',
  'greater london', 'greater manchester', 'tyne and wear', 'isle of wight',
  'isle of man', 'channel islands', 'county durham', 'east anglia',
  'north west england', 'south east england', 'south west england',
  'north east england', 'home counties', 'scottish highlands',
  'vale of glamorgan', 'north lanarkshire', 'south lanarkshire',
  'east lothian', 'west lothian', 'dumfries and galloway',
];

const UK_COUNTRY_SUBSTR = [
  'united kingdom', 'great britain', 'u.k.', 'u. k.',
];

// Major UK cities + tech hubs. Extend at runtime via data/uk-cities.txt.
const UK_CITIES = new Set<string>([
  'london', 'birmingham', 'manchester', 'leeds', 'glasgow', 'liverpool',
  'newcastle', 'newcastle upon tyne', 'sheffield', 'bristol', 'belfast',
  'edinburgh', 'cardiff', 'nottingham', 'leicester', 'coventry', 'bradford',
  'stoke-on-trent', 'stoke on trent', 'wolverhampton', 'plymouth',
  'southampton', 'reading', 'derby', 'portsmouth', 'brighton',
  'brighton and hove', 'hull', 'kingston upon hull', 'preston', 'luton',
  'milton keynes', 'northampton', 'norwich', 'swindon', 'oxford', 'cambridge',
  'york', 'bath', 'exeter', 'gloucester', 'ipswich', 'peterborough', 'slough',
  'watford', 'basildon', 'bournemouth', 'poole', 'blackpool', 'blackburn',
  'bolton', 'stockport', 'oldham', 'rochdale', 'salford', 'wigan', 'warrington',
  'huddersfield', 'wakefield', 'doncaster', 'rotherham', 'barnsley',
  'sunderland', 'middlesbrough', 'darlington', 'carlisle', 'lancaster',
  'chester', 'crewe', 'shrewsbury', 'telford', 'worcester', 'hereford',
  'cheltenham', 'swansea', 'newport', 'aberdeen', 'dundee', 'stirling',
  'inverness', 'perth', 'paisley', 'livingston', 'derry', 'lisburn',
  'st albans', 'st. albans', 'chelmsford', 'colchester', 'southend',
  'southend-on-sea', 'maidstone', 'canterbury', 'guildford', 'woking',
  'crawley', 'eastbourne', 'hastings', 'worthing', 'basingstoke', 'winchester',
  'salisbury', 'truro', 'torquay', 'lincoln', 'grimsby', 'scunthorpe',
  'mansfield', 'chesterfield', 'burnley', 'bury', 'halifax', 'harrogate',
  'scarborough', 'redditch', 'solihull', 'walsall', 'dudley', 'west bromwich',
  'sutton coldfield', 'stevenage', 'harlow', 'hemel hempstead', 'high wycombe',
  'aylesbury', 'bracknell', 'farnborough', 'newbury', 'hatfield', 'welwyn',
  'croydon', 'wimbledon', 'shoreditch', 'canary wharf', 'westminster',
  'camden', 'islington', 'hackney', 'greenwich', 'richmond upon thames',
  'kingston upon thames', 'ealing', 'wembley', 'stratford', 'silicon roundabout',
]);

const FOREIGN_SINGLE = new Set([
  // countries
  'usa', 'us', 'america', 'canada', 'mexico', 'brazil', 'argentina', 'chile',
  'colombia', 'peru', 'venezuela', 'ecuador', 'uruguay', 'bolivia', 'paraguay',
  'ireland', 'eire', 'france', 'germany', 'spain', 'portugal', 'italy',
  'netherlands', 'holland', 'belgium', 'switzerland', 'austria', 'sweden',
  'norway', 'denmark', 'finland', 'iceland', 'poland', 'ukraine', 'russia',
  'romania', 'bulgaria', 'hungary', 'greece', 'turkey', 'serbia', 'croatia',
  'slovakia', 'slovenia', 'lithuania', 'latvia', 'estonia', 'belarus', 'india',
  'pakistan', 'bangladesh', 'nepal', 'china', 'japan', 'korea', 'vietnam',
  'thailand', 'indonesia', 'malaysia', 'singapore', 'philippines', 'taiwan',
  'australia', 'zealand', 'egypt', 'nigeria', 'kenya', 'ghana', 'ethiopia',
  'morocco', 'algeria', 'tunisia', 'israel', 'iran', 'iraq', 'lebanon',
  'jordan', 'kuwait', 'qatar', 'bahrain', 'oman', 'afghanistan', 'kazakhstan',
  'uzbekistan', 'azerbaijan', 'armenia', 'cambodia', 'myanmar', 'laos',
  'mongolia', 'srilanka', 'cuba', 'jamaica', 'panama', 'guatemala', 'honduras',
  'nicaragua', 'costa', 'europe', 'asia', 'africa',
  // US states (single-word) — the biggest source of homonym confusion
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'tennessee',
  'texas', 'utah', 'vermont', 'virginia', 'wisconsin', 'wyoming',
  // unambiguous foreign cities (no notable UK homonyms)
  'tokyo', 'seoul', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'mumbai',
  'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'kolkata', 'pune', 'delhi',
  'karachi', 'lahore', 'dhaka', 'jakarta', 'bangkok', 'hanoi', 'istanbul',
  'tehran', 'baghdad', 'riyadh', 'jeddah', 'nairobi', 'lagos', 'johannesburg',
  'toronto', 'montreal', 'ottawa', 'calgary', 'edmonton', 'winnipeg', 'munich',
  'frankfurt', 'hamburg', 'stuttgart', 'cologne', 'lyon', 'marseille',
  'barcelona', 'lisbon', 'zurich', 'geneva', 'copenhagen', 'stockholm', 'oslo',
  'helsinki', 'warsaw', 'krakow', 'prague', 'budapest', 'bucharest', 'sofia',
  'kyiv', 'kiev', 'minsk', 'sydney', 'melbourne', 'brisbane', 'perth',
  'auckland', 'wellington', 'sao', 'medellin', 'bogota', 'guadalajara',
  'dublin', 'cork', 'galway', 'amsterdam', 'rotterdam', 'brussels', 'vienna',
  'madrid', 'milan', 'rome', 'naples', 'berlin', 'paris', 'nyc', 'sf',
  'seattle', 'chicago', 'houston', 'dallas', 'austin', 'denver', 'atlanta',
  'philadelphia', 'phoenix', 'miami', 'brooklyn', 'manhattan',
]);

const FOREIGN_MULTIWORD = [
  'united states', 'united states of america', 'u.s.a', 'u. s. a', 'u.s.',
  'new york', 'new jersey', 'new mexico', 'new hampshire', 'north carolina',
  'south carolina', 'north dakota', 'south dakota', 'west virginia',
  'rhode island', 'district of columbia', 'washington dc', 'washington, dc',
  'san francisco', 'los angeles', 'san diego', 'san jose', 'silicon valley',
  'bay area', 'las vegas', 'new orleans', 'salt lake city', 'palo alto',
  'mountain view', 'menlo park', 'new zealand', 'south korea', 'north korea',
  'south africa', 'saudi arabia', 'united arab emirates', 'hong kong',
  'costa rica', 'el salvador', 'dominican republic', 'puerto rico', 'sri lanka',
  'czech republic', 'sao paulo', 'rio de janeiro', 'buenos aires', 'mexico city',
  'ho chi minh', 'kuala lumpur', 'tel aviv', 'abu dhabi', 'south america',
  'latin america', 'republic of ireland',
];

// Canadian provinces — "London, Ontario" and "Surrey, BC" are the common traps.
const CA_PROVINCE_SINGLE = new Set([
  'ontario', 'quebec', 'québec', 'alberta', 'manitoba', 'saskatchewan',
  'newfoundland', 'labrador', 'yukon', 'nunavut',
]);

const CA_PROVINCE_MULTIWORD = [
  'british columbia', 'nova scotia', 'new brunswick', 'prince edward island',
  'northwest territories',
];

// Province abbreviations, matched only as a standalone segment ("Surrey, BC").
const CA_PROVINCE_ABBR = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

// US state abbreviations, matched as a standalone segment ("Boston, MA").
const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Abbreviations that are also ordinary words ("Co. Durham", "Kingston, Ont" ->
// "on"), or common in non-US addresses. Safe as a comma-delimited segment, NOT
// safe as a loose word, so word-level matching skips them.
const ABBR_AMBIGUOUS_AS_WORD = new Set([
  'al', 'ca', 'co', 'de', 'hi', 'id', 'in', 'la', 'me', 'ms', 'oh', 'ok', 'or',
  'pa', 'on', 'ne', 'nt', 'nu', 'pe',
]);

// Abbreviations safe to match without a comma, so "Durham NC 27705" is caught.
const US_STATE_ABBR_WORD = new Set(
  [...US_STATE_ABBR].filter((a) => !ABBR_AMBIGUOUS_AS_WORD.has(a.toLowerCase())),
);

// A UK postcode (full "SW1A 1AA" or outward code "EC2A") is a definitive signal.
const UK_POSTCODE = /\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/i;

// Optional runtime extension: data/uk-cities.txt, one city name per line.
function loadExtraCities(): void {
  const path = './data/uk-cities.txt';
  try {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const name = line.trim().toLowerCase();
      if (name) UK_CITIES.add(name);
    }
  } catch {
    /* ignore a bad/locked file */
  }
}
loadExtraCities();

/** All known UK counties + cities, for use as GitHub search location facets. */
export function getUkSearchLocations(): string[] {
  return [...COUNTY_SINGLE, ...COUNTY_MULTIWORD, ...UK_CITIES];
}

/** True if the location is empty/unknown or looks like it's in the UK. */
export function isUkOrEmpty(location: string | null | undefined): boolean {
  if (!location) return true;
  const raw = location.trim();
  if (!raw) return true;
  const s = raw.toLowerCase();
  const segs = s.split(/[,/|;•·]+/).map((t) => t.trim()).filter(Boolean);
  const words = s.split(/[^a-z]+/).filter(Boolean);

  // 1. Definitive UK signals — unambiguous, so they outrank everything below.
  if (UK_COUNTRY_SUBSTR.some((k) => s.includes(k))) return true;
  if (NATION_MULTIWORD.some((n) => s.includes(n))) return true;
  if (segs.some((seg) => NATION_SINGLE.has(seg))) return true;
  if (words.some((w) => NATION_SINGLE.has(w))) return true; // e.g. "London England"
  if (COUNTY_MULTIWORD.some((n) => s.includes(n))) return true; // e.g. "County Durham"
  if (UK_POSTCODE.test(s)) return true;

  // 2. Explicit foreign signals -> drop. Ahead of the bare county/city pass so a
  //    foreign qualifier beats a homonym: "Durham, NC" is North Carolina, not
  //    the county; "Boston, Lincolnshire" has no such qualifier and survives.
  if (FOREIGN_MULTIWORD.some((f) => s.includes(f))) return false;
  if (CA_PROVINCE_MULTIWORD.some((f) => s.includes(f))) return false;
  if (segs.some((seg) => FOREIGN_SINGLE.has(seg))) return false;
  if (words.some((w) => FOREIGN_SINGLE.has(w))) return false;
  if (words.some((w) => CA_PROVINCE_SINGLE.has(w))) return false;
  if (
    segs.some((seg) => {
      if (seg.length !== 2) return false;
      const abbr = seg.toUpperCase();
      return US_STATE_ABBR.has(abbr) || CA_PROVINCE_ABBR.has(abbr);
    })
  ) {
    return false;
  }
  // Comma-less "Durham NC 27705" / "Austin TX" — restricted to abbreviations
  // that aren't ordinary words, so "Co. Durham" isn't read as Colorado.
  if (words.some((w) => w.length === 2 && US_STATE_ABBR_WORD.has(w.toUpperCase()))) return false;

  // 3. Ambiguous UK signals — bare county or city name, no foreign qualifier.
  if (words.some((w) => COUNTY_SINGLE.has(w))) return true; // e.g. "Boston Lincolnshire"
  if (segs.some((seg) => UK_CITIES.has(seg)) || UK_CITIES.has(s)) return true;

  // 4. Unknown, non-empty -> drop
  return false;
}
