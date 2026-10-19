// Heuristic US-location detection for GitHub's free-text `location` field.
// Rule: keep a user if their location is EMPTY or looks like the US; drop
// clearly-foreign locations.
//
// Same three-tier shape the UK version used, with the home country swapped:
//   1. DEFINITIVE US — the country name, a multi-word state, or a state
//      abbreviation standing alone as a comma segment. Nothing outside the US
//      is "North Carolina" or sits in ", TX".
//   2. FOREIGN — an explicit country, a UK nation / county / UK-distinctive
//      city, or a Canadian province. Wins over tier 3.
//   3. AMBIGUOUS US — a bare state or city name, a ZIP code, or a comma-less
//      state abbreviation. These are homonym-prone, so they only count once
//      tier 2 has ruled out a foreign qualifier.
//
// The rule that makes this work: a place name shared by both countries must
// NOT appear in the tier-2 foreign lists, or its bare form would be read as
// British. Only UK-distinctive names belong there — which is why Boston,
// Cambridge, Manchester, Birmingham, Durham, Richmond, Lincoln, York, Reading,
// Portsmouth, Plymouth, Worcester, Newport, Bristol and Newcastle are all
// absent from them despite being British cities too.
//   "Boston"          -> US (city)     "Boston, Lincolnshire" -> foreign (county)
//   "Manchester"      -> US (NH)       "Manchester, UK"       -> foreign (nation)
//   "Cambridge"       -> US (MA)       "Cambridge, England"   -> foreign (nation)
//   "Paris, TX"       -> US (state)    "Paris, France"        -> foreign (country)
//   "Devon, PA"       -> US (state)    "Devon"                -> foreign (county)
//   "Austin TX 78701" -> US (abbr)     "London, Ontario"      -> foreign (province)
//
// ZIP codes sit in tier 3, not tier 1: plenty of countries use five-digit
// postal codes, so "Berlin, 10115" must reach the foreign check first.

import { readFileSync, existsSync } from 'node:fs';

// The country itself, as a whole comma segment or word.
const US_SINGLE = new Set(['usa', 'us', 'u.s.', 'u.s.a', 'u.s.a.', 'america', 'american', 'stateside']);

const US_MULTIWORD = [
  'united states', 'united states of america', 'u. s. a', 'the states',
];

// Multi-word states — unambiguous, so they can settle a location on their own.
const STATE_MULTIWORD = [
  'new york', 'new jersey', 'new mexico', 'new hampshire', 'north carolina',
  'south carolina', 'north dakota', 'south dakota', 'west virginia',
  'rhode island', 'district of columbia', 'washington dc', 'washington d.c.',
  'new england', 'puerto rico',
];

// Single-word states. Homonym risk is low but non-zero ("georgia" is also a
// country), so these sit in tier 3 behind the foreign pass.
const STATE_SINGLE = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'wisconsin', 'wyoming',
]);

