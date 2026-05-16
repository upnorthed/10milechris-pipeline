const ACTOR = "compass/crawler-google-places";
const BASE = "https://api.apify.com/v2";

const JUNK_TERMS = ["bus stop", "park", "parking", "beach", "atm", "trail"];

function apiKey() {
  const key = process.env.APIFY_API_KEY;
  if (!key) throw new Error("Missing APIFY_API_KEY");
  return key;
}

export interface ApifyPlace {
  title: string;
  website?: string;
  emails?: string[];
  phone?: string;
  address?: string;
  placeId?: string;
  totalScore?: number;
  reviewsCount?: number;
  reviews?: Array<{ text: string; stars: number }>;
}

// The 136 standard search terms for recipient lists
export const RECIPIENT_SEARCH_TERMS = [
  "restaurant",
  "cafe",
  "coffee shop",
  "pizza",
  "sushi",
  "mexican food",
  "chinese restaurant",
  "italian restaurant",
  "burger",
  "sandwich shop",
  "deli",
  "bakery",
  "brewery",
  "bar",
  "pub",
  "wine bar",
  "steakhouse",
  "seafood restaurant",
  "thai food",
  "indian restaurant",
  "mediterranean restaurant",
  "greek restaurant",
  "french restaurant",
  "japanese restaurant",
  "korean restaurant",
  "vietnamese restaurant",
  "bbq restaurant",
  "food truck",
  "catering",
  "brunch",
  "breakfast restaurant",
  "lunch restaurant",
  "dinner restaurant",
  "fast food",
  "fast casual",
  "food delivery",
  "meal prep",
  "health food",
  "vegan restaurant",
  "vegetarian restaurant",
  "gluten free restaurant",
  "farm to table",
  "organic restaurant",
  "local restaurant",
  "family restaurant",
  "fine dining",
  "casual dining",
  "sports bar",
  "nightclub",
  "lounge",
  "cocktail bar",
  "taproom",
  "winery",
  "distillery",
  "food hall",
  "market",
  "grocery store",
  "butcher",
  "fishmonger",
  "cheese shop",
  "ice cream shop",
  "dessert shop",
  "donut shop",
  "bagel shop",
  "juice bar",
  "smoothie bar",
  "bubble tea",
  "boba shop",
  "tea house",
  "noodle house",
  "ramen",
  "pho",
  "taco shop",
  "burrito",
  "wrap shop",
  "poke bowl",
  "bowl restaurant",
  "salad bar",
  "soup kitchen",
  "soup restaurant",
  "hot pot",
  "dim sum",
  "dumpling house",
  "gyoza",
  "shawarma",
  "falafel",
  "kebab",
  "gyro",
  "curry house",
  "tandoori",
  "buffet",
  "all you can eat",
  "food court",
  "diner",
  "american restaurant",
  "comfort food",
  "soul food",
  "creole restaurant",
  "cajun restaurant",
  "tex mex",
  "fusion restaurant",
  "tapas bar",
  "small plates",
  "charcuterie",
  "oyster bar",
  "sushi bar",
  "hibachi",
  "teppanyaki",
  "fondue",
  "raclette",
  "crepe shop",
  "waffle shop",
  "pancake house",
  "omelet bar",
  "brunch spot",
  "rooftop restaurant",
  "waterfront restaurant",
  "outdoor dining",
  "patio dining",
  "food pop up",
  "ghost kitchen",
  "cloud kitchen",
  "virtual restaurant",
  "private dining",
  "supper club",
  "members club restaurant",
  "hotel restaurant",
  "resort restaurant",
  "airport restaurant",
  "food kiosk",
  "specialty food",
  "ethnic food",
  "world cuisine",
  "international food",
];

function isJunk(place: ApifyPlace): boolean {
  const name = place.title?.toLowerCase() ?? "";
  return JUNK_TERMS.some((t) => name.includes(t));
}

async function runActor(input: Record<string, unknown>): Promise<string> {
  const res = await fetch(
    `${BASE}/acts/${encodeURIComponent(ACTOR)}/runs?token=${apiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify run failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { data: { id: string } };
  return data.data.id;
}

export async function triggerRecipientScrape(
  lat: number,
  lng: number
): Promise<string> {
  return runActor({
    searchTerms: RECIPIENT_SEARCH_TERMS,
    customGeolocation: { latitude: lat, longitude: lng },
    radiusKm: 16,
    maxCrawledPlacesPerSearch: 20,
    language: "en",
    exportPlaceUrls: false,
    additionalInfo: false,
    scrapeDirectories: false,
    scrapeReviews: false,
  });
}

export async function triggerHookBankScrape(
  lat: number,
  lng: number,
  vertical: string
): Promise<string> {
  return runActor({
    searchTerms: [vertical],
    customGeolocation: { latitude: lat, longitude: lng },
    radiusKm: 16,
    maxCrawledPlacesPerSearch: 100,
    language: "en",
    exportPlaceUrls: false,
    additionalInfo: false,
    scrapeDirectories: false,
    scrapeReviews: true,
    maxReviews: 50,
    reviewsFilterByStars: [1, 2],
  });
}

export async function getRunStatus(
  runId: string
): Promise<{ status: string; datasetId: string }> {
  const res = await fetch(`${BASE}/actor-runs/${runId}?token=${apiKey()}`);
  if (!res.ok) throw new Error(`Apify status check failed: ${res.status}`);
  const data = (await res.json()) as {
    data: { status: string; defaultDatasetId: string };
  };
  return {
    status: data.data.status,
    datasetId: data.data.defaultDatasetId,
  };
}

export async function getDatasetItems(
  datasetId: string
): Promise<ApifyPlace[]> {
  const res = await fetch(
    `${BASE}/datasets/${datasetId}/items?token=${apiKey()}&format=json&clean=true`
  );
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`);
  return res.json() as Promise<ApifyPlace[]>;
}

export function filterRecipients(places: ApifyPlace[]): ApifyPlace[] {
  return places.filter((p) => {
    if (isJunk(p)) return false;
    const emails = p.emails ?? [];
    return emails.length > 0 && emails.some((e) => e.includes("@"));
  });
}

export function extractHookPhrases(
  places: ApifyPlace[]
): Array<{ phrase: string; stars: number }> {
  const out: Array<{ phrase: string; stars: number }> = [];
  for (const place of places) {
    for (const review of place.reviews ?? []) {
      if (!review.text || review.stars > 2) continue;
      // Split on sentence boundaries and take non-trivial phrases
      const sentences = review.text
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20 && s.length < 200);
      for (const s of sentences) {
        out.push({ phrase: s, stars: review.stars });
      }
    }
  }
  return out;
}
