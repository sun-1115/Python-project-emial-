// Heuristic USA-location detection for GitHub's free-text `location` field.
// Rule: keep a user if their location is EMPTY or looks like the USA; drop
// clearly-foreign locations.
//
// Matching order matters — US signal FIRST, then foreign, then city — so that
// homonym towns resolve correctly:
//   "Paris, Texas"  -> US (state)      "Paris, France" -> foreign (country)
//   "Moscow, Idaho" -> US (state)      "Moscow, Russia" -> foreign (country)

import { readFileSync, existsSync } from 'node:fs';

const STATE_SINGLE = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'tennessee',
  'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming',
]);

const STATE_MULTIWORD = [
  'new york', 'new jersey', 'new mexico', 'new hampshire', 'north carolina',
  'south carolina', 'north dakota', 'south dakota', 'west virginia',
  'rhode island', 'district of columbia',
];

const STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const US_COUNTRY_SUBSTR = [
  'united states', 'united states of america', 'u.s.a', 'u. s. a',
];

// ~300 major US cities + tech hubs. Extend at runtime via data/us-cities.txt.
const US_CITIES = new Set<string>([
  'new york city', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
  'san antonio', 'san diego', 'dallas', 'san jose', 'austin', 'jacksonville',
  'fort worth', 'columbus', 'charlotte', 'san francisco', 'indianapolis',
  'seattle', 'denver', 'boston', 'el paso', 'nashville', 'oklahoma city',
  'las vegas', 'detroit', 'portland', 'memphis', 'louisville', 'milwaukee',
  'baltimore', 'albuquerque', 'tucson', 'fresno', 'mesa', 'sacramento',
  'atlanta', 'kansas city', 'colorado springs', 'omaha', 'raleigh', 'miami',
  'long beach', 'virginia beach', 'oakland', 'minneapolis', 'tulsa', 'tampa',
  'arlington', 'new orleans', 'wichita', 'cleveland', 'bakersfield', 'aurora',
  'anaheim', 'honolulu', 'santa ana', 'riverside', 'corpus christi', 'lexington',
  'henderson', 'stockton', 'saint paul', 'st. paul', 'st paul', 'cincinnati',
  'st. louis', 'st louis', 'saint louis', 'pittsburgh', 'greensboro', 'lincoln',
  'anchorage', 'plano', 'orlando', 'irvine', 'newark', 'toledo', 'durham',
  'chula vista', 'fort wayne', 'jersey city', 'st. petersburg', 'laredo',
  'madison', 'chandler', 'buffalo', 'lubbock', 'scottsdale', 'reno', 'glendale',
  'gilbert', 'winston-salem', 'north las vegas', 'norfolk', 'chesapeake',
  'garland', 'irving', 'hialeah', 'fremont', 'boise', 'richmond', 'baton rouge',
  'spokane', 'des moines', 'tacoma', 'san bernardino', 'modesto', 'fontana',
  'santa clarita', 'birmingham', 'oxnard', 'fayetteville', 'moreno valley',
  'rochester', 'glendale', 'huntington beach', 'salt lake city', 'grand rapids',
  'amarillo', 'yonkers', 'aurora', 'montgomery', 'akron', 'little rock',
  'huntsville', 'augusta', 'port st. lucie', 'grand prairie', 'columbus',
  'tallahassee', 'overland park', 'tempe', 'mckinney', 'mobile', 'cape coral',
  'shreveport', 'frisco', 'knoxville', 'worcester', 'brownsville', 'vancouver',
  'fort lauderdale', 'sioux falls', 'ontario', 'chattanooga', 'providence',
  'newport news', 'rancho cucamonga', 'santa rosa', 'peoria', 'oceanside',
  'elk grove', 'salem', 'pembroke pines', 'eugene', 'garden grove', 'cary',
  'fort collins', 'corona', 'springfield', 'jackson', 'alexandria', 'hayward',
  'clarksville', 'lakewood', 'lancaster', 'salinas', 'palmdale', 'hollywood',
  'macon', 'kansas city', 'sunnyvale', 'pomona', 'escondido', 'killeen',
  'naperville', 'joliet', 'bellevue', 'rockford', 'savannah', 'paterson',
  'torrance', 'bridgeport', 'mcallen', 'mesquite', 'syracuse', 'midland',
  'pasadena', 'murfreesboro', 'miramar', 'dayton', 'fullerton', 'orange',
  'flint', 'denton', 'roseville', 'thornton', 'visalia', 'sterling heights',
  'carrollton', 'coral springs', 'stamford', 'concord', 'kent', 'cedar rapids',
  'santa clara', 'new haven', 'gainesville', 'waco', 'columbia', 'ann arbor',
  'palo alto', 'mountain view', 'menlo park', 'cupertino', 'redmond',
  'san mateo', 'redwood city', 'berkeley', 'boulder', 'cambridge', 'brooklyn',
  'manhattan', 'bronx', 'queens', 'silicon valley', 'bay area', 'research triangle',
  'green bay', 'palo alto', 'bellevue', 'redwood', 'sunnyvale', 'santa monica',
  'pasadena', 'plano', 'chapel hill', 'princeton', 'evanston', 'berkeley',
]);