// US cities and tech hubs. Shared names (Boston, Cambridge, Manchester,
// Birmingham, Durham, Richmond...) live here deliberately: tier 2 already
// catches them when a British qualifier is present, so the bare form should
// resolve to the US. Extend at runtime via data/us-cities.txt.
const US_CITIES = new Set<string>([
  'new york city', 'nyc', 'brooklyn', 'manhattan', 'queens', 'bronx',
  'staten island', 'san francisco', 'sf', 'bay area', 'silicon valley',
  'palo alto', 'mountain view', 'menlo park', 'cupertino', 'sunnyvale',
  'santa clara', 'san jose', 'oakland', 'berkeley', 'los angeles', 'la',
  'san diego', 'sacramento', 'san mateo', 'irvine', 'pasadena', 'long beach',
  'santa monica', 'chicago', 'houston', 'dallas', 'austin', 'san antonio',
  'fort worth', 'el paso', 'phoenix', 'tucson', 'scottsdale', 'tempe',
  'philadelphia', 'philly', 'pittsburgh', 'seattle', 'redmond', 'bellevue',
  'tacoma', 'spokane', 'portland', 'eugene', 'denver', 'boulder',
  'colorado springs', 'fort collins', 'atlanta', 'savannah', 'miami',
  'orlando', 'tampa', 'jacksonville', 'st petersburg', 'fort lauderdale',
  'detroit', 'ann arbor', 'grand rapids', 'minneapolis', 'st paul',
  'milwaukee', 'madison', 'kansas city', 'st louis', 'omaha', 'des moines',
  'indianapolis', 'columbus', 'cleveland', 'cincinnati', 'dayton', 'akron',
  'toledo', 'nashville', 'memphis', 'knoxville', 'chattanooga', 'louisville',
  'lexington', 'charlotte', 'raleigh', 'durham', 'chapel hill', 'greensboro',
  'charleston', 'columbia', 'richmond', 'virginia beach', 'norfolk',
  'arlington', 'alexandria', 'baltimore', 'annapolis', 'washington',
  'boston', 'cambridge', 'somerville', 'worcester', 'springfield',
  'providence', 'newport', 'hartford', 'new haven', 'stamford', 'bridgeport',
  'manchester', 'nashua', 'portland maine', 'burlington', 'albany',
  'buffalo', 'rochester', 'syracuse', 'yonkers', 'newark', 'jersey city',
  'princeton', 'hoboken', 'trenton', 'wilmington', 'dover', 'salt lake city',
  'provo', 'ogden', 'las vegas', 'reno', 'henderson', 'boise', 'billings',
  'albuquerque', 'santa fe', 'oklahoma city', 'tulsa', 'little rock',
  'new orleans', 'baton rouge', 'birmingham', 'huntsville', 'montgomery',
  'mobile', 'jackson', 'anchorage', 'honolulu', 'lincoln', 'wichita',
  'lancaster', 'york', 'reading', 'allentown', 'bethlehem', 'scranton',
  'erie', 'harrisburg', 'plymouth', 'portsmouth', 'bristol', 'newcastle',
  'bath', 'exeter', 'gloucester', 'chester', 'warrington', 'carlisle',
  'darlington', 'wakefield', 'preston', 'mansfield', 'chesterfield',
  'winchester', 'canterbury', 'hastings', 'oxford', 'bedford', 'greenwich',
  'stratford', 'kingston', 'richmond hill', 'brighton', 'andover',
]);

// --- Foreign ---------------------------------------------------------------
// UK nation names. "british" is deliberately absent as a bare word: it also
// begins "British Columbia", and the multi-word guards below cover the rest.
const UK_SINGLE = new Set([
  'uk', 'u.k.', 'gb', 'britain', 'england', 'scotland', 'wales', 'cymru',
  'english', 'scottish', 'welsh',
]);

const UK_MULTIWORD = [
  'united kingdom', 'great britain', 'northern ireland', 'u. k.', 'the uk',
];

// UK counties and regions — distinctly British as bare words.
const UK_COUNTY = new Set([
  'bedfordshire', 'berkshire', 'buckinghamshire', 'cambridgeshire', 'cheshire',
  'cornwall', 'cumbria', 'derbyshire', 'devon', 'dorset', 'essex',
  'gloucestershire', 'hampshire', 'herefordshire', 'hertfordshire', 'kent',
  'lancashire', 'leicestershire', 'lincolnshire', 'merseyside', 'norfolk',
  'northamptonshire', 'northumberland', 'nottinghamshire', 'oxfordshire',
  'rutland', 'shropshire', 'somerset', 'staffordshire', 'suffolk', 'surrey',
  'warwickshire', 'wiltshire', 'worcestershire', 'yorkshire', 'anglesey',
  'ceredigion', 'conwy', 'denbighshire', 'flintshire', 'gwynedd',
  'monmouthshire', 'pembrokeshire', 'powys', 'wrexham', 'clwyd', 'dyfed',
  'gwent', 'glamorgan', 'aberdeenshire', 'angus', 'argyll', 'ayrshire',
  'clackmannanshire', 'dumfriesshire', 'fife', 'inverness-shire',
  'lanarkshire', 'lothian', 'midlothian', 'moray', 'perthshire',
  'renfrewshire', 'stirlingshire', 'antrim', 'armagh', 'fermanagh',
  'londonderry', 'tyrone',
]);

const UK_MULTIWORD_PLACE = [
  'east sussex', 'west sussex', 'north yorkshire', 'south yorkshire',
  'west yorkshire', 'east yorkshire', 'west midlands', 'east midlands',
  'greater london', 'greater manchester', 'tyne and wear', 'isle of wight',
  'isle of man', 'channel islands', 'county durham', 'east anglia',
  'north west england', 'south east england', 'south west england',
  'north east england', 'home counties', 'scottish highlands',
  'vale of glamorgan', 'north lanarkshire', 'south lanarkshire',
  'east lothian', 'west lothian', 'dumfries and galloway', 'milton keynes',
  'stoke-on-trent', 'newcastle upon tyne', 'kingston upon hull',
  'brighton and hove', 'st albans', 'southend-on-sea',
];

// UK cities WITHOUT a notable US counterpart. Anything shared (Boston,
// Cambridge, Manchester, Birmingham, Durham, York, Reading...) is left out on
// purpose — see the header.
const UK_CITIES = new Set([
  'london', 'edinburgh', 'glasgow', 'cardiff', 'belfast', 'liverpool', 'leeds',
  'sheffield', 'nottingham', 'leicester', 'coventry', 'bradford',
  'wolverhampton', 'southampton', 'norwich', 'swansea', 'aberdeen', 'dundee',
  'inverness', 'ipswich', 'luton', 'slough', 'croydon', 'blackpool',
  'blackburn', 'oldham', 'rochdale', 'salford', 'wigan', 'huddersfield',
  'doncaster', 'rotherham', 'barnsley', 'sunderland', 'middlesbrough', 'crewe',
  'shrewsbury', 'telford', 'cheltenham', 'harrogate', 'scarborough',
  'solihull', 'walsall', 'dudley', 'stevenage', 'harlow', 'aylesbury',
  'bracknell', 'farnborough', 'wembley', 'wimbledon', 'shoreditch',
  'canary wharf', 'westminster', 'islington', 'hackney', 'ealing', 'bolton',
  'paisley', 'livingston', 'lisburn', 'derry', 'truro', 'torquay', 'grimsby',
  'scunthorpe', 'burnley', 'redditch', 'basingstoke', 'guildford', 'woking',
  'crawley', 'eastbourne', 'worthing', 'maidstone', 'colchester', 'chelmsford',
  'peterborough', 'swindon', 'bournemouth', 'poole', 'basildon', 'watford',
  'hemel hempstead', 'high wycombe', 'welwyn', 'hatfield', 'stockport',
  'west bromwich', 'sutton coldfield', 'hereford', 'salisbury',
]);