const FOREIGN_SINGLE = new Set([
  // countries
  'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru',
  'venezuela', 'ecuador', 'uruguay', 'bolivia', 'paraguay', 'england',
  'scotland', 'wales', 'ireland', 'france', 'germany', 'spain', 'portugal',
  'italy', 'netherlands', 'belgium', 'switzerland', 'austria', 'sweden',
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
  // unambiguous foreign cities (no notable US homonyms)
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
]);

const FOREIGN_MULTIWORD = [
  'united kingdom', 'great britain', 'new zealand', 'south korea', 'north korea',
  'south africa', 'saudi arabia', 'united arab emirates', 'hong kong',
  'costa rica', 'el salvador', 'dominican republic', 'puerto rico', 'sri lanka',
  'czech republic', 'sao paulo', 'rio de janeiro', 'buenos aires', 'mexico city',
  'ho chi minh', 'kuala lumpur', 'tel aviv', 'abu dhabi', 'south america',
  'latin america',
];

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

/** All known US states + cities, for use as GitHub search location facets. */
export function getUsSearchLocations(): string[] {
  return [...STATE_SINGLE, ...STATE_MULTIWORD, ...US_CITIES];
}

/** True if the location is empty/unknown or looks like it's in the USA. */
export function isUsOrEmpty(location: string | null | undefined): boolean {
  if (!location) return true;
  const raw = location.trim();
  if (!raw) return true;
  const s = raw.toLowerCase();
  const segs = s.split(/[,/|;•·]+/).map((t) => t.trim()).filter(Boolean);
  const words = s.split(/[^a-z]+/).filter(Boolean);

  // 1. Explicit US signals
  if (US_COUNTRY_SUBSTR.some((k) => s.includes(k))) return true;
  if (segs.includes('us') || segs.includes('usa') || segs.includes('u.s.')) return true;
  if (words.some((w) => STATE_SINGLE.has(w))) return true; // e.g. "Denver Colorado"
  if (STATE_MULTIWORD.some((n) => s.includes(n))) return true;
  if (segs.some((seg) => seg.length === 2 && STATE_ABBR.has(seg.toUpperCase()))) return true;

  // 2. Explicit foreign signals -> drop
  if (FOREIGN_MULTIWORD.some((f) => s.includes(f))) return false;
  if (segs.some((seg) => FOREIGN_SINGLE.has(seg))) return false;

  // 3. US city
  if (segs.some((seg) => US_CITIES.has(seg)) || US_CITIES.has(s)) return true;

  // 4. Unknown, non-empty -> drop
  return false;
}