const FOREIGN_SINGLE = new Set([
  // countries
  'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru',
  'venezuela', 'ecuador', 'uruguay', 'bolivia', 'paraguay', 'ireland', 'eire',
  'france', 'germany', 'spain', 'portugal', 'italy', 'netherlands', 'holland',
  'belgium', 'switzerland', 'austria', 'sweden', 'norway', 'denmark',
  'finland', 'iceland', 'poland', 'ukraine', 'russia', 'romania', 'bulgaria',
  'hungary', 'greece', 'turkey', 'serbia', 'croatia', 'slovakia', 'slovenia',
  'lithuania', 'latvia', 'estonia', 'belarus', 'india', 'pakistan',
  'bangladesh', 'nepal', 'china', 'japan', 'korea', 'vietnam', 'thailand',
  'indonesia', 'malaysia', 'singapore', 'philippines', 'taiwan', 'australia',
  'zealand', 'egypt', 'nigeria', 'kenya', 'ghana', 'ethiopia', 'morocco',
  'algeria', 'tunisia', 'israel', 'iran', 'iraq', 'lebanon', 'jordan',
  'kuwait', 'qatar', 'bahrain', 'oman', 'afghanistan', 'kazakhstan',
  'uzbekistan', 'azerbaijan', 'armenia', 'cambodia', 'myanmar', 'laos',
  'mongolia', 'srilanka', 'cuba', 'jamaica', 'panama', 'guatemala',
  'honduras', 'nicaragua', 'europe', 'asia', 'africa',
  // foreign cities with no notable US counterpart
  'tokyo', 'seoul', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'mumbai',
  'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'kolkata', 'pune',
  'delhi', 'karachi', 'lahore', 'dhaka', 'jakarta', 'bangkok', 'hanoi',
  'istanbul', 'tehran', 'baghdad', 'riyadh', 'jeddah', 'nairobi', 'lagos',
  'johannesburg', 'toronto', 'montreal', 'ottawa', 'calgary', 'edmonton',
  'winnipeg', 'vancouver', 'munich', 'frankfurt', 'hamburg', 'stuttgart',
  'cologne', 'lyon', 'marseille', 'barcelona', 'lisbon', 'zurich', 'geneva',
  'copenhagen', 'stockholm', 'oslo', 'helsinki', 'warsaw', 'krakow', 'prague',
  'budapest', 'bucharest', 'sofia', 'kyiv', 'kiev', 'minsk', 'sydney',
  'melbourne', 'brisbane', 'auckland', 'wellington', 'medellin', 'bogota',
  'guadalajara', 'dublin', 'cork', 'galway', 'amsterdam', 'rotterdam',
  'brussels', 'vienna', 'madrid', 'milan', 'rome', 'naples', 'berlin',
  'paris', 'perth',
]);

const FOREIGN_MULTIWORD = [
  'new zealand', 'south korea', 'north korea', 'south africa', 'saudi arabia',
  'united arab emirates', 'hong kong', 'costa rica', 'el salvador',
  'dominican republic', 'sri lanka', 'czech republic', 'sao paulo',
  'rio de janeiro', 'buenos aires', 'mexico city', 'ho chi minh',
  'kuala lumpur', 'tel aviv', 'abu dhabi', 'south america', 'latin america',
  'republic of ireland', 'new south wales',
];

// Canadian provinces — "London, Ontario" and "Vancouver, BC" are the traps.
const CA_PROVINCE_SINGLE = new Set([
  'ontario', 'quebec', 'québec', 'alberta', 'manitoba', 'saskatchewan',
  'newfoundland', 'labrador', 'yukon', 'nunavut',
]);

const CA_PROVINCE_MULTIWORD = [
  'british columbia', 'nova scotia', 'new brunswick', 'prince edward island',
  'northwest territories',
];

const CA_PROVINCE_ABBR = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Abbreviations that are also ordinary words. Safe as a comma-delimited
// segment, NOT safe as a loose word, so the word-level pass skips them.
const ABBR_AMBIGUOUS_AS_WORD = new Set([
  'al', 'ca', 'co', 'de', 'hi', 'id', 'in', 'la', 'me', 'ms', 'oh', 'ok', 'or',
  'pa', 'ne', 'nv', 'md', 'mo', 'mt', 'sc', 'sd',
]);

const US_STATE_ABBR_WORD = new Set(
  [...US_STATE_ABBR].filter((a) => !ABBR_AMBIGUOUS_AS_WORD.has(a.toLowerCase())),
);

// A five-digit ZIP, optionally ZIP+4. Tier 3 only — see the header.
const US_ZIP = /\b\d{5}(?:-\d{4})?\b/;

// Optional runtime extension: data/us-cities.txt, one city name per line.
function loadExtraCities(): void {
  const path = './data/us-cities.txt';
  try {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const name = line.trim().toLowerCase();
      if (name) US_CITIES.add(name);
    }
  } catch {
    /* ignore a bad/locked file */
  }
}
loadExtraCities();

// Nation-level facets. Kept separate from US_SINGLE because that set holds
// adjectives and shorthands ('american', 'us') that make poor `location:`
// queries.
const NATION_FACETS = ['United States', 'USA', 'America'];

/**
 * All known US nations + states + cities, for use as GitHub search location
 * facets. The country and state names matter most: they are the commonest
 * thing a US user types, so leaving them out loses whoever wrote only "USA".
 */
export function getUsSearchLocations(): string[] {
  // Deduped: a few names are both a state and a city ("washington"), and a
  // repeated facet would issue the same search twice and burn API quota.
  return [...new Set([...NATION_FACETS, ...STATE_MULTIWORD, ...STATE_SINGLE, ...US_CITIES])];
}

/** True if the location is empty/unknown or looks like it's in the US. */
export function isUsOrEmpty(location: string | null | undefined): boolean {
  if (!location) return true;
  const raw = location.trim();
  if (!raw) return true;
  const s = raw.toLowerCase();
  const segs = s.split(/[,/|;•·]+/).map((t) => t.trim()).filter(Boolean);
  const words = s.split(/[^a-z]+/).filter(Boolean);

  // 1. Definitive US signals — unambiguous, so they outrank everything below.
  if (US_MULTIWORD.some((k) => s.includes(k))) return true;
  if (STATE_MULTIWORD.some((k) => s.includes(k))) return true;
  if (segs.some((seg) => US_SINGLE.has(seg))) return true;
  if (words.some((w) => US_SINGLE.has(w))) return true;
  // A bare two-letter segment: "Paris, TX" is Texas, not France. Checked here,
  // ahead of the foreign pass, because the abbreviation is the stronger signal.
  if (
    segs.some((seg) => seg.length === 2 && US_STATE_ABBR.has(seg.toUpperCase()) &&
      !CA_PROVINCE_ABBR.has(seg.toUpperCase()))
  ) {
    return true;
  }

  // 2. Explicit foreign signals -> drop.
  if (UK_MULTIWORD.some((k) => s.includes(k))) return false;
  if (UK_MULTIWORD_PLACE.some((k) => s.includes(k))) return false;
  if (FOREIGN_MULTIWORD.some((f) => s.includes(f))) return false;
  if (CA_PROVINCE_MULTIWORD.some((f) => s.includes(f))) return false;
  if (segs.some((seg) => UK_SINGLE.has(seg))) return false;
  if (words.some((w) => UK_SINGLE.has(w))) return false;
  if (words.some((w) => UK_COUNTY.has(w))) return false;
  if (segs.some((seg) => UK_CITIES.has(seg)) || UK_CITIES.has(s)) return false;
  if (segs.some((seg) => FOREIGN_SINGLE.has(seg))) return false;
  if (words.some((w) => FOREIGN_SINGLE.has(w))) return false;
  if (words.some((w) => CA_PROVINCE_SINGLE.has(w))) return false;
  if (segs.some((seg) => seg.length === 2 && CA_PROVINCE_ABBR.has(seg.toUpperCase()))) return false;

  // 3. Ambiguous US signals — a bare state or city, a ZIP, or a comma-less
  //    abbreviation, now that tier 2 has ruled out a foreign qualifier.
  if (words.some((w) => STATE_SINGLE.has(w))) return true;
  if (segs.some((seg) => US_CITIES.has(seg)) || US_CITIES.has(s)) return true;
  if (words.some((w) => w.length === 2 && US_STATE_ABBR_WORD.has(w.toUpperCase()))) return true;
  if (US_ZIP.test(s)) return true;

  // 4. Unknown, non-empty -> drop
  return false;
}
